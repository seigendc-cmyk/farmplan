import type { SupabaseClient } from '@supabase/supabase-js'
import { Db, uuid } from '../db/database'
import { hashPin, isInitialised } from './setup'
import { need } from './context'
import { setDeviceTag } from './device'
import { supabaseCloud, syncNow, type CloudClient, type SyncReport } from './sync'

const unwrap = <T>(r: { data: T | null; error: { message: string } | null }, what: string): T => { if (r.error) throw new Error(`${what}: ${r.error.message}`); return (r.data ?? ([] as unknown)) as T }

export interface MyFarm { tenant_id: string; tenant_name: string; role_id: string; role_name: string }
export async function myFarms(sb: SupabaseClient): Promise<MyFarm[]> { return unwrap(await sb.rpc('my_farms'), 'Farms') as MyFarm[] }

/**
 * Turns a blank device into a field terminal for an existing farm:
 *  1. registers the device with the cloud (unique code tag so offline codes never collide),
 *  2. copies the farm's tenant, roles and permissions,
 *  3. creates this person's local PIN sign-in with their cloud role,
 *  4. pulls the farm's data. If the pull yields no farm, everything is rolled back so the device stays blank.
 */
export async function joinFarm(db: Db, sb: SupabaseClient, o: { tenantId: string; deviceLabel: string; name: string; pin: string }, cloud: CloudClient = supabaseCloud(sb)): Promise<{ tag: string; report: SyncReport }> {
  need(!isInitialised(db), 'This device already belongs to a farm')
  need(o.name.trim(), 'Your name is required'); need(/^\d{4,8}$/.test(o.pin), 'PIN must be 4–8 digits'); need(o.deviceLabel.trim(), 'Give this device a name, e.g. "Supervisor phone"')
  const farm = (await myFarms(sb)).find(f => f.tenant_id === o.tenantId); need(farm, 'You are not a member of that farm')
  const tag = unwrap(await sb.rpc('register_device', { p_tenant: o.tenantId, p_label: o.deviceLabel.trim() }), 'Device') as unknown as string
  need(typeof tag === 'string' && /^[A-Z]{1,3}$/.test(tag), 'The cloud did not issue a device tag')
  const roles = unwrap(await sb.from('roles').select('*').eq('tenant_id', o.tenantId), 'Roles') as { id: string; name: string; is_system: boolean }[]
  const perms = unwrap(await sb.from('role_permissions').select('*').eq('tenant_id', o.tenantId), 'Permissions') as { role_id: string; permission: string }[]
  need(roles.some(r => r.id === farm.role_id), 'Your role could not be read from the cloud')
  return installFarm(db, { tenantId: o.tenantId, tenantName: farm.tenant_name, roleId: farm.role_id, roles, perms, tag, deviceLabel: o.deviceLabel.trim(), name: o.name.trim(), pin: o.pin }, cloud)
}

export interface Bootstrap { tenantId: string; tenantName: string; roleId: string; roles: { id: string; name: string; is_system: boolean }[]; perms: { role_id: string; permission: string }[]; tag: string; deviceLabel: string; name: string; pin: string; extraMeta?: Record<string, string> }
/** Shared by cloud and Wi-Fi hub joins: copy identity, create the local PIN user, sync, and undo everything if no farm arrives. */
export async function installFarm(db: Db, o: Bootstrap, cloud: CloudClient): Promise<{ tag: string; report: SyncReport }> {
  const salt = uuid(); const hash = await hashPin(o.pin, salt)
  db.tx(() => {
    db.run(`INSERT INTO tenants(id,name,kind) VALUES(?,?,'farm')`, [o.tenantId, o.tenantName])
    for (const r of o.roles) db.run(`INSERT INTO roles(id,tenant_id,name,is_system) VALUES(?,?,?,?)`, [r.id, o.tenantId, r.name, r.is_system ? 1 : 0])
    for (const p of o.perms) db.run(`INSERT OR IGNORE INTO role_permissions(tenant_id,role_id,permission) VALUES(?,?,?)`, [o.tenantId, p.role_id, p.permission])
    db.run(`INSERT INTO local_users(id,tenant_id,name,role_id,pin_salt,pin_hash) VALUES(?,?,?,?,?,?)`, [uuid(), o.tenantId, o.name, o.roleId, salt, hash])
    setDeviceTag(db, o.tag, o.deviceLabel)
    for (const [k, v] of Object.entries(o.extraMeta ?? {})) db.run(`INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, [k, v])
  })
  const report = await syncNow(db, cloud, o.tenantId, o.tenantName)
  const hasFarm = !!db.get(`SELECT 1 FROM farms WHERE tenant_id=? LIMIT 1`, [o.tenantId])
  if (report.errors.length || !hasFarm) {
    db.tx(() => {
      for (const t of ['local_users', 'role_permissions', 'roles', 'tenants']) db.run(`DELETE FROM ${t} WHERE ${t === 'tenants' ? 'id' : 'tenant_id'}=?`, [o.tenantId])
      db.run(`DELETE FROM meta WHERE key IN ('device_tag','device_label','hub_url','hub_token') OR key LIKE 'cursor:%' OR key='last_sync'`)
    })
    throw new Error(report.errors[0] ?? 'No farm data was found yet. Sync from the office computer first.')
  }
  await db.flush()
  return { tag: o.tag, report }
}

// ---------------------------------------------------------------- owner side: staff & devices
export interface Member { user_id: string; email: string; role_name: string; active: boolean; devices: string }
export async function listMembers(sb: SupabaseClient, tenantId: string): Promise<Member[]> { return unwrap(await sb.rpc('list_members', { p_tenant: tenantId }), 'Staff') as Member[] }
export async function addMember(sb: SupabaseClient, tenantId: string, email: string, role: string) {
  need(/^\S+@\S+\.\S+$/.test(email.trim()), 'Enter a valid email address'); unwrap(await sb.rpc('add_member', { p_tenant: tenantId, p_email: email.trim(), p_role: role }), 'Enrol')
}
export async function setMemberActive(sb: SupabaseClient, tenantId: string, userId: string, active: boolean) { unwrap(await sb.rpc('set_member_active', { p_tenant: tenantId, p_user: userId, p_active: active }), 'Update') }

/** One manual sync from a field device: signs in (password is never stored), pushes the outbox, pulls changes. */
import { connectCloud, saveCloudConfig, type CloudConfig } from '../lib/cloud'
export async function syncWithCloud(db: Db, tenantId: string, cfg: CloudConfig, password: string): Promise<SyncReport> {
  const sb = await connectCloud(cfg, password); saveCloudConfig({ url: cfg.url, key: cfg.key, email: cfg.email })
  const name = db.get<{ name: string }>(`SELECT name FROM tenants WHERE id=?`, [tenantId])!.name
  const r = await syncNow(db, supabaseCloud(sb), tenantId, name)
  try { await sb.auth.signOut() } catch { /* best effort */ }
  return r
}
