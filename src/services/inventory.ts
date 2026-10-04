import { type Ctx, require, need, isDate, round2, round4 } from './context'

export const INPUT_CATEGORIES = ['seed', 'fertilizer', 'chemical', 'fuel', 'packaging', 'other'] as const
export type InputCategory = typeof INPUT_CATEGORIES[number]

export interface InputRow {
  id: string; name: string; category: InputCategory; unit: string; supplier: string | null; default_unit_cost: number
  application_notes: string | null; safety_notes: string | null; active: number; on_hand: number; avg_cost: number; next_expiry: string | null
  /** Stock level (in the input's unit) at or below which the Dashboard says "low"; null when not tracked. */
  reorder_level: number | null
}

export function listInputs(ctx: Ctx): InputRow[] {
  require(ctx, 'resources.inventory.view')
  return ctx.db.all<InputRow>(`
    SELECT i.*,
      COALESCE((SELECT SUM(qty_delta) FROM inventory_transactions t WHERE t.input_id=i.id AND t.farm_id=? AND t.deleted_at IS NULL),0) AS on_hand,
      COALESCE((SELECT SUM(qty_delta*unit_cost)/NULLIF(SUM(qty_delta),0) FROM inventory_transactions t
                WHERE t.input_id=i.id AND t.farm_id=? AND t.deleted_at IS NULL AND t.qty_delta>0), i.default_unit_cost) AS avg_cost,
      (SELECT MIN(expiry_date) FROM inventory_transactions t WHERE t.input_id=i.id AND t.deleted_at IS NULL AND t.expiry_date IS NOT NULL AND t.kind='purchase') AS next_expiry
    FROM inputs i WHERE i.tenant_id=? AND i.deleted_at IS NULL ORDER BY i.category, i.name`, [ctx.farmId, ctx.farmId, ctx.tenantId])
}

export function stockOf(ctx: Ctx, inputId: string): number {
  return ctx.db.get<{ q: number }>(`SELECT COALESCE(SUM(qty_delta),0) q FROM inventory_transactions WHERE input_id=? AND farm_id=? AND deleted_at IS NULL`, [inputId, ctx.farmId])!.q
}

/** Moving weighted-average cost of everything received, falling back to the catalogue price. */
export function currentUnitCost(ctx: Ctx, inputId: string): number {
  const r = ctx.db.get<{ c: number | null }>(`SELECT SUM(qty_delta*unit_cost)/NULLIF(SUM(qty_delta),0) c FROM inventory_transactions
    WHERE input_id=? AND farm_id=? AND deleted_at IS NULL AND qty_delta>0`, [inputId, ctx.farmId])
  if (r?.c != null) return round4(r.c)
  return ctx.db.get<{ d: number }>(`SELECT default_unit_cost d FROM inputs WHERE id=?`, [inputId])?.d ?? 0
}

export interface InputInput {
  name: string; category: InputCategory; unit: string; supplier?: string; default_unit_cost?: number
  application_notes?: string; safety_notes?: string; reorder_level?: number | null
}
const reorderOk = (v: number | null | undefined) => need(v == null || (Number.isFinite(v) && v >= 0), 'Reorder level cannot be negative')

export function createInput(ctx: Ctx, i: InputInput): string {
  require(ctx, 'resources.inventory.manage')
  need(i.name.trim(), 'Product name is required'); need(i.unit.trim(), 'Unit is required')
  need(INPUT_CATEGORIES.includes(i.category), 'Invalid category')
  need((i.default_unit_cost ?? 0) >= 0, 'Price cannot be negative'); reorderOk(i.reorder_level)
  need(!ctx.db.get(`SELECT 1 FROM inputs WHERE tenant_id=? AND name=? AND deleted_at IS NULL`, [ctx.tenantId, i.name.trim()]), `${i.name} already exists in the catalogue`)
  return ctx.db.tx(() => {
    const id = ctx.db.insert('inputs', { tenant_id: ctx.tenantId, name: i.name.trim(), category: i.category, unit: i.unit.trim(),
      supplier: i.supplier ?? null, default_unit_cost: i.default_unit_cost ?? 0, application_notes: i.application_notes ?? null, safety_notes: i.safety_notes ?? null, reorder_level: i.reorder_level ?? null })
    ctx.db.audit(ctx.actor?.id ?? null, 'input.create', 'inputs', id)
    return id
  })
}

