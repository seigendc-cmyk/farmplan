import { Db } from '../db/database'
import { hasPermission } from '../lib/permissions'

export class PermissionError extends Error {
  constructor(public permission: string) { super(`Permission denied: ${permission}`); this.name = 'PermissionError' }
}
export class ValidationError extends Error {
  constructor(message: string) { super(message); this.name = 'ValidationError' }
}

export interface Ctx {
  db: Db
  tenantId: string
  farmId: string
  actor: { id: string; name: string } | null
  perms: ReadonlySet<string>
  /** The module this person is working in (their picker choice). Absent means the farm's first enabled module, i.e. Tobacco on every existing farm. */
  module?: string
}

export function can(ctx: Ctx, perm: string) { return hasPermission(ctx.perms, perm) }
export function require(ctx: Ctx, perm: string) { if (!can(ctx, perm)) throw new PermissionError(perm) }

export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100
export const round4 = (n: number) => Math.round((n + Number.EPSILON) * 10000) / 10000

export function need(cond: unknown, message: string): asserts cond {
  if (!cond) throw new ValidationError(message)
}
export const isDate = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s))
