import { type Ctx, require, can, need, round2, round4, isDate } from './context'
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

interface Computed { units: UnitCost[]; total: number }

/** Raw (unmasked) units plus the bed's total cost, from one cost query. per_seedling is rounded to 4 dp for display only: callers that need money
 *  (Task 8 attribution) must multiply from cost / seedlings, or split with splitByWeight, never from the rounded per_seedling. */
function compute(ctx: Ctx, seedbedId: string, asOf?: string): Computed {
  need(asOf == null || (isDate(asOf) && new Date(asOf).toISOString().slice(0, 10) === asOf), 'Invalid date')
  const { bed, own, shared } = load(ctx, seedbedId, asOf)
  const total = round2([...own.values()].reduce((s, v) => s + v, 0) + shared)
  const mk = (unit: 'tray' | 'bed', id: string, code: string, seedlings: number | null, amount: number): UnitCost => {
    const cost = round2(amount)
    const pending = (seedlings == null || seedlings === 0) && cost !== 0
    return { unit, id, code, seedlings, cost, per_seedling: !pending && seedlings ? round4(cost / seedlings) : null, pending }
  }
  if (bed.kind !== 'float_bay') return { units: [mk('bed', bed.id, bed.code, bed.actual_seedlings, total)], total }
  const trays = ctx.db.all<TrayRow>(`SELECT id, code, actual_seedlings FROM seedbed_trays WHERE seedbed_id=? AND farm_id=? AND deleted_at IS NULL ORDER BY code`, [seedbedId, ctx.farmId])
  const weights = trays.map(t => t.actual_seedlings ?? 0)
  const canSplit = weights.some(w => w > 0)
  const parts = canSplit ? splitByWeight(shared, weights) : trays.map(() => 0)
  // Bay cost that cannot be split (no tray has seedlings) leaves every tray pending.
  const stuck = !canSplit && round2(shared) !== 0
  return { total, units: trays.map((t, i) => {
    const u = mk('tray', t.id, t.code, t.actual_seedlings, (own.get(t.id) ?? 0) + parts[i])
    if (stuck) { u.pending = true; u.per_seedling = null }
    return u
  }) }
}

/** Cost per unit of a bed. Open bed: one 'bed' unit. Float bay: one 'tray' unit per live tray, with bay-level cost split by actual seedlings (splitByWeight, cents sum exactly).
 * per_seedling is a 4 dp display value: never multiply it for money; use cost / seedlings or splitByWeight.
 *  Derived on every call, nothing stored, so a changed tray count recomputes. Without finance.cost.view cost and per_seedling are null (seedlings and the real pending flag still shown). */
export function seedbedUnitCosts(ctx: Ctx, seedbedId: string, asOf?: string): UnitCost[] {
  require(ctx, 'production.seedbed.view')
  const { units } = compute(ctx, seedbedId, asOf)
  return can(ctx, 'finance.cost.view') ? units : units.map(u => ({ ...u, cost: null, per_seedling: null }))
}

/** Cost per seedling of the tray (tray_id given) or of the open bed. The result is a 4 dp display value: never multiply it for money; use cost / seedlings or splitByWeight. A float bay without tray_id returns total bay cost (tray-own plus bay-level) / sum of tray counts,
 *  but only when no unit is pending: any non-zero cost without a count (or bay-level cost with no tray) makes it pending with per_seedling null. */
export function costPerSeedling(ctx: Ctx, src: { seedbed_id: string; tray_id?: string | null }, asOf: string): { per_seedling: number | null; pending: boolean } {
  require(ctx, 'production.seedbed.view')
  const { units, total } = compute(ctx, src.seedbed_id, asOf)
  const show = can(ctx, 'finance.cost.view')
  if (src.tray_id) {
    const u = units.find(x => x.unit === 'tray' && x.id === src.tray_id); need(u, 'Tray not found in this seedbed')
    return { per_seedling: show ? u.per_seedling : null, pending: u.pending }
  }
  const seedlings = units.reduce((s, u) => s + (u.seedlings ?? 0), 0)
  const pending = units.some(u => u.pending) || (units.length === 0 && total !== 0)
  return { per_seedling: show && !pending && seedlings ? round4(total / seedlings) : null, pending }
}