export function updateInput(ctx: Ctx, id: string, i: InputInput & { active?: boolean }) {
  require(ctx, 'resources.inventory.manage')
  need(i.name.trim() && i.unit.trim(), 'Name and unit are required'); reorderOk(i.reorder_level)
  need(!ctx.db.get(`SELECT 1 FROM inputs WHERE tenant_id=? AND name=? AND id<>? AND deleted_at IS NULL`, [ctx.tenantId, i.name.trim(), id]), `${i.name} already exists`)
  ctx.db.tx(() => {
    ctx.db.update('inputs', id, { name: i.name.trim(), category: i.category, unit: i.unit.trim(), supplier: i.supplier ?? null,
      default_unit_cost: i.default_unit_cost ?? 0, application_notes: i.application_notes ?? null, safety_notes: i.safety_notes ?? null,
      active: i.active === false ? 0 : 1, ...(i.reorder_level !== undefined ? { reorder_level: i.reorder_level } : {}) })
    ctx.db.audit(ctx.actor?.id ?? null, 'input.update', 'inputs', id)
  })
}

export function recordPurchase(ctx: Ctx, i: { input_id: string; qty: number; unit_cost: number; occurred_on: string; batch_ref?: string; expiry_date?: string; note?: string }): string {
  require(ctx, 'resources.inventory.manage')
  need(i.qty > 0, 'Quantity must be greater than zero'); need(i.unit_cost >= 0, 'Unit cost cannot be negative')
  need(isDate(i.occurred_on), 'Valid purchase date required'); need(!i.expiry_date || isDate(i.expiry_date), 'Invalid expiry date')
  need(ctx.db.get(`SELECT 1 FROM inputs WHERE id=? AND tenant_id=? AND deleted_at IS NULL`, [i.input_id, ctx.tenantId]), 'Unknown product')
  return ctx.db.tx(() => {
    const id = ctx.db.insert('inventory_transactions', { tenant_id: ctx.tenantId, farm_id: ctx.farmId, input_id: i.input_id, kind: 'purchase',
      qty_delta: i.qty, unit_cost: i.unit_cost, batch_ref: i.batch_ref ?? null, expiry_date: i.expiry_date ?? null, occurred_on: i.occurred_on,
      note: i.note ?? null, created_by: ctx.actor?.id ?? null })
    ctx.db.audit(ctx.actor?.id ?? null, 'inventory.purchase', 'inventory_transactions', id, { qty: i.qty, unit_cost: i.unit_cost })
    return id
  })
}

/** Stock-take correction. Positive or negative; a reason is mandatory and the balance can never go below zero. */
export function recordAdjustment(ctx: Ctx, i: { input_id: string; qty_delta: number; occurred_on: string; note: string }): string {
  require(ctx, 'resources.inventory.manage')
  need(i.qty_delta !== 0, 'Adjustment cannot be zero'); need(i.note.trim(), 'A reason is required for stock adjustments')
  need(isDate(i.occurred_on), 'Valid date required')
  need(stockOf(ctx, i.input_id) + i.qty_delta >= 0, 'Adjustment would make stock negative')
  return ctx.db.tx(() => {
    const id = ctx.db.insert('inventory_transactions', { tenant_id: ctx.tenantId, farm_id: ctx.farmId, input_id: i.input_id, kind: 'adjustment',
      qty_delta: i.qty_delta, unit_cost: currentUnitCost(ctx, i.input_id), occurred_on: i.occurred_on, note: i.note.trim(), created_by: ctx.actor?.id ?? null })
    ctx.db.audit(ctx.actor?.id ?? null, 'inventory.adjust', 'inventory_transactions', id, { delta: i.qty_delta, reason: i.note })
    return id
  })
}

export function stockValue(ctx: Ctx): number {
  return round2(listInputs(ctx).reduce((s, r) => s + Math.max(0, r.on_hand) * r.avg_cost, 0))
}

export function listTransactions(ctx: Ctx, inputId?: string) {
  require(ctx, 'resources.inventory.view')
  return ctx.db.all<{ id: string; input_name: string; unit: string; kind: string; qty_delta: number; unit_cost: number; occurred_on: string; batch_ref: string | null; note: string | null }>(
    `SELECT t.id, i.name input_name, i.unit, t.kind, t.qty_delta, t.unit_cost, t.occurred_on, t.batch_ref, t.note
     FROM inventory_transactions t JOIN inputs i ON i.id=t.input_id
     WHERE t.farm_id=? AND t.deleted_at IS NULL ${inputId ? 'AND t.input_id=?' : ''}
     ORDER BY t.occurred_on DESC, t.created_at DESC LIMIT 500`, inputId ? [ctx.farmId, inputId] : [ctx.farmId])
}
