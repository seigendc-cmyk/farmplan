import type { Ctx } from './context'
import { need, round2 } from './context'
import { deviceTag } from './device'

/**
 * Next sequential code such as H-00034 within a farm. Counts soft-deleted rows so codes are never reused.
 * A device that joined the farm through the cloud carries a tag, so its codes read H-B-00007 and can never collide with
 * another device's, even when both record offline.
 */
export function nextCode(ctx: Ctx, table: string, prefix: string, pad = 5): string {
  const tag = deviceTag(ctx.db); const full = tag ? `${prefix}-${tag}` : prefix
  const rows = ctx.db.all<{ code: string }>(`SELECT code FROM ${table} WHERE farm_id=? AND code LIKE ?`, [ctx.farmId, `${full}-%`])
  let max = 0
  for (const r of rows) { const rest = r.code.slice(full.length + 1); if (!/^\d+$/.test(rest)) continue; const n = Number(rest); if (n > max) max = n }
  return `${full}-${String(max + 1).padStart(pad, '0')}`
}

export function assertSeasonOpen(ctx: Ctx, seasonId: string) {
  const s = ctx.db.get<{ status: string }>(`SELECT status FROM seasons WHERE id=? AND farm_id=? AND deleted_at IS NULL`, [seasonId, ctx.farmId])
  need(s, 'Season not found'); need(s.status !== 'closed', 'This season is closed; reopen it to record further activity')
}

export interface CostLink { seasonId: string; category: string; amount: number; on: string; sourceType: string; sourceId: string
  fieldId?: string | null; seedbedId?: string | null; cycleId?: string | null; note?: string }

export function addCost(ctx: Ctx, c: CostLink) {
  if (!(c.amount > 0)) return
  ctx.db.insert('cost_entries', { tenant_id: ctx.tenantId, farm_id: ctx.farmId, season_id: c.seasonId, category: c.category, amount: round2(c.amount),
    occurred_on: c.on, seedbed_id: c.seedbedId ?? null, field_id: c.fieldId ?? null, cycle_id: c.cycleId ?? null,
    source_type: c.sourceType, source_id: c.sourceId, note: c.note ?? null })
}

export function removeCostsFor(ctx: Ctx, sourceIds: string[]) {
  for (const id of sourceIds)
    for (const c of ctx.db.all<{ id: string }>(`SELECT id FROM cost_entries WHERE source_id=? AND deleted_at IS NULL`, [id])) ctx.db.softDelete('cost_entries', c.id)
}

export const nonNeg = (v: number | undefined | null, what: string) => need(v == null || (Number.isFinite(v) && v >= 0), `${what} cannot be negative`)
export const addDays = (date: string, days: number) => { const d = new Date(date + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10) }
export const daysBetween = (from: string, to: string) => Math.floor((Date.parse(to.slice(0, 10)) - Date.parse(from.slice(0, 10))) / 864e5)
