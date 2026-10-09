import { type Ctx, require, need } from './context'
import type { Db } from '../db/database'
import { recordActivity } from '../db/activity'
import { moduleLabel } from '../modules/registry'
import { stagesOf, stageLabel } from '../modules/stages'

export interface ProjectRow {
  id: string; season_id: string; season: string; module: string; name: string; season_status: string
  stage: string; stage_label: string; notes: string | null; since: string | null
  plan_ha: number | null; plan_yield_kg_ha: number | null; plan_price_kg: number | null
  /** The stage a plain "advance" goes to, and the one after it when the next stage is optional. */
  next: string | null; skip_to: string | null
  /** What is still missing before the project may leave its current stage. */
  unmet: string[]
}
export interface HistoryRow { id: string; from_stage: string | null; to_stage: string; kind: string; reason: string | null; changed_on: string; actor_name: string | null }

/**
 * Requirements to leave a stage, read from the records that already exist for the season. Stages without an entry have none yet:
 * Funding and Contracted get theirs with the funding step. An owner can override any of them (the reason is logged).
 */
type Gate = { season_id: string; season_status: string; plan_ha: number | null; plan_yield_kg_ha: number | null }
const LEAVE: Record<string, Record<string, (db: Db, p: Gate) => string | null>> = {
  tobacco: {
    planning: (_db, p) => p.plan_ha && p.plan_yield_kg_ha ? null : 'Enter the planned hectares and expected yield',
    budget: (db, p) => has(db, 'budget_versions', p.season_id) ? null : 'Approve the budget as the baseline',
    land_seedbed: (db, p) => has(db, 'seedbeds', p.season_id) ? null : 'Record at least one seedbed',
    growing: (db, p) => has(db, 'transplants', p.season_id) ? null : 'Record transplanting',
    harvest_curing: (db, p) => has(db, 'harvest_batches', p.season_id) ? null : 'Record at least one harvest batch',
    grading_marketing: (db, p) => !has(db, 'sales', p.season_id) ? 'Record at least one sale' : p.season_status !== 'closed' ? 'Close the season' : null,
  },
}
const has = (db: Db, table: string, seasonId: string) => !!db.get(`SELECT 1 FROM ${table} WHERE season_id=? AND deleted_at IS NULL LIMIT 1`, [seasonId])

export function unmetRequirements(db: Db, module: string, stage: string, p: Gate): string[] {
  const rule = LEAVE[module]?.[stage]; const m = rule?.(db, p); return m ? [m] : []
}

interface Raw { id: string; season_id: string; stage: string; notes: string | null; plan_ha: number | null; plan_yield_kg_ha: number | null; plan_price_kg: number | null; label: string; enterprise: string; season_status: string; since: string | null }
const BASE = `SELECT p.id, p.season_id, p.stage, p.notes, p.plan_ha, p.plan_yield_kg_ha, p.plan_price_kg, s.label, s.enterprise, s.status AS season_status,
  (SELECT MAX(h.changed_on) FROM project_stage_history h WHERE h.project_id=p.id AND h.deleted_at IS NULL) AS since
  FROM projects p JOIN seasons s ON s.id=p.season_id AND s.deleted_at IS NULL WHERE p.farm_id=? AND p.deleted_at IS NULL`

function shape(db: Db, r: Raw): ProjectRow {
  const stages = stagesOf(r.enterprise); const i = stages.findIndex(s => s.id === r.stage)
  const next = i >= 0 ? stages[i + 1] : undefined
  return { id: r.id, season_id: r.season_id, season: r.label, module: r.enterprise, name: `${moduleLabel(r.enterprise)} ${r.label}`, season_status: r.season_status,
    stage: r.stage, stage_label: stageLabel(r.enterprise, r.stage), notes: r.notes, since: r.since, plan_ha: r.plan_ha, plan_yield_kg_ha: r.plan_yield_kg_ha, plan_price_kg: r.plan_price_kg, next: next?.id ?? null,
    skip_to: next?.optional ? stages[i + 2]?.id ?? null : null, unmet: next ? unmetRequirements(db, r.enterprise, r.stage, r) : [] }
}

