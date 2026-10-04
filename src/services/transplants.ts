import { type Ctx, require, can, need, isDate } from './context'
import { addCost, assertSeasonOpen, nonNeg, removeCostsFor } from './util'

export interface TransplantInput {
  seedbed_id: string; field_id: string; kind?: 'transplant' | 'gap_fill'; occurred_on: string; qty: number; mortality?: number
  spacing_row_m?: number; spacing_plant_m?: number; labour_workers?: number; labour_cost?: number
  weather?: string; soil_condition?: string; remarks?: string
}

export function seedlingsTransplanted(ctx: Ctx, seedbedId: string): number {
  return ctx.db.get<{ n: number }>(`SELECT COALESCE(SUM(qty),0) n FROM transplants WHERE seedbed_id=? AND deleted_at IS NULL`, [seedbedId])!.n
}

/** Seedbed -> field. Draws down the seedbed's seedling inventory; cannot exceed what the bed produced. */
export function recordTransplant(ctx: Ctx, i: TransplantInput): string {
  require(ctx, 'production.transplant.record')
  need(isDate(i.occurred_on), 'Valid date required'); need(Number.isInteger(i.qty) && i.qty > 0, 'Number transplanted must be a whole number above zero')
  const mort = i.mortality ?? 0
  need(Number.isInteger(mort) && mort >= 0 && mort <= i.qty, 'Mortality must be between 0 and the number transplanted')
  nonNeg(i.spacing_row_m, 'Row spacing'); nonNeg(i.spacing_plant_m, 'Plant spacing'); nonNeg(i.labour_workers, 'Workers'); nonNeg(i.labour_cost, 'Labour cost')
  const sb = ctx.db.get<{ id: string; season_id: string; actual_seedlings: number | null; status: string; code: string }>(
    `SELECT id, season_id, actual_seedlings, status, code FROM seedbeds WHERE id=? AND farm_id=? AND deleted_at IS NULL`, [i.seedbed_id, ctx.farmId])
  need(sb, 'Seedbed not found')
  need(sb.actual_seedlings != null, `Record the actual seedlings produced on ${sb.code} before transplanting from it`)
  need(ctx.db.get(`SELECT 1 FROM fields WHERE id=? AND farm_id=? AND deleted_at IS NULL`, [i.field_id, ctx.farmId]), 'Field not found')
  assertSeasonOpen(ctx, sb.season_id)
  const available = sb.actual_seedlings - seedlingsTransplanted(ctx, sb.id)
  need(i.qty <= available, `Only ${available} seedlings remain in ${sb.code}; ${i.qty} requested`)
  return ctx.db.tx(() => {
    const db = ctx.db
    const id = db.insert('transplants', { tenant_id: ctx.tenantId, farm_id: ctx.farmId, season_id: sb.season_id, seedbed_id: sb.id, field_id: i.field_id,
      kind: i.kind ?? 'transplant', occurred_on: i.occurred_on, qty: i.qty, mortality: mort, spacing_row_m: i.spacing_row_m ?? null, spacing_plant_m: i.spacing_plant_m ?? null,
      labour_workers: i.labour_workers ?? null, labour_cost: i.labour_cost ?? 0, weather: i.weather ?? null, soil_condition: i.soil_condition ?? null,
      remarks: i.remarks ?? null, created_by: ctx.actor?.id ?? null })
    addCost(ctx, { seasonId: sb.season_id, category: 'labour', amount: i.labour_cost ?? 0, on: i.occurred_on, sourceType: 'transplant_labour', sourceId: id, fieldId: i.field_id, seedbedId: sb.id, note: 'Transplanting labour' })
    if (available - i.qty === 0 && ['ready', 'hardening', 'growing', 'sown', 'germinating'].includes(sb.status)) db.update('seedbeds', sb.id, { status: 'depleted' })
    db.audit(ctx.actor?.id ?? null, 'transplant.record', 'transplants', id, { qty: i.qty, seedbed: sb.code })
    return id
  })
}

export function deleteTransplant(ctx: Ctx, id: string) {
  require(ctx, 'production.transplant.record')
  const t = ctx.db.get<{ season_id: string; seedbed_id: string }>(`SELECT season_id, seedbed_id FROM transplants WHERE id=? AND farm_id=? AND deleted_at IS NULL`, [id, ctx.farmId])
  need(t, 'Record not found'); assertSeasonOpen(ctx, t.season_id)
  ctx.db.tx(() => {
    ctx.db.softDelete('transplants', id); removeCostsFor(ctx, [id])
    const sb = ctx.db.get<{ status: string }>(`SELECT status FROM seedbeds WHERE id=?`, [t.seedbed_id])!
    if (sb.status === 'depleted') ctx.db.update('seedbeds', t.seedbed_id, { status: 'ready' })
    ctx.db.audit(ctx.actor?.id ?? null, 'transplant.delete', 'transplants', id)
  })
}

export interface TransplantRow {
  id: string; occurred_on: string; kind: string; seedbed_code: string; field_no: string; season_label: string; qty: number; mortality: number
  established: number; spacing_row_m: number | null; spacing_plant_m: number | null; labour_workers: number | null; weather: string | null
  soil_condition: string | null; remarks: string | null; labour_cost: number | null
}

export function listTransplants(ctx: Ctx, f: { seasonId?: string } = {}): TransplantRow[] {
  require(ctx, 'production.transplant.view')
  const money = can(ctx, 'finance.cost.view')
  return ctx.db.all<TransplantRow>(`SELECT t.id, t.occurred_on, t.kind, s.code seedbed_code, fl.field_no, se.label season_label, t.qty, t.mortality,
      t.qty - t.mortality established, t.spacing_row_m, t.spacing_plant_m, t.labour_workers, t.weather, t.soil_condition, t.remarks, t.labour_cost
    FROM transplants t JOIN seedbeds s ON s.id=t.seedbed_id JOIN fields fl ON fl.id=t.field_id JOIN seasons se ON se.id=t.season_id
    WHERE t.farm_id=? AND t.deleted_at IS NULL ${f.seasonId ? 'AND t.season_id=?' : ''} ORDER BY t.occurred_on DESC, t.created_at DESC`,
    f.seasonId ? [ctx.farmId, f.seasonId] : [ctx.farmId]).map(r => ({ ...r, labour_cost: money ? r.labour_cost : null }))
}

/** Plants established per field this season (transplanted + gap filled − mortality) and implied plants per hectare. */
export function plantingByField(ctx: Ctx, seasonId: string) {
  require(ctx, 'production.transplant.view')
  return ctx.db.all<{ field_no: string; area_ha: number; established: number; plants_per_ha: number }>(
    `SELECT f.field_no, f.area_ha, SUM(t.qty - t.mortality) established, ROUND(SUM(t.qty - t.mortality) / f.area_ha) plants_per_ha
     FROM transplants t JOIN fields f ON f.id=t.field_id WHERE t.season_id=? AND t.farm_id=? AND t.deleted_at IS NULL GROUP BY f.id ORDER BY f.field_no`, [seasonId, ctx.farmId])
}
