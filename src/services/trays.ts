import { type Ctx, require, need, isDate } from './context'

export const TRAY_STATUSES = ['sown', 'germinating', 'growing', 'hardening', 'ready', 'depleted', 'abandoned'] as const

export interface Tray {
  id: string; seedbed_id: string; tray_type_id: string; tray_type: string; code: string; variety: string | null; sown_on: string | null
  expected_seedlings: number | null; actual_seedlings: number | null; status: string; transplanted: number; available: number | null
}
export interface TrayInput { seedbed_id: string; tray_type_id: string; code?: string; variety?: string; sown_on?: string; expected_seedlings?: number; actual_seedlings?: number }
export type TrayPatch = Partial<Omit<TrayInput, 'seedbed_id'>> & { status?: string }

const count = (v: number | null | undefined, what: string) => {
  need(v == null || Number.isInteger(v), `${what} must be a whole number`); need(v == null || v >= 0, `${what} cannot be negative`)
}
const blank = (s: string | null | undefined) => s?.trim() || null
const transplantedOf = (ctx: Ctx, id: string) => ctx.db.get<{ n: number }>(`SELECT COALESCE(SUM(qty),0) n FROM transplants WHERE tray_id=? AND deleted_at IS NULL`, [id])!.n

function nextTrayCode(ctx: Ctx, seedbedId: string): string {
  let k = ctx.db.get<{ n: number }>(`SELECT COUNT(*) n FROM seedbed_trays WHERE seedbed_id=?`, [seedbedId])!.n + 1, code = ''
  do { code = `T-${String(k++).padStart(3, '0')}` } while (ctx.db.get(`SELECT 1 FROM seedbed_trays WHERE seedbed_id=? AND code=?`, [seedbedId, code]))
  return code
}

export function createTray(ctx: Ctx, i: TrayInput): string {
  require(ctx, 'production.seedbed.edit')
  const bay = ctx.db.get<{ kind: string; code: string }>(`SELECT kind, code FROM seedbeds WHERE id=? AND farm_id=? AND deleted_at IS NULL`, [i.seedbed_id, ctx.farmId]); need(bay, 'Seedbed not found')
  need(bay.kind === 'float_bay', `${bay.code} is an open bed; trays go in a float bay`)
  const type = ctx.db.get<{ cells: number }>(`SELECT cells FROM tray_types WHERE id=? AND farm_id=? AND deleted_at IS NULL`, [i.tray_type_id, ctx.farmId]); need(type, 'Select a tray type')
  need(!i.sown_on || isDate(i.sown_on), 'Invalid sowing date'); count(i.expected_seedlings, 'Expected seedlings'); count(i.actual_seedlings, 'Actual seedlings')
  const code = i.code?.trim() || nextTrayCode(ctx, i.seedbed_id)
  need(!ctx.db.get(`SELECT 1 FROM seedbed_trays WHERE seedbed_id=? AND code=?`, [i.seedbed_id, code]), `Tray ${code} already exists in ${bay.code}`)
  return ctx.db.tx(() => {
    const id = ctx.db.insert('seedbed_trays', { tenant_id: ctx.tenantId, farm_id: ctx.farmId, seedbed_id: i.seedbed_id, tray_type_id: i.tray_type_id, code, variety: blank(i.variety),
      sown_on: i.sown_on || null, expected_seedlings: i.expected_seedlings ?? type.cells, actual_seedlings: i.actual_seedlings ?? null, status: 'sown' })
    ctx.db.audit(ctx.actor?.id ?? null, 'tray.create', 'seedbed_trays', id); return id
  })
}

export function updateTray(ctx: Ctx, id: string, i: TrayPatch): void {
  require(ctx, 'production.seedbed.edit')
  const cur = ctx.db.get<{ seedbed_id: string; tray_type_id: string; code: string; variety: string | null; sown_on: string | null; expected_seedlings: number | null; actual_seedlings: number | null; status: string }>(
    `SELECT seedbed_id, tray_type_id, code, variety, sown_on, expected_seedlings, actual_seedlings, status FROM seedbed_trays WHERE id=? AND farm_id=? AND deleted_at IS NULL`, [id, ctx.farmId]); need(cur, 'Tray not found')
  const m = { ...cur, ...i }
  need(m.code?.trim(), 'Code is required'); need((TRAY_STATUSES as readonly string[]).includes(m.status), 'Invalid tray status')
  need(ctx.db.get(`SELECT 1 FROM tray_types WHERE id=? AND farm_id=? AND deleted_at IS NULL`, [m.tray_type_id, ctx.farmId]), 'Select a tray type')
  need(!m.sown_on || isDate(m.sown_on), 'Invalid sowing date'); count(m.expected_seedlings, 'Expected seedlings'); count(m.actual_seedlings, 'Actual seedlings')
  const code = m.code.trim()
  need(!ctx.db.get(`SELECT 1 FROM seedbed_trays WHERE seedbed_id=? AND code=? AND id<>?`, [cur.seedbed_id, code, id]), `Tray ${code} already exists in this bay`)
  const tp = transplantedOf(ctx, id)
  need(m.actual_seedlings == null || m.actual_seedlings >= tp, `${tp} seedlings from ${code} are already transplanted; the count cannot be below that`)
  ctx.db.tx(() => {
    ctx.db.update('seedbed_trays', id, { tray_type_id: m.tray_type_id, code, variety: blank(m.variety), sown_on: m.sown_on || null,
      expected_seedlings: m.expected_seedlings, actual_seedlings: m.actual_seedlings, status: m.status })
    ctx.db.audit(ctx.actor?.id ?? null, 'tray.update', 'seedbed_trays', id)
  })
}

export function deleteTray(ctx: Ctx, id: string): void {
  require(ctx, 'production.seedbed.edit')
  const t = ctx.db.get<{ code: string }>(`SELECT code FROM seedbed_trays WHERE id=? AND farm_id=? AND deleted_at IS NULL`, [id, ctx.farmId]); need(t, 'Tray not found')
  for (const [table, what] of [['operations', 'operations'], ['cost_entries', 'costs'], ['transplants', 'transplants']] as const) {
    const n = ctx.db.get<{ n: number }>(`SELECT COUNT(*) n FROM ${table} WHERE tray_id=? AND deleted_at IS NULL`, [id])!.n
    need(n === 0, `Tray ${t.code} has ${what} recorded (${n}) and cannot be removed`)
  }
  ctx.db.tx(() => { ctx.db.softDelete('seedbed_trays', id); ctx.db.audit(ctx.actor?.id ?? null, 'tray.delete', 'seedbed_trays', id) })
}

export function listTrays(ctx: Ctx, seedbedId: string): Tray[] {
  require(ctx, 'production.seedbed.view')
  return ctx.db.all<Omit<Tray, 'available'>>(
    `SELECT r.id, r.seedbed_id, r.tray_type_id, tt.name AS tray_type, r.code, r.variety, r.sown_on, r.expected_seedlings, r.actual_seedlings, r.status,
       COALESCE((SELECT SUM(qty) FROM transplants t WHERE t.tray_id=r.id AND t.deleted_at IS NULL),0) AS transplanted
     FROM seedbed_trays r JOIN tray_types tt ON tt.id=r.tray_type_id JOIN seedbeds b ON b.id=r.seedbed_id
     WHERE r.seedbed_id=? AND b.farm_id=? AND r.deleted_at IS NULL ORDER BY r.code`, [seedbedId, ctx.farmId])
    .map(r => ({ ...r, available: r.actual_seedlings != null ? r.actual_seedlings - r.transplanted : null }))
}
