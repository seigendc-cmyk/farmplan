import { type Ctx, can, need, isDate } from '../services/context'
import { listActivity, activityActors } from '../services/activity'
import { buyerAgeing } from '../services/buyers'
import { listContracts } from '../services/contracts'
import { listInputs } from '../services/inventory'
import { listSeedbeds } from '../services/seedbeds'
import { listStorage } from '../services/storage'
import { listMachines } from '../services/machinery'

/**
 * The brain's catalogue of safe, named questions. A model (or the keyword router) only CHOOSES one and fills in its parameters;
 * the numbers always come from the fixed, tested query below, so a small local model can never invent a figure or a query.
 * Every entry lists the permissions it needs, so what the chat can answer is exactly what the person could already open.
 */
export type ParamType = 'season' | 'field' | 'text' | 'number' | 'date'
export interface Param { name: string; type: ParamType; optional?: boolean; about: string }
export type Rows = Record<string, unknown>[]
export interface Source { kind: 'view' | 'activity'; ref: string }
export interface Question {
  id: string; title: string; about: string; keywords: string[]; params: Param[]; perms: string[]
  run: (ctx: Ctx, p: Resolved) => Rows; sources: Source[]
}
export type Resolved = Record<string, string | number | undefined>
export type RawParams = Record<string, unknown>

const seasonOf = (p: Resolved) => String(p.season)
/** The resolved season label back to its id, for lookups that read through a service. */
const seasonIdOf = (c: Ctx, p: Resolved) => c.db.get<{ id: string }>(`SELECT id FROM seasons WHERE farm_id=? AND label=? AND deleted_at IS NULL`, [c.farmId, seasonOf(p)])?.id
const todayIso = () => new Date().toISOString().slice(0, 10)
const byView = (view: string, perms: string[]) => ({ sources: [{ kind: 'view', ref: view } as Source], perms })

/** Season labels are needed to answer anything, so the brain reads them directly instead of requiring the season-management permission; no other season data is exposed. */
export const seasonLabels = (ctx: Ctx) => ctx.db.all<{ label: string; status: string }>(`SELECT label, status FROM seasons WHERE farm_id=? AND deleted_at IS NULL ORDER BY starts_on DESC`, [ctx.farmId])

