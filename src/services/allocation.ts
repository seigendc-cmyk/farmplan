import { type Ctx, require, can, need, round2 } from './context'
import { revenueSummary } from './marketing'
import { COST_CATEGORIES } from './analytics'

export const ALLOCATION_BASES = ['none', 'area', 'green_kg', 'sold_kg'] as const
export type AllocationBasis = (typeof ALLOCATION_BASES)[number]
export const BASIS_LABEL: Record<AllocationBasis, string> = { none: 'Do not allocate', area: 'Field area (ha)', green_kg: 'Green kg harvested', sold_kg: 'Kg sold' }

/** Used when a category has no rule of its own. */
export const DEFAULT_BASIS: Record<string, AllocationBasis> = {
  curing: 'green_kg', storage: 'green_kg', grading: 'sold_kg', baling: 'sold_kg', marketing: 'sold_kg',
  seed: 'area', fertilizer: 'area', chemicals: 'area', labour: 'area', machinery: 'area', fuel: 'area', irrigation: 'area', transport: 'area', overhead: 'area',
}

export interface RuleRow { category: string; basis: AllocationBasis; is_default: boolean }

export function listAllocationRules(ctx: Ctx): RuleRow[] {
  require(ctx, 'finance.budget.view')
  const own = new Map(ctx.db.all<{ category: string; basis: AllocationBasis }>(`SELECT category, basis FROM allocation_rules WHERE farm_id=? AND deleted_at IS NULL`, [ctx.farmId]).map(r => [r.category, r.basis]))
  return COST_CATEGORIES.map(category => ({ category, basis: own.get(category) ?? DEFAULT_BASIS[category] ?? 'area', is_default: !own.has(category) }))
}

/** Sets the basis for one category. Passing null restores the built-in default. */
export function setAllocationRule(ctx: Ctx, category: string, basis: AllocationBasis | null) {
  require(ctx, 'finance.budget.edit')
  need((COST_CATEGORIES as readonly string[]).includes(category), 'Unknown cost category')
  need(basis == null || ALLOCATION_BASES.includes(basis), 'Unknown allocation basis')
  ctx.db.tx(() => {
    const cur = ctx.db.get<{ id: string }>(`SELECT id FROM allocation_rules WHERE farm_id=? AND category=? AND deleted_at IS NULL`, [ctx.farmId, category])
    if (basis == null) { if (cur) ctx.db.softDelete('allocation_rules', cur.id) }
    else if (cur) ctx.db.update('allocation_rules', cur.id, { basis })
    else ctx.db.insert('allocation_rules', { tenant_id: ctx.tenantId, farm_id: ctx.farmId, category, basis })
    ctx.db.audit(ctx.actor?.id ?? null, 'allocation.rule', 'allocation_rules', cur?.id, { category, basis })
  })
}

/** Splits `amount` by weights in whole cents, giving leftover cents to the largest fractional remainders so the parts always sum exactly. */
export function splitByWeight(amount: number, weights: number[]): number[] {
  const total = weights.reduce((s, w) => s + w, 0)
  if (!(total > 0)) return weights.map(() => 0)
  const cents = Math.round(amount * 100)
  const raw = weights.map(w => (cents * w) / total)
  const base = raw.map(Math.floor)
  let left = cents - base.reduce((s, v) => s + v, 0)
  const order = raw.map((v, i) => ({ i, frac: v - base[i] })).sort((a, b) => b.frac - a.frac || a.i - b.i)
  for (const o of order) { if (left <= 0) break; base[o.i]++; left-- }
  return base.map(c => c / 100)
}

export interface AllocationLine { category: string; basis: AllocationBasis; amount: number; allocated: number; unallocated: number }
export interface Allocation { by_field: Map<string, number>; lines: AllocationLine[]; allocated: number; unallocated: number }

/** Spreads cost entries with no field over the fields harvested in the season, using each category's rule. */
export function allocatedCosts(ctx: Ctx, seasonId: string): Allocation {
  require(ctx, 'finance.cost.view')
  const db = ctx.db
  const shared = db.all<{ category: string; a: number }>(`SELECT category, SUM(amount) a FROM cost_entries WHERE farm_id=? AND season_id=? AND field_id IS NULL AND deleted_at IS NULL GROUP BY category`, [ctx.farmId, seasonId])
  const fields = db.all<{ id: string; field_no: string; area_ha: number; kg: number }>(
    `SELECT f.id, f.field_no, f.area_ha, SUM(h.green_weight_kg) kg FROM harvest_batches h JOIN fields f ON f.id=h.field_id
     WHERE h.farm_id=? AND h.season_id=? AND h.deleted_at IS NULL GROUP BY f.id ORDER BY f.field_no`, [ctx.farmId, seasonId])
  const sold = can(ctx, 'marketing.sale.view') ? new Map(revenueSummary(ctx, seasonId).by_field.map(r => [r.key, r.kg])) : null
  const rules = new Map(listAllocationRulesSafe(ctx).map(r => [r.category, r.basis]))
  const by_field = new Map<string, number>(); const lines: AllocationLine[] = []
  for (const s of shared) {
    const basis = rules.get(s.category) ?? DEFAULT_BASIS[s.category] ?? 'area'
    const amount = round2(s.a)
    const weights = basis === 'none' ? fields.map(() => 0)
      : fields.map(f => basis === 'area' ? f.area_ha : basis === 'green_kg' ? f.kg : sold ? sold.get(f.field_no) ?? 0 : f.kg)
    const parts = splitByWeight(amount, weights)
    const allocated = round2(parts.reduce((x, y) => x + y, 0))
    fields.forEach((f, i) => { if (parts[i]) by_field.set(f.id, round2((by_field.get(f.id) ?? 0) + parts[i])) })
    lines.push({ category: s.category, basis, amount, allocated, unallocated: round2(amount - allocated) })
  }
  const allocated = round2(lines.reduce((x, l) => x + l.allocated, 0))
  return { by_field, lines, allocated, unallocated: round2(lines.reduce((x, l) => x + l.unallocated, 0)) }
}

// Profitability readers may hold finance.cost.view without finance.budget.view; rules are still applied for them.
function listAllocationRulesSafe(ctx: Ctx) {
  return ctx.db.all<{ category: string; basis: AllocationBasis }>(`SELECT category, basis FROM allocation_rules WHERE farm_id=? AND deleted_at IS NULL`, [ctx.farmId])
}
