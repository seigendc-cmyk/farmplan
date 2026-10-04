import { type Ctx, require, can, need, isDate, round2 } from './context'
import { addCost, assertSeasonOpen, nonNeg, removeCostsFor } from './util'
import { currentUnitCost, stockOf } from './inventory'

export const MACHINE_KINDS = ['tractor', 'implement', 'vehicle', 'pump', 'generator', 'other'] as const
export const LOG_KINDS = ['use', 'fuel', 'service', 'repair'] as const
export type MachineKind = (typeof MACHINE_KINDS)[number]; export type LogKind = (typeof LOG_KINDS)[number]

export interface MachineInput { name: string; kind?: MachineKind; make_model?: string | null; reg_no?: string | null; purchased_on?: string | null; purchase_cost?: number | null; hourly_rate?: number; service_interval_hours?: number | null; active?: boolean; notes?: string | null
  /** Default fuel product (an inventory input of category fuel) that this machine's fuel is drawn from. */
  fuel_input_id?: string | null }

/** A fuel product must be a fuel-category input of this tenant. */
function fuelProduct(ctx: Ctx, id: string) {
  const f = ctx.db.get<{ name: string; unit: string; category: string }>(`SELECT name, unit, category FROM inputs WHERE id=? AND tenant_id=? AND deleted_at IS NULL`, [id, ctx.tenantId])
  need(f, 'Fuel product not found'); need(f.category === 'fuel', `${f.name} is not a fuel product`); return f
}

function validateMachine(i: MachineInput) {
  need(i.name?.trim(), 'Machine name is required'); need(!i.kind || MACHINE_KINDS.includes(i.kind), 'Unknown machine type')
  nonNeg(i.purchase_cost, 'Purchase cost'); nonNeg(i.hourly_rate, 'Hourly rate'); need(i.service_interval_hours == null || i.service_interval_hours > 0, 'Service interval must be greater than zero')
  need(!i.purchased_on || isDate(i.purchased_on), 'Valid purchase date required')
}
export function createMachine(ctx: Ctx, i: MachineInput): string {
  require(ctx, 'resources.machinery.manage'); validateMachine(i); if (i.fuel_input_id) fuelProduct(ctx, i.fuel_input_id)
  need(!ctx.db.get(`SELECT 1 FROM machines WHERE farm_id=? AND lower(name)=lower(?) AND deleted_at IS NULL`, [ctx.farmId, i.name.trim()]), `A machine called ${i.name.trim()} already exists`)
  return ctx.db.tx(() => { const id = ctx.db.insert('machines', { tenant_id: ctx.tenantId, farm_id: ctx.farmId, name: i.name.trim(), kind: i.kind ?? 'tractor', make_model: i.make_model ?? null, reg_no: i.reg_no ?? null,
    purchased_on: i.purchased_on ?? null, purchase_cost: i.purchase_cost ?? null, hourly_rate: i.hourly_rate ?? 0, service_interval_hours: i.service_interval_hours ?? null, active: i.active === false ? 0 : 1, notes: i.notes ?? null, fuel_input_id: i.fuel_input_id ?? null })
    ctx.db.audit(ctx.actor?.id ?? null, 'machine.create', 'machines', id, { name: i.name }); return id })
}
export function updateMachine(ctx: Ctx, id: string, i: MachineInput) {
  require(ctx, 'resources.machinery.manage'); validateMachine(i); if (i.fuel_input_id) fuelProduct(ctx, i.fuel_input_id)
  need(ctx.db.get(`SELECT 1 FROM machines WHERE id=? AND farm_id=? AND deleted_at IS NULL`, [id, ctx.farmId]), 'Machine not found')
  need(!ctx.db.get(`SELECT 1 FROM machines WHERE farm_id=? AND lower(name)=lower(?) AND id<>? AND deleted_at IS NULL`, [ctx.farmId, i.name.trim(), id]), `A machine called ${i.name.trim()} already exists`)
  ctx.db.tx(() => { ctx.db.update('machines', id, { name: i.name.trim(), kind: i.kind ?? 'tractor', make_model: i.make_model ?? null, reg_no: i.reg_no ?? null, purchased_on: i.purchased_on ?? null, purchase_cost: i.purchase_cost ?? null,
    hourly_rate: i.hourly_rate ?? 0, service_interval_hours: i.service_interval_hours ?? null, active: i.active === false ? 0 : 1, notes: i.notes ?? null,
    ...(i.fuel_input_id !== undefined ? { fuel_input_id: i.fuel_input_id } : {}) }); ctx.db.audit(ctx.actor?.id ?? null, 'machine.update', 'machines', id) })
}
export function deleteMachine(ctx: Ctx, id: string) {
  require(ctx, 'resources.machinery.manage')
  need(!ctx.db.get(`SELECT 1 FROM machine_logs WHERE machine_id=? AND deleted_at IS NULL`, [id]), 'This machine has logged activity; mark it inactive instead')
  ctx.db.tx(() => { ctx.db.softDelete('machines', id); ctx.db.audit(ctx.actor?.id ?? null, 'machine.delete', 'machines', id) })
}

