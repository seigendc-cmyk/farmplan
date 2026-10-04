import { type Ctx, require, can, need, round2 } from './context'
import { listSeasons } from './seasons'
import { revenueSummary } from './marketing'
import { nonNeg } from './util'
import { allocatedCosts, type AllocationLine } from './allocation'

export const COST_CATEGORIES = ['seed', 'fertilizer', 'chemicals', 'labour', 'machinery', 'fuel', 'irrigation', 'transport', 'curing', 'storage', 'grading', 'baling', 'marketing', 'overhead'] as const
export type CostCategory = (typeof COST_CATEGORIES)[number]
const pct = (a: number, b: number) => (b ? round2((a / b) * 100) : null)
const per = (a: number, b: number) => (b ? round2(a / b) : null)

// ------------------------------------------------------------------ budgets
export function listBudgets(ctx: Ctx, seasonId: string) {
  require(ctx, 'finance.budget.view')
  return ctx.db.all<{ id: string; category: CostCategory; amount: number; notes: string | null }>(`SELECT id, category, amount, notes FROM budgets WHERE farm_id=? AND season_id=? AND deleted_at IS NULL ORDER BY category`, [ctx.farmId, seasonId])
}

/** Sets (or replaces) the planned amount for one category. A blank amount removes the line. */
export function setBudget(ctx: Ctx, seasonId: string, category: CostCategory, amount: number | null, notes?: string | null) {
  require(ctx, 'finance.budget.edit')
  need(COST_CATEGORIES.includes(category), 'Unknown cost category'); nonNeg(amount, 'Budget')
  need(ctx.db.get(`SELECT 1 FROM seasons WHERE id=? AND farm_id=? AND deleted_at IS NULL`, [seasonId, ctx.farmId]), 'Season not found')
  ctx.db.tx(() => {
    const cur = ctx.db.get<{ id: string }>(`SELECT id FROM budgets WHERE season_id=? AND category=? AND deleted_at IS NULL`, [seasonId, category])
    if (amount == null) { if (cur) ctx.db.softDelete('budgets', cur.id); return }
    if (cur) ctx.db.update('budgets', cur.id, { amount: round2(amount), notes: notes ?? null })
    else ctx.db.insert('budgets', { tenant_id: ctx.tenantId, farm_id: ctx.farmId, season_id: seasonId, category, amount: round2(amount), notes: notes ?? null })
    ctx.db.audit(ctx.actor?.id ?? null, 'budget.set', 'budgets', cur?.id, { seasonId, category, amount })
  })
}

/** Copies another season's budget lines, optionally scaled (e.g. 1.1 for +10% inflation). Existing lines in the target are kept. */
export function copyBudget(ctx: Ctx, fromSeason: string, toSeason: string, factor = 1): number {
  require(ctx, 'finance.budget.edit'); need(fromSeason !== toSeason, 'Choose a different season to copy from'); need(factor > 0, 'Factor must be positive')
  const have = new Set(listBudgets(ctx, toSeason).map(b => b.category)); let n = 0
  for (const b of listBudgets(ctx, fromSeason)) if (!have.has(b.category)) { setBudget(ctx, toSeason, b.category, round2(b.amount * factor), b.notes); n++ }
  return n
}

