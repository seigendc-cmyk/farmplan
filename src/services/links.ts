import { type Ctx, can } from './context'

/**
 * Every record a screen can point at, by the key people already see (unique per farm; inputs are shared across the tenant's farms),
 * the page that shows it and the permission needed to open that page. Machines are keyed by id because two can share a name;
 * a budget line is keyed by category within a season.
 */
export type RecKind = 'field' | 'harvest' | 'cycle' | 'storage' | 'lot' | 'bale' | 'sale' | 'contract' | 'buyer' | 'machine' | 'input' | 'budget'
interface RecDef { table: string; key: string; perm: string; path: string; seasoned: boolean; tenant?: boolean; nocase?: boolean }
export const RECORDS: Record<RecKind, RecDef> = {
  field: { table: 'fields', key: 'field_no', perm: 'production.field.view', path: '/fields', seasoned: false },
  harvest: { table: 'harvest_batches', key: 'code', perm: 'production.harvest.view', path: '/harvest', seasoned: true },
  cycle: { table: 'curing_cycles', key: 'code', perm: 'curing.cycle.view', path: '/curing', seasoned: true },
  storage: { table: 'storage_units', key: 'code', perm: 'curing.storage.view', path: '/starking', seasoned: true },
  lot: { table: 'grading_lots', key: 'code', perm: 'quality.grading.view', path: '/grading', seasoned: true },
  bale: { table: 'bales', key: 'code', perm: 'quality.bale.view', path: '/bales', seasoned: true },
  sale: { table: 'sales', key: 'code', perm: 'marketing.sale.view', path: '/sales', seasoned: true },
  contract: { table: 'contracts', key: 'code', perm: 'contracts.contract.view', path: '/contracts', seasoned: true },
  buyer: { table: 'buyers', key: 'name', perm: 'marketing.buyer.view', path: '/buyers', seasoned: false, nocase: true },
  machine: { table: 'machines', key: 'id', perm: 'resources.machinery.view', path: '/machinery', seasoned: false },
  input: { table: 'inputs', key: 'name', perm: 'resources.inventory.view', path: '/inventory', seasoned: false, tenant: true },
  budget: { table: 'budgets', key: 'category', perm: 'finance.budget.view', path: '/budgets', seasoned: true },
}

/** Where a page link goes. Fields have their own page; everything else opens its list with the record in focus (and, when given, in that season). */
export function recordHref(kind: RecKind, key: string, seasonId?: string): string {
  const r = RECORDS[kind]
  return kind === 'field' ? `${r.path}/${encodeURIComponent(key)}` : `${r.path}?focus=${encodeURIComponent(key)}${seasonId ? `&season=${encodeURIComponent(seasonId)}` : ''}`
}

/** Finds a record by its visible key, within this farm (or tenant, for inputs) and only if the reader may open its page. */
export function locate(ctx: Ctx, kind: RecKind, key: string, seasonId?: string): { id: string; season_id: string | null } | null {
  const r = RECORDS[kind]
  if (!key || !can(ctx, r.perm)) return null
  const where = [r.tenant ? 'tenant_id=?' : 'farm_id=?', r.nocase ? `lower(${r.key})=lower(?)` : `${r.key}=?`, 'deleted_at IS NULL']; const p = [r.tenant ? ctx.tenantId : ctx.farmId, key.trim()]
  if (seasonId && r.seasoned) { where.push('season_id=?'); p.push(seasonId) }
  return ctx.db.get<{ id: string; season_id: string | null }>(`SELECT id, ${r.seasoned ? 'season_id' : 'NULL'} season_id FROM ${r.table} WHERE ${where.join(' AND ')} LIMIT 1`, p) ?? null
}
