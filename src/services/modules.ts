import { type Ctx, require, need } from './context'
import { MODULES, moduleDef, parseModules, formatModules, DEFAULT_MODULES } from '../modules/registry'

/** Module ids switched on for this farm. Reading them needs no permission: the menu depends on it. */
export function enabledModules(ctx: Ctx): string[] {
  const row = ctx.db.get<{ modules: string | null }>(`SELECT modules FROM farms WHERE id=? AND deleted_at IS NULL`, [ctx.farmId])
  return parseModules(row?.modules)
}

/** The module the signed-in person is working in: their choice if it is still enabled, else the first enabled one. */
export function currentModule(ctx: Ctx): string {
  const on = enabledModules(ctx)
  return ctx.module && on.includes(ctx.module) ? ctx.module : (on[0] ?? DEFAULT_MODULES[0])
}

/**
 * Enabled modules this person can use. Tobacco is open to everyone who can sign in, as before. Each later module will list the permission
 * prefixes that grant it (see MODULE_ACCESS); until a module has an entry here nobody but an owner reaches it.
 */
export const MODULE_ACCESS: Record<string, readonly string[] | 'all'> = { tobacco: 'all' }
export function accessibleModules(ctx: Ctx, can: (perm: string) => boolean): string[] {
  return enabledModules(ctx).filter(id => {
    const rule = MODULE_ACCESS[id]
    return rule === 'all' || can('*') || (Array.isArray(rule) && rule.some(prefix => [...ctx.perms].some(p => p.startsWith(prefix))))
  })
}

export function setFarmModules(ctx: Ctx, ids: string[]) {
  require(ctx, 'settings.modules.manage')
  const next = ids.filter((s, i, a) => a.indexOf(s) === i)
  need(next.length > 0, 'Keep at least one module switched on')
  for (const id of next) { const m = moduleDef(id); need(m, `Unknown module: ${id}`); need(m.available, `${m.label} is not available yet`) }
  const before = enabledModules(ctx)
  // Switching a module off hides its screens and keeps every record; it is refused while it still has an active season so nobody loses their place by accident.
  for (const id of before.filter(b => !next.includes(b)))
    need(!ctx.db.get(`SELECT 1 FROM seasons WHERE farm_id=? AND enterprise=? AND status='active' AND deleted_at IS NULL`, [ctx.farmId, id]), `${moduleDef(id)?.label ?? id} has an active season. Close it first.`)
  ctx.db.tx(() => {
    ctx.db.update('farms', ctx.farmId, { modules: formatModules(MODULES.map(m => m.id).filter(id => next.includes(id))) })
    ctx.db.audit(ctx.actor?.id ?? null, 'modules.set', 'farms', ctx.farmId)
  })
}
