import { type Ctx, require, can, need, isDate, round2 } from './context'
import { addCost, assertSeasonOpen, nextCode, nonNeg } from './util'
import { currentUnitCost, stockOf } from './inventory'

export const CHECKLIST_ITEMS = ['Cleaning', 'Repairs', 'Furnace inspection', 'Flue inspection', 'Chimney', 'Ventilation', 'Thermometer', 'Safety', 'Fuel availability'] as const
const OPEN = ['preparing', 'ready', 'curing']

// ---------------------------------------------------------------- barns
export interface Barn {
  id: string; code: string; location: string | null; capacity_kg: number | null; barn_type: string | null; condition: string | null
  furnace: string | null; flues: string | null; ventilation: string | null; sensors: string | null; fuel_type: string | null; notes: string | null; active: number
}
export type BarnInput = Partial<Omit<Barn, 'id'>> & { code?: string }

export interface BarnRow extends Barn { open_cycle_code: string | null; open_cycle_status: string | null }

export function listBarns(ctx: Ctx): BarnRow[] {
  require(ctx, 'curing.barn.view')
  return ctx.db.all<BarnRow>(`SELECT b.*, c.code open_cycle_code, c.status open_cycle_status FROM barns b
    LEFT JOIN curing_cycles c ON c.barn_id=b.id AND c.deleted_at IS NULL AND c.status IN ('preparing','ready','curing')
    WHERE b.farm_id=? AND b.deleted_at IS NULL ORDER BY b.code`, [ctx.farmId])
}

function validateBarn(i: BarnInput) { need(i.capacity_kg == null || i.capacity_kg > 0, 'Capacity must be greater than zero') }

export function createBarn(ctx: Ctx, i: BarnInput): string {
  require(ctx, 'curing.barn.edit'); validateBarn(i)
  const code = (i.code?.trim() || nextCode(ctx, 'barns', 'B', 2))
  need(!ctx.db.get(`SELECT 1 FROM barns WHERE farm_id=? AND code=? AND deleted_at IS NULL`, [ctx.farmId, code]), `Barn ${code} already exists`)
  return ctx.db.tx(() => {
    const id = ctx.db.insert('barns', { tenant_id: ctx.tenantId, farm_id: ctx.farmId, code, location: i.location ?? null, capacity_kg: i.capacity_kg ?? null,
      barn_type: i.barn_type ?? null, condition: i.condition ?? null, furnace: i.furnace ?? null, flues: i.flues ?? null, ventilation: i.ventilation ?? null,
      sensors: i.sensors ?? null, fuel_type: i.fuel_type ?? null, notes: i.notes ?? null, active: i.active === 0 ? 0 : 1 })
    ctx.db.audit(ctx.actor?.id ?? null, 'barn.create', 'barns', id); return id
  })
}

export function updateBarn(ctx: Ctx, id: string, i: BarnInput) {
  require(ctx, 'curing.barn.edit'); validateBarn(i)
  need(i.code?.trim(), 'Barn ID is required')
  need(!ctx.db.get(`SELECT 1 FROM barns WHERE farm_id=? AND code=? AND id<>? AND deleted_at IS NULL`, [ctx.farmId, i.code!.trim(), id]), `Barn ${i.code} already exists`)
  need(i.active !== 0 || !ctx.db.get(`SELECT 1 FROM curing_cycles WHERE barn_id=? AND status IN ('preparing','ready','curing') AND deleted_at IS NULL`, [id]), 'Barn has an open curing cycle')
  ctx.db.tx(() => {
    ctx.db.update('barns', id, { code: i.code!.trim(), location: i.location ?? null, capacity_kg: i.capacity_kg ?? null, barn_type: i.barn_type ?? null, condition: i.condition ?? null,
      furnace: i.furnace ?? null, flues: i.flues ?? null, ventilation: i.ventilation ?? null, sensors: i.sensors ?? null, fuel_type: i.fuel_type ?? null, notes: i.notes ?? null, active: i.active === 0 ? 0 : 1 })
    ctx.db.audit(ctx.actor?.id ?? null, 'barn.update', 'barns', id)
  })
}

