import { type Ctx, require, need, isDate, round2 } from './context'
import { getProject } from './projects'
import { cashFlow, listVersions, planSummary } from './budgetplan'
import { COST_CATEGORIES, planVsActual } from './analytics'

export type FunderKind = 'contractor' | 'lender' | 'investor' | 'other'
export type FundingStatus = 'draft' | 'submitted' | 'approved' | 'disbursed' | 'repaid' | 'declined' | 'withdrawn'
export const FUNDER_KINDS: readonly FunderKind[] = ['contractor', 'lender', 'investor', 'other']
const OPEN: readonly FundingStatus[] = ['draft', 'submitted', 'approved']   // statuses a request can still be withdrawn from

export interface RequestInput {
  funder_kind: FunderKind; funder_name: string; purpose: string; amount_requested: number; needed_by?: string | null; repayment_source?: string | null; repayment_due?: string | null
  interest_pct?: number; terms?: string | null; covers?: string[]; notes?: string | null
}
const nn = (n: number | undefined, what: string) => { if (n !== undefined) need(Number.isFinite(n) && n >= 0, `${what} cannot be negative`) }

function requestOf(ctx: Ctx, id: string) {
  const r = ctx.db.get<RequestRow>(`SELECT id, project_id, funder_kind, funder_name, purpose, amount_requested, needed_by, repayment_source, repayment_due, interest_pct, terms, covers, status, amount_approved, decided_on, notes
    FROM funding_requests WHERE id=? AND farm_id=? AND deleted_at IS NULL`, [id, ctx.farmId]); need(r, 'Funding request not found'); return r
}
interface RequestRow { id: string; project_id: string; funder_kind: FunderKind; funder_name: string; purpose: string; amount_requested: number; needed_by: string | null; repayment_source: string | null; repayment_due: string | null
  interest_pct: number; terms: string | null; covers: string | null; status: FundingStatus; amount_approved: number | null; decided_on: string | null; notes: string | null }

function validate(i: RequestInput) {
  need(FUNDER_KINDS.includes(i.funder_kind), 'Choose the kind of funder'); need(i.funder_name.trim(), 'Name the funder'); need(i.purpose.trim(), 'Say what the funding is for')
  need(Number.isFinite(i.amount_requested) && i.amount_requested > 0, 'The amount requested must be more than zero'); nn(i.interest_pct, 'Interest')
  for (const [d, w] of [[i.needed_by, 'needed-by'], [i.repayment_due, 'repayment']] as const) need(d == null || d === '' || isDate(d), `Enter a valid ${w} date`)
  const bad = (i.covers ?? []).filter(c => !(COST_CATEGORIES as readonly string[]).includes(c)); need(!bad.length, `Unknown budget category: ${bad.join(', ')}`)
}

