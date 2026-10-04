import { type Ctx, require, can, need, isDate, round2 } from './context'
import { addCost, assertSeasonOpen, nonNeg, removeCostsFor } from './util'

export interface LabourInput { season_id: string; field_id?: string | null; worked_on: string; worker_name: string; task: string; hours?: number | null; pay_amount?: number; remarks?: string }

/** One labour entry per worker per task per day. Pay becomes a 'labour' cost against the season (and field, when given). */
export function recordLabour(ctx: Ctx, i: LabourInput): string {
  require(ctx, 'resources.labour.record')
  need(isDate(i.worked_on), 'Valid date required'); need(i.worker_name?.trim(), 'Worker name is required'); need(i.task?.trim(), 'Task is required')
  nonNeg(i.hours, 'Hours'); nonNeg(i.pay_amount, 'Pay')
  if (i.field_id) need(ctx.db.get(`SELECT 1 FROM fields WHERE id=? AND farm_id=? AND deleted_at IS NULL`, [i.field_id, ctx.farmId]), 'Field not found')
  assertSeasonOpen(ctx, i.season_id)
  return ctx.db.tx(() => {
    const id = ctx.db.insert('labour_entries', { tenant_id: ctx.tenantId, farm_id: ctx.farmId, season_id: i.season_id, field_id: i.field_id ?? null, worked_on: i.worked_on,
      worker_name: i.worker_name.trim(), task: i.task.trim(), hours: i.hours ?? null, pay_amount: round2(i.pay_amount ?? 0), remarks: i.remarks ?? null, created_by: ctx.actor?.id ?? null })
    addCost(ctx, { seasonId: i.season_id, category: 'labour', amount: i.pay_amount ?? 0, on: i.worked_on, sourceType: 'labour_entry', sourceId: id, fieldId: i.field_id ?? null, note: `${i.worker_name.trim()} — ${i.task.trim()}` })
    ctx.db.audit(ctx.actor?.id ?? null, 'labour.record', 'labour_entries', id, { worker: i.worker_name, task: i.task })
    return id
  })
}

export function deleteLabour(ctx: Ctx, id: string) {
  require(ctx, 'resources.labour.record')
  const r = ctx.db.get<{ season_id: string }>(`SELECT season_id FROM labour_entries WHERE id=? AND farm_id=? AND deleted_at IS NULL`, [id, ctx.farmId])
  need(r, 'Entry not found'); assertSeasonOpen(ctx, r.season_id)
  ctx.db.tx(() => { ctx.db.softDelete('labour_entries', id); removeCostsFor(ctx, [id]); ctx.db.audit(ctx.actor?.id ?? null, 'labour.delete', 'labour_entries', id) })
}

export interface LabourRow { id: string; worked_on: string; worker_name: string; task: string; field_no: string | null; hours: number | null; pay_amount: number | null; remarks: string | null; season_label: string }
export function listLabour(ctx: Ctx, f: { seasonId?: string; limit?: number } = {}): LabourRow[] {
  require(ctx, 'resources.labour.view')
  const where = ['l.farm_id=?', 'l.deleted_at IS NULL']; const p: (string | number)[] = [ctx.farmId]
  if (f.seasonId) { where.push('l.season_id=?'); p.push(f.seasonId) }
  const pay = can(ctx, 'finance.cost.view')
  return ctx.db.all<LabourRow>(`SELECT l.id, l.worked_on, l.worker_name, l.task, fl.field_no, l.hours, l.pay_amount, l.remarks, se.label season_label FROM labour_entries l
    JOIN seasons se ON se.id=l.season_id LEFT JOIN fields fl ON fl.id=l.field_id WHERE ${where.join(' AND ')} ORDER BY l.worked_on DESC, l.created_at DESC LIMIT ${Math.min(f.limit ?? 300, 1000)}`, p)
    .map(r => ({ ...r, pay_amount: pay ? r.pay_amount : null }))
}
