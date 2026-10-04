import { type Ctx, can } from './context'
import { listInputs } from './inventory'
import { listMachines } from './machinery'
import { listStorage, unstoredByCycle } from './storage'
import { ungradedUnits, unbaledOutputs } from './quality'
import { listHarvests } from './harvest'
import { buyerAgeing } from './buyers'
import { planVsActual } from './analytics'
import { activeSeason } from './seasons'
import { listSyncConflicts } from './sync'
import { recordHref, type RecKind } from './links'

/** One thing someone should act on, where to act on it, and how urgent it is (red: money or a commitment at risk; amber: needs doing soon; blue: next step in the chain). */
export interface Alert { key: string; tone: 'red' | 'amber' | 'blue'; area: string; text: string; to: string }

const fmtKg = (n: number) => `${Math.round(n * 10) / 10} kg`
const qty = (n: number) => String(Math.round(n * 100) / 100)
const daysAgo = (asOf: string, n: number) => new Date(Date.parse(asOf) - n * 864e5).toISOString().slice(0, 10)
/** Green leaf left this long after picking is at risk; flag it before it is lost. */
export const GREEN_LEAF_WAIT_DAYS = 2

/**
 * The dashboard's "needs attention" list, built from every module's own rules. Each check runs only when the reader's role can open
 * that module, so the list never reveals what the role may not see; amounts appear only behind the finance and sales permissions.
 * Every item links to its record (opened highlighted, in its season) except sync conflicts and buyers not in the register, which have none.
 * Stock: out of stock (red); at or below the input's reorder level, "low" (amber); expired (red) or expiring within 90 days (amber).
 */