// ---------------------------------------------------------------- cycles
export type CycleStatus = 'preparing' | 'ready' | 'curing' | 'completed' | 'aborted'
interface CycleRow { id: string; season_id: string; barn_id: string; status: CycleStatus; code: string; loaded_at: string | null; green_weight_kg: number | null
  fuel_input_id: string | null; fuel_opening_kg: number | null; cured_weight_kg: number | null; farm_id: string }

function cycleOf(ctx: Ctx, id: string): CycleRow {
  const c = ctx.db.get<CycleRow>(`SELECT * FROM curing_cycles WHERE id=? AND farm_id=? AND deleted_at IS NULL`, [id, ctx.farmId]); need(c, 'Curing cycle not found'); return c
}

export function createCycle(ctx: Ctx, i: { barn_id: string; season_id: string; fuel_input_id?: string }): { id: string; code: string } {
  require(ctx, 'curing.cycle.create')
  const barn = ctx.db.get<{ id: string; code: string; active: number }>(`SELECT id, code, active FROM barns WHERE id=? AND farm_id=? AND deleted_at IS NULL`, [i.barn_id, ctx.farmId])
  need(barn, 'Barn not found'); need(barn.active, `Barn ${barn.code} is inactive`)
  assertSeasonOpen(ctx, i.season_id)
  need(!ctx.db.get(`SELECT 1 FROM curing_cycles WHERE barn_id=? AND status IN ('preparing','ready','curing') AND deleted_at IS NULL`, [i.barn_id]), `Barn ${barn.code} already has an open curing cycle`)
  if (i.fuel_input_id) need(ctx.db.get(`SELECT 1 FROM inputs WHERE id=? AND tenant_id=? AND category='fuel' AND deleted_at IS NULL`, [i.fuel_input_id, ctx.tenantId]), 'Select a product in the fuel category')
  return ctx.db.tx(() => {
    const code = nextCode(ctx, 'curing_cycles', 'C')
    const id = ctx.db.insert('curing_cycles', { tenant_id: ctx.tenantId, farm_id: ctx.farmId, season_id: i.season_id, code, barn_id: i.barn_id, status: 'preparing',
      fuel_input_id: i.fuel_input_id ?? null, created_by: ctx.actor?.id ?? null })
    for (const item of CHECKLIST_ITEMS) ctx.db.insert('curing_cycle_checks', { tenant_id: ctx.tenantId, cycle_id: id, item, done: 0 })
    ctx.db.audit(ctx.actor?.id ?? null, 'cycle.create', 'curing_cycles', id, { code, barn: barn.code }); return { id, code }
  })
}

export function listChecks(ctx: Ctx, cycleId: string) {
  require(ctx, 'curing.cycle.view')
  return ctx.db.all<{ id: string; item: string; done: number; done_on: string | null; done_by: string | null }>(
    `SELECT k.id, k.item, k.done, k.done_on, u.name done_by FROM curing_cycle_checks k LEFT JOIN local_users u ON u.id=k.done_by WHERE k.cycle_id=? AND k.deleted_at IS NULL ORDER BY k.created_at, k.rowid`, [cycleId])
}

/** A cycle becomes `ready` only when every preparation check is complete, and drops back to `preparing` if one is un-ticked. */
export function setCheck(ctx: Ctx, cycleId: string, item: string, done: boolean, on: string) {
  require(ctx, 'curing.cycle.create')
  const c = cycleOf(ctx, cycleId); need(['preparing', 'ready'].includes(c.status), 'Checks can only change before loading')
  const row = ctx.db.get<{ id: string }>(`SELECT id FROM curing_cycle_checks WHERE cycle_id=? AND item=? AND deleted_at IS NULL`, [cycleId, item]); need(row, 'Unknown check')
  ctx.db.tx(() => {
    ctx.db.update('curing_cycle_checks', row.id, { done: done ? 1 : 0, done_on: done ? on : null, done_by: done ? ctx.actor?.id ?? null : null })
    const open = ctx.db.get<{ n: number }>(`SELECT COUNT(*) n FROM curing_cycle_checks WHERE cycle_id=? AND done=0 AND deleted_at IS NULL`, [cycleId])!.n
    const status: CycleStatus = open === 0 ? 'ready' : 'preparing'
    if (status !== c.status) ctx.db.update('curing_cycles', cycleId, { status })
  })
}

