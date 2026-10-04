import { Db, SYNC_ORDER, type Row } from '../db/database'

/** Minimal cloud surface so the engine is testable without a live Supabase project. */
export interface CloudClient {
  claimTenant(tenantId: string, name: string): Promise<void>
  upsert(table: string, rows: CloudRow[]): Promise<void>
  fetchSince(table: string, since: string | null, limit: number): Promise<Row[]>
  /** Cursor to resume from after `row`. Defaults to the row's updated_at (cloud); the Wi-Fi hub uses its own change sequence. */
  cursorOf?(row: Row): string
  /** Plain INSERT for insert-only rows (no ON CONFLICT, which RLS would also check against SELECT). A duplicate id throws DuplicateRowError.
   *  The three calls below come together; without them (the Wi-Fi hub) every row is upserted. */
  insert?(table: string, rows: CloudRow[]): Promise<void>
  /** After a duplicate id: is that id already a row of this tenant (i.e. our own earlier send)? */
  rowSent?(table: string, tenantId: string, id: string): Promise<boolean>
  /** Reversal of a derived cost / stock row by a role that may not update it (cloud function cancel_derived). */
  cancelDerived?(table: string, tenantId: string, row: CloudRow): Promise<void>
}

type CloudRow = Record<string, unknown>
export interface SyncReport { pushed: number; pulled: number; conflictsKept: number; quarantined: number; errors: string[] }
/** canWrite: the signed-in role's permissions, so derived rows go straight to plain inserts when the role may not upsert them. */
export interface SyncOptions { canWrite?: (perm: string) => boolean }

/** Thrown by a cloud adapter when the server understood the row but refused it (constraint, trigger or RLS). Network failures must NOT use this. */
export class RowRejectedError extends Error { constructor(message: string, readonly code?: string) { super(message) } }
/** A plain insert met an existing id. Whether that is our own earlier send is decided with rowSent, never assumed. */
export class DuplicateRowError extends RowRejectedError {}

/** Permission a role needs to upsert (create AND edit) rows of these tables in the cloud. Without it, they are sent insert-only. */
export const CLOUD_WRITE_PERM: Record<string, string> = { cost_entries: 'finance.cost.edit', inventory_transactions: 'resources.inventory.manage' }
/** Events are append-only: always a plain insert, whoever is signed in. */
const ALWAYS_INSERT = new Set(['activity_log'])
/** Pushed after everything else, in this order: stock movements once their source records are in the cloud; then the rows that point at
 *  a movement; then costs and events. Machine and curing logs referencing a movement still in the outbox go first without the link
 *  and are re-sent with it after the movements. SYNC_ORDER stays the pull and foreign-key order. */
export const PUSH_LATE = ['inventory_transactions', 'operation_inputs', 'contract_advances', 'cost_entries', 'activity_log'] as const
export const PUSH_ORDER: readonly string[] = [...SYNC_ORDER.filter(t => !(PUSH_LATE as readonly string[]).includes(t)), ...PUSH_LATE]
const FUEL_LINKED = ['machine_logs', 'curing_logs']

export const BOOL_COLS: Record<string, string[]> = { fields: ['irrigated'], inputs: ['active'], barns: ['active'], grades: ['active'], contractors: ['active'], machines: ['active'], buyers: ['active'], contract_obligations: ['done'] }
const LOCAL_ONLY_COLS = new Set<string>([])

function toCloud(table: string, row: Row): CloudRow {
  const out: CloudRow = {}
  for (const [k, v] of Object.entries(row)) {
    if (LOCAL_ONLY_COLS.has(k)) continue
    out[k] = BOOL_COLS[table]?.includes(k) ? Boolean(v) : v
  }
  return out
}
export function toLocal(table: string, row: Row): Row {
  const out: Row = {}
  for (const [k, v] of Object.entries(row)) {
    if (BOOL_COLS[table]?.includes(k)) out[k] = v ? 1 : 0
    else if (typeof v === 'boolean') out[k] = v ? 1 : 0
    else if (v !== null && typeof v === 'object') out[k] = JSON.stringify(v)
    else out[k] = v
  }
  return out
}

const ts = (s: unknown) => Date.parse(String(s))

/**
 * Push the outbox (latest snapshot per row, FK-safe order), then pull remote changes.
 * Conflict policy (Phase 1): last-writer-wins per row on updated_at; soft-deletes propagate as updates.
 */
