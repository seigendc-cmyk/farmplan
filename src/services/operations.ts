import { type Ctx, require, can, need, isDate, round2 } from './context'
import { currentUnitCost, stockOf } from './inventory'
import { recordLabour } from './labour'
import { logMachine, removeMachineLog } from './machinery'
import { removeCostsFor } from './util'

export const OPERATION_TYPES: Record<'seedbed' | 'land_prep' | 'field', string[]> = {
  seedbed: ['Bed preparation', 'Sowing', 'Fertilizer', 'Chemical application', 'Watering', 'Weeding', 'Thinning', 'Clipping',
    'Pest control', 'Disease control', 'Seedling selection', 'Hardening', 'Other'],
  land_prep: ['Clearing', 'Ripping', 'Ploughing', 'Discing', 'Harrowing', 'Ridging', 'Fertilizer application', 'Other preparation'],
  field: ['Weeding', 'Fertilizing', 'Spraying', 'Irrigation', 'Pest scouting', 'Disease scouting', 'Topping', 'Suckering', 'Clipping',
    'Cultivation', 'Other'],
}

const COST_CATEGORY: Record<string, string> = { seed: 'seed', fertilizer: 'fertilizer', chemical: 'chemicals', fuel: 'fuel', packaging: 'baling', other: 'overhead' }

export interface OperationInput {
  target: { type: 'seedbed' | 'field'; id: string }
  season_id?: string
  op_type: string
  phase?: 'seedbed' | 'land_prep' | 'field'
  occurred_on: string
  area_ha?: number
  /** Retired: kept only on operations recorded before schema v14. New operations use `workers` and `machines`; a value here is refused. */
  labour_workers?: number; labour_hours?: number; labour_cost?: number
  /** Retired, as above. */
  machinery_asset?: string; machinery_hours?: number; machinery_fuel_l?: number; machinery_cost?: number
  operator?: string; weather?: string; remarks?: string
  inputs?: { input_id: string; qty: number; rate_note?: string }[]
  /** Each line becomes a labour entry linked to the operation; its pay is the labour cost. */
  workers?: { worker_name: string; hours?: number | null; pay?: number }[]
  /** Each line becomes a machine 'use' log linked to the operation (hours × the machine's rate); litres are drawn from its fuel product. */
  machines?: { machine_id: string; hours: number; fuel_l?: number | null; input_id?: string | null }[]
}
const RETIRED = ['labour_workers', 'labour_hours', 'labour_cost', 'machinery_asset', 'machinery_hours', 'machinery_fuel_l', 'machinery_cost'] as const

/**
 * Records one field/seedbed activity as a single atomic transaction:
 *   operation + operation_inputs + inventory consumption + cost entries + linked labour entries and machine logs (+ seedbed sowing side-effects).
 * Labour and machinery cost come only from the linked entries and logs, so the same work can never be booked twice.
 * If any step fails (e.g. insufficient stock of a product or of a machine's fuel) nothing is written.
 */