export interface LoadInput { cycle_id: string; batch_ids: string[]; loaded_at: string; slates?: number; labour_workers?: number; labour_cost?: number; operator?: string; fuel_opening_kg?: number }

export function loadCycle(ctx: Ctx, i: LoadInput) {
  require(ctx, 'curing.cycle.create')
  const c = cycleOf(ctx, i.cycle_id)
  need(c.status === 'ready', c.status === 'preparing' ? 'Complete every preparation check before loading' : `Cycle ${c.code} is ${c.status}`)
  need(isDate(i.loaded_at.slice(0, 10)), 'Valid loading date required'); need(i.batch_ids.length > 0, 'Select at least one harvest batch')
  need(new Set(i.batch_ids).size === i.batch_ids.length, 'A batch was selected twice')
  nonNeg(i.slates, 'Slates'); nonNeg(i.labour_workers, 'Workers'); nonNeg(i.labour_cost, 'Labour cost'); nonNeg(i.fuel_opening_kg, 'Fuel opening balance')
  assertSeasonOpen(ctx, c.season_id)
  const batches = i.batch_ids.map(id => {
    const b = ctx.db.get<{ id: string; code: string; season_id: string; status: string; green_weight_kg: number }>(`SELECT id, code, season_id, status, green_weight_kg FROM harvest_batches WHERE id=? AND farm_id=? AND deleted_at IS NULL`, [id, ctx.farmId])
    need(b, 'Harvest batch not found'); need(b.status === 'harvested', `${b.code} is already loaded`); need(b.season_id === c.season_id, `${b.code} belongs to a different season`); return b
  })
  const total = round2(batches.reduce((s, b) => s + b.green_weight_kg, 0))
  const barn = ctx.db.get<{ code: string; capacity_kg: number | null }>(`SELECT code, capacity_kg FROM barns WHERE id=?`, [c.barn_id])!
  need(barn.capacity_kg == null || total <= barn.capacity_kg, `${total} kg exceeds the ${barn.code} capacity of ${barn.capacity_kg} kg`)
  if ((i.fuel_opening_kg ?? 0) > 0) {
    need(c.fuel_input_id, 'This cycle has no fuel product selected'); const onHand = stockOf(ctx, c.fuel_input_id)
    need(onHand >= i.fuel_opening_kg!, `Only ${onHand} of fuel in stock; ${i.fuel_opening_kg} allocated`)
  }
  ctx.db.tx(() => {
    for (const b of batches) { ctx.db.insert('cycle_batches', { tenant_id: ctx.tenantId, cycle_id: c.id, batch_id: b.id, green_weight_kg: b.green_weight_kg }); ctx.db.update('harvest_batches', b.id, { status: 'loaded' }) }
    ctx.db.update('curing_cycles', c.id, { status: 'curing', loaded_at: i.loaded_at, green_weight_kg: total, slates: i.slates ?? null, labour_workers: i.labour_workers ?? null,
      labour_cost: i.labour_cost ?? 0, operator: i.operator ?? null, fuel_opening_kg: i.fuel_opening_kg ?? 0 })
    addCost(ctx, { seasonId: c.season_id, category: 'labour', amount: i.labour_cost ?? 0, on: i.loaded_at.slice(0, 10), sourceType: 'cycle_load_labour', sourceId: c.id, cycleId: c.id, note: `Loading ${c.code}` })
    ctx.db.audit(ctx.actor?.id ?? null, 'cycle.load', 'curing_cycles', c.id, { kg: total, batches: batches.map(b => b.code) })
  })
}

