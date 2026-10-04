import { Db, SYNC_TABLES, uuid, type Row } from '../db/database'
import { hubReindex } from '../db/hublog'
import { can, need, require, type Ctx } from './context'
import { toLocal } from './sync'

/**
 * Wi-Fi hub (office PC). The Rust shell only moves HTTP bytes; every rule lives here so it can be tested without a network.
 *
 *   GET  /hello                         → { app, v }                     (no auth, reveals nothing about the farm)
 *   POST /pair  {code}                  → device token + farm bootstrap  (one-time code made by the owner)
 *   POST /session                       → { tenant_id, tenant_name, tag }
 *   POST /push  {table, rows}           → { applied, skipped }
 *   GET  /pull?table&since&limit        → { rows } each with _seq, the hub change-feed cursor
 */
export const HUB_VERSION = 1
/** Tables a field phone may write. Everything else is refused (422) so it is quarantined on the phone rather than blocking its sync. */
export const HUB_WRITE_TABLES = new Set(['operations', 'operation_inputs', 'inventory_transactions', 'cost_entries', 'weather_records', 'harvest_batches', 'labour_entries', 'machine_logs', 'activity_log'])
/** Never sent to phones over the hub (bank details live here). */
export const HUB_NO_READ = new Set(['buyers', 'buyer_deductions', 'activity_log'])
const PAIR_MINUTES = 10, MAX_PAIR_FAILS = 5

export interface HubRequest { method: string; path: string; auth?: string | null; body?: unknown }
export interface HubResponse { status: number; body: unknown }
const reply = (status: number, body: unknown): HubResponse => ({ status, body })

