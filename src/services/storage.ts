import { type Ctx, require, need, isDate, round2 } from './context'
import { addDays, assertSeasonOpen, daysBetween, nextCode } from './util'

export const DEFAULT_MATURITY_DAYS = 90

export interface StorageInput { cycle_id: string; kind: 'slate_pack' | 'pile'; weight_kg: number; created_on: string; location?: string; condition?: string; maturity_days?: number; remarks?: string }

/** Moves cured leaf from a completed curing cycle into a slate pack or pile. Total stored can never exceed the cured weight. */
export function createStorageUnit(ctx: Ctx, i: StorageInput): { id: string; code: string } {
  require(ctx, 'curing.storage.edit')
  need(i.kind === 'slate_pack' || i.kind === 'pile', 'Choose slate pack or pile'); need(i.weight_kg > 0, 'Weight must be greater than zero'); need(isDate(i.created_on), 'Valid date required')
  const days = i.maturity_days ?? DEFAULT_MATURITY_DAYS; need(Number.isInteger(days) && days >= 1 && days <= 365, 'Maturity period must be 1–365 days')
  const c = ctx.db.get<{ id: string; code: string; season_id: string; status: string; cured_weight_kg: number | null }>(`SELECT id, code, season_id, status, cured_weight_kg FROM curing_cycles WHERE id=? AND farm_id=? AND deleted_at IS NULL`, [i.cycle_id, ctx.farmId])
  need(c, 'Curing cycle not found'); need(c.status === 'completed', `Cycle ${c.code} must be offloaded before its leaf can be stored`); assertSeasonOpen(ctx, c.season_id)
  const stored = ctx.db.get<{ w: number }>(`SELECT COALESCE(SUM(weight_kg),0) w FROM storage_units WHERE cycle_id=? AND deleted_at IS NULL`, [c.id])!.w
  const remaining = round2((c.cured_weight_kg ?? 0) - stored)
  need(i.weight_kg <= remaining + 0.001, `Only ${remaining} kg of ${c.code} is left to store; ${i.weight_kg} kg requested`)
  return ctx.db.tx(() => {
    const code = nextCode(ctx, 'storage_units', i.kind === 'slate_pack' ? 'SP' : 'P')
    const id = ctx.db.insert('storage_units', { tenant_id: ctx.tenantId, farm_id: ctx.farmId, season_id: c.season_id, code, kind: i.kind, cycle_id: c.id, weight_kg: i.weight_kg,
      location: i.location ?? null, created_on: i.created_on, condition: i.condition ?? null, maturity_start: i.created_on, expected_open_on: addDays(i.created_on, days),
      status: 'maturing', remarks: i.remarks ?? null })
    ctx.db.audit(ctx.actor?.id ?? null, 'storage.create', 'storage_units', id, { code, kg: i.weight_kg }); return { id, code }
  })
}

export interface StorageRow {
  id: string; code: string; kind: string; cycle_code: string; season_label: string; weight_kg: number; location: string | null; condition: string | null
  created_on: string; maturity_start: string; expected_open_on: string; status: 'maturing' | 'opened'; opened_on: string | null
  age_days: number; days_to_open: number; stage: 'MATURING' | 'READY TO OPEN' | 'OPENED'; next_action: string
}

export function listStorage(ctx: Ctx, f: { seasonId?: string; asOf?: string } = {}): StorageRow[] {
  require(ctx, 'curing.storage.view')
  const asOf = f.asOf ?? new Date().toISOString().slice(0, 10)
  return ctx.db.all<Omit<StorageRow, 'age_days' | 'days_to_open' | 'stage' | 'next_action'>>(`SELECT u.id, u.code, u.kind, c.code cycle_code, se.label season_label, u.weight_kg, u.location, u.condition,
      u.created_on, u.maturity_start, u.expected_open_on, u.status, u.opened_on
    FROM storage_units u JOIN curing_cycles c ON c.id=u.cycle_id JOIN seasons se ON se.id=u.season_id
    WHERE u.farm_id=? AND u.deleted_at IS NULL ${f.seasonId ? 'AND u.season_id=?' : ''} ORDER BY u.status, u.expected_open_on, u.code`, f.seasonId ? [ctx.farmId, f.seasonId] : [ctx.farmId])
    .map(r => {
      const age = daysBetween(r.maturity_start, asOf); const toOpen = daysBetween(asOf, r.expected_open_on)
      const stage = r.status === 'opened' ? 'OPENED' : toOpen <= 0 ? 'READY TO OPEN' : 'MATURING'
      return { ...r, age_days: age, days_to_open: toOpen, stage,
        next_action: stage === 'OPENED' ? 'Opened for grading' : stage === 'READY TO OPEN' ? (toOpen < 0 ? `OPEN FOR GRADING (${-toOpen} days overdue)` : 'OPEN FOR GRADING') : `Maturing — ${toOpen} more day${toOpen === 1 ? '' : 's'}` }
    })
}

/** Opening before the expected date needs an explicit `early` flag so the decision is on record. Grading itself arrives in Phase 3. */
export function openStorageUnit(ctx: Ctx, id: string, openedOn: string, early = false) {
  require(ctx, 'curing.storage.edit'); need(isDate(openedOn), 'Valid date required')
  const u = ctx.db.get<{ code: string; season_id: string; status: string; maturity_start: string; expected_open_on: string }>(`SELECT code, season_id, status, maturity_start, expected_open_on FROM storage_units WHERE id=? AND farm_id=? AND deleted_at IS NULL`, [id, ctx.farmId])
  need(u, 'Storage unit not found'); need(u.status === 'maturing', `${u.code} is already open`); need(openedOn >= u.maturity_start, 'Cannot open before it was stored')
  need(early || openedOn >= u.expected_open_on, `${u.code} is not due until ${u.expected_open_on}. Confirm early opening to proceed.`); assertSeasonOpen(ctx, u.season_id)
  ctx.db.tx(() => { ctx.db.update('storage_units', id, { status: 'opened', opened_on: openedOn }); ctx.db.audit(ctx.actor?.id ?? null, early && openedOn < u.expected_open_on ? 'storage.open_early' : 'storage.open', 'storage_units', id) })
}

/** Cured leaf from completed cycles that has not yet been put into a pack or pile — prevents undocumented leaf. */
export function unstoredByCycle(ctx: Ctx) {
  require(ctx, 'curing.storage.view')
  return ctx.db.all<{ id: string; code: string; barn_code: string; cured_weight_kg: number; stored_kg: number; unstored_kg: number }>(
    `SELECT c.id, c.code, b.code barn_code, c.cured_weight_kg, COALESCE(SUM(u.weight_kg),0) stored_kg, ROUND(c.cured_weight_kg - COALESCE(SUM(u.weight_kg),0), 2) unstored_kg
     FROM curing_cycles c JOIN barns b ON b.id=c.barn_id LEFT JOIN storage_units u ON u.cycle_id=c.id AND u.deleted_at IS NULL
     WHERE c.farm_id=? AND c.status='completed' AND c.deleted_at IS NULL GROUP BY c.id HAVING unstored_kg > 0.001 ORDER BY c.code`, [ctx.farmId])
}
