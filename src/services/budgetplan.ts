import { type Ctx, require, need, round2 } from './context'
import { COST_CATEGORIES, listBudgets, planVsActual } from './analytics'
import { getProject } from './projects'
import { snapshotBudget } from '../db/budgetlink'

// ---- the plan: what the project expects to grow, yield and earn ----
export interface PlanInput { plan_ha: number | null; plan_yield_kg_ha: number | null; plan_price_kg: number | null }
export interface PlanSummary extends PlanInput {
  expected_kg: number | null; revenue: number | null; budget_total: number; margin: number | null; cost_per_ha: number | null
  /** Price per kg at which expected revenue equals the live budget. Needs hectares and yield. */
  break_even_kg_price: number | null
}
const pos = (n: number | null | undefined, what: string, allowZero = false) => { if (n == null) return; need(Number.isFinite(n) && (allowZero ? n >= 0 : n > 0), `${what} must be ${allowZero ? 'zero or more' : 'more than zero'}`) }

export function setPlan(ctx: Ctx, projectId: string, i: PlanInput) {
  require(ctx, 'projects.project.edit'); getProject(ctx, projectId)
  pos(i.plan_ha, 'Planned hectares'); pos(i.plan_yield_kg_ha, 'Expected yield'); pos(i.plan_price_kg, 'Expected price', true)
  ctx.db.tx(() => ctx.db.update('projects', projectId, { plan_ha: i.plan_ha ?? null, plan_yield_kg_ha: i.plan_yield_kg_ha ?? null, plan_price_kg: i.plan_price_kg ?? null }))
}

/** Expected output, revenue, margin and break-even from the plan and the season's live budget. Revenue and margin need a price; break-even needs only hectares and yield. */
export function planSummary(ctx: Ctx, projectId: string): PlanSummary {
  require(ctx, 'projects.project.view'); require(ctx, 'finance.budget.view')
  const p = getProject(ctx, projectId); const budget = round2(listBudgets(ctx, p.season_id).reduce((s, b) => s + b.amount, 0))
  const kg = p.plan_ha && p.plan_yield_kg_ha ? round2(p.plan_ha * p.plan_yield_kg_ha) : null
  const revenue = kg != null && p.plan_price_kg != null ? round2(kg * p.plan_price_kg) : null
  return { plan_ha: p.plan_ha, plan_yield_kg_ha: p.plan_yield_kg_ha, plan_price_kg: p.plan_price_kg, expected_kg: kg, revenue, budget_total: budget,
    margin: revenue != null ? round2(revenue - budget) : null, cost_per_ha: p.plan_ha ? round2(budget / p.plan_ha) : null, break_even_kg_price: kg ? round2(budget / kg) : null }
}

// ---- budget months and cash need ----
export function setBudgetMonth(ctx: Ctx, seasonId: string, category: string, month: string | null) {
  require(ctx, 'finance.budget.edit')
  need(month == null || /^\d{4}-(0[1-9]|1[0-2])$/.test(month), 'Month must look like 2026-11')
  const line = ctx.db.get<{ id: string }>(`SELECT id FROM budgets WHERE farm_id=? AND season_id=? AND category=? AND deleted_at IS NULL`, [ctx.farmId, seasonId, category]); need(line, 'Set the budget line first')
  ctx.db.tx(() => ctx.db.update('budgets', line.id, { expected_month: month }))
}
export interface CashMonth { month: string | null; amount: number; cumulative: number }
/** Monthly cash need from the live budget. Lines with no month are listed last, so nothing is hidden. */
export function cashFlow(ctx: Ctx, seasonId: string): CashMonth[] {
  require(ctx, 'finance.budget.view')
  const by = new Map<string | null, number>()
  for (const r of ctx.db.all<{ expected_month: string | null; amount: number }>(`SELECT expected_month, amount FROM budgets WHERE farm_id=? AND season_id=? AND deleted_at IS NULL`, [ctx.farmId, seasonId])) by.set(r.expected_month, (by.get(r.expected_month) ?? 0) + r.amount)
  const keys = [...by.keys()].sort((a, b) => a === null ? 1 : b === null ? -1 : a < b ? -1 : 1); let run = 0
  return keys.map(k => ({ month: k, amount: round2(by.get(k)!), cumulative: round2(run += by.get(k)!) }))
}