export interface MachineLogInput {
  machine_id: string; season_id: string; kind: LogKind; logged_on: string; field_id?: string | null; hours?: number | null; fuel_l?: number | null; cost?: number; description?: string; operator?: string
  /** Where the litres come from: a fuel product in the store (defaults to the machine's), or null for fuel bought outside the store. */
  input_id?: string | null
  /** Set by recordOperation when the log is one of an operation's machine lines. */
  operation_id?: string | null
  /** Books the cost against this seedbed (machine lines of a seedbed operation). */
  seedbed_id?: string | null
}

/**
 * One log per event. 'use' costs hours × the machine's hourly rate unless a cost is given; 'service' and 'repair' cost what is entered.
 * Litres (a 'fuel' log, or a 'use' log that gives them) are drawn from the store when there is a fuel product, the machine's by default:
 * one consumption at the average cost and a 'fuel' cost of litres × that cost, as curing fuel is. Fuel bought outside the store
 * (input_id null, or a machine with no fuel product) keeps the typed cost and leaves stock alone. Costs book against the field when given.
 */
export function logMachine(ctx: Ctx, i: MachineLogInput): { id: string; cost: number } {
  require(ctx, 'resources.machinery.record')
  need(LOG_KINDS.includes(i.kind), 'Unknown log type'); need(isDate(i.logged_on), 'Valid date required')
  nonNeg(i.hours, 'Hours'); nonNeg(i.fuel_l, 'Fuel'); nonNeg(i.cost, 'Cost')
  if (i.kind === 'use') need(i.hours != null && i.hours > 0, 'Enter the hours used')
  if (i.kind === 'fuel') need(i.fuel_l != null && i.fuel_l > 0, 'Enter the litres')
  if (i.kind === 'service' || i.kind === 'repair') need(i.description?.trim(), 'Describe the work done')
  const m = ctx.db.get<{ hourly_rate: number; active: number; name: string; fuel_input_id: string | null }>(`SELECT hourly_rate, active, name, fuel_input_id FROM machines WHERE id=? AND farm_id=? AND deleted_at IS NULL`, [i.machine_id, ctx.farmId]); need(m, 'Machine not found'); need(m.active, `${m.name} is marked inactive`)
  if (i.field_id) need(ctx.db.get(`SELECT 1 FROM fields WHERE id=? AND farm_id=? AND deleted_at IS NULL`, [i.field_id, ctx.farmId]), 'Field not found')
  assertSeasonOpen(ctx, i.season_id)
  const litres = (i.kind === 'fuel' || i.kind === 'use') ? i.fuel_l ?? 0 : 0
  const fuelId = litres > 0 ? (i.input_id !== undefined ? i.input_id : m.fuel_input_id) : null
  let unit = 0
  if (fuelId) {
    const f = fuelProduct(ctx, fuelId)
    need(i.kind !== 'fuel' || i.cost == null, 'Fuel from the store is costed at its average price: leave the cost empty, or choose "bought outside the store"')
    const onHand = stockOf(ctx, fuelId); need(onHand >= litres, `Insufficient stock of ${f.name}: ${onHand} ${f.unit} on hand, ${litres} requested`)
    unit = currentUnitCost(ctx, fuelId)
  }
  const fuelCost = round2(litres * unit)
  const workCost = round2(i.kind === 'fuel' ? (fuelId ? 0 : i.cost ?? 0) : i.cost ?? (i.kind === 'use' ? (i.hours ?? 0) * m.hourly_rate : 0))
  return ctx.db.tx(() => {
    const id = crypto.randomUUID(); const on = i.logged_on; const actor = ctx.actor?.id ?? null
    const txn = fuelId ? ctx.db.insert('inventory_transactions', { tenant_id: ctx.tenantId, farm_id: ctx.farmId, input_id: fuelId, kind: 'consumption', qty_delta: -litres, unit_cost: unit,
      occurred_on: on, source_type: 'machine_log', source_id: id, created_by: actor }) : null
    ctx.db.insert('machine_logs', { id, tenant_id: ctx.tenantId, farm_id: ctx.farmId, season_id: i.season_id, machine_id: i.machine_id, field_id: i.field_id ?? null, kind: i.kind, logged_on: on,
      hours: i.hours ?? null, fuel_l: i.fuel_l ?? null, cost: round2(workCost + fuelCost), description: i.description?.trim() || null, operator: i.operator ?? ctx.actor?.name ?? null, created_by: actor,
      input_id: fuelId, fuel_txn_id: txn, operation_id: i.operation_id ?? null })
    const note = `${m.name} — ${i.kind}${i.description ? `: ${i.description.trim()}` : ''}`
    addCost(ctx, { seasonId: i.season_id, category: i.kind === 'fuel' ? 'fuel' : 'machinery', amount: workCost, on, sourceType: 'machine_log', sourceId: id, fieldId: i.field_id ?? null, seedbedId: i.seedbed_id ?? null, note })
    addCost(ctx, { seasonId: i.season_id, category: 'fuel', amount: fuelCost, on, sourceType: 'machine_fuel', sourceId: id, fieldId: i.field_id ?? null, seedbedId: i.seedbed_id ?? null, note: `${m.name} — ${litres} L from the store` })
    ctx.db.audit(actor, 'machine.log', 'machine_logs', id, { machine: m.name, kind: i.kind }); return { id, cost: round2(workCost + fuelCost) }
  })
}
/** Soft-deletes a log with its costs and, for fuel from the store, its stock movement (the litres go back on hand). Call inside a transaction. */
export function removeMachineLog(ctx: Ctx, id: string) {
  const l = ctx.db.get<{ fuel_txn_id: string | null }>(`SELECT fuel_txn_id FROM machine_logs WHERE id=?`, [id])
  ctx.db.softDelete('machine_logs', id); removeCostsFor(ctx, [id]); if (l?.fuel_txn_id) ctx.db.softDelete('inventory_transactions', l.fuel_txn_id)
}
export function deleteMachineLog(ctx: Ctx, id: string) {
  require(ctx, 'resources.machinery.record')
  const l = ctx.db.get<{ season_id: string }>(`SELECT season_id FROM machine_logs WHERE id=? AND farm_id=? AND deleted_at IS NULL`, [id, ctx.farmId]); need(l, 'Entry not found'); assertSeasonOpen(ctx, l.season_id)
  ctx.db.tx(() => { removeMachineLog(ctx, id); ctx.db.audit(ctx.actor?.id ?? null, 'machine.log.delete', 'machine_logs', id) })
}