export interface PlanLine { category: CostCategory; budget: number | null; actual: number; variance: number | null; pct_used: number | null; status: 'under' | 'near' | 'over' | 'unplanned' }
export interface PlanVsActual { lines: PlanLine[]; budget_total: number; actual_total: number; variance: number; pct_used: number | null; unplanned_actual: number }
/** Planned vs actual per cost category. 'near' means ≥90% of the line is used; spend with no budget line is 'unplanned'. */
export function planVsActual(ctx: Ctx, seasonId: string): PlanVsActual {
  require(ctx, 'finance.budget.view'); require(ctx, 'finance.cost.view')
  const actual = new Map(ctx.db.all<{ category: string; a: number }>(`SELECT category, SUM(amount) a FROM cost_entries WHERE farm_id=? AND season_id=? AND deleted_at IS NULL GROUP BY category`, [ctx.farmId, seasonId]).map(r => [r.category, r.a]))
  const budget = new Map(listBudgets(ctx, seasonId).map(b => [b.category, b.amount]))
  const lines: PlanLine[] = COST_CATEGORIES.filter(c => budget.has(c) || actual.has(c)).map(category => {
    const b = budget.has(category) ? budget.get(category)! : null; const a = round2(actual.get(category) ?? 0)
    const status: PlanLine['status'] = b == null ? 'unplanned' : a > b ? 'over' : b > 0 && a >= 0.9 * b ? 'near' : 'under'
    return { category, budget: b, actual: a, variance: b == null ? null : round2(b - a), pct_used: b == null ? null : pct(a, b), status }
  })
  const budget_total = round2([...budget.values()].reduce((s, v) => s + v, 0)); const actual_total = round2([...actual.values()].reduce((s, v) => s + v, 0))
  return { lines, budget_total, actual_total, variance: round2(budget_total - actual_total), pct_used: pct(actual_total, budget_total), unplanned_actual: round2(lines.filter(l => l.budget == null).reduce((s, l) => s + l.actual, 0)) }
}

// ------------------------------------------------------------------ profitability
export interface FieldProfit { field_no: string; area_ha: number; green_kg: number; green_kg_per_ha: number | null; field_cost: number; cost_per_ha: number | null; sold_kg: number; net_revenue: number | null; field_margin: number | null
  allocated_cost: number; full_cost: number; full_cost_per_ha: number | null; full_margin: number | null }
export interface ContractProfit { contract: string; sold_kg: number; gross: number; net: number }
export interface Profitability {
  season_id: string; harvested_ha: number; green_kg: number; sold_kg: number; total_cost: number; field_cost: number; shared_cost: number
  net_revenue: number | null; margin: number | null; margin_pct: number | null
  cost_per_ha: number | null; cost_per_kg_sold: number | null; net_per_kg: number | null; margin_per_ha: number | null
  allocated_cost: number; unallocated_cost: number; allocation: AllocationLine[]
  by_field: FieldProfit[]; by_contract: ContractProfit[]
}

