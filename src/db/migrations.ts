import type { Db } from './database'
import { hubReindex } from './hublog'
import { adoptBuyerNames } from './buyerlink'
import { backfillActivity } from './activity'
import { backfillProjects } from './projectlink'
import { PHASE10_GRANTS, PHASE11_GRANTS, PHASE12_GRANTS, PHASE13_GRANTS, PHASE2_GRANTS, PHASE3_GRANTS, PHASE4_GRANTS, PHASE5_GRANTS, PHASE6_GRANTS, PHASE7_GRANTS } from '../lib/permissions'

/** In-place upgrades for databases created by an earlier schema version. New tables arrive via `CREATE IF NOT EXISTS` in DDL. */
export function runMigrations(db: Db, from: number) {
  if (from < 9) hubReindex(db)
  db.tx(() => {
    if (from < 16) { grantOnce(db, PHASE13_GRANTS); backfillProjects(db) }   // Platform step 1: a project for every existing tobacco season, at the stage its data shows
    if (from < 15) {   // Modules: a farm lists the modules it uses; every existing farm keeps running Tobacco only. No permission grant: the Owner role holds '*'.
      const cols = db.all<{ name: string }>(`PRAGMA table_info(farms)`).map(c => c.name)
      if (cols.length && !cols.includes('modules')) db.run(`ALTER TABLE farms ADD COLUMN modules TEXT NOT NULL DEFAULT 'tobacco'`)
    }
    if (from < 14) {   // Phase D: fuel drawn from stock by machine logs; labour entries and machine logs linked to the operation they belong to
      const add = (table: string, col: string, ddl: string) => { const cols = db.all<{ name: string }>(`PRAGMA table_info(${table})`).map(c => c.name); if (cols.length && !cols.includes(col)) db.run(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`) }
      add('machines', 'fuel_input_id', 'TEXT REFERENCES inputs(id)')
      add('machine_logs', 'input_id', 'TEXT REFERENCES inputs(id)'); add('machine_logs', 'fuel_txn_id', 'TEXT REFERENCES inventory_transactions(id)'); add('machine_logs', 'operation_id', 'TEXT REFERENCES operations(id)')
      add('labour_entries', 'operation_id', 'TEXT REFERENCES operations(id)')
    }
    if (from < 13) {   // reorder level per input: when stock falls to it, the Dashboard says "low"
      const cols = db.all<{ name: string }>(`PRAGMA table_info(inputs)`).map(c => c.name)
      if (cols.length && !cols.includes('reorder_level')) db.run(`ALTER TABLE inputs ADD COLUMN reorder_level REAL CHECK (reorder_level IS NULL OR reorder_level >= 0)`)
    }
    if (from < 12) grantOnce(db, PHASE12_GRANTS)
    if (from < 11) { grantOnce(db, PHASE11_GRANTS); backfillActivity(db) }
    if (from < 10) {
      const cols = db.all<{ name: string }>(`PRAGMA table_info(sales)`).map(c => c.name)
      if (cols.length && !cols.includes('buyer_id')) db.run(`ALTER TABLE sales ADD COLUMN buyer_id TEXT`)
      grantOnce(db, PHASE10_GRANTS)
      for (const f of db.all<{ id: string }>(`SELECT id FROM farms WHERE deleted_at IS NULL`)) adoptBuyerNames(db, f.id)
    }
    if (from < 7) grantOnce(db, PHASE7_GRANTS)
    if (from < 6) grantOnce(db, PHASE6_GRANTS)
    if (from < 5) grantOnce(db, PHASE5_GRANTS)
    if (from < 4) {
      const cols = db.all<{ name: string }>(`PRAGMA table_info(sales)`).map(c => c.name)
      if (cols.length && !cols.includes('contract_id')) db.run(`ALTER TABLE sales ADD COLUMN contract_id TEXT REFERENCES contracts(id)`)
      grantOnce(db, PHASE4_GRANTS)
    }
    if (from < 3) grantOnce(db, PHASE3_GRANTS)
    if (from < 2) {
      const cols = db.all<{ name: string }>(`PRAGMA table_info(cost_entries)`).map(c => c.name)
      if (!cols.includes('cycle_id')) db.run(`ALTER TABLE cost_entries ADD COLUMN cycle_id TEXT`)
      // One-time grant of the new permissions to built-in roles (never re-applied, so later removals by the owner stick).
      for (const role of db.all<{ id: string; tenant_id: string; name: string }>(`SELECT id, tenant_id, name FROM roles WHERE is_system=1`)) {
        for (const p of PHASE2_GRANTS[role.name] ?? [])
          db.run(`INSERT OR IGNORE INTO role_permissions(tenant_id,role_id,permission) VALUES(?,?,?)`, [role.tenant_id, role.id, p])
      }
    }
  })
}

function grantOnce(db: Db, grants: Record<string, string[]>) {
  for (const role of db.all<{ id: string; tenant_id: string; name: string }>(`SELECT id, tenant_id, name FROM roles WHERE is_system=1`))
    for (const p of grants[role.name] ?? []) db.run(`INSERT OR IGNORE INTO role_permissions(tenant_id,role_id,permission) VALUES(?,?,?)`, [role.tenant_id, role.id, p])
}
