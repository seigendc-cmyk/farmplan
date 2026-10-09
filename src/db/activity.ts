import { SYNC_ORDER, type Db, type Row } from './database'

/** Business brain, layer 1: turns every local save into a readable event. Pure functions of (db, table, row); no UI, no network. */
export type Domain = 'ops' | 'finance' | 'admin'
export type EventKind = 'action' | 'note' | 'voice' | 'photo' | 'system'
export interface ActivityEvent { kind: EventKind; verb: string; domain: Domain; summary: string; body?: string | null; table_name?: string | null; row_id?: string | null; season_id?: string | null; field_id?: string | null; details?: unknown; occurred_at?: string; actor_id?: string | null; actor_name?: string | null }

/** Rows that only repeat their parent (the parent's event already says it) or are the log itself. */
export const NOT_LOGGED = new Set(['activity_log', 'cost_entries', 'operation_inputs', 'sale_lines', 'sale_deductions', 'grading_outputs', 'cycle_batches', 'curing_cycle_checks', 'buyer_deductions', 'contract_fields', 'project_stage_history'])
const FINANCE = new Set(['sales', 'sale_payments', 'budgets', 'allocation_rules', 'buyers', 'contracts', 'contractors', 'contract_advances', 'contract_obligations', 'contract_settlements'])
const LABEL: Record<string, string> = {
  farms: 'farm', seasons: 'season', projects: 'project', blocks: 'block', fields: 'field', inputs: 'input', inventory_transactions: 'stock movement', seedbeds: 'seedbed', operations: 'operation', transplants: 'transplant',
  harvest_batches: 'harvest batch', barns: 'barn', curing_cycles: 'curing cycle', curing_logs: 'curing log', storage_units: 'storage unit', contractors: 'contractor', contracts: 'contract',
  contract_advances: 'contract advance', contract_obligations: 'contract obligation', contract_settlements: 'contract settlement', grades: 'grade', grading_lots: 'grading lot', bales: 'bale', sales: 'sale',
  sale_payments: 'sale payment', labour_entries: 'labour entry', budgets: 'budget line', machines: 'machine', machine_logs: 'machine log', allocation_rules: 'allocation rule', weather_records: 'weather record', buyers: 'buyer',
}
const num = (n: unknown) => (typeof n === 'number' ? String(Math.round(n * 100) / 100) : String(n))
const fieldNo = (db: Db, id: unknown) => (id ? db.get<{ field_no: string }>(`SELECT field_no FROM fields WHERE id=?`, [id as string])?.field_no ?? null : null)

/** A short phrase naming the record. Never includes prices, pay or other money figures except payments and budgets, which are finance-domain events. */
function describe(db: Db, table: string, r: Row): string {
  const f = fieldNo(db, r.field_id)
  switch (table) {
    case 'harvest_batches': return `${r.code}: ${num(r.green_weight_kg)} kg green from ${fieldNo(db, r.field_id) ?? 'a field'}`
    case 'operations': return `${r.op_type} on ${f ? `field ${f}` : r.seedbed_id ? 'a seedbed' : 'the farm'}${r.occurred_on ? ` (${r.occurred_on})` : ''}`
    case 'weather_records': return [r.rainfall_mm != null ? `${num(r.rainfall_mm)} mm rain` : null, r.event && r.event !== 'none' ? String(r.event) : null, r.observation ? `“${String(r.observation).slice(0, 80)}”` : null].filter(Boolean).join(', ') + (f ? ` on ${f}` : '') + ` (${r.recorded_on})`
    case 'labour_entries': return `${r.worker_name}: ${r.task}${r.hours != null ? ` (${num(r.hours)} h)` : ''}${f ? ` on ${f}` : ''}`
    case 'machine_logs': return `${r.kind}${r.hours != null ? ` ${num(r.hours)} h` : ''}${r.fuel_l != null ? ` ${num(r.fuel_l)} L` : ''} — ${db.get<{ name: string }>(`SELECT name FROM machines WHERE id=?`, [r.machine_id as string])?.name ?? 'machine'}${f ? ` on ${f}` : ''}`
    case 'inventory_transactions': { const i = db.get<{ name: string; unit: string }>(`SELECT name, unit FROM inputs WHERE id=?`, [r.input_id as string]); return `${r.kind} of ${num(Math.abs(Number(r.qty_delta)))} ${i ? `${i.unit} ${i.name}` : ''}`.trim() }
    case 'sales': return `${r.code}${r.buyer ? ` to ${r.buyer}` : ''} (${r.channel})`
    case 'sale_payments': return `payment of ${num(r.amount)} on ${db.get<{ code: string }>(`SELECT code FROM sales WHERE id=?`, [r.sale_id as string])?.code ?? 'a sale'}`
    case 'budgets': return `${r.category} budget ${num(r.amount)}`
    case 'allocation_rules': return `${r.category} spread by ${r.basis}`
    case 'bales': return `${r.code} (${num(r.weight_kg)} kg)`
    case 'fields': return `${r.field_no} (${num(r.area_ha)} ha)`
    case 'curing_cycles': case 'storage_units': case 'grading_lots': case 'seedbeds': return `${r.code}`
    default: return String(r.code ?? r.name ?? r.field_no ?? r.label ?? r.category ?? String(r.id).slice(0, 8))
  }
}

