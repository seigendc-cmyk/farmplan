import { revenueSummary } from './marketing'
import { type Ctx, require, can, round2 } from './context'
import { stockValue } from './inventory'
import { activeSeason } from './seasons'

export interface SeasonCostSummary {
  season_id: string; total: number
  by_category: { category: string; amount: number; pct: number }[]
  by_field: { field_no: string; area_ha: number; cost: number; cost_per_ha: number }[]
  by_seedbed: { code: string; cost: number }[]
  field_area_costed_ha: number; field_cost: number; cost_per_ha: number | null
}

export function seasonCostSummary(ctx: Ctx, seasonId: string): SeasonCostSummary {
  require(ctx, 'finance.cost.view')
  const db = ctx.db
  const cats = db.all<{ category: string; amount: number }>(`SELECT category, SUM(amount) amount FROM cost_entries WHERE season_id=? AND farm_id=? AND deleted_at IS NULL GROUP BY category ORDER BY amount DESC`, [seasonId, ctx.farmId])
  const total = round2(cats.reduce((s, c) => s + c.amount, 0))
  const by_field = db.all<{ field_no: string; area_ha: number; cost: number }>(
    `SELECT f.field_no, f.area_ha, SUM(c.amount) cost FROM cost_entries c JOIN fields f ON f.id=c.field_id
     WHERE c.season_id=? AND c.farm_id=? AND c.deleted_at IS NULL GROUP BY f.id ORDER BY f.field_no`, [seasonId, ctx.farmId])
    .map(r => ({ ...r, cost: round2(r.cost), cost_per_ha: round2(r.cost / r.area_ha) }))
  const by_seedbed = db.all<{ code: string; cost: number }>(
    `SELECT s.code, SUM(c.amount) cost FROM cost_entries c JOIN seedbeds s ON s.id=c.seedbed_id
     WHERE c.season_id=? AND c.farm_id=? AND c.deleted_at IS NULL GROUP BY s.id ORDER BY s.code`, [seasonId, ctx.farmId]).map(r => ({ ...r, cost: round2(r.cost) }))
  const field_area = by_field.reduce((s, f) => s + f.area_ha, 0)
  const field_cost = round2(by_field.reduce((s, f) => s + f.cost, 0))
  return { season_id: seasonId, total,
    by_category: cats.map(c => ({ category: c.category, amount: round2(c.amount), pct: total ? round2((c.amount / total) * 100) : 0 })),
    by_field, by_seedbed, field_area_costed_ha: round2(field_area), field_cost, cost_per_ha: field_area ? round2(field_cost / field_area) : null }
}

export interface Dashboard {
  season: ReturnType<typeof activeSeason> | null
  fields: number; total_area_ha: number; seedbeds: number; operations_30d: number
  stock_value: number | null
  season_cost: number | null; pending_sync: number
  curing_active: number; storage_ready: number; green_kg_season: number | null
  ungraded_units: number; bales_unsold: number; net_revenue: number | null; contracts_active: number
}

export function dashboard(ctx: Ctx): Dashboard {
  const db = ctx.db; const season = activeSeason(ctx) ?? null
  const f = can(ctx, 'production.field.view') ? db.get<{ n: number; a: number }>(`SELECT COUNT(*) n, COALESCE(SUM(area_ha),0) a FROM fields WHERE farm_id=? AND deleted_at IS NULL`, [ctx.farmId])! : { n: 0, a: 0 }
  const sb = season && can(ctx, 'production.seedbed.view') ? db.get<{ n: number }>(`SELECT COUNT(*) n FROM seedbeds WHERE season_id=? AND deleted_at IS NULL`, [season.id])!.n : 0
  const ops = can(ctx, 'production.operation.view') ? db.get<{ n: number }>(`SELECT COUNT(*) n FROM operations WHERE farm_id=? AND deleted_at IS NULL AND occurred_on >= date('now','-30 day')`, [ctx.farmId])!.n : 0
  const stock_value = can(ctx, 'resources.inventory.view') && can(ctx, 'finance.cost.view') ? stockValue(ctx) : null
  const season_cost = season && can(ctx, 'finance.cost.view') ? round2(db.get<{ t: number }>(`SELECT COALESCE(SUM(amount),0) t FROM cost_entries WHERE season_id=? AND deleted_at IS NULL`, [season.id])!.t) : null
  const curing_active = can(ctx, 'curing.cycle.view') ? db.get<{ n: number }>(`SELECT COUNT(*) n FROM curing_cycles WHERE farm_id=? AND status='curing' AND deleted_at IS NULL`, [ctx.farmId])!.n : 0
  const storage_ready = can(ctx, 'curing.storage.view') ? db.get<{ n: number }>(`SELECT COUNT(*) n FROM storage_units WHERE farm_id=? AND status='maturing' AND expected_open_on <= date('now') AND deleted_at IS NULL`, [ctx.farmId])!.n : 0
  const green_kg_season = season && can(ctx, 'production.harvest.view') ? round2(db.get<{ w: number }>(`SELECT COALESCE(SUM(green_weight_kg),0) w FROM harvest_batches WHERE season_id=? AND deleted_at IS NULL`, [season.id])!.w) : null
  const ungraded_units = can(ctx, 'quality.grading.view') ? db.get<{ n: number }>(`SELECT COUNT(*) n FROM storage_units u WHERE u.farm_id=? AND u.status='opened' AND u.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM grading_lots l WHERE l.storage_unit_id=u.id AND l.deleted_at IS NULL)`, [ctx.farmId])!.n : 0
  const bales_unsold = can(ctx, 'quality.bale.view') ? db.get<{ n: number }>(`SELECT COUNT(*) n FROM bales WHERE farm_id=? AND status='baled' AND deleted_at IS NULL`, [ctx.farmId])!.n : 0
  const net_revenue = season && can(ctx, 'marketing.sale.view') ? revenueSummary(ctx, season.id).net : null
  const contracts_active = can(ctx, 'contracts.contract.view') ? db.get<{ n: number }>(`SELECT COUNT(*) n FROM contracts WHERE farm_id=? AND status='active' AND deleted_at IS NULL`, [ctx.farmId])!.n : 0
  return { contracts_active, ungraded_units, bales_unsold, net_revenue, season, fields: f.n, total_area_ha: round2(f.a), seedbeds: sb, operations_30d: ops, stock_value, season_cost, pending_sync: db.pendingSync(), curing_active, storage_ready, green_kg_season }
}