export function recordOperation(ctx: Ctx, i: OperationInput): string {
  require(ctx, 'production.operation.record')
  need(i.op_type?.trim(), 'Operation type is required'); need(isDate(i.occurred_on), 'Valid date required')
  need(i.area_ha == null || (Number.isFinite(i.area_ha) && i.area_ha >= 0), 'area ha cannot be negative')
  need(RETIRED.every(k => i[k] == null || i[k] === '' || i[k] === 0), 'Record people as worker lines and machine work as machine lines; the old labour and machinery boxes are kept only on earlier operations')
  const workers = i.workers ?? []; const machines = i.machines ?? []
  if (workers.length) require(ctx, 'resources.labour.record')
  if (machines.length) require(ctx, 'resources.machinery.record')
  for (const w of workers) { need(w.worker_name?.trim(), 'Each worker line needs a name'); need(w.hours == null || w.hours >= 0, 'Hours cannot be negative'); need((w.pay ?? 0) >= 0, 'Pay cannot be negative') }
  for (const m of machines) { need(m.machine_id, 'Choose the machine on each machine line'); need(m.hours > 0, 'Enter the hours on each machine line'); need(m.fuel_l == null || m.fuel_l >= 0, 'Litres cannot be negative') }
  const lines = i.inputs ?? []
  const seen = new Set<string>()
  for (const l of lines) {
    need(l.qty > 0, 'Input quantity must be greater than zero')
    need(!seen.has(l.input_id), 'Each product may appear only once per operation'); seen.add(l.input_id)
  }

  // Diesel goes on the machine line when a machine used it; an input line for the same fuel would draw and cost it a second time.
  if (machines.some(m => (m.fuel_l ?? 0) > 0)) for (const l of lines) {
    const c = ctx.db.get<{ category: string; name: string }>(`SELECT category, name FROM inputs WHERE id=? AND tenant_id=?`, [l.input_id, ctx.tenantId])
    need(c?.category !== 'fuel', `${c?.name ?? 'Fuel'} is a fuel: put the litres on the machine line instead of adding it as an input`)
  }

  let seasonId = i.season_id; let phase = i.phase
  if (i.target.type === 'seedbed') {
    const sb = ctx.db.get<{ season_id: string; sown_on: string | null }>(`SELECT season_id, sown_on FROM seedbeds WHERE id=? AND farm_id=? AND deleted_at IS NULL`, [i.target.id, ctx.farmId])
    need(sb, 'Seedbed not found'); seasonId = sb.season_id; phase = 'seedbed'
  } else {
    need(ctx.db.get(`SELECT 1 FROM fields WHERE id=? AND farm_id=? AND deleted_at IS NULL`, [i.target.id, ctx.farmId]), 'Field not found')
    need(seasonId, 'Select a season for this field operation'); phase = phase ?? 'field'
  }
  need(ctx.db.get(`SELECT 1 FROM seasons WHERE id=? AND farm_id=? AND deleted_at IS NULL`, [seasonId!, ctx.farmId]), 'Season not found')
  const season = ctx.db.get<{ status: string }>(`SELECT status FROM seasons WHERE id=?`, [seasonId!])!
  need(season.status !== 'closed', 'This season is closed; reopen it to record further activity')

  return ctx.db.tx(() => {
    const db = ctx.db; const actor = ctx.actor?.id ?? null
    const opId = db.insert('operations', {
      tenant_id: ctx.tenantId, farm_id: ctx.farmId, season_id: seasonId!, target_type: i.target.type,
      seedbed_id: i.target.type === 'seedbed' ? i.target.id : null, field_id: i.target.type === 'field' ? i.target.id : null,
      op_type: i.op_type.trim(), phase: phase!, occurred_on: i.occurred_on, area_ha: i.area_ha ?? null,
      operator: i.operator ?? null, weather: i.weather ?? null, remarks: i.remarks ?? null, created_by: actor })

    const costBase = { tenant_id: ctx.tenantId, farm_id: ctx.farmId, season_id: seasonId!, occurred_on: i.occurred_on,
      seedbed_id: i.target.type === 'seedbed' ? i.target.id : null, field_id: i.target.type === 'field' ? i.target.id : null }

    for (const l of lines) {
      const inp = db.get<{ name: string; category: string; unit: string }>(`SELECT name,category,unit FROM inputs WHERE id=? AND tenant_id=? AND deleted_at IS NULL`, [l.input_id, ctx.tenantId])
      need(inp, 'Unknown product')
      const onHand = stockOf(ctx, l.input_id)
      need(onHand >= l.qty, `Insufficient stock of ${inp.name}: ${onHand} ${inp.unit} on hand, ${l.qty} requested`)
      const unitCost = currentUnitCost(ctx, l.input_id)
      const txn = db.insert('inventory_transactions', { tenant_id: ctx.tenantId, farm_id: ctx.farmId, input_id: l.input_id, kind: 'consumption',
        qty_delta: -l.qty, unit_cost: unitCost, occurred_on: i.occurred_on, source_type: 'operation', source_id: opId, created_by: actor })
      const oi = db.insert('operation_inputs', { tenant_id: ctx.tenantId, operation_id: opId, input_id: l.input_id, qty: l.qty,
        rate_note: l.rate_note ?? null, unit_cost: unitCost, inventory_txn_id: txn })
      db.insert('cost_entries', { ...costBase, category: COST_CATEGORY[inp.category] ?? 'overhead', amount: round2(l.qty * unitCost),
        source_type: 'operation_input', source_id: oi, note: `${inp.name} × ${l.qty} ${inp.unit}` })
    }
    const fieldId = i.target.type === 'field' ? i.target.id : null; const seedbedId = i.target.type === 'seedbed' ? i.target.id : null
    for (const w of workers) recordLabour(ctx, { season_id: seasonId!, field_id: fieldId, worked_on: i.occurred_on, worker_name: w.worker_name, task: i.op_type.trim(), hours: w.hours ?? null, pay_amount: w.pay ?? 0, operation_id: opId, seedbed_id: seedbedId })
    for (const m of machines) logMachine(ctx, { machine_id: m.machine_id, season_id: seasonId!, kind: 'use', logged_on: i.occurred_on, field_id: fieldId, hours: m.hours, fuel_l: m.fuel_l ?? null,
      ...(m.input_id !== undefined ? { input_id: m.input_id } : {}), operator: i.operator, description: i.op_type.trim(), operation_id: opId, seedbed_id: seedbedId })

    if (i.target.type === 'seedbed' && /sow/i.test(i.op_type)) {
      const sb = db.get<{ sown_on: string | null; status: string }>(`SELECT sown_on, status FROM seedbeds WHERE id=?`, [i.target.id])!
      if (!sb.sown_on) db.update('seedbeds', i.target.id, { sown_on: i.occurred_on, status: 'sown' })
    }
    db.audit(actor, 'operation.record', 'operations', opId, { type: i.op_type, target: i.target })
    return opId
  })
}

