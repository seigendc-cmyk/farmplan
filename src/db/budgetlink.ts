import type { Db } from './database'

/** Snapshots a season's live budget lines as a new version. Returns the version id, or null when there are no lines. */
export function snapshotBudget(db: Db, seasonId: string, o: { kind: 'baseline' | 'revision'; reason: string | null; by: string | null }): string | null {
  const s = db.get<{ tenant_id: string; farm_id: string }>(`SELECT tenant_id, farm_id FROM seasons WHERE id=?`, [seasonId]); if (!s) return null
  const lines = db.all<{ category: string; amount: number; expected_month: string | null }>(`SELECT category, amount, expected_month FROM budgets WHERE season_id=? AND deleted_at IS NULL ORDER BY category`, [seasonId])
  if (!lines.length) return null
  const no = (db.get<{ n: number | null }>(`SELECT MAX(version_no) n FROM budget_versions WHERE season_id=? AND deleted_at IS NULL`, [seasonId])?.n ?? 0) + 1
  const id = db.insert('budget_versions', { tenant_id: s.tenant_id, farm_id: s.farm_id, season_id: seasonId, version_no: no, kind: o.kind, reason: o.reason, approved_on: new Date().toISOString().slice(0, 10), approved_by: o.by })
  for (const l of lines) db.insert('budget_version_lines', { tenant_id: s.tenant_id, version_id: id, category: l.category, amount: l.amount, expected_month: l.expected_month })
  return id
}

/** Schema v17: every season that already has budget lines gets them as version 1, unchanged. Running it again adds nothing. */
export function backfillBaselines(db: Db) {
  for (const s of db.all<{ id: string }>(`SELECT id FROM seasons WHERE deleted_at IS NULL ORDER BY starts_on`))
    if (!db.get(`SELECT 1 FROM budget_versions WHERE season_id=? AND deleted_at IS NULL`, [s.id])) snapshotBudget(db, s.id, { kind: 'baseline', reason: 'The season’s existing budget when budget versions were introduced', by: null })
}