export interface LogInput { cycle_id: string; logged_at: string; temperature_c?: number; ventilation?: string; fuel_added_kg?: number; operator?: string; remarks?: string }

export function logCuring(ctx: Ctx, i: LogInput): string {
  require(ctx, 'curing.cycle.record')
  const c = cycleOf(ctx, i.cycle_id); need(c.status === 'curing', `Cycle ${c.code} is ${c.status}; readings can only be logged while curing`)
  need(i.temperature_c != null || (i.fuel_added_kg ?? 0) > 0, 'Enter a temperature reading or fuel added')
  need(i.temperature_c == null || (i.temperature_c >= -10 && i.temperature_c <= 120), 'Temperature must be between -10 and 120 °C')
  nonNeg(i.fuel_added_kg, 'Fuel added'); need(isDate(i.logged_at.slice(0, 10)), 'Valid date/time required')
  need(c.loaded_at == null || i.logged_at >= c.loaded_at, 'Reading cannot be earlier than the loading time')
  const fuel = i.fuel_added_kg ?? 0
  if (fuel > 0) { need(c.fuel_input_id, 'This cycle has no fuel product selected'); const onHand = stockOf(ctx, c.fuel_input_id); need(onHand >= fuel, `Only ${onHand} of fuel in stock`) }
  return ctx.db.tx(() => {
    let txn: string | null = null; const id = crypto.randomUUID()
    if (fuel > 0) {
      const unit = currentUnitCost(ctx, c.fuel_input_id!)
      txn = ctx.db.insert('inventory_transactions', { tenant_id: ctx.tenantId, farm_id: ctx.farmId, input_id: c.fuel_input_id!, kind: 'consumption', qty_delta: -fuel, unit_cost: unit,
        occurred_on: i.logged_at.slice(0, 10), source_type: 'curing_log', source_id: id, created_by: ctx.actor?.id ?? null })
      addCost(ctx, { seasonId: c.season_id, category: 'curing', amount: fuel * unit, on: i.logged_at.slice(0, 10), sourceType: 'curing_fuel', sourceId: id, cycleId: c.id, note: `${c.code} fuel` })
    }
    ctx.db.insert('curing_logs', { id, tenant_id: ctx.tenantId, cycle_id: c.id, logged_at: i.logged_at, temperature_c: i.temperature_c ?? null, ventilation: i.ventilation ?? null,
      fuel_added_kg: fuel || null, fuel_txn_id: txn, operator: i.operator ?? null, remarks: i.remarks ?? null })
    return id
  })
}

export interface OffloadInput { cycle_id: string; offloaded_at: string; cured_weight_kg: number; labour_cost?: number; condition?: string; losses_note?: string }

export function offloadCycle(ctx: Ctx, i: OffloadInput) {
  require(ctx, 'curing.cycle.close')
  const c = cycleOf(ctx, i.cycle_id); need(c.status === 'curing', `Cycle ${c.code} is ${c.status}`)
  need(i.cured_weight_kg > 0, 'Cured weight must be greater than zero')
  need(i.cured_weight_kg <= (c.green_weight_kg ?? 0), 'Cured weight cannot exceed the green weight loaded')
  need(isDate(i.offloaded_at.slice(0, 10)), 'Valid date required'); need(c.loaded_at == null || i.offloaded_at >= c.loaded_at, 'Offloading cannot precede loading'); nonNeg(i.labour_cost, 'Labour cost')
  ctx.db.tx(() => {
    ctx.db.update('curing_cycles', c.id, { status: 'completed', offloaded_at: i.offloaded_at, cured_weight_kg: i.cured_weight_kg, offload_labour_cost: i.labour_cost ?? 0, condition: i.condition ?? null, losses_note: i.losses_note ?? null })
    addCost(ctx, { seasonId: c.season_id, category: 'labour', amount: i.labour_cost ?? 0, on: i.offloaded_at.slice(0, 10), sourceType: 'cycle_offload_labour', sourceId: c.id, cycleId: c.id, note: `Offloading ${c.code}` })
    ctx.db.audit(ctx.actor?.id ?? null, 'cycle.offload', 'curing_cycles', c.id, { cured_kg: i.cured_weight_kg })
  })
}