export interface MachineRow {
  id: string; name: string; kind: MachineKind; make_model: string | null; reg_no: string | null; hourly_rate: number; service_interval_hours: number | null; active: number; purchase_cost: number | null; fuel_input_id: string | null; fuel_name: string | null
  total_hours: number; fuel_l: number; l_per_hour: number | null; cost: number | null; cost_per_hour: number | null; last_service_on: string | null; hours_since_service: number | null; service_due: boolean
}
/** Lifetime usage per machine. Service is due once hours since the last service reach the interval (or since first use, if never serviced). */
export function listMachines(ctx: Ctx, f: { seasonId?: string } = {}): MachineRow[] {
  require(ctx, 'resources.machinery.view'); const showCost = can(ctx, 'finance.cost.view')
  const ms = ctx.db.all<Omit<MachineRow, 'total_hours' | 'fuel_l' | 'l_per_hour' | 'cost' | 'cost_per_hour' | 'last_service_on' | 'hours_since_service' | 'service_due'>>(`SELECT m.id,m.name,m.kind,m.make_model,m.reg_no,m.hourly_rate,m.service_interval_hours,m.active,m.purchase_cost,m.fuel_input_id,i.name fuel_name
      FROM machines m LEFT JOIN inputs i ON i.id=m.fuel_input_id WHERE m.farm_id=? AND m.deleted_at IS NULL ORDER BY m.active DESC, m.name`, [ctx.farmId])
  return ms.map(m => {
    const w = f.seasonId ? ' AND season_id=?' : ''; const p: (string | number)[] = f.seasonId ? [m.id, f.seasonId] : [m.id]
    const t = ctx.db.get<{ h: number; fl: number; c: number; fh: number }>(`SELECT COALESCE(SUM(hours),0) h, COALESCE(SUM(fuel_l),0) fl, COALESCE(SUM(cost),0) c,
      COALESCE(SUM(CASE WHEN kind='use' THEN hours END),0) fh FROM machine_logs WHERE machine_id=? AND deleted_at IS NULL${w}`, p)!
    const hours = ctx.db.get<{ h: number }>(`SELECT COALESCE(SUM(hours),0) h FROM machine_logs WHERE machine_id=? AND kind='use' AND deleted_at IS NULL${w}`, p)!.h
    const ls = ctx.db.get<{ d: string | null }>(`SELECT MAX(logged_on) d FROM machine_logs WHERE machine_id=? AND kind='service' AND deleted_at IS NULL`, [m.id])!.d
    const since = ctx.db.get<{ h: number }>(`SELECT COALESCE(SUM(hours),0) h FROM machine_logs WHERE machine_id=? AND kind='use' AND deleted_at IS NULL${ls ? ' AND logged_on > ?' : ''}`, ls ? [m.id, ls] : [m.id])!.h
    return { ...m, total_hours: round2(hours), fuel_l: round2(t.fl), l_per_hour: hours ? round2(t.fl / hours) : null, cost: showCost ? round2(t.c) : null, cost_per_hour: showCost && hours ? round2(t.c / hours) : null,
      last_service_on: ls, hours_since_service: round2(since), service_due: m.service_interval_hours != null && since >= m.service_interval_hours }
  })
}

