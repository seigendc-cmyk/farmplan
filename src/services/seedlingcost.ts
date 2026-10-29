import { type Ctx, require, can, need, round2, round4 } from './context'
import { splitByWeight } from './allocation'

export interface UnitCost { unit: 'tray' | 'bed'; id: string; code: string; seedlings: number | null; cost: number | null; per_seedling: number | null; pending: boolean }

interface Bed { id: string; code: string; kind: string; actual_seedlings: number | null }
interface TrayRow { id: string; code: string; actual_seedlings: number | null }

/** Read-only. Seedbed cost = live cost_entries on the bed with no field (transplant labour carries a field and is excluded), dated up to asOf (inclusive; none = all). */
function load(ctx: Ctx, seedbedId: string, asOf?: string) {
  const bed = ctx.db.get<Bed>(`SELECT id, code, kind, actual_seedlings FROM seedbeds WHERE id=? AND farm_id=? AND deleted_at IS NULL`, [seedbedId, ctx.farmId]); need(bed, 'Seedbed not found')
  const entries = ctx.db.all<{ tray_id: string | null; a: number }>(
    `SELECT tray_id, SUM(amount) a FROM cost_entries WHERE farm_id=? AND seedbed_id=? AND field_id IS NULL AND deleted_at IS NULL${asOf ? ' AND occurred_on<=?' : ''} GROUP BY tray_id`,
    asOf ? [ctx.farmId, seedbedId, asOf] : [ctx.farmId, seedbedId])
  const own = new Map<string, number>(); let shared = 0
  for (const e of entries) { if (e.tray_id) own.set(e.tray_id, e.a); else shared = e.a }
  return { bed, own, shared }
}

/** Cost per unit of a bed. Open bed: one 'bed' unit. Float bay: one 'tray' unit per live tray, with bay-level cost split by actual seedlings (splitByWeight, cents sum exactly).
 *  Derived on every call, nothing stored, so a changed tray count recomputes. Without finance.cost.view cost and per_seedling are null (seedlings and pending still shown). */
export function seedbedUnitCosts(ctx: Ctx, seedbedId: string, asOf?: string): UnitCost[] {
  require(ctx, 'production.seedbed.view')
  need(asOf == null || /^\d{4}-\d{2}-\d{2}$/.test(asOf), 'Invalid date')
  const show = can(ctx, 'finance.cost.view')
  const { bed, own, shared } = load(ctx, seedbedId, asOf)
  const mk = (unit: 'tray' | 'bed', id: string, code: string, seedlings: number | null, total: number): UnitCost => {
    const cost = round2(total)
    const pending = (seedlings == null || seedlings === 0) && cost !== 0
    return { unit, id, code, seedlings, cost: show ? cost : null, per_seedling: show && !pending && seedlings ? round4(cost / seedlings) : null, pending }
  }
  if (bed.kind !== 'float_bay') return [mk('bed', bed.id, bed.code, bed.actual_seedlings, [...own.values()].reduce((s, v) => s + v, 0) + shared)]
  const trays = ctx.db.all<TrayRow>(`SELECT id, code, actual_seedlings FROM seedbed_trays WHERE seedbed_id=? AND farm_id=? AND deleted_at IS NULL ORDER BY code`, [seedbedId, ctx.farmId])
  const weights = trays.map(t => t.actual_seedlings ?? 0)
  const canSplit = weights.some(w => w > 0)
  const parts = canSplit ? splitByWeight(shared, weights) : trays.map(() => 0)
  // Bay cost that cannot be split (no tray has seedlings) leaves every tray pending.
  const stuck = !canSplit && round2(shared) !== 0
  return trays.map((t, i) => {
    const u = mk('tray', t.id, t.code, t.actual_seedlings, (own.get(t.id) ?? 0) + parts[i])
    if (stuck) { u.pending = true; u.per_seedling = null }
    return u
  })
}

/** Cost per seedling of the tray (tray_id given) or of the open bed. A float bay without tray_id returns bay total cost (own tray cost plus bay-level) / the bay's seedlings (sum of tray counts). */
export function costPerSeedling(ctx: Ctx, src: { seedbed_id: string; tray_id?: string | null }, asOf: string): { per_seedling: number | null; pending: boolean } {
  const units = seedbedUnitCosts(ctx, src.seedbed_id, asOf)
  if (src.tray_id) {
    const u = units.find(x => x.unit === 'tray' && x.id === src.tray_id); need(u, 'Tray not found in this seedbed')
    return { per_seedling: u.per_seedling, pending: u.pending }
  }
  if (units.length === 1 && units[0].unit === 'bed') return { per_seedling: units[0].per_seedling, pending: units[0].pending }
  if (!can(ctx, 'finance.cost.view')) return { per_seedling: null, pending: false }
  const { own, shared } = load(ctx, src.seedbed_id, asOf)
  const total = round2([...own.values()].reduce((s, v) => s + v, 0) + shared)
  const seedlings = units.reduce((s, u) => s + (u.seedlings ?? 0), 0)
  const pending = seedlings === 0 && total !== 0
  return { per_seedling: pending || !seedlings ? null : round4(total / seedlings), pending }
}