/** Only possible before loading; once leaf is in the barn the cycle must be completed. */
export function abortCycle(ctx: Ctx, id: string) {
  require(ctx, 'curing.cycle.create')
  const c = cycleOf(ctx, id); need(['preparing', 'ready'].includes(c.status), 'Only cycles that are not yet loaded can be cancelled')
  ctx.db.tx(() => { ctx.db.update('curing_cycles', id, { status: 'aborted' }); ctx.db.audit(ctx.actor?.id ?? null, 'cycle.abort', 'curing_cycles', id) })
}

// ---------------------------------------------------------------- read models
export interface CycleSummary {
  id: string; code: string; season_id: string; season_label: string; barn_id: string; barn_code: string; status: CycleStatus
  loaded_at: string | null; offloaded_at: string | null; green_weight_kg: number | null; cured_weight_kg: number | null
  curing_loss_kg: number | null; recovery_pct: number | null; fuel_used: number; checks_done: number; checks_total: number
  curing_cost: number | null; cost_per_kg_cured: number | null
}

const recovery = (cured: number | null, green: number | null) => cured != null && green ? round2((cured / green) * 100) : null

export function listCycles(ctx: Ctx, seasonId?: string): CycleSummary[] {
  require(ctx, 'curing.cycle.view')
  const money = can(ctx, 'finance.cost.view')
  return ctx.db.all<CycleSummary & { fuel: number; cost: number }>(`SELECT c.id, c.code, c.season_id, se.label season_label, c.barn_id, b.code barn_code, c.status, c.loaded_at, c.offloaded_at,
      c.green_weight_kg, c.cured_weight_kg,
      COALESCE((SELECT SUM(fuel_added_kg) FROM curing_logs l WHERE l.cycle_id=c.id AND l.deleted_at IS NULL),0) fuel,
      (SELECT COUNT(*) FROM curing_cycle_checks k WHERE k.cycle_id=c.id AND k.done=1 AND k.deleted_at IS NULL) checks_done,
      (SELECT COUNT(*) FROM curing_cycle_checks k WHERE k.cycle_id=c.id AND k.deleted_at IS NULL) checks_total,
      COALESCE((SELECT SUM(amount) FROM cost_entries x WHERE x.cycle_id=c.id AND x.deleted_at IS NULL),0) cost
    FROM curing_cycles c JOIN barns b ON b.id=c.barn_id JOIN seasons se ON se.id=c.season_id
    WHERE c.farm_id=? AND c.deleted_at IS NULL ${seasonId ? 'AND c.season_id=?' : ''} ORDER BY c.code DESC`, seasonId ? [ctx.farmId, seasonId] : [ctx.farmId])
    .map(({ fuel, cost, ...r }) => ({ ...r, fuel_used: fuel,
      curing_loss_kg: r.cured_weight_kg != null && r.green_weight_kg != null ? round2(r.green_weight_kg - r.cured_weight_kg) : null,
      recovery_pct: recovery(r.cured_weight_kg, r.green_weight_kg), curing_cost: money ? round2(cost) : null,
      cost_per_kg_cured: money && r.cured_weight_kg ? round2(cost / r.cured_weight_kg) : null }))
}

export interface CycleDashboard {
  summary: CycleSummary; fuel_product: string | null; fuel_unit: string | null; slates: number | null; operator: string | null
  batches: { code: string; field_no: string; green_weight_kg: number }[]
  temp: { current: number | null; min: number | null; max: number | null; last_at: string | null }
  fuel: { opening: number; used: number; remaining: number }
  hours_elapsed: number | null
  logs: { id: string; logged_at: string; temperature_c: number | null; ventilation: string | null; fuel_added_kg: number | null; operator: string | null; remarks: string | null }[]
  checks: ReturnType<typeof listChecks>
}