export async function syncNow(db: Db, cloud: CloudClient, tenantId: string, tenantName: string, opts: SyncOptions = {}): Promise<SyncReport> {
  const rep: SyncReport = { pushed: 0, pulled: 0, conflictsKept: 0, quarantined: 0, errors: [] }
  try {
    await cloud.claimTenant(tenantId, tenantName)

    // ---- push ----
    const pending = db.all<{ seq: number; table_name: string; row_id: string }>(`SELECT seq, table_name, row_id FROM outbox WHERE synced_at IS NULL ORDER BY seq`)
    const latest = new Map<string, { table: string; id: string; seqs: number[] }>()
    for (const p of pending) {
      const k = `${p.table_name}:${p.row_id}`
      const e = latest.get(k) ?? { table: p.table_name, id: p.row_id, seqs: [] }
      e.seqs.push(p.seq); latest.set(k, e)
    }
    const done = (seqs: number[]) => db.tx(() => { for (const s of seqs) db.run(`UPDATE outbox SET synced_at=datetime('now') WHERE seq=?`, [s]) })
    const canInsert = !!(cloud.insert && cloud.rowSent && cloud.cancelDerived)
    // Tables this sync sends insert-only: decided from the role's permissions when given, or on the cloud's first RLS refusal of an upsert.
    const insertOnly = new Set(canInsert ? [...ALWAYS_INSERT, ...Object.keys(CLOUD_WRITE_PERM).filter(t => opts.canWrite && !opts.canWrite(CLOUD_WRITE_PERM[t]))] : [])
    const pendingTxns = new Set([...latest.values()].filter(e => e.table === 'inventory_transactions').map(e => e.id))
    type Item = { id: string; seqs: number[]; row: CloudRow }
    const relink: { table: string; items: Item[] }[] = []

    /** One insert-only row. A duplicate id counts as sent only when rowSent confirms it is this tenant's row. */
    const insertOne = async (table: string, it: Item) => {
      try { await cloud.insert!(table, [it.row]); return } catch (e) { if (!(e instanceof DuplicateRowError)) throw e }
      if (!(await cloud.rowSent!(table, tenantId, it.id))) throw new RowRejectedError(`${table}: the cloud already holds a conflicting row that is not this farm's own copy`)
      const who = CLOUD_WRITE_PERM[table] ? `a person with ${CLOUD_WRITE_PERM[table]} must apply it` : 'events cannot be changed'
      if (it.row.deleted_at) {
        if (!CLOUD_WRITE_PERM[table]) return
        try { await cloud.cancelDerived!(table, tenantId, it.row) } catch (e) { if (e instanceof RowRejectedError) throw new RowRejectedError(`${table}: the cloud refused this reversal (${e.message}); ${who}`, e.code); throw e }
      } else if (Number(it.row.version ?? 1) > 1) throw new RowRejectedError(`${table}: this edits a row already in the cloud; ${who}`)
      // else: our own earlier send whose reply was lost
    }
    const sendOne = async (table: string, it: Item) => {
      if (insertOnly.has(table)) return insertOne(table, it)
      try { await cloud.upsert(table, [it.row]) }
      catch (e) {
        if (!(e instanceof RowRejectedError && e.code === '42501' && canInsert && CLOUD_WRITE_PERM[table])) throw e
        insertOnly.add(table); return insertOne(table, it)   // the role may create these rows from its own records, not edit them
      }
    }
    /** Chunks of 200; when the cloud refuses a chunk, row by row, quarantining only the offenders. `mark` false: the outbox stays pending (sent again later). */
    const pushTable = async (table: string, items: Item[], mark = true): Promise<Set<string>> => {
      const refused = new Set<string>()
      for (let i = 0; i < items.length; i += 200) {
        const chunk = items.slice(i, i + 200)
        try {
          await (insertOnly.has(table) ? cloud.insert!(table, chunk.map(x => x.row)) : cloud.upsert(table, chunk.map(x => x.row)))
          if (mark) { done(chunk.flatMap(x => x.seqs)); rep.pushed += chunk.length }
        } catch (err) {
          if (!(err instanceof RowRejectedError)) throw err
          for (const x of chunk) {
            try { await sendOne(table, x); if (mark) { done(x.seqs); rep.pushed++ } }
            catch (e2) {
              if (!(e2 instanceof RowRejectedError)) throw e2
              db.tx(() => { db.run(`INSERT INTO sync_conflicts(table_name,row_id,reason) VALUES(?,?,?)`, [table, x.id, e2.message]); done(x.seqs) })
              rep.quarantined++; refused.add(x.id)
            }
          }
        }
      }
      return refused
    }

    for (const table of PUSH_ORDER) {
      if (table === 'cost_entries') for (const r of relink.splice(0)) await pushTable(r.table, r.items)   // the links, now that the movements are in
      const entries = [...latest.values()].filter(e => e.table === table)
      if (!entries.length) continue
      const items: Item[] = []
      for (const e of entries) { const row = db.get(`SELECT * FROM ${table} WHERE id=?`, [e.id]); if (row) items.push({ id: e.id, seqs: e.seqs, row: toCloud(table, row) }) }
      if (FUEL_LINKED.includes(table)) {
        const later = items.filter(x => x.row.fuel_txn_id && pendingTxns.has(String(x.row.fuel_txn_id)))
        const refused = await pushTable(table, later.map(x => ({ ...x, row: { ...x.row, fuel_txn_id: null } })), false)
        relink.push({ table, items: later.filter(x => !refused.has(x.id)) })
        await pushTable(table, items.filter(x => !later.includes(x)))
      } else await pushTable(table, items)
      // rows deleted outright locally (none expected: soft delete) have nothing to send
      done(entries.filter(e => !items.some(x => x.id === e.id)).flatMap(e => e.seqs))
    }

    // ---- pull ----
    for (const table of SYNC_ORDER) {
      const cur = db.get<{ value: string }>(`SELECT value FROM meta WHERE key=?`, [`cursor:${table}`])?.value ?? null
      let since = cur
      for (;;) {
        const batch = await cloud.fetchSince(table, since, 500)
        if (!batch.length) break
        db.tx(() => {
          for (const remote of batch) {
            const local = db.get<{ updated_at: string }>(`SELECT updated_at FROM ${table} WHERE id=?`, [remote.id as string])
            if (local && ts(local.updated_at) > ts(remote.updated_at)) { rep.conflictsKept++; continue }
            const row = toLocal(table, remote)
            const cols = Object.keys(row)
            db.run(`INSERT OR REPLACE INTO ${table}(${cols.join(',')}) VALUES(${cols.map(() => '?').join(',')})`, cols.map(c => row[c]))
            db.run(`INSERT INTO hub_log(table_name,row_id) VALUES(?,?)`, [table, remote.id as string])
            rep.pulled++
          }
        })
        since = cloud.cursorOf ? cloud.cursorOf(batch[batch.length - 1]) : String(batch[batch.length - 1].updated_at)
        db.run(`INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, [`cursor:${table}`, since])
        if (batch.length < 500) break
      }
    }
    db.run(`INSERT INTO meta(key,value) VALUES('last_sync',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, [new Date().toISOString()])
    await db.flush()
  } catch (e) {
    rep.errors.push(e instanceof Error ? e.message : String(e))
  }
  return rep
}

/** Supabase adapter. Pass a client created with the project's URL and publishable key and a signed-in session. */
import type { SupabaseClient } from '@supabase/supabase-js'
/** 23xxx integrity, P0001 raised by our triggers and functions, 42501 RLS/permission, 22xxx bad data → the row itself is refused. */
function refused(table: string, error: { code?: string; message: string } | null) {
  if (!error) return
  const code = error.code ?? ''; const msg = `${table}: ${error.message}`
  if (code === '23505') throw new DuplicateRowError(msg, code)
  throw /^(23|22|P0001|42501)/.test(code) ? new RowRejectedError(msg, code) : new Error(msg)
}
export function supabaseCloud(sb: SupabaseClient): CloudClient {
  return {
    async claimTenant(tenantId, name) {
      const { error } = await sb.rpc('claim_tenant', { p_tenant: tenantId, p_name: name })
      if (error) throw new Error(`claim_tenant: ${error.message}`)
    },
    async upsert(table, rows) { refused(table, (await sb.from(table).upsert(rows, { onConflict: 'id' })).error) },
    // No .select(): a RETURNING clause would need read rights the inserting role may not have.
    async insert(table, rows) { refused(table, (await sb.from(table).insert(rows)).error) },
    async rowSent(table, tenantId, id) {
      const { data, error } = await sb.rpc('row_sent', { p_table: table, p_tenant: tenantId, p_id: id }); refused(table, error); return data === true
    },
    async cancelDerived(table, tenantId, row) {
      refused(table, (await sb.rpc('cancel_derived', { p_table: table, p_tenant: tenantId, p_id: row.id, p_source_type: row.source_type, p_source_id: row.source_id })).error)
    },
    async fetchSince(table, since, limit) {
      let q = sb.from(table).select('*').order('updated_at', { ascending: true }).limit(limit)
      if (since) q = q.gt('updated_at', since)
      const { data, error } = await q
      if (error) throw new Error(`${table}: ${error.message}`)
      return (data ?? []) as Row[]
    },
  }
}

export interface SyncConflict { id: number; table_name: string; row_id: string; reason: string; created_at: string }
export function listSyncConflicts(db: Db): SyncConflict[] {
  return db.all<SyncConflict>(`SELECT id, table_name, row_id, reason, created_at FROM sync_conflicts WHERE resolved_at IS NULL ORDER BY id`)
}
/** Queue the row for another push attempt (e.g. after the missing stock purchase has synced). */
export function retrySyncConflict(db: Db, id: number) {
  const c = db.get<{ table_name: string; row_id: string }>(`SELECT table_name, row_id FROM sync_conflicts WHERE id=? AND resolved_at IS NULL`, [id]); if (!c) return
  db.tx(() => {
    db.run(`INSERT INTO outbox(table_name,row_id,op,payload) VALUES(?,?, 'upsert', '{}')`, [c.table_name, c.row_id])
    db.run(`UPDATE sync_conflicts SET resolved_at=datetime('now'), resolution='retry' WHERE id=?`, [id])
  })
}
/** Acknowledge a refused row. The local copy is kept; it is simply not sent. */
export function dismissSyncConflict(db: Db, id: number) { db.run(`UPDATE sync_conflicts SET resolved_at=datetime('now'), resolution='dismissed' WHERE id=?`, [id]) }