export interface MachineLogRow { id: string; logged_on: string; machine: string; kind: LogKind; field_no: string | null; hours: number | null; fuel_l: number | null; cost: number | null; description: string | null; operator: string | null; season_label: string
  /** The store product the litres were drawn from; null when there were none or they were bought outside the store. */
  fuel_name: string | null; operation_id: string | null; operation: string | null }
export function listMachineLogs(ctx: Ctx, f: { seasonId?: string; machineId?: string; limit?: number } = {}): MachineLogRow[] {
  require(ctx, 'resources.machinery.view'); const where = ['l.farm_id=?', 'l.deleted_at IS NULL']; const p: (string | number)[] = [ctx.farmId]
  if (f.seasonId) { where.push('l.season_id=?'); p.push(f.seasonId) }; if (f.machineId) { where.push('l.machine_id=?'); p.push(f.machineId) }
  const showCost = can(ctx, 'finance.cost.view')
  return ctx.db.all<MachineLogRow>(`SELECT l.id, l.logged_on, m.name machine, l.kind, fl.field_no, l.hours, l.fuel_l, l.cost, l.description, l.operator, se.label season_label, fi.name fuel_name, l.operation_id,
      CASE WHEN o.id IS NULL THEN NULL ELSE o.op_type || ' (' || o.occurred_on || ')' END operation FROM machine_logs l
    JOIN machines m ON m.id=l.machine_id JOIN seasons se ON se.id=l.season_id LEFT JOIN fields fl ON fl.id=l.field_id LEFT JOIN inputs fi ON fi.id=l.input_id
    LEFT JOIN operations o ON o.id=l.operation_id WHERE ${where.join(' AND ')} ORDER BY l.logged_on DESC, l.created_at DESC LIMIT ${Math.min(f.limit ?? 300, 1000)}`, p)
    .map(r => ({ ...r, cost: showCost ? r.cost : null }))
}
