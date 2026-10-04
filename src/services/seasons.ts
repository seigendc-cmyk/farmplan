import { type Ctx, require, need, isDate } from './context'

export interface Season { id: string; label: string; enterprise: string; starts_on: string; ends_on: string; status: string }

export function listSeasons(ctx: Ctx): Season[] {
  require(ctx, 'settings.season.view')
  return ctx.db.all<Season>(`SELECT id,label,enterprise,starts_on,ends_on,status FROM seasons WHERE farm_id=? AND deleted_at IS NULL ORDER BY starts_on DESC`, [ctx.farmId])
}

export function createSeason(ctx: Ctx, i: { label: string; starts_on: string; ends_on: string; enterprise?: string; activate?: boolean }) {
  require(ctx, 'settings.season.manage')
  need(i.label.trim(), 'Season label is required (e.g. 2026/27)')
  need(isDate(i.starts_on) && isDate(i.ends_on), 'Valid start and end dates are required')
  need(i.ends_on > i.starts_on, 'Season must end after it starts')
  const enterprise = i.enterprise ?? 'tobacco'
  need(!ctx.db.get(`SELECT 1 FROM seasons WHERE farm_id=? AND enterprise=? AND label=? AND deleted_at IS NULL`, [ctx.farmId, enterprise, i.label.trim()]), 'That season already exists')
  return ctx.db.tx(() => {
    if (i.activate) for (const s of ctx.db.all<{ id: string }>(`SELECT id FROM seasons WHERE farm_id=? AND status='active' AND deleted_at IS NULL`, [ctx.farmId]))
      ctx.db.update('seasons', s.id, { status: 'planned' })
    const id = ctx.db.insert('seasons', { tenant_id: ctx.tenantId, farm_id: ctx.farmId, enterprise, label: i.label.trim(),
      starts_on: i.starts_on, ends_on: i.ends_on, status: i.activate ? 'active' : 'planned' })
    ctx.db.audit(ctx.actor?.id ?? null, 'season.create', 'seasons', id)
    return id
  })
}

export function setSeasonStatus(ctx: Ctx, id: string, status: 'planned' | 'active' | 'closed') {
  require(ctx, 'settings.season.manage')
  ctx.db.tx(() => {
    if (status === 'active') for (const s of ctx.db.all<{ id: string }>(`SELECT id FROM seasons WHERE farm_id=? AND status='active' AND id<>? AND deleted_at IS NULL`, [ctx.farmId, id]))
      ctx.db.update('seasons', s.id, { status: 'planned' })
    ctx.db.update('seasons', id, { status })
    ctx.db.audit(ctx.actor?.id ?? null, `season.${status}`, 'seasons', id)
  })
}

export function activeSeason(ctx: Ctx): Season | undefined {
  return ctx.db.get<Season>(`SELECT id,label,enterprise,starts_on,ends_on,status FROM seasons WHERE farm_id=? AND status='active' AND deleted_at IS NULL LIMIT 1`, [ctx.farmId])
}