export function listProjects(ctx: Ctx): ProjectRow[] {
  require(ctx, 'projects.project.view')
  return ctx.db.all<Raw>(`${BASE} ORDER BY s.starts_on DESC, s.enterprise`, [ctx.farmId]).map(r => shape(ctx.db, r))
}
export function getProject(ctx: Ctx, id: string): ProjectRow {
  require(ctx, 'projects.project.view')
  const r = ctx.db.get<Raw>(`${BASE} AND p.id=?`, [ctx.farmId, id]); need(r, 'Project not found'); return shape(ctx.db, r)
}
export function projectHistory(ctx: Ctx, id: string): HistoryRow[] {
  require(ctx, 'projects.project.view'); getProject(ctx, id)
  return ctx.db.all<HistoryRow>(`SELECT id,from_stage,to_stage,kind,reason,changed_on,actor_name FROM project_stage_history WHERE project_id=? AND deleted_at IS NULL ORDER BY created_at, rowid`, [id])
}
/** The project of a season, if its module has a pipeline. */
export function projectOfSeason(ctx: Ctx, seasonId: string): ProjectRow | undefined {
  require(ctx, 'projects.project.view')
  const r = ctx.db.get<Raw>(`${BASE} AND p.season_id=?`, [ctx.farmId, seasonId]); return r ? shape(ctx.db, r) : undefined
}

export function editProjectNotes(ctx: Ctx, id: string, notes: string) {
  require(ctx, 'projects.project.edit'); getProject(ctx, id)
  ctx.db.tx(() => ctx.db.update('projects', id, { notes: notes.trim() || null }))
}

/** Moves a project to its next stage (or past an optional one). A stage's requirements must be met, or an owner overrides with a reason that is logged. */
export function advanceProject(ctx: Ctx, id: string, opts: { to?: string; override?: boolean; reason?: string } = {}) {
  require(ctx, 'projects.stage.advance')
  const p = getProject(ctx, id); const stages = stagesOf(p.module)
  need(p.next, 'This project is at its last stage')
  const to = opts.to ?? p.next
  need(to === p.next || to === p.skip_to, `Cannot move from ${p.stage_label} to ${stageLabel(p.module, to)}`)
  const reason = (opts.reason ?? '').trim()
  if (p.unmet.length) {
    need(opts.override, `Not ready to leave ${p.stage_label}: ${p.unmet.join('; ')}`)
    require(ctx, 'projects.stage.override'); need(reason, 'Say why you are moving past an unmet requirement')
  }
  const skipped = to === p.skip_to ? stages.find(s => s.id === p.next)!.label : null
  const note = [skipped ? `Skipped ${skipped} (optional)` : '', p.unmet.length ? `Override of: ${p.unmet.join('; ')}` : '', reason].filter(Boolean).join(' — ') || null
  move(ctx, p, to, p.unmet.length ? 'override' : 'advance', note)
}

/** Back one stage, for a mistake. A reason is required and the history keeps both moves. */
export function backProject(ctx: Ctx, id: string, reason: string) {
  require(ctx, 'projects.stage.advance')
  const p = getProject(ctx, id); const stages = stagesOf(p.module); const i = stages.findIndex(s => s.id === p.stage)
  need(i > 0, 'This project is at its first stage'); need(reason.trim(), 'Say what was wrong')
  move(ctx, p, stages[i - 1].id, 'back', reason.trim())
}

function move(ctx: Ctx, p: ProjectRow, to: string, kind: 'advance' | 'back' | 'override', reason: string | null) {
  ctx.db.tx(() => {
    ctx.db.update('projects', p.id, { stage: to })
    ctx.db.insert('project_stage_history', { tenant_id: ctx.tenantId, project_id: p.id, from_stage: p.stage, to_stage: to, kind, reason, changed_on: new Date().toISOString().slice(0, 10), actor_name: ctx.actor?.name ?? null })
    ctx.db.audit(ctx.actor?.id ?? null, `project.${kind}`, 'projects', p.id)
    const verb = kind === 'back' ? 'Moved back' : kind === 'override' ? 'Moved past an unmet requirement' : 'Moved'
    recordActivity(ctx.db, { kind: 'action', verb: `project.${kind}`, domain: 'ops', table_name: 'projects', row_id: p.id, season_id: p.season_id,
      summary: `${verb}: ${p.name} from ${p.stage_label} to ${stageLabel(p.module, to)}${reason ? ` — ${reason}` : ''}` })
  })
}
