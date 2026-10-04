import { type Ctx, require, can, need, isDate } from './context'
import { addCost, assertSeasonOpen, nextCode, nonNeg, removeCostsFor } from './util'
import { round2 } from './context'

export interface HarvestInput {
  field_id: string; season_id: string; harvested_on: string; variety?: string; priming?: number; leaf_position?: string
  labour_workers?: number; labour_cost?: number; green_weight_kg: number; bundles?: number; transport_cost?: number
  barn_destination?: string; remarks?: string
}

/** Each harvest creates a uniquely coded batch (H-00034) that follows the leaf through curing, storage, grading and sale. */
export function recordHarvest(ctx: Ctx, i: HarvestInput): { id: string; code: string } {
  require(ctx, 'production.harvest.record')
  need(isDate(i.harvested_on), 'Valid harvest date required'); need(i.green_weight_kg > 0, 'Green weight must be greater than zero')
  need(i.priming == null || (Number.isInteger(i.priming) && i.priming > 0), 'Priming must be a positive whole number')
  nonNeg(i.labour_workers, 'Workers'); nonNeg(i.labour_cost, 'Labour cost'); nonNeg(i.transport_cost, 'Transport cost'); nonNeg(i.bundles, 'Bundles')
  const field = ctx.db.get<{ id: string; variety: string | null }>(`SELECT id, variety FROM fields WHERE id=? AND farm_id=? AND deleted_at IS NULL`, [i.field_id, ctx.farmId])
  need(field, 'Field not found'); assertSeasonOpen(ctx, i.season_id)
  return ctx.db.tx(() => {
    const code = nextCode(ctx, 'harvest_batches', 'H')
    const id = ctx.db.insert('harvest_batches', { tenant_id: ctx.tenantId, farm_id: ctx.farmId, season_id: i.season_id, code, field_id: i.field_id,
      variety: i.variety ?? field.variety, harvested_on: i.harvested_on, priming: i.priming ?? null, leaf_position: i.leaf_position ?? null,
      labour_workers: i.labour_workers ?? null, labour_cost: i.labour_cost ?? 0, green_weight_kg: i.green_weight_kg, bundles: i.bundles ?? null,
      transport_cost: i.transport_cost ?? 0, barn_destination: i.barn_destination ?? null, remarks: i.remarks ?? null, created_by: ctx.actor?.id ?? null })
    addCost(ctx, { seasonId: i.season_id, category: 'labour', amount: i.labour_cost ?? 0, on: i.harvested_on, sourceType: 'harvest_labour', sourceId: id, fieldId: i.field_id, note: `Harvest ${code}` })
    addCost(ctx, { seasonId: i.season_id, category: 'transport', amount: i.transport_cost ?? 0, on: i.harvested_on, sourceType: 'harvest_transport', sourceId: id, fieldId: i.field_id, note: `Harvest ${code}` })
    ctx.db.audit(ctx.actor?.id ?? null, 'harvest.record', 'harvest_batches', id, { code, kg: i.green_weight_kg })
    return { id, code }
  })
}

export function deleteHarvest(ctx: Ctx, id: string) {
  require(ctx, 'production.harvest.record')
  const h = ctx.db.get<{ season_id: string; status: string; code: string }>(`SELECT season_id, status, code FROM harvest_batches WHERE id=? AND farm_id=? AND deleted_at IS NULL`, [id, ctx.farmId])
  need(h, 'Batch not found'); need(h.status === 'harvested', `${h.code} is already in a barn and cannot be deleted`); assertSeasonOpen(ctx, h.season_id)
  ctx.db.tx(() => { ctx.db.softDelete('harvest_batches', id); removeCostsFor(ctx, [id]); ctx.db.audit(ctx.actor?.id ?? null, 'harvest.delete', 'harvest_batches', id) })
}

export interface HarvestRow {
  id: string; code: string; season_id: string; season_label: string; field_id: string; field_no: string; variety: string | null; harvested_on: string
  priming: number | null; leaf_position: string | null; green_weight_kg: number; bundles: number | null; labour_workers: number | null
  barn_destination: string | null; status: string; cycle_code: string | null; remarks: string | null; labour_cost: number | null; transport_cost: number | null
}

export function listHarvests(ctx: Ctx, f: { seasonId?: string; onlyUnloaded?: boolean } = {}): HarvestRow[] {
  require(ctx, 'production.harvest.view')
  const money = can(ctx, 'finance.cost.view')
  const where = ['h.farm_id=?', 'h.deleted_at IS NULL']; const p: string[] = [ctx.farmId]
  if (f.seasonId) { where.push('h.season_id=?'); p.push(f.seasonId) }
  if (f.onlyUnloaded) where.push(`h.status='harvested'`)
  return ctx.db.all<HarvestRow>(`SELECT h.*, se.label season_label, fl.field_no,
      (SELECT c.code FROM cycle_batches cb JOIN curing_cycles c ON c.id=cb.cycle_id WHERE cb.batch_id=h.id AND cb.deleted_at IS NULL AND c.status<>'aborted' LIMIT 1) cycle_code
    FROM harvest_batches h JOIN seasons se ON se.id=h.season_id JOIN fields fl ON fl.id=h.field_id
    WHERE ${where.join(' AND ')} ORDER BY h.harvested_on DESC, h.code DESC`, p)
    .map(r => ({ ...r, labour_cost: money ? r.labour_cost : null, transport_cost: money ? r.transport_cost : null }))
}

/** Green-leaf yield per field for a season. */
export function harvestYield(ctx: Ctx, seasonId: string) {
  require(ctx, 'production.harvest.view')
  return ctx.db.all<{ field_no: string; area_ha: number; batches: number; green_kg: number; kg_per_ha: number }>(
    `SELECT f.field_no, f.area_ha, COUNT(*) batches, SUM(h.green_weight_kg) green_kg, ROUND(SUM(h.green_weight_kg)/f.area_ha, 1) kg_per_ha
     FROM harvest_batches h JOIN fields f ON f.id=h.field_id WHERE h.season_id=? AND h.farm_id=? AND h.deleted_at IS NULL GROUP BY f.id ORDER BY f.field_no`, [seasonId, ctx.farmId])
    .map(r => ({ ...r, green_kg: round2(r.green_kg) }))
}