// ---- requests ----
export function createRequest(ctx: Ctx, projectId: string, i: RequestInput): string {
  require(ctx, 'projects.funding.edit'); getProject(ctx, projectId); validate(i)
  return ctx.db.tx(() => {
    const id = ctx.db.insert('funding_requests', { tenant_id: ctx.tenantId, farm_id: ctx.farmId, project_id: projectId, funder_kind: i.funder_kind, funder_name: i.funder_name.trim(), purpose: i.purpose.trim(),
      amount_requested: round2(i.amount_requested), needed_by: i.needed_by || null, repayment_source: i.repayment_source?.trim() || null, repayment_due: i.repayment_due || null, interest_pct: i.interest_pct ?? 0,
      terms: i.terms?.trim() || null, covers: (i.covers ?? []).join(',') || null, status: 'draft', notes: i.notes?.trim() || null })
    ctx.db.audit(ctx.actor?.id ?? null, 'funding.create', 'funding_requests', id); return id
  })
}
/** A request can be reworded until it is submitted; after that its terms are what was sent. */
export function updateRequest(ctx: Ctx, id: string, i: RequestInput) {
  require(ctx, 'projects.funding.edit'); const r = requestOf(ctx, id); need(r.status === 'draft', 'Only a draft can be edited; withdraw it and raise a new one'); validate(i)
  ctx.db.tx(() => ctx.db.update('funding_requests', id, { funder_kind: i.funder_kind, funder_name: i.funder_name.trim(), purpose: i.purpose.trim(), amount_requested: round2(i.amount_requested), needed_by: i.needed_by || null,
    repayment_source: i.repayment_source?.trim() || null, repayment_due: i.repayment_due || null, interest_pct: i.interest_pct ?? 0, terms: i.terms?.trim() || null, covers: (i.covers ?? []).join(',') || null, notes: i.notes?.trim() || null }))
}
export function deleteDraft(ctx: Ctx, id: string) {
  require(ctx, 'projects.funding.edit'); need(requestOf(ctx, id).status === 'draft', 'Only a draft can be deleted; otherwise withdraw it'); ctx.db.tx(() => ctx.db.softDelete('funding_requests', id))
}
export function submitRequest(ctx: Ctx, id: string) {
  require(ctx, 'projects.funding.edit'); need(requestOf(ctx, id).status === 'draft', 'Only a draft can be submitted'); setStatus(ctx, id, 'submitted', {})
}
export function approveRequest(ctx: Ctx, id: string, i: { amount_approved: number; decided_on: string; terms?: string | null; interest_pct?: number }) {
  require(ctx, 'projects.funding.edit'); need(requestOf(ctx, id).status === 'submitted', 'Only a submitted request can be approved')
  need(Number.isFinite(i.amount_approved) && i.amount_approved > 0, 'The approved amount must be more than zero'); need(isDate(i.decided_on), 'Enter the date it was approved'); nn(i.interest_pct, 'Interest')
  setStatus(ctx, id, 'approved', { amount_approved: round2(i.amount_approved), decided_on: i.decided_on, ...(i.terms != null ? { terms: i.terms.trim() || null } : {}), ...(i.interest_pct != null ? { interest_pct: i.interest_pct } : {}) })
}
export function declineRequest(ctx: Ctx, id: string, decided_on: string) {
  require(ctx, 'projects.funding.edit'); need(requestOf(ctx, id).status === 'submitted', 'Only a submitted request can be declined'); need(isDate(decided_on), 'Enter the date it was declined'); setStatus(ctx, id, 'declined', { decided_on })
}
export function withdrawRequest(ctx: Ctx, id: string) {
  require(ctx, 'projects.funding.edit'); need(OPEN.includes(requestOf(ctx, id).status), 'Only a request that has not paid out can be withdrawn'); setStatus(ctx, id, 'withdrawn', {})
}
function setStatus(ctx: Ctx, id: string, status: FundingStatus, extra: Record<string, string | number | null>) {
  ctx.db.tx(() => { ctx.db.update('funding_requests', id, { status, ...extra }); ctx.db.audit(ctx.actor?.id ?? null, `funding.${status}`, 'funding_requests', id) })
}

// ---- money that moved ----
export interface FundingEvent { id: string; kind: 'disbursement' | 'repayment'; form: 'cash' | 'inputs' | null; amount: number; occurred_on: string; input_id: string | null; qty: number | null; note: string | null }
const eventsOf = (ctx: Ctx, requestId: string) => ctx.db.all<FundingEvent>(`SELECT id, kind, form, amount, occurred_on, input_id, qty, note FROM funding_events WHERE request_id=? AND deleted_at IS NULL ORDER BY occurred_on, created_at, rowid`, [requestId])

