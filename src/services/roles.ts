import { type Ctx, require, need } from './context'
import { ALL_PERMISSIONS } from '../lib/permissions'
import { uuid } from '../db/database'

export interface RoleRow { id: string; name: string; is_system: number; permissions: string[]; users: number }
export interface UserRow { id: string; name: string; role_id: string; role_name: string; active: number }

export function listRoles(ctx: Ctx): RoleRow[] {
  require(ctx, 'settings.roles.manage')
  return ctx.db.all<{ id: string; name: string; is_system: number }>(`SELECT id,name,is_system FROM roles WHERE tenant_id=? AND deleted_at IS NULL ORDER BY is_system DESC, name`, [ctx.tenantId])
    .map(r => ({ ...r,
      permissions: ctx.db.all<{ permission: string }>(`SELECT permission FROM role_permissions WHERE role_id=? ORDER BY permission`, [r.id]).map(p => p.permission),
      users: ctx.db.get<{ n: number }>(`SELECT COUNT(*) n FROM local_users WHERE role_id=? AND active=1`, [r.id])!.n }))
}

export function createRole(ctx: Ctx, name: string, permissions: string[]): string {
  require(ctx, 'settings.roles.manage')
  need(name.trim(), 'Role name is required')
  need(!ctx.db.get(`SELECT 1 FROM roles WHERE tenant_id=? AND lower(name)=lower(?) AND deleted_at IS NULL`, [ctx.tenantId, name.trim()]), 'A role with that name exists')
  need(permissions.every(p => ALL_PERMISSIONS.includes(p)), 'Unknown permission')
  const id = uuid()
  ctx.db.tx(() => {
    ctx.db.run(`INSERT INTO roles(id,tenant_id,name,is_system) VALUES(?,?,?,0)`, [id, ctx.tenantId, name.trim()])
    for (const p of permissions) ctx.db.run(`INSERT INTO role_permissions(tenant_id,role_id,permission) VALUES(?,?,?)`, [ctx.tenantId, id, p])
    ctx.db.audit(ctx.actor?.id ?? null, 'role.create', 'roles', id, { name, permissions })
  })
  return id
}

/** The Owner role is fixed to full access so a farm can never lock itself out. */
export function setRolePermissions(ctx: Ctx, roleId: string, permissions: string[]) {
  require(ctx, 'settings.roles.manage')
  const r = ctx.db.get<{ name: string }>(`SELECT name FROM roles WHERE id=? AND tenant_id=?`, [roleId, ctx.tenantId]); need(r, 'Role not found')
  need(r.name !== 'Owner', 'The Owner role always has full access')
  need(permissions.every(p => ALL_PERMISSIONS.includes(p)), 'Unknown permission')
  ctx.db.tx(() => {
    ctx.db.run(`DELETE FROM role_permissions WHERE role_id=?`, [roleId])
    for (const p of permissions) ctx.db.run(`INSERT INTO role_permissions(tenant_id,role_id,permission) VALUES(?,?,?)`, [ctx.tenantId, roleId, p])
    ctx.db.audit(ctx.actor?.id ?? null, 'role.permissions', 'roles', roleId, { permissions })
  })
}

export function listUsers(ctx: Ctx): UserRow[] {
  require(ctx, 'settings.users.manage')
  return ctx.db.all<UserRow>(`SELECT u.id,u.name,u.role_id,r.name role_name,u.active FROM local_users u JOIN roles r ON r.id=u.role_id WHERE u.tenant_id=? ORDER BY u.name`, [ctx.tenantId])
}

export function setUserActive(ctx: Ctx, userId: string, active: boolean) {
  require(ctx, 'settings.users.manage')
  need(userId !== ctx.actor?.id, 'You cannot deactivate your own account')
  if (!active) {
    const owners = ctx.db.get<{ n: number }>(`SELECT COUNT(*) n FROM local_users u JOIN roles r ON r.id=u.role_id WHERE r.name='Owner' AND u.active=1 AND u.id<>?`, [userId])!.n
    need(owners > 0, 'At least one active Owner is required')
  }
  ctx.db.tx(() => { ctx.db.run(`UPDATE local_users SET active=?, updated_at=datetime('now') WHERE id=? AND tenant_id=?`, [active ? 1 : 0, userId, ctx.tenantId]); ctx.db.audit(ctx.actor?.id ?? null, active ? 'user.activate' : 'user.deactivate', 'local_users', userId) })
}

export function auditTrail(ctx: Ctx, limit = 200) {
  require(ctx, 'settings.audit.view')
  return ctx.db.all<{ seq: number; at: string; actor_name: string | null; action: string; table_name: string | null }>(
    `SELECT a.seq,a.at,u.name actor_name,a.action,a.table_name FROM audit_log a LEFT JOIN local_users u ON u.id=a.actor ORDER BY a.seq DESC LIMIT ?`, [limit])
}