/** Reverses an operation: soft-deletes it, its input lines, its linked labour entries and machine logs, every stock movement and every derived cost. */
export function deleteOperation(ctx: Ctx, id: string) {
  require(ctx, 'production.operation.delete')
  const op = ctx.db.get<{ id: string; season_id: string }>(`SELECT id, season_id FROM operations WHERE id=? AND farm_id=? AND deleted_at IS NULL`, [id, ctx.farmId])
  need(op, 'Operation not found')
  need(ctx.db.get<{ status: string }>(`SELECT status FROM seasons WHERE id=?`, [op.season_id])!.status !== 'closed', 'Season is closed')
  ctx.db.tx(() => {
    const db = ctx.db
    for (const oi of db.all<{ id: string; inventory_txn_id: string | null }>(`SELECT id, inventory_txn_id FROM operation_inputs WHERE operation_id=? AND deleted_at IS NULL`, [id])) {
      for (const c of db.all<{ id: string }>(`SELECT id FROM cost_entries WHERE source_type='operation_input' AND source_id=? AND deleted_at IS NULL`, [oi.id])) db.softDelete('cost_entries', c.id)
      if (oi.inventory_txn_id) db.softDelete('inventory_transactions', oi.inventory_txn_id)
      db.softDelete('operation_inputs', oi.id)
    }
    for (const c of db.all<{ id: string }>(`SELECT id FROM cost_entries WHERE source_id=? AND source_type IN ('operation_labour','operation_machinery') AND deleted_at IS NULL`, [id])) db.softDelete('cost_entries', c.id)   // operations recorded before v14
    for (const l of db.all<{ id: string }>(`SELECT id FROM labour_entries WHERE operation_id=? AND deleted_at IS NULL`, [id])) { db.softDelete('labour_entries', l.id); removeCostsFor(ctx, [l.id]) }
    for (const m of db.all<{ id: string }>(`SELECT id FROM machine_logs WHERE operation_id=? AND deleted_at IS NULL`, [id])) removeMachineLog(ctx, m.id)
    db.softDelete('operations', id)
    db.audit(ctx.actor?.id ?? null, 'operation.delete', 'operations', id)
  })
}

export interface OperationRow {
  id: string; occurred_on: string; op_type: string; target_type: string; target_code: string; season_label: string
  labour_hours: number | null; operator: string | null; weather: string | null; remarks: string | null
  inputs: string; cost: number | null
  /** Linked worker and machine lines, e.g. "Tendai 8 h; Rudo 8 h" and "MF 375 3 h, 20 L". */
  workers: string; machines: string
  /** For operations recorded before v14: the old free-text machinery entry, which never counted towards machine hours. */
  legacy_machinery: string | null
}

