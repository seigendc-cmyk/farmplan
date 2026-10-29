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

/** Money for one transplant: round2(qty * unit cost / unit seedlings) from the source unit's cost as of the transplant date (never from the 4 dp per_seedling).
 *  null = pending (the unit has cost but no seedling count, or the tray vanished). Transplant labour carries a field and is not part of unit cost. */
interface TpRow { id: string; seedbed_id: string; tray_id: string | null; field_id: string; qty: number; occurred_on: string }
function attribute(ctx: Ctx, rows: TpRow[]): (number | null)[] {
  const cache = new Map<string, UnitCost[]>()
  return rows.map(t => {
    const key = t.seedbed_id + '|' + t.occurred_on
    if (!cache.has(key)) cache.set(key, compute(ctx, t.seedbed_id, t.occurred_on).units)
    const u = cache.get(key)!.find(x => (t.tray_id ? x.unit === 'tray' && x.id === t.tray_id : x.unit === 'bed'))
    if (!u || u.pending) return null
    if (!u.cost || !u.seedlings) return 0
    return round2(t.qty * u.cost / u.seedlings)
  })
}

/** Seedling cost carried to the fields of a crop season by cross-season transplants (crop_season_id = the season; gap-fill included). Derived on every call, nothing stored:
 *  deleting a transplant removes its attribution. Legacy same-season transplants have no crop_season_id and are not here (their cost is already in the season).
 *  A row is pending (amount null) when any contributing transplant's source cost has no seedling count. amount is also null without finance.cost.view. */
export function seedlingCostByField(ctx: Ctx, cropSeasonId: string): { field_id: string; seedlings: number; amount: number | null; pending: boolean }[] {
  require(ctx, 'production.transplant.view')
  const rows = ctx.db.all<TpRow>(`SELECT t.id, t.seedbed_id, t.tray_id, t.field_id, t.qty, t.occurred_on FROM transplants t JOIN fields f ON f.id=t.field_id
    WHERE t.farm_id=? AND t.crop_season_id=? AND t.deleted_at IS NULL ORDER BY f.field_no, t.occurred_on, t.created_at`, [ctx.farmId, cropSeasonId])
  const amounts = attribute(ctx, rows); const show = can(ctx, 'finance.cost.view')
  const by = new Map<string, { field_id: string; seedlings: number; sum: number; pending: boolean }>()
  rows.forEach((t, i) => {
    const g = by.get(t.field_id) ?? { field_id: t.field_id, seedlings: 0, sum: 0, pending: false }
    g.seedlings += t.qty; if (amounts[i] == null) g.pending = true; else g.sum += amounts[i]!
    by.set(t.field_id, g)
  })
  return [...by.values()].map(g => ({ field_id: g.field_id, seedlings: g.seedlings, amount: show && !g.pending ? round2(g.sum) : null, pending: g.pending }))
}

/** The seedbed's total unit cost (all dates) less the amounts its transplants carried to fields (every live transplant of the bed, legacy ones too).
 *  Exact difference, not clamped: each transplant is rounded to cents on its own, so a few cents of drift is possible. null without finance.cost.view,
 *  or when any transplant is pending (the split cannot be computed). */
export function seedbedLoss(ctx: Ctx, seedbedId: string): number | null {
  require(ctx, 'production.seedbed.view')
  if (!can(ctx, 'finance.cost.view')) return null
  const { total } = compute(ctx, seedbedId)
  const rows = ctx.db.all<TpRow>(`SELECT id, seedbed_id, tray_id, field_id, qty, occurred_on FROM transplants WHERE farm_id=? AND seedbed_id=? AND deleted_at IS NULL`, [ctx.farmId, seedbedId])
  const amounts = attribute(ctx, rows)
  if (amounts.some(a => a == null)) return null
  return round2(total - amounts.reduce<number>((s, a) => s + a!, 0))
}