/** Cash or inputs received. Inputs go into stock at their value, as contractor advances do, so later use flows into field costs at the true price. */
export function recordDisbursement(ctx: Ctx, requestId: string, i: { form: 'cash' | 'inputs'; amount: number; occurred_on: string; input_id?: string; qty?: number; note?: string }) {
  require(ctx, 'projects.funding.edit'); const r = requestOf(ctx, requestId)
  need(r.funder_kind !== 'contractor', 'Record contractor advances on the contract; they appear here by themselves')
  need(r.status === 'approved' || r.status === 'disbursed', 'Money can only be received against an approved request')
  need(['cash', 'inputs'].includes(i.form), 'Say whether cash or inputs were received'); need(Number.isFinite(i.amount) && i.amount > 0, 'The amount must be more than zero'); need(isDate(i.occurred_on), 'Enter the date received')
  const got = eventsOf(ctx, requestId).filter(e => e.kind === 'disbursement').reduce((s, e) => s + e.amount, 0)
  need(got + i.amount <= (r.amount_approved ?? 0) + 0.005, `That is more than was approved (${round2((r.amount_approved ?? 0) - got)} left to receive)`)
  if (i.form === 'inputs') { need(ctx.db.get(`SELECT 1 FROM inputs WHERE id=? AND tenant_id=? AND deleted_at IS NULL`, [i.input_id ?? '', ctx.tenantId]), 'Choose the input received'); need(i.qty && i.qty > 0, 'Enter the quantity received') }
  ctx.db.tx(() => {
    const txn = i.form === 'inputs' ? ctx.db.insert('inventory_transactions', { tenant_id: ctx.tenantId, farm_id: ctx.farmId, input_id: i.input_id!, kind: 'purchase', qty_delta: i.qty!, unit_cost: round2(i.amount / i.qty!),
      occurred_on: i.occurred_on, note: `Received under funding from ${r.funder_name}`, created_by: ctx.actor?.id ?? null }) : null
    const id = ctx.db.insert('funding_events', { tenant_id: ctx.tenantId, request_id: requestId, kind: 'disbursement', form: i.form, amount: round2(i.amount), occurred_on: i.occurred_on,
      input_id: i.form === 'inputs' ? i.input_id! : null, qty: i.form === 'inputs' ? i.qty! : null, inventory_txn_id: txn, note: i.note?.trim() || null })
    ctx.db.audit(ctx.actor?.id ?? null, 'funding.disbursement', 'funding_events', id); refreshStatus(ctx, requestId)
  })
}
export function recordRepayment(ctx: Ctx, requestId: string, i: { amount: number; occurred_on: string; note?: string }) {
  require(ctx, 'projects.funding.edit'); const r = requestOf(ctx, requestId); need(r.status === 'disbursed', 'There is nothing to repay on this request')
  need(Number.isFinite(i.amount) && i.amount > 0, 'The amount must be more than zero'); need(isDate(i.occurred_on), 'Enter the date repaid')
  const ev = eventsOf(ctx, requestId); need(!ev.length || i.occurred_on >= ev.at(-1)!.occurred_on, 'A repayment cannot be dated before an earlier movement')
  const owed = ledger(r, ev, i.occurred_on).owed; need(i.amount <= owed + 0.005, `That is more than is owed on ${i.occurred_on} (${owed})`)
  ctx.db.tx(() => {
    const id = ctx.db.insert('funding_events', { tenant_id: ctx.tenantId, request_id: requestId, kind: 'repayment', form: null, amount: round2(i.amount), occurred_on: i.occurred_on, note: i.note?.trim() || null })
    ctx.db.audit(ctx.actor?.id ?? null, 'funding.repayment', 'funding_events', id); refreshStatus(ctx, requestId)
  })
}
/** Removes a recorded movement (a mistake). Inputs received are taken back out of stock, unless some has already been used. */
export function deleteEvent(ctx: Ctx, eventId: string) {
  require(ctx, 'projects.funding.edit')
  const e = ctx.db.get<{ id: string; request_id: string; kind: string; input_id: string | null; qty: number | null; inventory_txn_id: string | null }>(`SELECT e.id, e.request_id, e.kind, e.input_id, e.qty, e.inventory_txn_id FROM funding_events e JOIN funding_requests r ON r.id=e.request_id
    WHERE e.id=? AND r.farm_id=? AND e.deleted_at IS NULL`, [eventId, ctx.farmId]); need(e, 'Movement not found')
  if (e.kind === 'disbursement') {
    const later = eventsOf(ctx, e.request_id).some(x => x.kind === 'repayment'); need(!later, 'Remove the repayments first')
    if (e.inventory_txn_id && e.input_id) { const onHand = ctx.db.get<{ n: number }>(`SELECT COALESCE(SUM(qty_delta),0) n FROM inventory_transactions WHERE input_id=? AND farm_id=? AND deleted_at IS NULL`, [e.input_id, ctx.farmId])!.n
      need(onHand >= (e.qty ?? 0) - 0.0001, 'Some of this input has already been used; it cannot be removed from stock') }
  }
  ctx.db.tx(() => { if (e.inventory_txn_id) ctx.db.softDelete('inventory_transactions', e.inventory_txn_id); ctx.db.softDelete('funding_events', eventId); refreshStatus(ctx, e.request_id) })
}