export const CATALOGUE: Question[] = [
  { id: 'harvest_by_field', title: 'Green leaf harvested per field', about: 'Total green weight (kg) harvested from each field in a season, highest first', keywords: ['harvest', 'harvested', 'green', 'yield', 'reaped', 'picked', 'most tobacco', 'gave us the most'],
    params: [{ name: 'season', type: 'season', optional: true, about: 'Season label like 2026/27; defaults to the active season' }], ...byView('bi_harvests', ['production.harvest.view']),
    run: (c, p) => c.db.all(`SELECT field_no AS field, ROUND(SUM(green_weight_kg),1) AS green_kg, COUNT(*) AS batches FROM bi_harvests WHERE season=? GROUP BY field_no ORDER BY green_kg DESC`, [seasonOf(p)]) },
  { id: 'rain_by_month', title: 'Rainfall by month', about: 'Rain (mm) and rain days for each month of a season', keywords: ['rain', 'rainfall', 'mm', 'wet', 'weather'],
    params: [{ name: 'season', type: 'season', optional: true, about: 'Season label; defaults to the active season' }], ...byView('bi_weather', ['production.weather.view']),
    run: (c, p) => c.db.all(`SELECT substr(w.recorded_on,1,7) AS month, ROUND(SUM(w.rainfall_mm),1) AS rain_mm, SUM(CASE WHEN w.rainfall_mm>0 THEN 1 ELSE 0 END) AS rain_days
      FROM bi_weather w JOIN bi_seasons s ON w.recorded_on BETWEEN s.starts_on AND s.ends_on WHERE s.season=? AND w.rainfall_mm IS NOT NULL GROUP BY month ORDER BY month`, [seasonOf(p)]) },
  { id: 'cost_by_category', title: 'Costs by category', about: 'Total spend per cost category in a season, largest first', keywords: ['cost', 'costs', 'spend', 'spent', 'expense', 'expenses', 'category', 'money going', 'money go'],
    params: [{ name: 'season', type: 'season', optional: true, about: 'Season label; defaults to the active season' }], ...byView('bi_costs', ['finance.cost.view']),
    run: (c, p) => c.db.all(`SELECT category, ROUND(SUM(amount),2) AS total FROM bi_costs WHERE season=? GROUP BY category ORDER BY total DESC`, [seasonOf(p)]) },
  { id: 'cost_per_ha', title: 'Direct cost per hectare by field', about: 'Costs recorded against each field divided by its area, highest first', keywords: ['hectare', 'ha', 'per ha', 'cost per hectare', 'expensive', 'highest cost'],
    params: [{ name: 'season', type: 'season', optional: true, about: 'Season label; defaults to the active season' }], ...byView('bi_costs', ['finance.cost.view', 'production.field.view']),
    run: (c, p) => c.db.all(`SELECT f.field_no AS field, f.area_ha, ROUND(SUM(c.amount),2) AS cost, ROUND(SUM(c.amount)/f.area_ha,2) AS cost_per_ha FROM bi_costs c JOIN bi_fields f ON f.field_no=c.field_no
      WHERE c.season=? AND f.area_ha>0 GROUP BY f.field_no ORDER BY cost_per_ha DESC`, [seasonOf(p)]) },
  { id: 'budget_vs_actual', title: 'Budget against actual spend', about: 'For each cost category: budget, actual spend and the difference', keywords: ['budget', 'budgeted', 'over budget', 'under budget', 'variance', 'planned', 'what we planned', 'planned to spend'],
    params: [{ name: 'season', type: 'season', optional: true, about: 'Season label; defaults to the active season' }], ...byView('bi_budgets', ['finance.budget.view', 'finance.cost.view']),
    run: (c, p) => c.db.all(`SELECT b.category, ROUND(b.budget,2) AS budget, ROUND(COALESCE(a.t,0),2) AS actual, ROUND(b.budget-COALESCE(a.t,0),2) AS remaining
      FROM (SELECT category, SUM(budget) budget FROM bi_budgets WHERE season=? GROUP BY category) b LEFT JOIN (SELECT category, SUM(amount) t FROM bi_costs WHERE season=? GROUP BY category) a ON a.category=b.category ORDER BY remaining`, [seasonOf(p), seasonOf(p)]) },
  { id: 'price_by_grade', title: 'Average selling price by grade', about: 'Weighted average price per kg and kg sold for each grade in a season', keywords: ['price', 'prices', 'grade', 'grades', 'average price', 'per kg', 'selling'],
    params: [{ name: 'season', type: 'season', optional: true, about: 'Season label; defaults to the active season' }], ...byView('bi_sales', ['marketing.sale.view']),
    run: (c, p) => c.db.all(`SELECT grade, ROUND(SUM(weight_kg),1) AS kg_sold, ROUND(SUM(weight_kg*price_per_kg)/SUM(weight_kg),2) AS avg_price_per_kg FROM bi_sales WHERE season=? AND weight_kg>0 GROUP BY grade ORDER BY avg_price_per_kg DESC`, [seasonOf(p)]) },
  { id: 'sales_by_buyer', title: 'Sales by buyer', about: 'Kg sold and gross value per buyer in a season', keywords: ['buyer', 'buyers', 'sold to', 'sell to', 'sales by', 'sold', 'merchant', 'floor', 'revenue'],
    params: [{ name: 'season', type: 'season', optional: true, about: 'Season label; defaults to the active season' }], ...byView('bi_sales', ['marketing.sale.view']),
    run: (c, p) => c.db.all(`SELECT COALESCE(buyer,'(none recorded)') AS buyer, ROUND(SUM(weight_kg),1) AS kg_sold, ROUND(SUM(gross),2) AS gross FROM bi_sales WHERE season=? GROUP BY buyer ORDER BY gross DESC`, [seasonOf(p)]) },
  { id: 'buyers_owing', title: 'Money owed by buyers', about: 'Outstanding balances per buyer, with how old and how overdue they are', keywords: ['+owe', '+owes', '+owed', '+owing', '+outstanding', '+debt', '+debtors', '+unpaid', '+overdue', '+receivable'],
    params: [], sources: [{ kind: 'view', ref: 'sales and payments' }], perms: ['marketing.sale.view'],
    run: c => buyerAgeing(c).sort((a, b) => b.total - a.total).map(a => ({ buyer: a.name, owed: Math.round(a.total * 100) / 100, overdue: Math.round(a.overdue * 100) / 100, oldest_days: a.oldest_days })) },
  { id: 'bales_by_grade', title: 'Bales by grade', about: 'Number of bales and weight (kg) per grade in a season', keywords: ['bale', 'bales', 'baled', 'grade', 'stock of bales'],
    params: [{ name: 'season', type: 'season', optional: true, about: 'Season label; defaults to the active season' }], ...byView('bi_bales', ['quality.bale.view']),
    run: (c, p) => c.db.all(`SELECT grade, COUNT(*) AS bales, ROUND(SUM(weight_kg),1) AS kg FROM bi_bales WHERE season=? GROUP BY grade ORDER BY grade`, [seasonOf(p)]) },
  { id: 'curing_status', title: 'Curing cycles', about: 'Curing cycles with barn, status and weights for a season', keywords: ['curing', 'cure', 'barn', 'barns', 'cycle', 'cycles', 'loaded', 'offloaded'],
    params: [{ name: 'season', type: 'season', optional: true, about: 'Season label; defaults to the active season' }], ...byView('bi_curing', ['curing.cycle.view']),
    run: (c, p) => c.db.all(`SELECT code, barn, status, ROUND(green_weight_kg,1) AS green_kg, ROUND(cured_weight_kg,1) AS cured_kg, substr(loaded_at,1,10) AS loaded, substr(offloaded_at,1,10) AS offloaded FROM bi_curing WHERE season=? ORDER BY loaded_at DESC`, [seasonOf(p)]) },
  { id: 'labour_hours', title: 'Labour hours by worker', about: 'Hours logged per worker in a season, most first', keywords: ['labour', 'labor', 'worker', 'workers', 'hours', 'staff', 'worked'],
    params: [{ name: 'season', type: 'season', optional: true, about: 'Season label; defaults to the active season' }], ...byView('bi_labour', ['resources.labour.view', 'finance.cost.view']),
    run: (c, p) => c.db.all(`SELECT worker_name AS worker, ROUND(SUM(hours),1) AS hours, COUNT(*) AS entries FROM bi_labour WHERE season=? GROUP BY worker_name ORDER BY hours DESC`, [seasonOf(p)]) },
  { id: 'fuel_by_machine', title: 'Fuel and hours by machine', about: 'Litres of fuel and hours used per machine in a season', keywords: ['fuel', 'diesel', 'machine', 'machines', 'tractor', 'litres', 'machinery'],
    params: [{ name: 'season', type: 'season', optional: true, about: 'Season label; defaults to the active season' }], ...byView('bi_machine_logs', ['resources.machinery.view', 'finance.cost.view']),
    run: (c, p) => c.db.all(`SELECT machine, ROUND(SUM(fuel_l),1) AS fuel_l, ROUND(SUM(hours),1) AS hours FROM bi_machine_logs WHERE season=? GROUP BY machine ORDER BY fuel_l DESC`, [seasonOf(p)]) },
  { id: 'operations_recent', title: 'Recent field operations', about: 'The latest operations (planting, spraying, ploughing…), optionally for one field', keywords: ['operation', 'operations', 'sprayed', 'spray', 'ploughed', 'planted', 'fertilised', 'applied'],
    params: [{ name: 'field', type: 'field', optional: true, about: 'Field number such as F-04' }], ...byView('bi_operations', ['production.operation.view']),
    run: (c, p) => c.db.all(`SELECT occurred_on AS date, op_type AS operation, field_no AS field, operator FROM bi_operations WHERE (? IS NULL OR field_no=?) ORDER BY occurred_on DESC LIMIT 30`, [p.field ?? null, p.field ?? null]) },
  { id: 'fields_list', title: 'Fields', about: 'All fields with area, variety and current crop', keywords: ['fields', 'field list', 'area', 'how big', 'hectares', 'variety'],
    params: [], ...byView('bi_fields', ['production.field.view']), run: c => c.db.all(`SELECT field_no AS field, area_ha, variety, current_crop AS crop FROM bi_fields ORDER BY field_no`) },
  { id: 'recent_activity', title: 'Recent activity', about: 'What happened on the farm recently, from the activity log; can be limited to a person, a field or a number of days', keywords: ['happened', 'activity', 'who did', 'yesterday', 'recently', 'lately', 'last week', 'did anyone', 'who recorded'],
    params: [{ name: 'actor', type: 'text', optional: true, about: 'Name of a person' }, { name: 'field', type: 'field', optional: true, about: 'Field number such as F-04' }, { name: 'days', type: 'number', optional: true, about: 'How many days back; default 7' }],
    sources: [{ kind: 'activity', ref: 'activity log' }], perms: [],
    run: (c, p) => { const from = new Date(Date.now() - (Number(p.days ?? 7)) * 864e5).toISOString().slice(0, 10)
      const fid = p.field ? c.db.get<{ id: string }>(`SELECT id FROM fields WHERE farm_id=? AND field_no=? AND deleted_at IS NULL`, [c.farmId, p.field])?.id : undefined
      return listActivity(c, { actor: p.actor ? String(p.actor) : undefined, fieldId: fid, from, limit: 30 }).map(e => ({ when: e.occurred_at.slice(0, 16).replace('T', ' '), what: e.summary, who: e.actor_name ?? '—' })) } },
  { id: 'find_notes', title: 'Search notes and activity', about: 'Find notes and events that mention some words', keywords: ['+note', '+notes', '+noted', '+mention', '+mentioned', '+mentions', 'find', 'search', 'said'],
    params: [{ name: 'text', type: 'text', about: 'Words to look for' }], sources: [{ kind: 'activity', ref: 'activity log' }], perms: [],
    run: (c, p) => listActivity(c, { q: String(p.text), limit: 30 }).map(e => ({ when: e.occurred_at.slice(0, 16).replace('T', ' '), what: e.summary, who: e.actor_name ?? '—' })) },
  // The next six read through the same services as their pages (and the Dashboard's attention list), so the brain and the screens always agree. None returns money.
  { id: 'contract_delivery', title: 'Contract deliveries against target', about: 'For each contract in a season: target kg, kg delivered so far and the share of target, with the delivery deadline', keywords: ['contract', 'contracts', 'contracted', 'contractor', 'target', 'delivered', 'deliveries', 'delivery'],
    params: [{ name: 'season', type: 'season', optional: true, about: 'Season label; defaults to the active season' }], sources: [{ kind: 'view', ref: 'contracts and sales' }], perms: ['contracts.contract.view'],
    run: (c, p) => listContracts(c, seasonIdOf(c, p)).filter(k => k.status !== 'cancelled')
      .map(k => ({ contract: k.code, contractor: k.contractor, status: k.status, target_kg: k.target_kg, delivered_kg: k.delivered_kg, delivered_pct: k.delivered_pct, deadline: k.delivery_deadline })) },
  { id: 'stock_on_hand', title: 'Stock on hand', about: 'Inputs in the store (seed, fertiliser, chemicals, fuel…) with quantity on hand, reorder level, whether stock is low, and the next expiry date', keywords: ['stock', 'low on', 'reorder', 'inventory', 'on hand', 'in the store', 'store room', 'left in', 'run out', 'running out', 'expire', 'expiring', 'expiry', 'inputs'],
    params: [], sources: [{ kind: 'view', ref: 'inventory' }], perms: ['resources.inventory.view'],
    run: c => listInputs(c).filter(i => i.active).map(i => ({ input: i.name, category: i.category, on_hand: Math.round(i.on_hand * 100) / 100, unit: i.unit, reorder_at: i.reorder_level,
      level: i.on_hand <= 0.0001 ? 'out' : i.reorder_level != null && i.on_hand <= i.reorder_level ? 'low' : 'ok', next_expiry: i.next_expiry })) },
  { id: 'seedbeds_status', title: 'Seedbeds', about: 'Seedbeds in a season with variety, sowing date, expected and actual seedlings, achievement and seedlings still available to transplant', keywords: ['seedbed', 'seedbeds', 'seedling', 'seedlings', 'nursery', 'germination', 'germinated', 'sown', 'sowing'],
    params: [{ name: 'season', type: 'season', optional: true, about: 'Season label; defaults to the active season' }], sources: [{ kind: 'view', ref: 'seedbeds' }], perms: ['production.seedbed.view'],
    run: (c, p) => listSeedbeds(c, seasonIdOf(c, p)).map(s => ({ seedbed: s.code, variety: s.variety, sown: s.sown_on, expected: s.expected_seedlings, actual: s.actual_seedlings, achieved_pct: s.achievement_pct, available: s.available_seedlings, status: s.status })) },
  { id: 'storage_ready', title: 'Storage ready to open', about: 'Slate packs and piles still maturing: which are ready to open for grading and how many days the rest need', keywords: ['storage', 'stored', 'starking', 'slate', 'slates', 'pile', 'piles', 'maturing', 'matured', 'ready to open', 'open for grading', 'ready for grading'],
    params: [], sources: [{ kind: 'view', ref: 'storage units' }], perms: ['curing.storage.view'],
    run: c => listStorage(c).filter(u => u.status === 'maturing').sort((a, b) => a.days_to_open - b.days_to_open)
      .map(u => ({ unit: u.code, kind: u.kind === 'slate_pack' ? 'slate pack' : 'pile', weight_kg: u.weight_kg, opens: u.expected_open_on, stage: u.stage === 'READY TO OPEN' ? 'ready to open' : 'maturing', days_to_open: Math.max(0, u.days_to_open) })) },
  { id: 'service_due', title: 'Machines due for a service', about: 'Each active machine with hours since its last service, its service interval and whether a service is due', keywords: ['+service', '+serviced', '+servicing', '+maintenance', 'due for'],
    params: [], sources: [{ kind: 'view', ref: 'machinery' }], perms: ['resources.machinery.view'],
    run: c => listMachines(c).filter(m => m.active).sort((a, b) => Number(b.service_due) - Number(a.service_due) || (b.hours_since_service ?? 0) - (a.hours_since_service ?? 0))
      .map(m => ({ machine: m.name, hours_since_service: m.hours_since_service == null ? null : Math.round(m.hours_since_service * 10) / 10, interval_hours: m.service_interval_hours, last_service: m.last_service_on, due: m.service_due ? 'yes' : 'no' })) },
  { id: 'obligations_overdue', title: 'Overdue contract obligations', about: 'Contract obligations not yet done whose due date has passed, oldest first', keywords: ['+obligation', '+obligations', 'contract obligations', 'overdue obligations', 'commitments', 'committed to', 'promised', 'not done'],
    params: [], sources: [{ kind: 'view', ref: 'contract obligations' }], perms: ['contracts.contract.view'],
    run: c => c.db.all(`SELECT k.code AS contract, o.kind, o.description AS obligation, o.due_on AS due, CAST(julianday(?) - julianday(o.due_on) AS INTEGER) AS days_overdue
      FROM contract_obligations o JOIN contracts k ON k.id=o.contract_id WHERE k.farm_id=? AND k.status IN ('draft','active') AND k.deleted_at IS NULL AND o.deleted_at IS NULL
      AND o.done=0 AND o.due_on IS NOT NULL AND o.due_on < ? ORDER BY o.due_on`, [todayIso(), c.farmId, todayIso()]) },
]

