import initSqlJs, { type Database as SqlDb, type SqlValue } from 'sql.js'
import { DDL, SCHEMA_VERSION } from './schema'
import { runMigrations } from './migrations'
import { describeAdmin, describeChange, recordActivity } from './activity'

export interface Persistence {
  load(): Promise<Uint8Array | null>
  save(data: Uint8Array): Promise<void>
}

export class MemoryPersistence implements Persistence {
  data: Uint8Array | null = null
  async load() { return this.data }
  async save(d: Uint8Array) { this.data = d }
}

export class IndexedDbPersistence implements Persistence {
  constructor(private name = 'farmplan-tobacco', private key = 'main') {}
  private open(): Promise<IDBDatabase> {
    return new Promise((res, rej) => {
      const r = indexedDB.open(this.name, 1)
      r.onupgradeneeded = () => r.result.createObjectStore('db')
      r.onsuccess = () => res(r.result)
      r.onerror = () => rej(r.error)
    })
  }
  async load() {
    const db = await this.open()
    return new Promise<Uint8Array | null>((res, rej) => {
      const q = db.transaction('db').objectStore('db').get(this.key)
      q.onsuccess = () => res((q.result as Uint8Array) ?? null)
      q.onerror = () => rej(q.error)
    })
  }
  async save(data: Uint8Array) {
    const db = await this.open()
    return new Promise<void>((res, rej) => {
      const t = db.transaction('db', 'readwrite')
      t.objectStore('db').put(data, this.key)
      t.oncomplete = () => res()
      t.onerror = () => rej(t.error)
    })
  }
}

/** Tables that participate in sync and receive outbox journalling. */
export const SYNC_ORDER = [
  'farms','seasons','projects','project_stage_history','blocks','fields','inputs','inventory_transactions',
  'seedbeds','operations','operation_inputs','transplants','harvest_batches','barns','curing_cycles',
  'curing_cycle_checks','cycle_batches','curing_logs','storage_units','contractors','contracts','contract_fields','contract_advances','contract_obligations','contract_settlements','grades','grading_lots','grading_outputs','bales',
  'buyers','buyer_deductions','sales','sale_lines','sale_deductions','sale_payments','labour_entries','budgets','machines','machine_logs','allocation_rules','cost_entries','weather_records','activity_log',
] as const
/** Identity tables (tenants, roles, permissions) are owned by the cloud and are not synced from devices. */
export const SYNC_TABLES = new Set<string>(SYNC_ORDER)

export type Row = Record<string, SqlValue>

const nowIso = () => new Date().toISOString()
export const uuid = (): string => globalThis.crypto.randomUUID()

export class Db {
  private depth = 0
  /** Who is signed in on this device; stamped on activity events. Set at login, cleared at sign-out. */
  actor: { id: string; name: string } | null = null
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  private constructor(private sql: SqlDb, private persistence: Persistence) {}