/**
 * Simple interest on the principal still outstanding, per year of 365 days, from each disbursement; a repayment pays accrued interest first, then principal.
 * `owed` is principal plus interest accrued up to `asOf`.
 */
export function ledger(r: { interest_pct: number }, events: Pick<FundingEvent, 'kind' | 'amount' | 'occurred_on'>[], asOf: string) {
  let principal = 0, interest = 0, received = 0, repaid = 0, last = ''
  const days = (a: string, b: string) => Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 86400e3))
  for (const e of events) {
    if (e.occurred_on > asOf) break
    if (last) interest += principal * (r.interest_pct / 100) * days(last, e.occurred_on) / 365
    last = e.occurred_on
    if (e.kind === 'disbursement') { principal += e.amount; received += e.amount }
    else { repaid += e.amount; const toInterest = Math.min(interest, e.amount); interest -= toInterest; principal -= e.amount - toInterest }
  }
  if (last) interest += principal * (r.interest_pct / 100) * days(last, asOf) / 365
  principal = Math.max(0, principal); interest = Math.max(0, interest)
  return { received: round2(received), repaid: round2(repaid), principal: round2(principal), interest: round2(interest), owed: round2(principal + interest) }
}
function refreshStatus(ctx: Ctx, requestId: string) {
  const r = requestOf(ctx, requestId); if (!['approved', 'disbursed', 'repaid'].includes(r.status)) return
  const ev = eventsOf(ctx, requestId); const got = ev.some(e => e.kind === 'disbursement')
  const next: FundingStatus = !got ? 'approved' : ledger(r, ev, ev.at(-1)!.occurred_on).owed <= 0.005 ? 'repaid' : 'disbursed'
  if (next !== r.status) ctx.db.update('funding_requests', requestId, { status: next })
}

// ---- project link: contractor, contract, independent, "no funding needed" ----
export function linkContract(ctx: Ctx, projectId: string, i: { contract_id: string | null; independent?: boolean }) {
  require(ctx, 'projects.project.edit'); const p = getProject(ctx, projectId)
  if (i.contract_id) {
    const c = ctx.db.get<{ contractor_id: string }>(`SELECT contractor_id FROM contracts WHERE id=? AND farm_id=? AND season_id=? AND deleted_at IS NULL AND status<>'cancelled'`, [i.contract_id, ctx.farmId, p.season_id])
    need(c, 'Choose a contract of this project’s season')
    ctx.db.tx(() => ctx.db.update('projects', projectId, { contract_id: i.contract_id, contractor_id: c.contractor_id, independent: 0 }))
  } else ctx.db.tx(() => ctx.db.update('projects', projectId, { contract_id: null, contractor_id: null, independent: i.independent ? 1 : 0 }))
}
export function setFundingNotNeeded(ctx: Ctx, projectId: string, on: boolean) {
  require(ctx, 'projects.project.edit'); getProject(ctx, projectId)
  if (on) need(!ctx.db.get(`SELECT 1 FROM funding_requests WHERE project_id=? AND deleted_at IS NULL AND status NOT IN ('declined','withdrawn')`, [projectId]), 'This project has a funding request in progress')
  ctx.db.tx(() => ctx.db.update('projects', projectId, { funding_not_needed: on ? 1 : 0 }))
}

