import { type Ctx, require, need, isDate, round2 } from './context'
import { assertSeasonOpen, nextCode, nonNeg } from './util'

// ---------------------------------------------------------------- contractors
export interface Contractor { id: string; name: string; contact_person: string | null; phone: string | null; email: string | null; notes: string | null; active: number; contracts: number }
export type ContractorInput = { name: string; contact_person?: string | null; phone?: string | null; email?: string | null; notes?: string | null; active?: boolean }

export function listContractors(ctx: Ctx): Contractor[] {
  require(ctx, 'contracts.contract.view')
  return ctx.db.all<Contractor>(`SELECT c.id, c.name, c.contact_person, c.phone, c.email, c.notes, c.active,
      (SELECT COUNT(*) FROM contracts k WHERE k.contractor_id=c.id AND k.deleted_at IS NULL) contracts FROM contractors c WHERE c.farm_id=? AND c.deleted_at IS NULL ORDER BY c.name`, [ctx.farmId])
}
export function saveContractor(ctx: Ctx, i: ContractorInput, id?: string): string {
  require(ctx, 'contracts.contract.edit'); const name = i.name?.trim(); need(name, 'Contractor name is required')
  need(!i.email || /^\S+@\S+\.\S+$/.test(i.email), 'Enter a valid email address')
  need(!ctx.db.get(`SELECT 1 FROM contractors WHERE farm_id=? AND lower(name)=lower(?) AND deleted_at IS NULL ${id ? 'AND id<>?' : ''}`, id ? [ctx.farmId, name, id] : [ctx.farmId, name]), `${name} is already registered`)
  const d = { name, contact_person: i.contact_person ?? null, phone: i.phone ?? null, email: i.email ?? null, notes: i.notes ?? null, active: i.active === false ? 0 : 1 }
  return ctx.db.tx(() => {
    if (id) { ctx.db.update('contractors', id, d); ctx.db.audit(ctx.actor?.id ?? null, 'contractor.update', 'contractors', id); return id }
    const nid = ctx.db.insert('contractors', { tenant_id: ctx.tenantId, farm_id: ctx.farmId, ...d }); ctx.db.audit(ctx.actor?.id ?? null, 'contractor.create', 'contractors', nid); return nid
  })
}
export function deleteContractor(ctx: Ctx, id: string) {
  require(ctx, 'contracts.contract.edit'); need(!ctx.db.get(`SELECT 1 FROM contracts WHERE contractor_id=? AND deleted_at IS NULL`, [id]), 'This contractor has contracts; deactivate it instead')
  ctx.db.tx(() => ctx.db.softDelete('contractors', id))
}

// ---------------------------------------------------------------- contracts
export type ContractStatus = 'draft' | 'active' | 'settled' | 'cancelled'
export interface ContractInput {
  season_id: string; contractor_id: string; contract_no?: string; variety?: string; area_ha?: number; target_kg?: number; signed_on?: string; delivery_deadline?: string
  extension_services?: string; production_obligations?: string; delivery_requirements?: string; notes?: string; field_ids?: string[]
}
interface ContractRow { id: string; code: string; status: ContractStatus; season_id: string; farm_id: string }
function contractOf(ctx: Ctx, id: string): ContractRow {
  const c = ctx.db.get<ContractRow>(`SELECT id, code, status, season_id, farm_id FROM contracts WHERE id=? AND farm_id=? AND deleted_at IS NULL`, [id, ctx.farmId]); need(c, 'Contract not found'); return c
}
const editable = (c: ContractRow) => need(c.status === 'draft' || c.status === 'active', `Contract ${c.code} is ${c.status} and can no longer be changed`)

function validate(ctx: Ctx, i: ContractInput) {
  need(i.area_ha == null || i.area_ha > 0, 'Contracted area must be above zero'); need(i.target_kg == null || i.target_kg > 0, 'Target production must be above zero')
  need(!i.signed_on || isDate(i.signed_on), 'Invalid signing date'); need(!i.delivery_deadline || isDate(i.delivery_deadline), 'Invalid delivery deadline')
  need(!i.signed_on || !i.delivery_deadline || i.delivery_deadline >= i.signed_on, 'Delivery deadline cannot precede signing')
  need(ctx.db.get(`SELECT 1 FROM contractors WHERE id=? AND farm_id=? AND deleted_at IS NULL AND active=1`, [i.contractor_id, ctx.farmId]), 'Choose an active contractor')
  for (const f of i.field_ids ?? []) need(ctx.db.get(`SELECT 1 FROM fields WHERE id=? AND farm_id=? AND deleted_at IS NULL`, [f, ctx.farmId]), 'Unknown field')
}
function writeFields(ctx: Ctx, contractId: string, fieldIds: string[]) {
  const want = new Set(fieldIds)
  for (const r of ctx.db.all<{ id: string; field_id: string }>(`SELECT id, field_id FROM contract_fields WHERE contract_id=? AND deleted_at IS NULL`, [contractId])) { if (!want.delete(r.field_id)) ctx.db.softDelete('contract_fields', r.id) }
  for (const f of want) ctx.db.insert('contract_fields', { tenant_id: ctx.tenantId, contract_id: contractId, field_id: f })
}

