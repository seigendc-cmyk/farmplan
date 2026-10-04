import { recordActivity, type Domain, type EventKind } from '../db/activity'
import { type Ctx, can, need, require } from './context'
import { isDate } from './context'

export interface ActivityRow {
  id: string; occurred_at: string; actor_id: string | null; actor_name: string | null; device_tag: string | null; kind: EventKind; verb: string; domain: Domain
  table_name: string | null; row_id: string | null; season_id: string | null; field_id: string | null; field_no: string | null; summary: string; body: string | null
}

const DOMAIN_PERM: Record<Domain, string> = { ops: 'brain.log.view_ops', finance: 'brain.log.view_finance', admin: 'brain.log.view_admin' }
/** The domains this person may read in full. "Own" access is separate: it only ever covers events they made. */
export const visibleDomains = (ctx: Ctx): Domain[] => (Object.keys(DOMAIN_PERM) as Domain[]).filter(d => can(ctx, DOMAIN_PERM[d]))
export const canSeeAnyActivity = (ctx: Ctx) => can(ctx, 'brain.log.view_own') || visibleDomains(ctx).length > 0

/**
 * The single access rule for the brain: an event is visible if the person holds its domain's level, or they made it and hold "own".
 * Every reader (timeline, search, and later the chat) must build its SQL from this so nothing can slip past it.
 */
export function accessFilter(ctx: Ctx, alias = 'a'): { sql: string; params: string[] } {
  const parts: string[] = []; const params: string[] = []; const doms = visibleDomains(ctx)
  if (doms.length) { parts.push(`${alias}.domain IN (${doms.map(() => '?').join(',')})`); params.push(...doms) }
  if (can(ctx, 'brain.log.view_own') && ctx.actor) { parts.push(`${alias}.actor_id = ?`); params.push(ctx.actor.id) }
  return { sql: parts.length ? `(${parts.join(' OR ')})` : '0', params }
}

export interface ActivityFilter { q?: string; kind?: EventKind; domain?: Domain; actor?: string; fieldId?: string; seasonId?: string; from?: string; to?: string; limit?: number; offset?: number }

export function listActivity(ctx: Ctx, f: ActivityFilter = {}): ActivityRow[] {
  need(canSeeAnyActivity(ctx), 'You do not have access to the activity log')
  const acc = accessFilter(ctx); const where = [`a.farm_id=?`, `a.deleted_at IS NULL`, acc.sql]; const params: (string | number)[] = [ctx.farmId, ...acc.params]
  if (f.kind) { where.push('a.kind=?'); params.push(f.kind) }
  if (f.domain) { where.push('a.domain=?'); params.push(f.domain) }
  if (f.actor) { where.push('a.actor_name=? COLLATE NOCASE'); params.push(f.actor) }
  if (f.fieldId) { where.push('a.field_id=?'); params.push(f.fieldId) }
  if (f.seasonId) { where.push('a.season_id=?'); params.push(f.seasonId) }
  if (f.from) { need(isDate(f.from), 'Valid from-date required'); where.push('a.occurred_at >= ?'); params.push(f.from) }
  if (f.to) { need(isDate(f.to), 'Valid to-date required'); where.push('a.occurred_at < ?'); params.push(new Date(Date.parse(f.to) + 864e5).toISOString().slice(0, 10)) }
  for (const w of (f.q ?? '').trim().split(/\s+/).filter(Boolean).slice(0, 6)) { where.push(`(a.summary LIKE ? ESCAPE '\\' OR a.body LIKE ? ESCAPE '\\' OR a.actor_name LIKE ? ESCAPE '\\')`); const like = `%${w.replace(/[\\%_]/g, m => '\\' + m)}%`; params.push(like, like, like) }
  return ctx.db.all<ActivityRow>(`SELECT a.id, a.occurred_at, a.actor_id, a.actor_name, a.device_tag, a.kind, a.verb, a.domain, a.table_name, a.row_id, a.season_id, a.field_id, f.field_no, a.summary, a.body
    FROM activity_log a LEFT JOIN fields f ON f.id=a.field_id WHERE ${where.join(' AND ')} ORDER BY a.occurred_at DESC, a.id DESC LIMIT ? OFFSET ?`, [...params, Math.min(f.limit ?? 100, 500), f.offset ?? 0])
}

/** People who appear in the events this person may read (for the filter drop-down). */
export function activityActors(ctx: Ctx): string[] {
  need(canSeeAnyActivity(ctx), 'You do not have access to the activity log'); const acc = accessFilter(ctx)
  return ctx.db.all<{ n: string }>(`SELECT DISTINCT a.actor_name n FROM activity_log a WHERE a.farm_id=? AND a.deleted_at IS NULL AND a.actor_name IS NOT NULL AND ${acc.sql} ORDER BY n COLLATE NOCASE`, [ctx.farmId, ...acc.params]).map(r => r.n)
}

export interface NoteInput { text: string; field_id?: string | null; season_id?: string | null; visibility?: Domain }
/** A free-text note. Its visibility is the level needed to read it. Anyone who may add notes can add operations-level ones; finance and admin notes need that level yourself. */
export function recordNote(ctx: Ctx, i: NoteInput): string {
  require(ctx, 'brain.note.record'); const text = (i.text ?? '').trim(); need(text, 'Write something first'); need(text.length <= 4000, 'Notes are limited to 4000 characters')
  const domain = i.visibility ?? 'ops'; need(domain === 'ops' || visibleDomains(ctx).includes(domain), 'You can only add notes at a level you can read yourself')
  if (i.field_id) need(ctx.db.get(`SELECT 1 FROM fields WHERE id=? AND farm_id=? AND deleted_at IS NULL`, [i.field_id, ctx.farmId]), 'Field not found')
  const id = recordActivity(ctx.db, { kind: 'note', verb: 'note.add', domain, summary: text.length > 160 ? `${text.slice(0, 157)}…` : text, body: text.length > 160 ? text : null, field_id: i.field_id ?? null, season_id: i.season_id ?? null,
    actor_id: ctx.actor?.id ?? null, actor_name: ctx.actor?.name ?? null })
  need(id, 'The note could not be saved'); return id
}
