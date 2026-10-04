import { type Ctx, require, can, need, isDate, round2 } from './context'
import { currentUnitCost, stockOf } from './inventory'

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
  labour_workers?: number; labour_hours?: number; labour_cost?: number
  machinery_asset?: string; machinery_hours?: number; machinery_fuel_l?: number; machinery_cost?: number
  operator?: string; weather?: string; remarks?: string
  inputs?: { input_id: string; qty: number; rate_note?: string }[]
}

/**
 * Records one field/seedbed activity as a single atomic transaction:
 *   operation + operation_inputs + inventory consumption + cost entries (+ seedbed sowing side-effects).
 * If any step fails (e.g. insufficient stock) nothing is written.
 */
export function recordOperation(ctx: Ctx, i: OperationInput): string {
  require(ctx, 'production.operation.record')
  need(i.op_type?.trim(), 'Operation type is required'); need(isDate(i.occurred_on), 'Valid date required')
  for (const k of ['area_ha', 'labour_workers', 'labour_hours', 'labour_cost', 'machinery_hours', 'machinery_fuel_l', 'machinery_cost'] as const)
    need(i[k] == null || (Number.isFinite(i[k]) && (i[k] as number) >= 0), `${k.replace(/_/g, ' ')} cannot be negative`)
  const lines = i.inputs ?? []
  const seen = new Set<string>()
  for (const l of lines) {
    need(l.qty > 0, 'Input quantity must be greater than zero')
    need(!seen.has(l.input_id), 'Each product may appear only once per operation'); seen.add(l.input_id)
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
      labour_workers: i.labour_workers ?? null, labour_hours: i.labour_hours ?? null, labour_cost: round2(i.labour_cost ?? 0),
      machinery_asset: i.machinery_asset ?? null, machinery_hours: i.machinery_hours ?? null, machinery_fuel_l: i.machinery_fuel_l ?? null,
      machinery_cost: round2(i.machinery_cost ?? 0), operator: i.operator ?? null, weather: i.weather ?? null, remarks: i.remarks ?? null, created_by: actor })

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
    if ((i.labour_cost ?? 0) > 0) db.insert('cost_entries', { ...costBase, category: 'labour', amount: round2(i.labour_cost!), source_type: 'operation_labour', source_id: opId, note: i.op_type })
    if ((i.machinery_cost ?? 0) > 0) db.insert('cost_entries', { ...costBase, category: 'machinery', amount: round2(i.machinery_cost!), source_type: 'operation_machinery', source_id: opId, note: i.machinery_asset ?? i.op_type })

    if (i.target.type === 'seedbed' && /sow/i.test(i.op_type)) {
      const sb = db.get<{ sown_on: string | null; status: string }>(`SELECT sown_on, status FROM seedbeds WHERE id=?`, [i.target.id])!
      if (!sb.sown_on) db.update('seedbeds', i.target.id, { sown_on: i.occurred_on, status: 'sown' })
    }
    db.audit(actor, 'operation.record', 'operations', opId, { type: i.op_type, target: i.target })
    return opId
  })
}

/** Reverses an operation: soft-deletes it, its input lines, the stock consumption and every derived cost. */
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
    for (const c of db.all<{ id: string }>(`SELECT id FROM cost_entries WHERE source_id=? AND source_type IN ('operation_labour','operation_machinery') AND deleted_at IS NULL`, [id])) db.softDelete('cost_entries', c.id)
    db.softDelete('operations', id)
    db.audit(ctx.actor?.id ?? null, 'operation.delete', 'operations', id)
  })
}

export interface OperationRow {
  id: string; occurred_on: string; op_type: string; target_type: string; target_code: string; season_label: string
  labour_hours: number | null; operator: string | null; weather: string | null; remarks: string | null
  inputs: string; cost: number | null
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
       o.labour_hours, o.operator, o.weather, o.remarks,
       COALESCE((SELECT group_concat(i.name || ' ' || oi.qty || ' ' || i.unit, '; ') FROM operation_inputs oi JOIN inputs i ON i.id=oi.input_id
                 WHERE oi.operation_id=o.id AND oi.deleted_at IS NULL),'') AS inputs,
       COALESCE((SELECT SUM(amount) FROM cost_entries c WHERE c.deleted_at IS NULL AND
                 ((c.source_type IN ('operation_labour','operation_machinery') AND c.source_id=o.id) OR
                  (c.source_type='operation_input' AND c.source_id IN (SELECT id FROM operation_inputs WHERE operation_id=o.id)))),0) AS c
     FROM operations o JOIN seasons se ON se.id=o.season_id
     LEFT JOIN seedbeds sb ON sb.id=o.seedbed_id LEFT JOIN fields fl ON fl.id=o.field_id
     WHERE ${where.join(' AND ')} ORDER BY o.occurred_on DESC, o.created_at DESC LIMIT ${Math.min(f.limit ?? 300, 1000)}`, p)
    .map(({ c, ...r }) => ({ ...r, cost: showCost ? round2(c) : null }))
}