export function profitability(ctx: Ctx, seasonId: string): Profitability {
  require(ctx, 'finance.cost.view')
  const db = ctx.db; const revenue = can(ctx, 'marketing.sale.view') ? revenueSummary(ctx, seasonId) : null
  const total_cost = round2(db.get<{ s: number }>(`SELECT COALESCE(SUM(amount),0) s FROM cost_entries WHERE farm_id=? AND season_id=? AND deleted_at IS NULL`, [ctx.farmId, seasonId])!.s)
  const costs = new Map(db.all<{ f: string; c: number }>(`SELECT field_id f, SUM(amount) c FROM cost_entries WHERE farm_id=? AND season_id=? AND field_id IS NOT NULL AND deleted_at IS NULL GROUP BY field_id`, [ctx.farmId, seasonId]).map(r => [r.f, r.c]))
  const green = new Map(db.all<{ f: string; kg: number }>(`SELECT field_id f, SUM(green_weight_kg) kg FROM harvest_batches WHERE farm_id=? AND season_id=? AND deleted_at IS NULL GROUP BY field_id`, [ctx.farmId, seasonId]).map(r => [r.f, r.kg]))
  const fields = db.all<{ id: string; field_no: string; area_ha: number }>(`SELECT id, field_no, area_ha FROM fields WHERE farm_id=? AND deleted_at IS NULL ORDER BY field_no`, [ctx.farmId]).filter(f => costs.has(f.id) || green.has(f.id))
  const alloc = allocatedCosts(ctx, seasonId)
  const revBy = new Map((revenue?.by_field ?? []).map(r => [r.key, r]))
  const by_field: FieldProfit[] = fields.map(f => {
    const a = alloc.by_field.get(f.id) ?? 0, c = round2(costs.get(f.id) ?? 0), g = round2(green.get(f.id) ?? 0), r = revBy.get(f.field_no)
    return { field_no: f.field_no, area_ha: f.area_ha, green_kg: g, green_kg_per_ha: per(g, green.has(f.id) ? f.area_ha : 0), field_cost: c, cost_per_ha: per(c, f.area_ha),
      sold_kg: r?.kg ?? 0, net_revenue: revenue ? r?.net ?? 0 : null, field_margin: revenue ? round2((r?.net ?? 0) - c) : null,
      allocated_cost: a, full_cost: round2(c + a), full_cost_per_ha: per(c + a, f.area_ha), full_margin: revenue ? round2((r?.net ?? 0) - c - a) : null }
  })
  const field_cost = round2([...costs.values()].reduce((s, v) => s + v, 0))
  const harvested_ha = round2(fields.filter(f => green.has(f.id)).reduce((s, f) => s + f.area_ha, 0))
  const green_kg = round2([...green.values()].reduce((s, v) => s + v, 0))
  const by_contract = !revenue ? [] : [...db.all<{ contract: string; kg: number; gross: number; share: number }>(
    `SELECT c.code contract, l.weight_kg kg, l.gross, CASE WHEN sg.g > 0 THEN COALESCE(sd.d,0) / sg.g ELSE 0 END share
     FROM sale_lines l JOIN sales s ON s.id=l.sale_id JOIN contracts c ON c.id=s.contract_id
     LEFT JOIN (SELECT sale_id, SUM(gross) g FROM sale_lines WHERE deleted_at IS NULL GROUP BY sale_id) sg ON sg.sale_id=s.id
     LEFT JOIN (SELECT sale_id, SUM(amount) d FROM sale_deductions WHERE deleted_at IS NULL GROUP BY sale_id) sd ON sd.sale_id=s.id
     WHERE s.season_id=? AND s.farm_id=? AND l.deleted_at IS NULL AND s.deleted_at IS NULL`, [seasonId, ctx.farmId])
    .reduce((m, r) => { const e = m.get(r.contract) ?? { contract: r.contract, sold_kg: 0, gross: 0, net: 0 }; e.sold_kg += r.kg; e.gross += r.gross; e.net += r.gross * (1 - r.share); m.set(r.contract, e); return m }, new Map<string, ContractProfit>())
    .values()].map(e => ({ contract: e.contract, sold_kg: round2(e.sold_kg), gross: round2(e.gross), net: round2(e.net) })).sort((a, b) => a.contract.localeCompare(b.contract))
  const net = revenue ? revenue.net : null; const margin = net == null ? null : round2(net - total_cost)
  return { season_id: seasonId, harvested_ha, green_kg, sold_kg: revenue?.kg ?? 0, total_cost, field_cost, shared_cost: round2(total_cost - field_cost), net_revenue: net, margin, margin_pct: net ? pct(margin!, net) : null,
    cost_per_ha: per(total_cost, harvested_ha), cost_per_kg_sold: per(total_cost, revenue?.kg ?? 0), net_per_kg: revenue ? revenue.net_per_kg : null, margin_per_ha: margin == null ? null : per(margin, harvested_ha),
    allocated_cost: alloc.allocated, unallocated_cost: alloc.unallocated, allocation: alloc.lines, by_field, by_contract }
}

// ------------------------------------------------------------------ season vs season
export interface SeasonRow { season_id: string; label: string; status: string; harvested_ha: number; green_kg: number; green_kg_per_ha: number | null; sold_kg: number; total_cost: number; cost_per_ha: number | null; cost_per_kg_sold: number | null; net_revenue: number | null; margin: number | null; avg_price_per_kg: number | null }
export function seasonComparison(ctx: Ctx): SeasonRow[] {
  require(ctx, 'finance.cost.view')
  return listSeasons(ctx).map(s => {
    const p = profitability(ctx, s.id); const rev = can(ctx, 'marketing.sale.view') ? revenueSummary(ctx, s.id) : null
    return { season_id: s.id, label: s.label, status: s.status, harvested_ha: p.harvested_ha, green_kg: p.green_kg, green_kg_per_ha: per(p.green_kg, p.harvested_ha), sold_kg: p.sold_kg, total_cost: p.total_cost,
      cost_per_ha: p.cost_per_ha, cost_per_kg_sold: p.cost_per_kg_sold, net_revenue: p.net_revenue, margin: p.margin, avg_price_per_kg: rev?.avg_price_per_kg ?? null }
  }).sort((a, b) => a.label.localeCompare(b.label))
}