export function listOperations(ctx: Ctx, f: { seasonId?: string; targetType?: 'seedbed' | 'field'; targetId?: string; limit?: number } = {}): OperationRow[] {
  require(ctx, 'production.operation.view')
  const where = ['o.farm_id=?', 'o.deleted_at IS NULL']; const p: (string | number)[] = [ctx.farmId]
  if (f.seasonId) { where.push('o.season_id=?'); p.push(f.seasonId) }
  if (f.targetType === 'seedbed' && f.targetId) { where.push('o.seedbed_id=?'); p.push(f.targetId) }
  if (f.targetType === 'field' && f.targetId) { where.push('o.field_id=?'); p.push(f.targetId) }
  const showCost = can(ctx, 'finance.cost.view')
  return ctx.db.all<OperationRow & { c: number }>(
    `SELECT o.id, o.occurred_on, o.op_type, o.target_type, COALESCE(sb.code, fl.field_no) AS target_code, se.label AS season_label,
       COALESCE(o.labour_hours, (SELECT SUM(hours) FROM labour_entries le WHERE le.operation_id=o.id AND le.deleted_at IS NULL)) AS labour_hours, o.operator, o.weather, o.remarks,
       COALESCE((SELECT group_concat(le.worker_name || CASE WHEN le.hours IS NULL THEN '' ELSE ' ' || printf('%g', le.hours) || ' h' END, '; ') FROM labour_entries le WHERE le.operation_id=o.id AND le.deleted_at IS NULL),'') AS workers,
       COALESCE((SELECT group_concat(m.name || CASE WHEN ml.hours IS NULL THEN '' ELSE ' ' || printf('%g', ml.hours) || ' h' END || CASE WHEN ml.fuel_l IS NULL THEN '' ELSE ', ' || printf('%g', ml.fuel_l) || ' L' END, '; ') FROM machine_logs ml JOIN machines m ON m.id=ml.machine_id
                 WHERE ml.operation_id=o.id AND ml.deleted_at IS NULL),'') AS machines,
       CASE WHEN o.machinery_asset IS NULL AND o.machinery_hours IS NULL AND o.machinery_fuel_l IS NULL THEN NULL
            ELSE TRIM(COALESCE(o.machinery_asset, 'machine') || CASE WHEN o.machinery_hours IS NULL THEN '' ELSE ' ' || printf('%g', o.machinery_hours) || ' h' END || CASE WHEN o.machinery_fuel_l IS NULL THEN '' ELSE ', ' || printf('%g', o.machinery_fuel_l) || ' L' END) END AS legacy_machinery,
       COALESCE((SELECT group_concat(i.name || ' ' || oi.qty || ' ' || i.unit, '; ') FROM operation_inputs oi JOIN inputs i ON i.id=oi.input_id
                 WHERE oi.operation_id=o.id AND oi.deleted_at IS NULL),'') AS inputs,
       COALESCE((SELECT SUM(amount) FROM cost_entries c WHERE c.deleted_at IS NULL AND
                 ((c.source_type IN ('operation_labour','operation_machinery') AND c.source_id=o.id) OR
                  (c.source_type='operation_input' AND c.source_id IN (SELECT id FROM operation_inputs WHERE operation_id=o.id)) OR
                  c.source_id IN (SELECT id FROM labour_entries WHERE operation_id=o.id) OR c.source_id IN (SELECT id FROM machine_logs WHERE operation_id=o.id))),0) AS c
     FROM operations o JOIN seasons se ON se.id=o.season_id
     LEFT JOIN seedbeds sb ON sb.id=o.seedbed_id LEFT JOIN fields fl ON fl.id=o.field_id
     WHERE ${where.join(' AND ')} ORDER BY o.occurred_on DESC, o.created_at DESC LIMIT ${Math.min(f.limit ?? 300, 1000)}`, p)
    .map(({ c, ...r }) => ({ ...r, cost: showCost ? round2(c) : null }))
}
