import { Db, uuid } from '../db/database'
import { SYSTEM_ROLES } from '../lib/permissions'
import { need, require as requirePerm, type Ctx } from './context'

export async function hashPin(pin: string, salt: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', iterations: 120_000, salt: new TextEncoder().encode(salt) }, key, 256)
  return Array.from(new Uint8Array(bits)).map(b => b.toString(16).padStart(2, '0')).join('')
}

export function isInitialised(db: Db): boolean {
  return !!db.get(`SELECT 1 FROM tenants LIMIT 1`)
}

export interface SetupInput { tenantName: string; farmName: string; location?: string; currency?: string; ownerName: string; ownerPin: string }

/** First-run: creates tenant, farm, the four system roles and the Owner account. */
export async function initialiseFarm(db: Db, input: SetupInput) {
  need(!isInitialised(db), 'This device is already set up')
  need(input.tenantName.trim() && input.farmName.trim(), 'Business and farm names are required')
  need(input.ownerName.trim(), 'Owner name is required')
  need(/^\d{4,8}$/.test(input.ownerPin), 'PIN must be 4–8 digits')
  const salt = uuid()
  const pin_hash = await hashPin(input.ownerPin, salt)
  const tenantId = uuid(); const farmId = uuid(); const ownerRole = uuid()
  db.tx(() => {
    db.run(`INSERT INTO tenants(id,name,kind) VALUES(?,?,'farm')`, [tenantId, input.tenantName.trim()])
    for (const [name, perms] of Object.entries(SYSTEM_ROLES)) {
      const rid = name === 'Owner' ? ownerRole : uuid()
      db.run(`INSERT INTO roles(id,tenant_id,name,is_system) VALUES(?,?,?,1)`, [rid, tenantId, name])
      for (const p of perms) db.run(`INSERT INTO role_permissions(tenant_id,role_id,permission) VALUES(?,?,?)`, [tenantId, rid, p])
    }
    db.insert('farms', { id: farmId, tenant_id: tenantId, name: input.farmName.trim(), location: input.location ?? null, currency: input.currency ?? 'USD' })
    db.run(`INSERT INTO local_users(id,tenant_id,name,role_id,pin_salt,pin_hash) VALUES(?,?,?,?,?,?)`,
      [uuid(), tenantId, input.ownerName.trim(), ownerRole, salt, pin_hash])
    db.audit(null, 'setup', 'tenants', tenantId)
  })
  await db.flush()
  return { tenantId, farmId }
}

export interface LoginResult { ok: boolean; reason?: string; ctx?: { tenantId: string; farmId: string; actor: { id: string; name: string }; perms: Set<string> } }

const attempts = new Map<string, { n: number; until: number }>()

export async function login(db: Db, name: string, pin: string): Promise<LoginResult> {
  const lock = attempts.get(name.toLowerCase())
  if (lock && lock.until > Date.now()) return { ok: false, reason: 'Too many attempts. Try again shortly.' }
  const u = db.get<{ id: string; tenant_id: string; name: string; role_id: string; pin_salt: string; pin_hash: string }>(
    `SELECT * FROM local_users WHERE lower(name)=lower(?) AND active=1 AND deleted_at IS NULL`, [name.trim()])
  const ok = u && (await hashPin(pin, u.pin_salt)) === u.pin_hash
  if (!u || !ok) {
    const cur = attempts.get(name.toLowerCase()) ?? { n: 0, until: 0 }
    cur.n++; if (cur.n >= 5) { cur.until = Date.now() + 60_000; cur.n = 0 }
    attempts.set(name.toLowerCase(), cur)
    return { ok: false, reason: 'Incorrect name or PIN' }
  }
  attempts.delete(name.toLowerCase())
  const perms = new Set(db.all<{ permission: string }>(`SELECT permission FROM role_permissions WHERE role_id=?`, [u.role_id]).map(r => r.permission))
  const farm = db.get<{ id: string }>(`SELECT id FROM farms WHERE tenant_id=? AND deleted_at IS NULL LIMIT 1`, [u.tenant_id])!
  db.actor = { id: u.id, name: u.name }
  db.audit(u.id, 'login')
  return { ok: true, ctx: { tenantId: u.tenant_id, farmId: farm.id, actor: { id: u.id, name: u.name }, perms } }
}

/**
 * Picks a sign-in back up after a page reload (the app keeps a per-tab session, see store/app.ts). Only a still-active user is
 * resumed, with the role's permissions as they are now, so deactivating someone or changing their role takes effect on reload.
 */
export function resumeSession(db: Db, userId: string): LoginResult['ctx'] | null {
  const u = db.get<{ id: string; tenant_id: string; name: string; role_id: string }>(`SELECT id, tenant_id, name, role_id FROM local_users WHERE id=? AND active=1 AND deleted_at IS NULL`, [userId])
  const farm = u && db.get<{ id: string }>(`SELECT id FROM farms WHERE tenant_id=? AND deleted_at IS NULL LIMIT 1`, [u.tenant_id])
  if (!u || !farm) return null
  const perms = new Set(db.all<{ permission: string }>(`SELECT permission FROM role_permissions WHERE role_id=?`, [u.role_id]).map(r => r.permission))
  db.actor = { id: u.id, name: u.name }
  return { tenantId: u.tenant_id, farmId: farm.id, actor: { id: u.id, name: u.name }, perms }
}

export async function createUser(ctx: Ctx, name: string, pin: string, roleId: string) {
  const { db, tenantId } = ctx
  requirePerm(ctx, 'settings.users.manage')
  need(name.trim(), 'Name is required'); need(/^\d{4,8}$/.test(pin), 'PIN must be 4–8 digits')
  need(db.get(`SELECT 1 FROM roles WHERE id=? AND tenant_id=?`, [roleId, tenantId]), 'Unknown role')
  const salt = uuid(); const h = await hashPin(pin, salt)
  const id = uuid()
  db.tx(() => {
    db.run(`INSERT INTO local_users(id,tenant_id,name,role_id,pin_salt,pin_hash) VALUES(?,?,?,?,?,?)`, [id, tenantId, name.trim(), roleId, salt, h])
    db.audit(ctx.actor?.id ?? null, 'user.create', 'local_users', id, { name, roleId })
  })
  await db.flush()
  return id
}
