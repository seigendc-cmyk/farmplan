import { type Ctx, can, need, require, round2 } from './context'
import { listFields, type Field } from './fields'
import { listOperations } from './operations'
import { listTransplants } from './transplants'
import { listHarvests } from './harvest'
import { listLabour } from './labour'
import { listMachineLogs } from './machinery'
import { listBales } from './quality'
import { revenueSummary } from './marketing'
import { profitability } from './analytics'
import { canSeeAnyActivity, listActivity } from './activity'

const per = (v: number, ha: number) => (ha > 0 ? round2(v / ha) : null)

/**
 * Everything recorded against one field in one season, from every module, so the field is the place the chain can be read
 * end to end: planting → work → harvest → curing → bales → sale → money. Each section is null when the reader's role
 * does not include it, using the same permissions as the module's own page; revenue and margin need both `finance.cost.view` and `marketing.sale.view`.
 * The field's activity comes through `listActivity`, so `accessFilter` decides which events the reader sees.
 */
export function fieldRecord(ctx: Ctx, fieldNo: string, seasonId?: string) {
  require(ctx, 'production.field.view')
  const field: Field | undefined = listFields(ctx).find(f => f.field_no === fieldNo)
  need(field, `No field ${fieldNo}`)
  const db = ctx.db; const sid = seasonId || undefined; const mine = <T extends { field_no: string | null }>(rows: T[]) => rows.filter(r => r.field_no === field.field_no)
  const money = can(ctx, 'finance.cost.view'); const sales = can(ctx, 'marketing.sale.view')
  /** Revenue and margin are finance figures: they need cost access as well as sales access. Sold kg is not money and follows sales access alone. */
  const finance = money && sales

  const transplants = can(ctx, 'production.transplant.view') ? mine(listTransplants(ctx, { seasonId: sid })) : null
  const operations = can(ctx, 'production.operation.view') ? listOperations(ctx, { seasonId: sid, targetType: 'field', targetId: field.id, limit: 1000 }) : null
  const harvests = can(ctx, 'production.harvest.view') ? mine(listHarvests(ctx, { seasonId: sid })) : null
  const labour = can(ctx, 'resources.labour.view') ? mine(listLabour(ctx, { seasonId: sid, limit: 1000 })) : null
  const machine = can(ctx, 'resources.machinery.view') ? mine(listMachineLogs(ctx, { seasonId: sid, limit: 1000 })) : null
  const bales = can(ctx, 'quality.bale.view') ? mine(listBales(ctx, { seasonId: sid })) : null
  /** Rain recorded on this field, plus farm-wide records (no field) for the same season, which apply to every field. */
  const weather = !can(ctx, 'production.weather.view') ? null : db.all<{ id: string; recorded_on: string; farm_wide: number; rainfall_mm: number | null; event: string | null; observation: string | null }>(
    `SELECT w.id, w.recorded_on, w.field_id IS NULL farm_wide, w.rainfall_mm, w.event, w.observation FROM weather_records w LEFT JOIN seasons se ON se.id=?
     WHERE w.farm_id=? AND w.deleted_at IS NULL AND (w.field_id=? OR w.field_id IS NULL)
       AND (? IS NULL OR w.season_id=se.id OR (w.season_id IS NULL AND w.recorded_on BETWEEN se.starts_on AND se.ends_on))
     ORDER BY w.recorded_on DESC LIMIT 200`, [sid ?? null, ctx.farmId, field.id, sid ?? null])
  const costs = !money ? null : db.all<{ category: string; amount: number }>(
    `SELECT category, ROUND(SUM(amount),2) amount FROM cost_entries WHERE farm_id=? AND field_id=? AND deleted_at IS NULL ${sid ? 'AND season_id=?' : ''}
     GROUP BY category ORDER BY amount DESC`, sid ? [ctx.farmId, field.id, sid] : [ctx.farmId, field.id])
  const contracts = !can(ctx, 'contracts.contract.view') ? null : db.all<{ code: string; contractor: string; status: string; target_kg: number | null }>(
    `SELECT c.code, k.name contractor, c.status, c.target_kg FROM contract_fields cf JOIN contracts c ON c.id=cf.contract_id JOIN contractors k ON k.id=c.contractor_id
     WHERE cf.field_id=? AND cf.deleted_at IS NULL AND c.deleted_at IS NULL AND c.farm_id=? ${sid ? 'AND c.season_id=?' : ''} ORDER BY c.code`, sid ? [field.id, ctx.farmId, sid] : [field.id, ctx.farmId])

  const activity = canSeeAnyActivity(ctx) ? listActivity(ctx, { fieldId: field.id, seasonId: sid, limit: 50 }) : null

  const established = transplants ? transplants.reduce((s, t) => s + t.established, 0) : null
  const green = harvests ? round2(harvests.reduce((s, h) => s + h.green_weight_kg, 0)) : null
  const rain = weather ? round2(weather.reduce((s, w) => s + (w.rainfall_mm ?? 0), 0)) : null
  const cost = costs ? round2(costs.reduce((s, c) => s + c.amount, 0)) : null
  // Profit needs one season: revenue is booked to a bale's dominant field, and shared costs are allocated per season.
  const profit = sid && money ? profitability(ctx, sid).by_field.find(f => f.field_no === field.field_no) ?? null : null
  const revenue = sid && sales ? revenueSummary(ctx, sid).by_field.find(r => r.key === field.field_no) ?? null : null
  return {
    field, transplants, operations, harvests, labour, machine, bales, weather, costs, contracts, activity,
    totals: {
      established, plants_per_ha: established == null ? null : per(established, field.area_ha),
      green_kg: green, green_kg_per_ha: green == null ? null : per(green, field.area_ha), rain_mm: rain,
      cost, cost_per_ha: cost == null ? null : per(cost, field.area_ha),
      sold_kg: sales && sid ? revenue?.kg ?? 0 : null, net_revenue: finance && sid ? revenue?.net ?? 0 : null,
      shared_cost: profit?.allocated_cost ?? null, full_margin: finance ? profit?.full_margin ?? null : null,
    },
  }
}
export type FieldRecord = ReturnType<typeof fieldRecord>
