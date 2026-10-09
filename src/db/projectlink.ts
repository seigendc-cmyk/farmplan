import type { Db } from './database'
import { stagesOf } from '../modules/stages'

/** The furthest tobacco stage a season's existing records show. Used once, when projects are created for seasons that already hold data. */
export function stageFromData(db: Db, seasonId: string, status: string): string {
  if (status === 'closed') return 'closed'
  const has = (table: string) => !!db.get(`SELECT 1 FROM ${table} WHERE season_id=? AND deleted_at IS NULL LIMIT 1`, [seasonId])
  if (has('sales')) return 'grading_marketing'
  if (has('harvest_batches') || has('curing_cycles')) return 'harvest_curing'
  if (has('transplants') || has('operations')) return 'growing'
  if (has('seedbeds')) return 'land_seedbed'
  if (has('budgets')) return 'budget'
  return 'planning'
}

/** Adds the project (and its first history row) for one season, when its module has a pipeline and it has none yet. Returns the project id, or null. */
export function addProject(db: Db, season: { id: string; tenant_id: string; farm_id: string; enterprise: string }, stage: string, reason: string | null): string | null {
  if (!stagesOf(season.enterprise).some(s => s.id === stage)) return null
  if (db.get(`SELECT 1 FROM projects WHERE season_id=? AND deleted_at IS NULL`, [season.id])) return null
  const id = db.insert('projects', { tenant_id: season.tenant_id, farm_id: season.farm_id, season_id: season.id, stage })
  db.insert('project_stage_history', { tenant_id: season.tenant_id, project_id: id, from_stage: null, to_stage: stage, kind: 'create', reason, changed_on: new Date().toISOString().slice(0, 10), actor_name: db.actor?.name ?? null })
  return id
}

/** Schema v16: every existing tobacco season gets a project at the stage its data matches. Nothing existing is changed. */
export function backfillProjects(db: Db) {
  for (const s of db.all<{ id: string; tenant_id: string; farm_id: string; enterprise: string; status: string }>(`SELECT id,tenant_id,farm_id,enterprise,status FROM seasons WHERE deleted_at IS NULL ORDER BY starts_on`))
    addProject(db, s, stagesOf(s.enterprise).length ? stageFromData(db, s.id, s.status) : '', 'Created from the season’s existing records when the pipeline was introduced')
}