export function describeChange(db: Db, table: string, op: 'create' | 'update' | 'delete', row: Row, changed?: string[]): ActivityEvent | null {
  if (NOT_LOGGED.has(table)) return null
  if (table === 'inventory_transactions' && row.kind === 'consumption') return null   // already part of the operation
  const label = LABEL[table] ?? table.replace(/_/g, ' '); let phrase = ''
  try { phrase = describe(db, table, row) } catch { phrase = String(row.id).slice(0, 8) }
  const keys = (changed ?? []).filter(k => !['updated_at', 'version'].includes(k))
  const summary = op === 'create' ? `Recorded ${label} ${phrase}` : op === 'delete' ? `Removed ${label} ${phrase}` : `Updated ${label} ${phrase}${keys.length ? ` — changed ${keys.join(', ')}` : ''}`
  return { kind: 'action', verb: `${table}.${op}`, domain: FINANCE.has(table) ? 'finance' : 'ops', summary, table_name: table, row_id: row.id as string, season_id: (row.season_id as string) ?? null, field_id: (row.field_id as string) ?? null,
    details: keys.length ? { changed: keys } : undefined }
}

const ADMIN_PREFIXES = ['role.', 'user.', 'hub.', 'setup', 'login']
export function describeAdmin(db: Db, action: string, rowId: string | null, detail: unknown): ActivityEvent | null {
  if (!ADMIN_PREFIXES.some(p => action === p || action.startsWith(p))) return null
  const d = (detail ?? {}) as Record<string, unknown>
  const roleName = rowId ? db.get<{ name: string }>(`SELECT name FROM roles WHERE id=?`, [rowId])?.name : null
  const userName = rowId ? db.get<{ name: string }>(`SELECT name FROM local_users WHERE id=?`, [rowId])?.name : null
  const text: Record<string, string> = {
    'login': 'Signed in', 'setup': 'Farm set up', 'role.create': `Created role ${d.name ?? roleName ?? ''}`, 'role.permissions': `Changed permissions of role ${roleName ?? ''}`,
    'user.create': `Created user ${d.name ?? userName ?? ''}`, 'user.activate': `Reactivated user ${userName ?? ''}`, 'user.deactivate': `Deactivated user ${userName ?? ''}`,
    'hub.pairing.create': `Created a pairing code for ${d.deviceLabel ?? 'a phone'}`, 'hub.device.pair': `Paired phone ${d.label ?? ''} as ${d.tag ?? ''}`, 'hub.device.revoke': 'Removed a phone from the hub',
  }
  return { kind: 'system', verb: action, domain: 'admin', summary: (text[action] ?? action).trim(), table_name: null, row_id: rowId }
}

/** Writes one event (journalled like any record so it syncs). Never throws: logging must not break the save that triggered it. */
export function recordActivity(db: Db, e: ActivityEvent): string | null {
  try {
    const farm = db.get<{ id: string; tenant_id: string }>(`SELECT id, tenant_id FROM farms WHERE deleted_at IS NULL LIMIT 1`); if (!farm) return null
    const tag = db.get<{ value: string }>(`SELECT value FROM meta WHERE key='device_tag'`)?.value ?? ''
    return db.insert('activity_log', { tenant_id: farm.tenant_id, farm_id: farm.id, occurred_at: e.occurred_at ?? new Date().toISOString(), actor_id: e.actor_id !== undefined ? e.actor_id : db.actor?.id ?? null, actor_name: e.actor_name !== undefined ? e.actor_name : db.actor?.name ?? null, device_tag: tag || null,
      kind: e.kind, verb: e.verb, domain: e.domain, table_name: e.table_name ?? null, row_id: e.row_id ?? null, season_id: e.season_id ?? null, field_id: e.field_id ?? null, summary: e.summary.slice(0, 500), body: e.body ?? null, details: e.details === undefined ? null : JSON.stringify(e.details) })
  } catch { return null }
}

/** One-time history for databases that existed before the log: every live record becomes a `system` event dated when it was created. */
export function backfillActivity(db: Db) {
  const tables = db.all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type='table'`).map(t => t.name)
  for (const t of SYNC_ORDER) {
    if (NOT_LOGGED.has(t) || !tables.includes(t)) continue
    for (const row of db.all(`SELECT * FROM ${t} WHERE deleted_at IS NULL ORDER BY created_at`)) {
      const ev = describeChange(db, t, 'create', row); if (ev) recordActivity(db, { ...ev, kind: 'system', occurred_at: String(row.created_at ?? new Date().toISOString()), actor_id: null, actor_name: null })
    }
  }
}