// ---- read models ----
export interface FundingLine extends RequestRow { events: FundingEvent[]; received: number; repaid: number; principal: number; interest: number; owed: number }
export interface ContractorSource { contract_id: string; code: string; contractor: string; received: number; recovered: number; outstanding: number; settled: boolean; advances: { id: string; description: string; value: number; advanced_on: string }[] }
export interface FundingSummary {
  requests: FundingLine[]; contractor: ContractorSource | null
  /** Money in across all funders, including contractor advances. */
  received: number; repaid: number; outstanding: number; interest: number; requested_open: number; asOf: string
}
export function fundingSummary(ctx: Ctx, projectId: string, asOf = new Date().toISOString().slice(0, 10)): FundingSummary {
  require(ctx, 'projects.funding.view'); const p = getProject(ctx, projectId)
  const requests = ctx.db.all<RequestRow>(`SELECT id FROM funding_requests WHERE project_id=? AND farm_id=? AND deleted_at IS NULL ORDER BY created_at, rowid`, [projectId, ctx.farmId]).map(x => requestOf(ctx, x.id)).map(r => {
    const events = eventsOf(ctx, r.id); return { ...r, events, ...ledger(r, events, asOf) }
  })
  let contractor: ContractorSource | null = null
  if (p.contract_id) {
    const k = ctx.db.get<{ code: string; contractor: string }>(`SELECT k.code, c.name contractor FROM contracts k JOIN contractors c ON c.id=k.contractor_id WHERE k.id=? AND k.deleted_at IS NULL`, [p.contract_id])
    if (k) {
      const advances = ctx.db.all<ContractorSource['advances'][number]>(`SELECT id, description, value, advanced_on FROM contract_advances WHERE contract_id=? AND deleted_at IS NULL ORDER BY advanced_on, rowid`, [p.contract_id])
      const s = ctx.db.get<{ advances_recovered: number }>(`SELECT advances_recovered FROM contract_settlements WHERE contract_id=? AND deleted_at IS NULL`, [p.contract_id])
      const received = round2(advances.reduce((t, a) => t + a.value, 0)); const recovered = round2(s?.advances_recovered ?? 0)
      contractor = { contract_id: p.contract_id, code: k.code, contractor: k.contractor, received, recovered, outstanding: round2(received - recovered), settled: !!s, advances }
    }
  }
  const sum = (f: (l: FundingLine) => number) => round2(requests.reduce((t, l) => t + f(l), 0))
  return { requests, contractor, asOf,
    received: round2(sum(l => l.received) + (contractor?.received ?? 0)), repaid: round2(sum(l => l.repaid) + (contractor?.recovered ?? 0)),
    outstanding: round2(sum(l => l.principal) + (contractor?.outstanding ?? 0)), interest: sum(l => l.interest),
    requested_open: sum(l => ['draft', 'submitted'].includes(l.status) ? l.amount_requested : 0) }
}

/** What goes into the printable pack for one request: the plan, the baseline budget, the monthly cash need, break-even, the repayment plan and, once production has started, budget against actual. */
export function fundingPack(ctx: Ctx, requestId: string) {
  require(ctx, 'projects.funding.view'); require(ctx, 'finance.budget.view'); require(ctx, 'finance.cost.view')
  const r = requestOf(ctx, requestId); const p = getProject(ctx, r.project_id); const plan = planSummary(ctx, p.id); const versions = listVersions(ctx, p.season_id)
  const live = planVsActual(ctx, p.season_id); const started = live.actual_total > 0
  return { project: p.name, stage: p.stage_label, request: r, plan, baseline: versions[0] ?? null, latest: versions.at(-1) ?? null, cash_need: cashFlow(ctx, p.season_id),
    covers: r.covers ? r.covers.split(',') : [], budget_vs_actual: started ? live : null, generated_on: new Date().toISOString().slice(0, 10) }
}