  static async open(persistence: Persistence, locateFile?: (f: string) => string): Promise<Db> {
    const SQL = await initSqlJs(locateFile ? { locateFile } : {})
    const existing = await persistence.load()
    const sql = existing ? new SQL.Database(existing) : new SQL.Database()
    sql.run('PRAGMA foreign_keys = ON;')
    const db = new Db(sql, persistence)
    const hadMeta = !!db.get(`SELECT name FROM sqlite_master WHERE type='table' AND name='meta'`)
    const before = hadMeta ? Number(db.get<{ value: string }>(`SELECT value FROM meta WHERE key='schema_version'`)?.value ?? 0) : 0
    sql.exec(DDL)
    if (before > 0 && before < SCHEMA_VERSION) runMigrations(db, before)
    db.run(`INSERT INTO meta(key,value) VALUES('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, [String(SCHEMA_VERSION)])
    await db.flush()
    return db
  }

  all<T = Row>(query: string, params: SqlValue[] = []): T[] {
    const st = this.sql.prepare(query)
    try {
      st.bind(params)
      const out: T[] = []
      while (st.step()) out.push(st.getAsObject() as T)
      return out
    } finally { st.free() }
  }
  get<T = Row>(query: string, params: SqlValue[] = []): T | undefined { return this.all<T>(query, params)[0] }
  run(query: string, params: SqlValue[] = []) { this.sql.run(query, params) }

  /** Atomic unit of work. Nested calls use savepoints. Persists after the outermost commit. */
  tx<T>(fn: () => T): T {
    const outer = this.depth === 0
    const sp = `sp${this.depth}`
    this.sql.run(outer ? 'BEGIN' : `SAVEPOINT ${sp}`)
    this.depth++
    try {
      const r = fn()
      this.depth--
      this.sql.run(outer ? 'COMMIT' : `RELEASE ${sp}`)
      if (outer) this.scheduleSave()
      return r
    } catch (e) {
      this.depth--
      this.sql.run(outer ? 'ROLLBACK' : `ROLLBACK TO ${sp}`)
      if (!outer) this.sql.run(`RELEASE ${sp}`)
      throw e
    }
  }

  private assertTable(t: string) { if (!SYNC_TABLES.has(t)) throw new Error(`Unknown sync table: ${t}`) }

  private journal(table: string, id: string, op: 'upsert' | 'delete', change: 'create' | 'update' | 'delete' = op === 'delete' ? 'delete' : 'update', changed?: string[]) {
    const row = this.get(`SELECT * FROM ${table} WHERE id = ?`, [id])
    this.run(`INSERT INTO outbox(table_name,row_id,op,payload) VALUES(?,?,?,?)`, [table, id, op, JSON.stringify(row ?? {})])
    this.run(`INSERT INTO hub_log(table_name,row_id) VALUES(?,?)`, [table, id])
    if (row && table !== 'activity_log') { const ev = describeChange(this, table, change, row, changed); if (ev) recordActivity(this, ev) }
  }

  /** Insert a row, journal it for sync. Returns the row id. */
  insert(table: string, row: Record<string, SqlValue>): string {
    this.assertTable(table)
    const id = (row.id as string) ?? uuid()
    const data: Record<string, SqlValue> = { ...row, id, created_at: nowIso(), updated_at: nowIso(), version: 1 }
    const cols = Object.keys(data)
    this.run(`INSERT INTO ${table}(${cols.join(',')}) VALUES(${cols.map(() => '?').join(',')})`, cols.map(c => data[c] as SqlValue))
    this.journal(table, id, 'upsert', 'create')
    return id
  }

  update(table: string, id: string, patch: Record<string, SqlValue>) {
    this.assertTable(table)
    const forbidden = ['id', 'tenant_id', 'created_at', 'version']
    for (const k of Object.keys(patch)) if (forbidden.includes(k)) throw new Error(`Column ${k} is immutable`)
    const cols = Object.keys(patch)
    if (!cols.length) return
    this.run(`UPDATE ${table} SET ${cols.map(c => `${c}=?`).join(',')}, updated_at=?, version=version+1 WHERE id=? AND deleted_at IS NULL`,
      [...cols.map(c => patch[c] as SqlValue), nowIso(), id])
    if (this.sql.getRowsModified() === 0) throw new Error(`${table}:${id} not found`)
    this.journal(table, id, 'upsert', 'update', cols)
  }

  softDelete(table: string, id: string) {
    this.assertTable(table)
    this.run(`UPDATE ${table} SET deleted_at=?, updated_at=?, version=version+1 WHERE id=? AND deleted_at IS NULL`, [nowIso(), nowIso(), id])
    this.journal(table, id, 'delete')
  }

  audit(actor: string | null, action: string, table?: string, rowId?: string, detail?: unknown) {
    this.run(`INSERT INTO audit_log(actor,action,table_name,row_id,detail) VALUES(?,?,?,?,?)`,
      [actor, action, table ?? null, rowId ?? null, detail === undefined ? null : JSON.stringify(detail)])
    const ev = describeAdmin(this, action, rowId ?? null, detail); if (ev) recordActivity(this, { ...ev, actor_id: actor ?? this.actor?.id ?? null })
  }

  pendingSync(): number { return this.get<{ n: number }>(`SELECT COUNT(*) n FROM outbox WHERE synced_at IS NULL`)!.n }

  private scheduleSave() {
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => { this.saveTimer = null; void this.flush() }, 250)
  }
  async flush() {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null }
    const bytes = this.exportBytes()
    await this.persistence.save(bytes)
  }
  /** sql.js export() resets connection pragmas, so foreign keys are re-enabled afterwards. */
  exportBytes(): Uint8Array {
    const bytes = this.sql.export()
    this.sql.run('PRAGMA foreign_keys = ON;')
    return bytes
  }
}