export function cycleDashboard(ctx: Ctx, id: string): CycleDashboard {
  require(ctx, 'curing.cycle.view')
  const c = cycleOf(ctx, id); const summary = listCycles(ctx).find(s => s.id === id)!
  const cyc = ctx.db.get<{ fuel_input_id: string | null; slates: number | null; operator: string | null; fuel_opening_kg: number | null }>(`SELECT fuel_input_id, slates, operator, fuel_opening_kg FROM curing_cycles WHERE id=?`, [id])!
  const inp = cyc.fuel_input_id ? ctx.db.get<{ name: string; unit: string }>(`SELECT name, unit FROM inputs WHERE id=?`, [cyc.fuel_input_id]) : undefined
  const logs = ctx.db.all<CycleDashboard['logs'][number]>(`SELECT id, logged_at, temperature_c, ventilation, fuel_added_kg, operator, remarks FROM curing_logs WHERE cycle_id=? AND deleted_at IS NULL ORDER BY logged_at DESC`, [id])
  const temps = logs.filter(l => l.temperature_c != null)
  const used = logs.reduce((s, l) => s + (l.fuel_added_kg ?? 0), 0); const opening = cyc.fuel_opening_kg ?? 0
  const end = c.status === 'completed' ? (ctx.db.get<{ o: string }>(`SELECT offloaded_at o FROM curing_cycles WHERE id=?`, [id])?.o ?? null) : new Date().toISOString()
  return { summary, fuel_product: inp?.name ?? null, fuel_unit: inp?.unit ?? null, slates: cyc.slates, operator: cyc.operator,
    batches: ctx.db.all(`SELECT h.code, f.field_no, cb.green_weight_kg FROM cycle_batches cb JOIN harvest_batches h ON h.id=cb.batch_id JOIN fields f ON f.id=h.field_id WHERE cb.cycle_id=? AND cb.deleted_at IS NULL ORDER BY h.code`, [id]),
    temp: { current: temps[0]?.temperature_c ?? null, min: temps.length ? Math.min(...temps.map(t => t.temperature_c!)) : null, max: temps.length ? Math.max(...temps.map(t => t.temperature_c!)) : null, last_at: temps[0]?.logged_at ?? null },
    fuel: { opening, used: round2(used), remaining: round2(opening - used) },
    hours_elapsed: c.loaded_at && end ? Math.round((Date.parse(end) - Date.parse(c.loaded_at)) / 36e5) : null,
    logs, checks: listChecks(ctx, id) }
}

/** Compare barns across a season: recovery % (weighted), fuel per kg cured and cost per kg cured. */
export function barnPerformance(ctx: Ctx, seasonId: string) {
  require(ctx, 'curing.cycle.view')
  const money = can(ctx, 'finance.cost.view')
  const rows = listCycles(ctx, seasonId).filter(c => c.status === 'completed')
  const by = new Map<string, { barn: string; cycles: number; green: number; cured: number; fuel: number; cost: number }>()
  for (const c of rows) { const e = by.get(c.barn_id) ?? { barn: c.barn_code, cycles: 0, green: 0, cured: 0, fuel: 0, cost: 0 }
    e.cycles++; e.green += c.green_weight_kg ?? 0; e.cured += c.cured_weight_kg ?? 0; e.fuel += c.fuel_used; e.cost += c.curing_cost ?? 0; by.set(c.barn_id, e) }
  return [...by.values()].sort((a, b) => a.barn.localeCompare(b.barn)).map(e => ({ barn: e.barn, cycles: e.cycles, green_kg: round2(e.green), cured_kg: round2(e.cured),
    recovery_pct: recovery(e.cured, e.green), fuel_per_kg_cured: e.cured ? round2(e.fuel / e.cured) : null, cost_per_kg_cured: money && e.cured ? round2(e.cost / e.cured) : null }))
}