export function createContract(ctx: Ctx, i: ContractInput): { id: string; code: string } {
  require(ctx, 'contracts.contract.edit'); validate(ctx, i); assertSeasonOpen(ctx, i.season_id)
  const no = i.contract_no?.trim() || null
  if (no) need(!ctx.db.get(`SELECT 1 FROM contracts WHERE farm_id=? AND contractor_id=? AND contract_no=? AND deleted_at IS NULL`, [ctx.farmId, i.contractor_id, no]), `Contract number ${no} already exists for this contractor`)
  return ctx.db.tx(() => {
    const code = nextCode(ctx, 'contracts', 'CT')
    const id = ctx.db.insert('contracts', { tenant_id: ctx.tenantId, farm_id: ctx.farmId, season_id: i.season_id, code, contract_no: no, contractor_id: i.contractor_id, status: 'draft', crop: 'tobacco',
      variety: i.variety ?? null, area_ha: i.area_ha ?? null, target_kg: i.target_kg ?? null, signed_on: i.signed_on ?? null, delivery_deadline: i.delivery_deadline ?? null,
      extension_services: i.extension_services ?? null, production_obligations: i.production_obligations ?? null, delivery_requirements: i.delivery_requirements ?? null, notes: i.notes ?? null })
    writeFields(ctx, id, i.field_ids ?? []); ctx.db.audit(ctx.actor?.id ?? null, 'contract.create', 'contracts', id, { code }); return { id, code }
  })
}
export function updateContract(ctx: Ctx, id: string, i: ContractInput) {
  require(ctx, 'contracts.contract.edit'); const c = contractOf(ctx, id); editable(c); validate(ctx, i); need(i.season_id === c.season_id, 'The season of a contract cannot be changed')
  ctx.db.tx(() => {
    ctx.db.update('contracts', id, { contract_no: i.contract_no?.trim() || null, contractor_id: i.contractor_id, variety: i.variety ?? null, area_ha: i.area_ha ?? null, target_kg: i.target_kg ?? null,
      signed_on: i.signed_on ?? null, delivery_deadline: i.delivery_deadline ?? null, extension_services: i.extension_services ?? null, production_obligations: i.production_obligations ?? null,
      delivery_requirements: i.delivery_requirements ?? null, notes: i.notes ?? null })
    if (i.field_ids) writeFields(ctx, id, i.field_ids); ctx.db.audit(ctx.actor?.id ?? null, 'contract.update', 'contracts', id)
  })
}
export function activateContract(ctx: Ctx, id: string) {
  require(ctx, 'contracts.contract.edit'); const c = contractOf(ctx, id); need(c.status === 'draft', `Contract ${c.code} is ${c.status}`); assertSeasonOpen(ctx, c.season_id)
  const k = ctx.db.get<{ signed_on: string | null; target_kg: number | null }>(`SELECT signed_on, target_kg FROM contracts WHERE id=?`, [id])!
  need(k.signed_on, 'Enter the signing date before activating'); need(k.target_kg, 'Enter the target production before activating')
  ctx.db.tx(() => { ctx.db.update('contracts', id, { status: 'active' }); ctx.db.audit(ctx.actor?.id ?? null, 'contract.activate', 'contracts', id) })
}
export function cancelContract(ctx: Ctx, id: string) {
  require(ctx, 'contracts.contract.edit'); const c = contractOf(ctx, id); editable(c)
  need(!ctx.db.get(`SELECT 1 FROM sales WHERE contract_id=? AND deleted_at IS NULL`, [id]), 'Deliveries are recorded against this contract; reverse them first')
  need(!ctx.db.get(`SELECT 1 FROM contract_advances WHERE contract_id=? AND deleted_at IS NULL`, [id]), 'Remove the recorded advances first')
  ctx.db.tx(() => { ctx.db.update('contracts', id, { status: 'cancelled' }); ctx.db.audit(ctx.actor?.id ?? null, 'contract.cancel', 'contracts', id) })
}