// ------------------------------------------------------------------ rainfall vs yield
export interface RainYield {
  by_month: { month: string; mm: number; rain_days: number }[]
  by_field: { field_no: string; rain_mm: number; green_kg_per_ha: number | null }[]
  by_season: { label: string; rain_mm: number; green_kg_per_ha: number | null }[]
}
/** Rain recorded against a season (its id, or undated-to-season records inside its dates). Field rain = field-specific records plus farm-wide ones. */
export function rainfallVsYield(ctx: Ctx, seasonId: string): RainYield {
  require(ctx, 'production.weather.view'); require(ctx, 'production.harvest.view')
  const db = ctx.db; const s = db.get<{ starts_on: string; ends_on: string }>(`SELECT starts_on, ends_on FROM seasons WHERE id=? AND farm_id=?`, [seasonId, ctx.farmId]); need(s, 'Season not found')
  const inSeason = `(w.season_id=? OR (w.season_id IS NULL AND w.recorded_on BETWEEN ? AND ?))`
  const by_month = db.all<{ month: string; mm: number; d: number }>(`SELECT substr(w.recorded_on,1,7) month, SUM(w.rainfall_mm) mm, SUM(CASE WHEN w.rainfall_mm > 0 THEN 1 ELSE 0 END) d FROM weather_records w
    WHERE w.farm_id=? AND w.deleted_at IS NULL AND w.rainfall_mm IS NOT NULL AND ${inSeason} GROUP BY month ORDER BY month`, [ctx.farmId, seasonId, s.starts_on, s.ends_on]).map(r => ({ month: r.month, mm: round2(r.mm), rain_days: r.d }))
  const farmWide = db.get<{ mm: number }>(`SELECT COALESCE(SUM(w.rainfall_mm),0) mm FROM weather_records w WHERE w.farm_id=? AND w.deleted_at IS NULL AND w.field_id IS NULL AND ${inSeason}`, [ctx.farmId, seasonId, s.starts_on, s.ends_on])!.mm
  const by_field = db.all<{ field_no: string; area_ha: number; kg: number; own: number }>(
    `SELECT f.field_no, f.area_ha, SUM(h.green_weight_kg) kg,
       COALESCE((SELECT SUM(w.rainfall_mm) FROM weather_records w WHERE w.field_id=f.id AND w.deleted_at IS NULL AND ${inSeason}),0) own
     FROM harvest_batches h JOIN fields f ON f.id=h.field_id WHERE h.farm_id=? AND h.season_id=? AND h.deleted_at IS NULL GROUP BY f.id ORDER BY f.field_no`, [seasonId, s.starts_on, s.ends_on, ctx.farmId, seasonId])
    .map(r => ({ field_no: r.field_no, rain_mm: round2(r.own + farmWide), green_kg_per_ha: per(r.kg, r.area_ha) }))
  const by_season = listSeasons(ctx).sort((a, b) => a.label.localeCompare(b.label)).map(se => {
    const rain = db.get<{ mm: number }>(`SELECT COALESCE(SUM(w.rainfall_mm),0) mm FROM weather_records w WHERE w.farm_id=? AND w.deleted_at IS NULL AND ${inSeason}`, [ctx.farmId, se.id, se.starts_on, se.ends_on])!.mm
    const h = db.get<{ kg: number; ha: number }>(`SELECT COALESCE(SUM(h.green_weight_kg),0) kg, COALESCE((SELECT SUM(f.area_ha) FROM fields f WHERE f.id IN (SELECT field_id FROM harvest_batches WHERE season_id=? AND deleted_at IS NULL)),0) ha FROM harvest_batches h WHERE h.farm_id=? AND h.season_id=? AND h.deleted_at IS NULL`, [se.id, ctx.farmId, se.id])!
    return { label: se.label, rain_mm: round2(rain), green_kg_per_ha: per(h.kg, h.ha) }
  })
  return { by_month, by_field, by_season }
}
