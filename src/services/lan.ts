import type { Db, Row } from '../db/database'
import { need } from './context'
import { installFarm } from './devices'
import { isInitialised } from './setup'
import { RowRejectedError, syncNow, type CloudClient, type SyncReport } from './sync'

export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ status: number; ok: boolean; json(): Promise<unknown> }>
const defaultFetch: FetchLike = (u, i) => fetch(u, i)

/** "192.168.1.20", "192.168.1.20:7878" or a full URL → "http://192.168.1.20:7878" */
export function normaliseHubUrl(raw: string): string {
  let u = raw.trim().replace(/\/+$/, ''); need(u, 'Enter the hub address shown on the office computer')
  if (!/^https?:\/\//i.test(u)) u = `http://${u}`
  need(/^https?:\/\/[^\s/:]+(:\d{1,5})?$/i.test(u), 'The hub address should look like 192.168.1.20:7878')
  return /:\d+$/.test(u.replace(/^https?:\/\//i, '')) ? u : `${u}:7878`
}

async function call(fetchImpl: FetchLike, base: string, method: string, path: string, token: string | null, body?: unknown): Promise<unknown> {
  let res; try {
    res = await fetchImpl(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) })
  } catch { throw new Error('Cannot reach the farm hub. Check you are on the farm Wi-Fi and the office computer has the hub switched on.') }
  let data: { error?: string } & Record<string, unknown> = {}; try { data = (await res.json()) as typeof data } catch { /* non-JSON error page */ }
  if (res.status === 422) throw new RowRejectedError(data.error ?? 'The hub refused this record')
  if (res.status === 401) throw new Error(data.error ?? 'This device is not authorised by the hub')
  if (!res.ok) throw new Error(data.error ?? `Hub error ${res.status}`)
  return data
}

/** CloudClient over the farm Wi-Fi: the same sync engine as the cloud relay, pointed at the office PC. */
export function lanCloud(baseUrl: string, token: string, fetchImpl: FetchLike = defaultFetch): CloudClient {
  const base = normaliseHubUrl(baseUrl); const seqs = new WeakMap<Row, string>()
  return {
    async claimTenant(tenantId) {
      const s = (await call(fetchImpl, base, 'POST', '/session', token, {})) as { tenant_id: string }
      need(s.tenant_id === tenantId, 'This hub belongs to a different farm')
    },
    async upsert(table, rows) { await call(fetchImpl, base, 'POST', '/push', token, { table, rows }) },
    async fetchSince(table, since, limit) {
      const d = (await call(fetchImpl, base, 'GET', `/pull?table=${encodeURIComponent(table)}&since=${encodeURIComponent(since ?? '0')}&limit=${limit}`, token)) as { rows: Row[] }
      return d.rows.map(r => { const { _seq, ...row } = r as Row & { _seq: number }; seqs.set(row, String(_seq)); return row })
    },
    cursorOf: row => seqs.get(row) ?? '0',
  }
}

/** Pairs a blank device with the office hub using the owner's one-time code, then pulls the farm. Rolls back if nothing arrives. */
export async function joinHub(db: Db, o: { hubUrl: string; code: string; name: string; pin: string }, fetchImpl: FetchLike = defaultFetch): Promise<{ tag: string; report: SyncReport }> {
  need(!isInitialised(db), 'This device already belongs to a farm')
  need(o.name.trim(), 'Your name is required'); need(/^\d{4,8}$/.test(o.pin), 'PIN must be 4–8 digits'); need(/^\d{6}$/.test(o.code.replace(/\D/g, '')), 'Enter the 6-digit pairing code')
  const base = normaliseHubUrl(o.hubUrl)
  const p = (await call(fetchImpl, base, 'POST', '/pair', null, { code: o.code })) as { token: string; tag: string; device_label: string; tenant_id: string; tenant_name: string; role_id: string; roles: { id: string; name: string; is_system: boolean }[]; role_permissions: { role_id: string; permission: string }[] }
  need(p.roles.some(r => r.id === p.role_id), 'The hub did not send this device\'s role')
  return installFarm(db, { tenantId: p.tenant_id, tenantName: p.tenant_name, roleId: p.role_id, roles: p.roles.map(r => ({ ...r, is_system: !!r.is_system })), perms: p.role_permissions, tag: p.tag, deviceLabel: p.device_label, name: o.name.trim(), pin: o.pin,
    extraMeta: { hub_url: base, hub_token: p.token } }, lanCloud(base, p.token, fetchImpl))
}

export const hubUrl = (db: Db) => db.get<{ value: string }>(`SELECT value FROM meta WHERE key='hub_url'`)?.value ?? ''
export const isHubPaired = (db: Db) => !!db.get(`SELECT 1 FROM meta WHERE key='hub_token'`)
export function setHubUrl(db: Db, raw: string) { const u = normaliseHubUrl(raw); db.run(`INSERT INTO meta(key,value) VALUES('hub_url',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, [u]) }

/** One sync against the hub this device was paired with. No password: the device token is the credential. */
export async function syncViaHub(db: Db, tenantId: string, fetchImpl: FetchLike = defaultFetch): Promise<SyncReport> {
  const token = db.get<{ value: string }>(`SELECT value FROM meta WHERE key='hub_token'`)?.value; need(token, 'This device is not paired with a hub')
  const name = db.get<{ name: string }>(`SELECT name FROM tenants WHERE id=?`, [tenantId])!.name
  return syncNow(db, lanCloud(hubUrl(db), token, fetchImpl), tenantId, name)
}