// ---------------------------------------------------------------- advances (inputs supplied, cash, services)
export interface AdvanceInput { contract_id: string; kind: 'input' | 'cash' | 'service'; description?: string; input_id?: string; qty?: number; value: number; advanced_on: string; notes?: string }

/** Inputs supplied by the contractor are received into stock at their advance value, so later usage flows into field costs at the true price. */
export function addAdvance(ctx: Ctx, i: AdvanceInput): string {
  require(ctx, 'contracts.contract.edit'); const c = contractOf(ctx, i.contract_id); editable(c)
  need(['input', 'cash', 'service'].includes(i.kind), 'Choose the advance type'); need(isDate(i.advanced_on), 'Valid date required'); nonNeg(i.value, 'Advance value'); need(i.value > 0, 'Advance value must be above zero')
  let desc = i.description?.trim() ?? ''
  if (i.kind === 'input') {
    const inp = ctx.db.get<{ name: string; unit: string }>(`SELECT name, unit FROM inputs WHERE id=? AND tenant_id=? AND deleted_at IS NULL`, [i.input_id ?? '', ctx.tenantId]); need(inp, 'Choose the input supplied')
    need(i.qty && i.qty > 0, 'Enter the quantity supplied'); desc = desc || `${inp.name} (${i.qty} ${inp.unit})`
  } else need(desc, 'Describe the advance')
  return ctx.db.tx(() => {
    let txn: string | null = null
    if (i.kind === 'input') txn = ctx.db.insert('inventory_transactions', { tenant_id: ctx.tenantId, farm_id: ctx.farmId, input_id: i.input_id!, kind: 'purchase', qty_delta: i.qty!, unit_cost: round2(i.value / i.qty!),
      occurred_on: i.advanced_on, note: `Supplied under ${c.code}`, created_by: ctx.actor?.id ?? null })
    const id = ctx.db.insert('contract_advances', { tenant_id: ctx.tenantId, contract_id: c.id, kind: i.kind, description: desc, input_id: i.kind === 'input' ? i.input_id! : null, qty: i.kind === 'input' ? i.qty! : null,
      value: round2(i.value), advanced_on: i.advanced_on, inventory_txn_id: txn, notes: i.notes ?? null })
    ctx.db.audit(ctx.actor?.id ?? null, 'contract.advance', 'contracts', c.id, { kind: i.kind, value: i.value }); return id
  })
}
export function deleteAdvance(ctx: Ctx, id: string) {
  require(ctx, 'contracts.contract.edit')
  const a = ctx.db.get<{ contract_id: string; input_id: string | null; qty: number | null; inventory_txn_id: string | null }>(`SELECT contract_id, input_id, qty, inventory_txn_id FROM contract_advances WHERE id=? AND deleted_at IS NULL`, [id]); need(a, 'Advance not found')
  editable(contractOf(ctx, a.contract_id))
  if (a.inventory_txn_id && a.input_id) {
    const onHand = ctx.db.get<{ n: number }>(`SELECT COALESCE(SUM(qty_delta),0) n FROM inventory_transactions WHERE input_id=? AND farm_id=? AND deleted_at IS NULL`, [a.input_id, ctx.farmId])!.n
    need(onHand >= (a.qty ?? 0) - 0.0001, 'Some of this input has already been used; it cannot be removed from stock')
  }
  ctx.db.tx(() => { if (a.inventory_txn_id) ctx.db.softDelete('inventory_transactions', a.inventory_txn_id); ctx.db.softDelete('contract_advances', id) })
}

// ---------------------------------------------------------------- obligations
export function addObligation(ctx: Ctx, i: { contract_id: string; kind: 'production' | 'delivery' | 'extension' | 'other'; description: string; due_on?: string }): string {
  require(ctx, 'contracts.contract.edit'); editable(contractOf(ctx, i.contract_id)); need(i.description?.trim(), 'Describe the obligation'); need(!i.due_on || isDate(i.due_on), 'Invalid due date')
  return ctx.db.tx(() => ctx.db.insert('contract_obligations', { tenant_id: ctx.tenantId, contract_id: i.contract_id, kind: i.kind, description: i.description.trim(), due_on: i.due_on ?? null, done: 0 }))
}
export function setObligationDone(ctx: Ctx, id: string, done: boolean, on: string) {
  require(ctx, 'contracts.contract.edit'); const o = ctx.db.get<{ contract_id: string }>(`SELECT contract_id FROM contract_obligations WHERE id=? AND deleted_at IS NULL`, [id]); need(o, 'Obligation not found'); editable(contractOf(ctx, o.contract_id))
  ctx.db.tx(() => ctx.db.update('contract_obligations', id, { done: done ? 1 : 0, done_on: done ? on : null }))
}
export function deleteObligation(ctx: Ctx, id: string) {
  require(ctx, 'contracts.contract.edit'); const o = ctx.db.get<{ contract_id: string }>(`SELECT contract_id FROM contract_obligations WHERE id=? AND deleted_at IS NULL`, [id]); need(o, 'Obligation not found'); editable(contractOf(ctx, o.contract_id))
  ctx.db.tx(() => ctx.db.softDelete('contract_obligations', id))
}