export function attention(ctx: Ctx, asOf = new Date().toISOString().slice(0, 10)): Alert[] {
  const out: Alert[] = []; const db = ctx.db
  const add = (tone: Alert['tone'], area: string, key: string, text: string, to: string) => out.push({ key: `${area}:${key}`, tone, area, text, to })
  const link = (kind: RecKind, code: string) => recordHref(kind, code)
  const cur = db.get<{ currency: string | null }>(`SELECT currency FROM farms WHERE id=?`, [ctx.farmId])?.currency || 'USD'
  const money = (n: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: cur, maximumFractionDigits: 2 }).format(n)

  const n = listSyncConflicts(db).length
  if (n) add('red', 'Sync', 'conflicts', `${n} record${n > 1 ? 's were' : ' was'} refused by the cloud and ${n > 1 ? 'are' : 'is'} waiting for a decision`, '/sync')

  if (can(ctx, 'production.harvest.view')) for (const h of listHarvests(ctx, { onlyUnloaded: true }).filter(h => h.harvested_on <= daysAgo(asOf, GREEN_LEAF_WAIT_DAYS)))
    add('amber', 'Harvest', h.code, `${h.code} (${fmtKg(h.green_weight_kg)} from ${h.field_no}) was picked ${Math.round((Date.parse(asOf) - Date.parse(h.harvested_on)) / 864e5)} days ago and is not in a barn`, link('harvest', h.code))

  if (can(ctx, 'curing.storage.view')) {
    for (const c of unstoredByCycle(ctx)) add('amber', 'Storage', c.code, `${c.code}: ${fmtKg(c.unstored_kg)} of cured leaf is not yet stored`, link('cycle', c.code))
    for (const u of listStorage(ctx, { asOf }).filter(u => u.stage === 'READY TO OPEN')) add('blue', 'Storage', u.code, `${u.code} is ready to open for grading${u.days_to_open < 0 ? ` (${-u.days_to_open} days overdue)` : ''}`, link('storage', u.code))
  }
  if (can(ctx, 'quality.grading.view')) for (const u of ungradedUnits(ctx)) add('blue', 'Grading', u.code, `${u.code} (${fmtKg(u.weight_kg)}) is open and waiting to be graded`, link('storage', u.code))
  if (can(ctx, 'quality.bale.view')) for (const o of unbaledOutputs(ctx)) add('blue', 'Bales', `${o.lot_code}-${o.grade}`, `${o.lot_code} grade ${o.grade}: ${fmtKg(o.remaining_kg)} graded but not baled`, link('lot', o.lot_code))

  if (can(ctx, 'contracts.contract.view')) {
    for (const o of db.all<{ id: string; code: string; description: string; due_on: string }>(
      `SELECT o.id, c.code, o.description, o.due_on FROM contract_obligations o JOIN contracts c ON c.id=o.contract_id
       WHERE c.farm_id=? AND c.status IN ('draft','active') AND c.deleted_at IS NULL AND o.deleted_at IS NULL AND o.done=0 AND o.due_on IS NOT NULL AND o.due_on < ? ORDER BY o.due_on`, [ctx.farmId, asOf]))
      add('red', 'Contracts', o.id, `${o.code}: “${o.description}” was due ${o.due_on}`, link('contract', o.code))
    for (const c of db.all<{ code: string; delivery_deadline: string }>(
      `SELECT code, delivery_deadline FROM contracts WHERE farm_id=? AND status='active' AND deleted_at IS NULL AND delivery_deadline IS NOT NULL AND delivery_deadline < ? ORDER BY delivery_deadline`, [ctx.farmId, asOf]))
      add('red', 'Contracts', `${c.code}-deadline`, `${c.code} passed its delivery deadline (${c.delivery_deadline}) and is not settled`, link('contract', c.code))
  }

  if (can(ctx, 'marketing.sale.view')) for (const a of buyerAgeing(ctx, asOf).filter(a => a.overdue > 0.005))
    add('red', 'Buyers', a.buyer_id ?? a.name, `${a.name} is overdue with ${money(a.overdue)}`, a.buyer_id ? link('buyer', a.name) : '/buyers')

  const season = activeSeason(ctx)
  if (season && can(ctx, 'finance.budget.view') && can(ctx, 'finance.cost.view')) for (const l of planVsActual(ctx, season.id).lines.filter(l => l.status === 'over'))
    add('amber', 'Budget', l.category, `${l.category} is over budget: ${money(l.actual)} spent of ${money(l.budget ?? 0)}`, recordHref('budget', l.category, season.id))

  if (can(ctx, 'resources.machinery.view')) for (const m of listMachines(ctx).filter(m => m.active && m.service_due))
    add('amber', 'Machinery', m.id, `${m.name} is due for a service (${Math.round(m.hours_since_service ?? m.total_hours)} h since the last one)`, link('machine', m.id))

  if (can(ctx, 'resources.inventory.view')) {
    const soon = daysAgo(asOf, -90)
    for (const i of listInputs(ctx).filter(i => i.active)) {
      // A product is tracked once it has a reorder level or any stock history; one never bought and never given a level is just a catalogue entry.
      const tracked = i.reorder_level != null || !!db.get(`SELECT 1 FROM inventory_transactions WHERE input_id=? AND farm_id=? AND deleted_at IS NULL`, [i.id, ctx.farmId])
      if (i.on_hand <= 0.0001) { if (tracked) add('red', 'Inventory', `${i.id}-out`, `${i.name} is out of stock`, link('input', i.name)); continue }
      if (i.reorder_level != null && i.on_hand <= i.reorder_level) add('amber', 'Inventory', `${i.id}-low`, `${i.name} is low: ${qty(i.on_hand)} ${i.unit} left (reorder at ${qty(i.reorder_level)})`, link('input', i.name))
      if (i.next_expiry && i.next_expiry <= soon) add(i.next_expiry < asOf ? 'red' : 'amber', 'Inventory', `${i.id}-exp`, `${i.name} ${i.next_expiry < asOf ? 'expired' : 'expires'} ${i.next_expiry}`, link('input', i.name))
    }
  }
  const rank = { red: 0, amber: 1, blue: 2 }
  return out.map((a, i) => ({ a, i })).sort((x, y) => rank[x.a.tone] - rank[y.a.tone] || x.i - y.i).map(x => x.a)
}