// ---- versions: the approved baseline and later revisions ----
export interface BudgetVersion { id: string; version_no: number; kind: 'baseline' | 'revision'; reason: string | null; approved_on: string; approved_by: string | null; total: number; lines: { category: string; amount: number; expected_month: string | null }[] }
export function listVersions(ctx: Ctx, seasonId: string): BudgetVersion[] {
  require(ctx, 'finance.budget.view')
  return ctx.db.all<Omit<BudgetVersion, 'total' | 'lines'>>(`SELECT id,version_no,kind,reason,approved_on,approved_by FROM budget_versions WHERE farm_id=? AND season_id=? AND deleted_at IS NULL ORDER BY version_no`, [ctx.farmId, seasonId]).map(v => {
    const lines = ctx.db.all<BudgetVersion['lines'][number]>(`SELECT category,amount,expected_month FROM budget_version_lines WHERE version_id=? AND deleted_at IS NULL ORDER BY category`, [v.id])
    return { ...v, lines, total: round2(lines.reduce((s, l) => s + l.amount, 0)) }
  })
}
/** Whether the live budget differs from the latest version (amounts, lines or months). */
export function budgetChanged(ctx: Ctx, seasonId: string): boolean {
  const last = listVersions(ctx, seasonId).at(-1); if (!last) return false
  const key = (l: { category: string; amount: number; expected_month: string | null }) => `${l.category}|${round2(l.amount)}|${l.expected_month ?? ''}`
  const live = listBudgets(ctx, seasonId); const a = live.map(b => key({ category: b.category, amount: b.amount, expected_month: (ctx.db.get<{ m: string | null }>(`SELECT expected_month m FROM budgets WHERE id=?`, [b.id])?.m) ?? null })).sort()
  const b = last.lines.map(key).sort(); return a.length !== b.length || a.some((x, i) => x !== b[i])
}
/** Locks the season's budget as version 1. Only once, and only with at least one line. */
export function approveBaseline(ctx: Ctx, seasonId: string) {
  require(ctx, 'finance.budget.approve'); need(listVersions(ctx, seasonId).length === 0, 'This budget already has an approved baseline')
  need(listBudgets(ctx, seasonId).length > 0, 'Set at least one budget line before approving')
  ctx.db.tx(() => { snapshotBudget(ctx.db, seasonId, { kind: 'baseline', reason: null, by: ctx.actor?.name ?? null }); ctx.db.audit(ctx.actor?.id ?? null, 'budget.approve', 'budget_versions', undefined, { seasonId }) })
}
/** Records the live budget as the next version, with the reason for the change. The baseline is never altered. */
export function recordRevision(ctx: Ctx, seasonId: string, reason: string) {
  require(ctx, 'finance.budget.edit'); const last = listVersions(ctx, seasonId).at(-1); need(last, 'Approve a baseline first')
  need(reason.trim(), 'Say why the budget changed'); need(budgetChanged(ctx, seasonId), `The budget has not changed since version ${last.version_no}`)
  ctx.db.tx(() => { snapshotBudget(ctx.db, seasonId, { kind: 'revision', reason: reason.trim(), by: ctx.actor?.name ?? null }); ctx.db.audit(ctx.actor?.id ?? null, 'budget.revise', 'budget_versions', undefined, { seasonId }) })
}

// ---- budget against baseline, latest version and actual ----
export interface BaselineLine { category: string; baseline: number | null; latest: number | null; actual: number; vs_baseline: number | null }
export interface BaselineReport { has_baseline: boolean; latest_version: number | null; baseline_total: number; latest_total: number; actual_total: number; unsaved_changes: boolean; lines: BaselineLine[] }
export function baselineReport(ctx: Ctx, seasonId: string): BaselineReport {
  require(ctx, 'finance.budget.view'); require(ctx, 'finance.cost.view')
  const vs = listVersions(ctx, seasonId); const base = vs[0]; const last = vs.at(-1); const actual = new Map(planVsActual(ctx, seasonId).lines.map(l => [l.category, l.actual]))
  const amt = (v: BudgetVersion | undefined, c: string) => v?.lines.find(l => l.category === c)?.amount ?? null
  const lines = COST_CATEGORIES.filter(c => amt(base, c) != null || amt(last, c) != null || actual.has(c)).map(category => {
    const baseline = amt(base, category), latest = amt(last, category), a = round2(actual.get(category) ?? 0)
    return { category, baseline, latest, actual: a, vs_baseline: baseline == null ? null : round2(baseline - a) }
  })
  return { has_baseline: !!base, latest_version: last?.version_no ?? null, baseline_total: base?.total ?? 0, latest_total: last?.total ?? 0, actual_total: round2([...actual.values()].reduce((s, v) => s + v, 0)), unsaved_changes: budgetChanged(ctx, seasonId), lines }
}