// ---------------------------------------------------------------- read models
export interface ContractSummary {
  id: string; code: string; contract_no: string | null; status: ContractStatus; season_id: string; season_label: string; contractor_id: string; contractor: string; variety: string | null
  area_ha: number | null; target_kg: number | null; delivery_deadline: string | null; delivered_kg: number; delivered_pct: number | null; delivered_net: number; advances_total: number; balance: number
}
const deliveredSql = `COALESCE((SELECT SUM(l.weight_kg) FROM sale_lines l JOIN sales s ON s.id=l.sale_id WHERE s.contract_id=k.id AND l.deleted_at IS NULL AND s.deleted_at IS NULL),0) kg,
  COALESCE((SELECT SUM(l.gross) FROM sale_lines l JOIN sales s ON s.id=l.sale_id WHERE s.contract_id=k.id AND l.deleted_at IS NULL AND s.deleted_at IS NULL),0) gross,
  COALESCE((SELECT SUM(d.amount) FROM sale_deductions d JOIN sales s ON s.id=d.sale_id WHERE s.contract_id=k.id AND d.deleted_at IS NULL AND s.deleted_at IS NULL),0) ded,
  COALESCE((SELECT SUM(a.value) FROM contract_advances a WHERE a.contract_id=k.id AND a.deleted_at IS NULL),0) adv`

export function listContracts(ctx: Ctx, seasonId?: string): ContractSummary[] {
  require(ctx, 'contracts.contract.view')
  return ctx.db.all<Record<string, number | string | null>>(`SELECT k.id, k.code, k.contract_no, k.status, k.season_id, se.label season_label, k.contractor_id, c.name contractor, k.variety, k.area_ha, k.target_kg, k.delivery_deadline, ${deliveredSql}
    FROM contracts k JOIN contractors c ON c.id=k.contractor_id JOIN seasons se ON se.id=k.season_id WHERE k.farm_id=? AND k.deleted_at IS NULL ${seasonId ? 'AND k.season_id=?' : ''} ORDER BY k.code DESC`,
    seasonId ? [ctx.farmId, seasonId] : [ctx.farmId]).map(r => {
    const { kg, gross, ded, adv, ...rest } = r as Record<string, number>
    const net = round2(gross - ded)
    return { ...(rest as unknown as ContractSummary), delivered_kg: round2(kg), delivered_pct: r.target_kg ? round2((kg / (r.target_kg as number)) * 100) : null, delivered_net: net, advances_total: round2(adv), balance: round2(net - adv) }
  })
}

