import { Db, SYNC_ORDER, type Row } from '../db/database'

/** Minimal cloud surface so the engine is testable without a live Supabase project. */
export interface CloudClient {
  claimTenant(tenantId: string, name: string): Promise<void>
  upsert(table: string, rows: CloudRow[]): Promise<void>
  fetchSince(table: string, since: string | null, limit: number): Promise<Row[]>
  /** Cursor to resume from after `row`. Defaults to the row's updated_at (cloud); the Wi-Fi hub uses its own change sequence. */
  cursorOf?(row: Row): string
}

type CloudRow = Record<string, unknown>
export interface SyncReport { pushed: number; pulled: number; conflictsKept: number; quarantined: number; errors: string[] }

/** Thrown by a cloud adapter when the server understood the row but refused it (constraint, trigger or RLS). Network failures must NOT use this. */
export class RowRejectedError extends Error {}

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
export async function syncNow(db: Db, cloud: CloudClient, tenantId: string, tenantName: string): Promise<SyncReport> {
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
    for (const table of SYNC_ORDER) {
      const entries = [...latest.values()].filter(e => e.table === table)
      if (!entries.length) continue
      const live = entries.map(e => ({ e, row: db.get(`SELECT * FROM ${table} WHERE id=?`, [e.id]) })).filter((x): x is { e: typeof x.e; row: Row } => !!x.row)
      const done = (seqs: number[]) => db.tx(() => { for (const s of seqs) db.run(`UPDATE outbox SET synced_at=datetime('now') WHERE seq=?`, [s]) })
      for (let i = 0; i < live.length; i += 200) {
        const chunk = live.slice(i, i + 200)
        try { await cloud.upsert(table, chunk.map(x => toCloud(table, x.row))); done(chunk.flatMap(x => x.e.seqs)); rep.pushed += chunk.length }
        catch (err) {
          if (!(err instanceof RowRejectedError)) throw err
          // The server refused something in this chunk: retry row by row and quarantine only the offenders.
          for (const x of chunk) {
            try { await cloud.upsert(table, [toCloud(table, x.row)]); done(x.e.seqs); rep.pushed++ }
            catch (e2) {
              if (!(e2 instanceof RowRejectedError)) throw e2
              db.tx(() => {
                db.run(`INSERT INTO sync_conflicts(table_name,row_id,reason) VALUES(?,?,?)`, [table, x.e.id, e2.message])
                done(x.e.seqs)
              })
              rep.quarantined++
            }
          }
        }
      }
      // rows deleted outright locally (none expected: soft delete) have nothing to send
      done(entries.filter(e => !live.some(l => l.e === e)).flatMap(e => e.seqs))
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
export function supabaseCloud(sb: SupabaseClient): CloudClient {
  return {
    async claimTenant(tenantId, name) {
      const { error } = await sb.rpc('claim_tenant', { p_tenant: tenantId, p_name: name })
      if (error) throw new Error(`claim_tenant: ${error.message}`)
    },
    async upsert(table, rows) {
      // Events are append-only: re-sending one after a lost reply must be a harmless no-op, not an update.
      const { error } = await sb.from(table).upsert(rows, table === 'activity_log' ? { onConflict: 'id', ignoreDuplicates: true } : { onConflict: 'id' })
      if (error) {
        // 23xxx integrity, P0001 raised by our triggers, 42501 RLS/permission, 22xxx bad data → the row itself is refused.
        const rejected = /^(23|22|P0001|42501)/.test(error.code ?? '')
        throw rejected ? new RowRejectedError(`${table}: ${error.message}`) : new Error(`${table}: ${error.message}`)
      }
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