/** True if this person may use the entry: it needs its data permissions, and activity entries need some activity access. */
export function available(ctx: Ctx, q: Question): boolean {
  if (!q.perms.every(p => can(ctx, p))) return false
  if (q.sources.some(s => s.kind === 'activity')) return can(ctx, 'brain.log.view_own') || can(ctx, 'brain.log.view_ops') || can(ctx, 'brain.log.view_finance') || can(ctx, 'brain.log.view_admin')
  return true
}
export const availableQuestions = (ctx: Ctx) => CATALOGUE.filter(q => available(ctx, q))

/** Validates and completes parameters. Unknown ones are dropped; bad ones are refused with a plain message; season defaults to the active one. */
export function resolveParams(ctx: Ctx, q: Question, raw: RawParams = {}): Resolved {
  const out: Resolved = {}
  for (const d of q.params) {
    let v = raw[d.name]; if (typeof v === 'string') v = v.trim()
    if (v == null || v === '') {
      if (d.type === 'season') { const all = seasonLabels(ctx); const s = all.find(x => x.status === 'active') ?? all[0]; need(s, 'There is no season yet'); out[d.name] = s.label; continue }
      need(d.optional, `Missing: ${d.about}`); continue
    }
    switch (d.type) {
      case 'season': { const s = seasonLabels(ctx).find(x => x.label === String(v)); need(s, `No season called ${v}`); out[d.name] = s.label; break }
      case 'field': { const f = ctx.db.get<{ field_no: string }>(`SELECT field_no FROM fields WHERE farm_id=? AND deleted_at IS NULL AND field_no=? COLLATE NOCASE`, [ctx.farmId, String(v)]); need(f, `No field called ${v}`); out[d.name] = f.field_no; break }
      case 'number': { const n = Number(v); need(Number.isFinite(n) && n >= 1 && n <= 365, `${d.name} must be between 1 and 365`); out[d.name] = Math.round(n); break }
      case 'date': need(isDate(v), `${d.name} must be a date like 2027-01-31`); out[d.name] = String(v); break
      default: need(String(v).length <= 80, 'That text is too long'); out[d.name] = String(v)
    }
  }
  return out
}

/** People the log knows about, so a router can recognise "what did Tendai do". Respects the caller's access. */
export const knownPeople = (ctx: Ctx) => { try { return activityActors(ctx) } catch { return [] } }

/** Plain one-or-two-sentence description built by code, used when no model phrases the answer. */
export function templateSentence(title: string, rows: Rows): string {
  if (!rows.length) return `${title}: nothing found.`
  const cols = Object.keys(rows[0]); const label = cols[0]; const num = cols.find(c => typeof rows[0][c] === 'number')
  const f = (v: unknown) => typeof v === 'number' ? new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(v) : String(v ?? '—')
  if (rows.length === 1) return `${title}: ${cols.map(c => `${c.replace(/_/g, ' ')} ${f(rows[0][c])}`).join(', ')}.`
  const top = num ? `${f(rows[0][label])} leads with ${f(rows[0][num])} ${num.replace(/_/g, ' ')}` : `latest: ${f(rows[0][label])}`
  return `${title}: ${rows.length} rows; ${top}.`
}