export function contractStatement(ctx: Ctx, id: string, asOf = new Date().toISOString().slice(0, 10)) {
  require(ctx, 'contracts.contract.view'); contractOf(ctx, id)
  const summary = listContracts(ctx).find(c => c.id === id)!
  const detail = ctx.db.get<{ signed_on: string | null; extension_services: string | null; production_obligations: string | null; delivery_requirements: string | null; notes: string | null }>(`SELECT signed_on, extension_services, production_obligations, delivery_requirements, notes FROM contracts WHERE id=?`, [id])!
  const fields = ctx.db.all<{ field_id: string; field_no: string; area_ha: number }>(`SELECT f.id field_id, f.field_no, f.area_ha FROM contract_fields cf JOIN fields f ON f.id=cf.field_id WHERE cf.contract_id=? AND cf.deleted_at IS NULL ORDER BY f.field_no`, [id])
  const advances = ctx.db.all<{ id: string; kind: string; description: string; qty: number | null; value: number; advanced_on: string }>(`SELECT id, kind, description, qty, value, advanced_on FROM contract_advances WHERE contract_id=? AND deleted_at IS NULL ORDER BY advanced_on, rowid`, [id])
  const obligations = ctx.db.all<{ id: string; kind: string; description: string; due_on: string | null; done: number; done_on: string | null }>(`SELECT id, kind, description, due_on, done, done_on FROM contract_obligations WHERE contract_id=? AND deleted_at IS NULL ORDER BY COALESCE(due_on,'9999'), rowid`, [id])
  const deliveries = ctx.db.all<{ code: string; sold_on: string; kg: number; gross: number }>(`SELECT s.code, s.sold_on, COALESCE(SUM(l.weight_kg),0) kg, COALESCE(SUM(l.gross),0) gross FROM sales s LEFT JOIN sale_lines l ON l.sale_id=s.id AND l.deleted_at IS NULL WHERE s.contract_id=? AND s.deleted_at IS NULL GROUP BY s.id ORDER BY s.sold_on`, [id])
  const settlement = ctx.db.get<{ id: string; settled_on: string; delivered_kg: number; delivered_gross: number; sale_deductions: number; advances_total: number; advances_recovered: number; other_deductions: number; net_payable: number; shortfall: number; notes: string | null }>(`SELECT id, settled_on, delivered_kg, delivered_gross, sale_deductions, advances_total, advances_recovered, other_deductions, net_payable, shortfall, notes FROM contract_settlements WHERE contract_id=? AND deleted_at IS NULL`, [id]) ?? null
  const byKind = (['input', 'cash', 'service'] as const).map(k => ({ kind: k, value: round2(advances.filter(a => a.kind === k).reduce((s, a) => s + a.value, 0)) }))
  return { summary, ...detail, fields, linked_ha: round2(fields.reduce((s, f) => s + f.area_ha, 0)), advances, advances_by_kind: byKind, obligations, deliveries, settlement,
    obligations_open: obligations.filter(o => !o.done).length, obligations_overdue: obligations.filter(o => !o.done && o.due_on && o.due_on < asOf).length,
    deadline_days: summary.delivery_deadline ? Math.floor((Date.parse(summary.delivery_deadline) - Date.parse(asOf)) / 864e5) : null,
    kg_per_contracted_ha: summary.area_ha ? round2(summary.delivered_kg / summary.area_ha) : null }
}

// ---------------------------------------------------------------- settlement
/** Closes the contract: records what was delivered, how much of the advances the contractor recovered, and what is payable to the farmer. */
export function settleContract(ctx: Ctx, id: string, i: { settled_on: string; advances_recovered: number; other_deductions?: number; notes?: string }) {
  require(ctx, 'contracts.contract.settle'); const c = contractOf(ctx, id); need(c.status === 'active', `Contract ${c.code} is ${c.status}; only active contracts can be settled`)
  need(isDate(i.settled_on), 'Valid settlement date required'); nonNeg(i.advances_recovered, 'Advances recovered'); nonNeg(i.other_deductions, 'Other deductions')
  const s = listContracts(ctx).find(x => x.id === id)!; const ded = ctx.db.get<{ d: number }>(`SELECT COALESCE(SUM(d.amount),0) d FROM sale_deductions d JOIN sales x ON x.id=d.sale_id WHERE x.contract_id=? AND d.deleted_at IS NULL AND x.deleted_at IS NULL`, [id])!.d
  const gross = round2(s.delivered_net + ded)
  need(i.advances_recovered <= s.advances_total + 0.005, `Recovered ${i.advances_recovered} exceeds the advances of ${s.advances_total}`)
  const net = round2(s.delivered_net - i.advances_recovered - (i.other_deductions ?? 0)); need(net >= -0.005, `Deductions exceed the delivered value by ${round2(-net)}`)
  ctx.db.tx(() => {
    ctx.db.insert('contract_settlements', { tenant_id: ctx.tenantId, contract_id: id, settled_on: i.settled_on, delivered_kg: s.delivered_kg, delivered_gross: gross, sale_deductions: round2(ded), advances_total: s.advances_total,
      advances_recovered: round2(i.advances_recovered), other_deductions: round2(i.other_deductions ?? 0), net_payable: Math.max(0, net), shortfall: round2(s.advances_total - i.advances_recovered), notes: i.notes ?? null })
    ctx.db.update('contracts', id, { status: 'settled' }); ctx.db.audit(ctx.actor?.id ?? null, 'contract.settle', 'contracts', id, { net, shortfall: s.advances_total - i.advances_recovered })
  })
}
export function reopenContract(ctx: Ctx, id: string) {
  require(ctx, 'contracts.contract.settle'); const c = contractOf(ctx, id); need(c.status === 'settled', 'Only settled contracts can be reopened'); assertSeasonOpen(ctx, c.season_id)
  const st = ctx.db.get<{ id: string }>(`SELECT id FROM contract_settlements WHERE contract_id=? AND deleted_at IS NULL`, [id])
  ctx.db.tx(() => { if (st) ctx.db.softDelete('contract_settlements', st.id); ctx.db.update('contracts', id, { status: 'active' }); ctx.db.audit(ctx.actor?.id ?? null, 'contract.reopen', 'contracts', id) })
}