async function sha256(s: string) { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))).map(b => b.toString(16).padStart(2, '0')).join('') }
const randomHex = (bytes: number) => Array.from(crypto.getRandomValues(new Uint8Array(bytes))).map(b => b.toString(16).padStart(2, '0')).join('')
const meta = (db: Db, k: string) => db.get<{ value: string }>(`SELECT value FROM meta WHERE key=?`, [k])?.value
const setMeta = (db: Db, k: string, v: string) => db.run(`INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, [k, v])

export const isHubEnabled = (db: Db) => meta(db, 'hub_enabled') === '1'
export function setHubEnabled(db: Db, on: boolean) { if (on) hubReindex(db); setMeta(db, 'hub_enabled', on ? '1' : '0') }

// ---------------------------------------------------------------- owner side
export function createPairing(ctx: Ctx, deviceLabel: string, roleName = 'Field Recorder'): Promise<{ code: string; expires_at: string }> {
  return (async () => {
    require(ctx, 'settings.users.manage')
    need(deviceLabel.trim(), 'Give the device a name, e.g. "Supervisor phone"')
    const role = ctx.db.get<{ id: string; name: string }>(`SELECT id, name FROM roles WHERE tenant_id=? AND name=?`, [ctx.tenantId, roleName])
    need(role, 'Unknown role'); need(role.name !== 'Owner', 'A phone cannot be paired as Owner')
    const id = uuid(); const expires = new Date(Date.now() + PAIR_MINUTES * 60_000).toISOString()
    const real = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1e6).padStart(6, '0') // short-lived, single-use and attempt-limited
    const hash = await sha256(`${id}:${real}`)
    ctx.db.tx(() => {
      ctx.db.run(`INSERT INTO lan_pairings(id,code_hash,device_label,role_id,expires_at,created_by) VALUES(?,?,?,?,?,?)`, [id, hash, deviceLabel.trim(), role.id, expires, ctx.actor?.id ?? null])
      ctx.db.audit(ctx.actor?.id ?? null, 'hub.pairing.create', 'lan_pairings', id, { deviceLabel, role: role.name })
    })
    return { code: real, expires_at: expires }
  })()
}

export interface HubDevice { id: string; tag: string; label: string; role_name: string; created_at: string; last_seen: string | null; revoked: boolean }
export function listHubDevices(ctx: Ctx): HubDevice[] {
  require(ctx, 'settings.users.manage')
  return ctx.db.all<HubDevice & { revoked_at: string | null }>(`SELECT d.id, d.tag, d.label, r.name role_name, d.created_at, d.last_seen, d.revoked_at FROM lan_devices d LEFT JOIN roles r ON r.id=d.role_id ORDER BY d.tag`)
    .map(d => ({ id: d.id, tag: d.tag, label: d.label, role_name: d.role_name, created_at: d.created_at, last_seen: d.last_seen, revoked: !!d.revoked_at }))
}
export function revokeHubDevice(ctx: Ctx, id: string) {
  require(ctx, 'settings.users.manage')
  ctx.db.tx(() => { ctx.db.run(`UPDATE lan_devices SET revoked_at=datetime('now') WHERE id=? AND revoked_at IS NULL`, [id]); ctx.db.audit(ctx.actor?.id ?? null, 'hub.device.revoke', 'lan_devices', id) })
}
export const canManageHub = (ctx: Ctx) => can(ctx, 'settings.users.manage')

// ---------------------------------------------------------------- request handling
const tenantOf = (db: Db) => db.get<{ id: string; name: string }>(`SELECT id, name FROM tenants LIMIT 1`)

async function authDevice(db: Db, auth?: string | null) {
  const m = /^Bearer ([0-9a-f]{64})$/.exec(auth ?? ''); if (!m) return null
  const d = db.get<{ id: string; tag: string; role_id: string }>(`SELECT id, tag, role_id FROM lan_devices WHERE token_hash=? AND revoked_at IS NULL`, [await sha256(m[1])])
  if (d) db.run(`UPDATE lan_devices SET last_seen=datetime('now') WHERE id=?`, [d.id])
  return d
}

export async function hubHandle(db: Db, req: HubRequest): Promise<HubResponse> {
  try {
    const url = new URL(req.path, 'http://hub'); const route = `${req.method.toUpperCase()} ${url.pathname}`
    if (route === 'GET /hello') return reply(200, { app: 'farmplan-hub', v: HUB_VERSION })
    if (!isHubEnabled(db)) return reply(503, { error: 'The farm hub is switched off' })
    const t = tenantOf(db); if (!t) return reply(503, { error: 'This hub has no farm yet' })
    if (route === 'POST /pair') return await pair(db, t, req.body as { code?: string })
    const dev = await authDevice(db, req.auth)
    if (!dev) return reply(401, { error: 'This device is not authorised. Pair it again with the farm owner.' })
    if (route === 'POST /session') return reply(200, { tenant_id: t.id, tenant_name: t.name, tag: dev.tag })
    if (route === 'POST /push') return push(db, t.id, req.body as { table?: string; rows?: Row[] })
    if (route === 'GET /pull') return pull(db, url.searchParams)
    return reply(404, { error: 'Unknown request' })
  } catch (e) { return reply(500, { error: e instanceof Error ? e.message : String(e) }) }
}

async function pair(db: Db, t: { id: string; name: string }, body: { code?: string }): Promise<HubResponse> {
  const code = String(body?.code ?? '').replace(/\D/g, '')
  const pending = db.all<{ id: string; code_hash: string; device_label: string; role_id: string }>(`SELECT id, code_hash, device_label, role_id FROM lan_pairings WHERE used_at IS NULL AND expires_at > ?`, [new Date().toISOString()])
  let hit: (typeof pending)[number] | undefined
  if (/^\d{6}$/.test(code)) for (const p of pending) if (p.code_hash === await sha256(`${p.id}:${code}`)) hit = p
  if (!hit) {
    const fails = Number(meta(db, 'hub_pair_fails') ?? 0) + 1
    if (fails >= MAX_PAIR_FAILS) { db.run(`UPDATE lan_pairings SET used_at='locked' WHERE used_at IS NULL`); setMeta(db, 'hub_pair_fails', '0'); return reply(429, { error: 'Too many wrong codes. Ask the owner to create a new pairing code.' }) }
    setMeta(db, 'hub_pair_fails', String(fails)); return reply(403, { error: 'That code is wrong or has expired.' })
  }
  const n = db.get<{ n: number }>(`SELECT COUNT(*) n FROM lan_devices`)!.n
  if (n >= 26) return reply(409, { error: 'This hub supports up to 26 phones. Remove unused devices first.' })
  const tag = `L${String.fromCharCode(65 + n)}`; const token = randomHex(32); const id = uuid(); const tokenHash = await sha256(token)
  db.tx(() => {
    db.run(`INSERT INTO lan_devices(id,tag,label,role_id,token_hash) VALUES(?,?,?,?,?)`, [id, tag, hit!.device_label, hit!.role_id, tokenHash])
    db.run(`UPDATE lan_pairings SET used_at=datetime('now') WHERE id=?`, [hit!.id]); db.audit(null, 'hub.device.pair', 'lan_devices', id, { tag, label: hit!.device_label })
  })
  setMeta(db, 'hub_pair_fails', '0')
  const roles = db.all<Row>(`SELECT id, name, is_system FROM roles WHERE tenant_id=?`, [t.id])
  const role_permissions = db.all<Row>(`SELECT role_id, permission FROM role_permissions WHERE tenant_id=?`, [t.id])
  return reply(200, { token, tag, device_label: hit.device_label, tenant_id: t.id, tenant_name: t.name, role_id: hit.role_id, roles, role_permissions })
}

const columnsOf = (db: Db, table: string) => new Set(db.all<{ name: string }>(`PRAGMA table_info(${table})`).map(c => c.name))

function push(db: Db, tenantId: string, body: { table?: string; rows?: Row[] }): HubResponse {
  const table = body?.table ?? ''; const rows = body?.rows
  if (!SYNC_TABLES.has(table) || !HUB_WRITE_TABLES.has(table)) return reply(422, { error: `${table}: field devices may not write this table over the hub` })
  if (!Array.isArray(rows) || rows.length > 500) return reply(422, { error: 'rows must be a list of at most 500' })
  const cols = columnsOf(db, table); let applied = 0, skipped = 0
  try {
    db.tx(() => {
      for (const raw of rows) {
        if (typeof raw?.id !== 'string' || raw.tenant_id !== tenantId || typeof raw.updated_at !== 'string') throw new Error(`${table}: row is missing id/updated_at or belongs to another farm`)
        const row = toLocal(table, raw); const keys = Object.keys(row)
        for (const k of keys) if (!cols.has(k)) throw new Error(`${table}: unknown column ${k}`)
        const local = db.get<{ updated_at: string }>(`SELECT updated_at FROM ${table} WHERE id=?`, [raw.id])
        if (local && Date.parse(local.updated_at) > Date.parse(raw.updated_at)) { skipped++; continue }
        db.run(`INSERT OR REPLACE INTO ${table}(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`, keys.map(k => row[k]))
        db.run(`INSERT INTO outbox(table_name,row_id,op,payload) VALUES(?,?, 'upsert', '{}')`, [table, raw.id])
        db.run(`INSERT INTO hub_log(table_name,row_id) VALUES(?,?)`, [table, raw.id]); applied++
      }
    })
  } catch (e) { return reply(422, { error: e instanceof Error ? e.message : String(e) }) }
  return reply(200, { applied, skipped })
}

function pull(db: Db, q: URLSearchParams): HubResponse {
  const table = q.get('table') ?? ''; if (!SYNC_TABLES.has(table)) return reply(422, { error: 'Unknown table' })
  if (HUB_NO_READ.has(table)) return reply(200, { rows: [] })
  const since = Math.max(0, Number(q.get('since') ?? 0) || 0); const limit = Math.min(500, Math.max(1, Number(q.get('limit') ?? 500) || 500))
  const heads = db.all<{ row_id: string; seq: number }>(`SELECT row_id, MAX(seq) seq FROM hub_log WHERE table_name=? AND seq>? GROUP BY row_id ORDER BY seq LIMIT ?`, [table, since, limit])
  const rows: Row[] = []
  for (const h of heads) { const r = db.get(`SELECT * FROM ${table} WHERE id=?`, [h.row_id]); if (r) rows.push({ ...r, _seq: h.seq }) }
  return reply(200, { rows })
}
