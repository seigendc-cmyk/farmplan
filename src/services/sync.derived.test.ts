import { describe, it, expect, beforeEach } from 'vitest'
import { Db, MemoryPersistence, type Row } from '../db/database'
import { initialiseFarm, login, createUser } from './setup'
import { can, type Ctx } from './context'
import { hasPermission } from '../lib/permissions'
import { createSeason } from './seasons'
import { createField } from './fields'
import { createInput, recordPurchase } from './inventory'
import { createMachine, logMachine, deleteMachineLog } from './machinery'
import { recordOperation } from './operations'
import { recordLabour } from './labour'
import { recordHarvest } from './harvest'
import { syncNow, listSyncConflicts, RowRejectedError, DuplicateRowError, PUSH_ORDER, type CloudClient } from './sync'

type R = Record<string, unknown>
/** Where each derived row's source lives, and the permission that may create it (mirrors migration 0016). */
const SOURCE: Record<string, [string, string]> = {
  'cost_entries:operation_input': ['operation_inputs', 'production.operation.record'], 'cost_entries:labour_entry': ['labour_entries', 'resources.labour.record'],
  'cost_entries:machine_log': ['machine_logs', 'resources.machinery.record'], 'cost_entries:machine_fuel': ['machine_logs', 'resources.machinery.record'],
  'cost_entries:harvest_labour': ['harvest_batches', 'production.harvest.record'], 'cost_entries:harvest_transport': ['harvest_batches', 'production.harvest.record'],
  'inventory_transactions:operation': ['operations', 'production.operation.record'], 'inventory_transactions:machine_log': ['machine_logs', 'resources.machinery.record'],
}
const WRITE: R = { cost_entries: 'finance.cost.edit', inventory_transactions: 'resources.inventory.manage' }
const READ: R = { cost_entries: 'finance.cost.view', inventory_transactions: 'resources.inventory.view', activity_log: 'brain.log.view_admin' }
const deny = (m: string) => new RowRejectedError(`new row violates row-level security policy (${m})`, '42501')

/** The cloud as RLS sees it for one signed-in role: upserts (ON CONFLICT) need write AND read rights; derived rows and events may be
 *  plain-inserted under 0016's rules; foreign keys to stock movements are enforced, so a wrong push order is refused. */
class RlsCloud implements CloudClient {
  tables = new Map<string, Map<string, R>>(); clock = 1_800_000_000_000; perms = new Set(['*']); calls: string[] = []
  constructor(readonly tenant: string) {}
  t(name: string) { let t = this.tables.get(name); if (!t) this.tables.set(name, t = new Map()); return t }
  can(p: unknown) { return typeof p === 'string' && hasPermission(this.perms, p) }
  async claimTenant() {}
  private fk(table: string, r: R) {
    for (const c of ['fuel_txn_id', 'inventory_txn_id']) if (r[c] && !this.t('inventory_transactions').has(String(r[c]))) throw new RowRejectedError(`${table}: violates foreign key on ${c}`, '23503')
  }
  private put(table: string, rows: R[]) { for (const r of rows) this.t(table).set(String(r.id), { ...r, updated_at: new Date(this.clock += 1000).toISOString() }) }
  async upsert(table: string, rows: R[]) {
    this.calls.push(`upsert ${table}`)
    if ((WRITE[table] && !(this.can(WRITE[table]) && this.can(READ[table]))) || (table === 'activity_log' && !this.can(READ[table]))) throw deny(`upsert ${table}`)
    rows.forEach(r => this.fk(table, r)); this.put(table, rows)
  }
  async insert(table: string, rows: R[]) {
    this.calls.push(`insert ${table}`)
    for (const r of rows) {
      if (this.t(table).has(String(r.id))) throw new DuplicateRowError(`${table}: duplicate key value violates unique constraint "${table}_pkey"`, '23505')
      if (table === 'activity_log' || this.can(WRITE[table])) continue
      const [src, perm] = SOURCE[`${table}:${r.source_type}`] ?? []
      if (!src || !this.can(perm) || !this.t(src).has(String(r.source_id)) || (table === 'inventory_transactions' && r.kind !== 'consumption')) throw deny(`insert ${table}`)
    }
    this.put(table, rows)
  }
  async rowSent(table: string, tenantId: string, id: string) { return this.t(table).get(id)?.tenant_id === tenantId }
  async cancelDerived(table: string, tenantId: string, row: R) {
    this.calls.push(`cancel ${table}`)
    const [src, perm] = SOURCE[`${table}:${row.source_type}`] ?? []; const cur = this.t(table).get(String(row.id))
    if (!src || !this.can(perm)) throw new RowRejectedError('cancel_derived: permission denied', '42501')
    if (!cur || cur.tenant_id !== tenantId || cur.source_id !== row.source_id) throw new RowRejectedError('cancel_derived: no matching derived row', 'P0001')
    if (!this.t(src).get(String(row.source_id))?.deleted_at) throw new RowRejectedError('cancel_derived: the source record is still live', 'P0001')
    this.put(table, [{ ...cur, deleted_at: new Date(this.clock).toISOString() }])
  }
  async fetchSince(table: string, since: string | null, limit: number) {
    if (READ[table] && !this.can(READ[table])) return []
    return [...this.t(table).values()].filter(r => !since || String(r.updated_at) > since).sort((a, b) => String(a.updated_at).localeCompare(String(b.updated_at))).slice(0, limit) as Row[]
  }
}

let db: Db; let o: Ctx; let rec: Ctx; let cloud: RlsCloud; let season: string; let field: string; let diesel: string; let fert: string; let tractor: string
beforeEach(async () => {
  db = await Db.open(new MemoryPersistence())
  await initialiseFarm(db, { tenantName: 'T', farmName: 'F', ownerName: 'Lovemore', ownerPin: '1234' })
  o = { db, ...(await login(db, 'Lovemore', '1234')).ctx! }
  season = createSeason(o, { label: '2026/27', starts_on: '2026-09-01', ends_on: '2027-08-31', activate: true })
  field = createField(o, { field_no: 'F-04', area_ha: 4 })
  diesel = createInput(o, { name: 'Diesel', category: 'fuel', unit: 'L' }); recordPurchase(o, { input_id: diesel, qty: 100, unit_cost: 1.5, occurred_on: '2026-10-01' })
  fert = createInput(o, { name: 'Compound C', category: 'fertilizer', unit: 'kg' }); recordPurchase(o, { input_id: fert, qty: 50, unit_cost: 2, occurred_on: '2026-10-01' })
  tractor = createMachine(o, { name: 'MF 375', hourly_rate: 10, fuel_input_id: diesel })
  const rid = db.get<{ id: string }>(`SELECT id FROM roles WHERE name='Field Recorder'`)!.id
  await createUser(o, 'Tendai', '1111', rid); rec = { db, ...(await login(db, 'Tendai', '1111')).ctx! }
  // the office set-up reaches the cloud under the owner's account; from here on the cloud sees a Field Recorder signed in
  cloud = new RlsCloud(o.tenantId); expect((await syncNow(db, cloud, o.tenantId, 'T')).errors).toEqual([])
  cloud.perms = new Set(rec.perms); cloud.calls = []
})
/** Everything a Field Recorder's day produces: an operation with an input, workers and a machine; a labour entry; store fuel; a harvest. */
const fieldDay = () => {
  const op = recordOperation(rec, { target: { type: 'field', id: field }, season_id: season, op_type: 'Ploughing', phase: 'land_prep', occurred_on: '2026-10-06',
    inputs: [{ input_id: fert, qty: 10 }], workers: [{ worker_name: 'Rudo', hours: 8, pay: 12 }], machines: [{ machine_id: tractor, hours: 4, fuel_l: 20 }] })
  recordLabour(rec, { season_id: season, worked_on: '2026-10-07', worker_name: 'Chipo', task: 'Weeding', field_id: field, hours: 6, pay_amount: 9 })
  const fuel = logMachine(rec, { machine_id: tractor, season_id: season, kind: 'fuel', logged_on: '2026-10-07', fuel_l: 15 })
  recordHarvest(rec, { field_id: field, season_id: season, harvested_on: '2026-10-08', green_weight_kg: 300, labour_cost: 25, transport_cost: 10 })
  return { op, fuel: fuel.id }
}
const live = (table: string) => [...cloud.t(table).values()].filter(r => !r.deleted_at)
const localLive = (table: string) => db.get<{ n: number }>(`SELECT COUNT(*) n FROM ${table} WHERE deleted_at IS NULL`)!.n

describe('a Field Recorder phone syncs the rows its records derive (cloud 0016)', () => {
  it('quarantines nothing: stock and costs are plain inserts after their sources, logs get their fuel link on a second send', async () => {
    fieldDay(); const pending = db.get<{ n: number }>(`SELECT COUNT(DISTINCT table_name || ':' || row_id) n FROM outbox WHERE synced_at IS NULL`)!.n
    const r = await syncNow(db, cloud, rec.tenantId, 'T', { canWrite: p => can(rec, p) })
    expect(r.errors).toEqual([]); expect(r.quarantined).toBe(0); expect(listSyncConflicts(db)).toEqual([]); expect(db.pendingSync()).toBe(0)
    expect(live('cost_entries')).toHaveLength(localLive('cost_entries')); expect(live('inventory_transactions')).toHaveLength(localLive('inventory_transactions'))
    expect(live('activity_log').length).toBeGreaterThan(0); expect(live('activity_log')).toHaveLength(localLive('activity_log'))
    for (const l of db.all<{ id: string; fuel_txn_id: string }>(`SELECT id, fuel_txn_id FROM machine_logs WHERE fuel_txn_id IS NOT NULL`)) expect(cloud.t('machine_logs').get(l.id)!.fuel_txn_id).toBe(l.fuel_txn_id)
    expect(cloud.calls.filter(c => c.startsWith('upsert cost') || c.startsWith('upsert inventory') || c.startsWith('upsert activity'))).toEqual([])   // never tried the refused path
    expect(cloud.calls.indexOf('insert inventory_transactions')).toBeGreaterThan(cloud.calls.indexOf('upsert machine_logs'))
    expect(cloud.calls.indexOf('upsert operation_inputs')).toBeGreaterThan(cloud.calls.indexOf('insert inventory_transactions'))
    expect(r.pushed).toBe(pending)   // each row counted once, the re-sent logs included
  })
  it('without the role passed in, the first RLS refusal of an upsert switches that table to plain inserts', async () => {
    fieldDay()
    const r = await syncNow(db, cloud, rec.tenantId, 'T')
    expect(r.errors).toEqual([]); expect(r.quarantined).toBe(0); expect(live('cost_entries')).toHaveLength(localLive('cost_entries'))
  })
  it('a re-send after a lost reply counts as sent once the cloud confirms the id is this farm\'s own row', async () => {
    fieldDay()
    const orig = cloud.insert.bind(cloud); cloud.insert = async (t, rows) => { await orig(t, rows); if (t === 'cost_entries') { cloud.insert = orig; throw new Error('fetch failed') } }
    expect((await syncNow(db, cloud, rec.tenantId, 'T', { canWrite: p => can(rec, p) })).errors[0]).toMatch(/fetch failed/)
    const r = await syncNow(db, cloud, rec.tenantId, 'T', { canWrite: p => can(rec, p) })
    expect(r.errors).toEqual([]); expect(r.quarantined).toBe(0); expect(db.pendingSync()).toBe(0)
    expect(live('cost_entries')).toHaveLength(localLive('cost_entries'))
  })
  it('a reversal after sync is applied through cancel_derived, once the deleted log is in the cloud', async () => {
    const { fuel } = fieldDay(); await syncNow(db, cloud, rec.tenantId, 'T', { canWrite: p => can(rec, p) })
    deleteMachineLog(rec, fuel)
    const r = await syncNow(db, cloud, rec.tenantId, 'T', { canWrite: p => can(rec, p) })
    expect(r.errors).toEqual([]); expect(r.quarantined).toBe(0)
    expect(cloud.t('machine_logs').get(fuel)!.deleted_at).toBeTruthy()
    expect([...cloud.t('cost_entries').values()].filter(c => c.source_id === fuel).every(c => c.deleted_at)).toBe(true)
    expect([...cloud.t('inventory_transactions').values()].filter(c => c.source_id === fuel).every(c => c.deleted_at)).toBe(true)
    expect(cloud.calls.filter(c => c.startsWith('cancel'))).toHaveLength(2)   // the fuel cost and the stock draw
  })
  it('a reversal the cloud refuses is quarantined with its reason', async () => {
    const { fuel } = fieldDay(); await syncNow(db, cloud, rec.tenantId, 'T', { canWrite: p => can(rec, p) })
    deleteMachineLog(rec, fuel); cloud.perms.delete('resources.machinery.record')   // e.g. the permission was withdrawn in the meantime
    const r = await syncNow(db, cloud, rec.tenantId, 'T', { canWrite: p => can(rec, p) })
    expect(r.quarantined).toBe(2); expect(listSyncConflicts(db).map(c => c.reason).join('\n')).toMatch(/refused this reversal .*permission denied.*must apply it/)
  })
})

describe('activity events always go as plain inserts', () => {
  it('a Field Recorder\'s events sync; a duplicate id that is not this farm\'s own row is quarantined, not taken as sent', async () => {
    fieldDay()
    const ev = db.all<{ id: string }>(`SELECT id FROM activity_log WHERE id IN (SELECT row_id FROM outbox WHERE synced_at IS NULL) ORDER BY occurred_at`)
    cloud.t('activity_log').set(ev[0].id, { id: ev[0].id, tenant_id: 'another-tenant' })   // an id collision with someone else's event
    const r = await syncNow(db, cloud, rec.tenantId, 'T', { canWrite: p => can(rec, p) })
    expect(r.errors).toEqual([]); expect(r.quarantined).toBe(1)
    expect(listSyncConflicts(db)).toMatchObject([{ table_name: 'activity_log', row_id: ev[0].id }])
    expect(listSyncConflicts(db)[0].reason).toMatch(/not this farm's own copy/)
    expect(cloud.calls).toContain('insert activity_log'); expect(cloud.calls).not.toContain('upsert activity_log')
    expect(ev.slice(1).every(e => cloud.t('activity_log').get(e.id)?.tenant_id === rec.tenantId)).toBe(true)
  })
  it('an event re-sent after a lost reply is recognised as already sent', async () => {
    fieldDay(); const orig = cloud.insert.bind(cloud)
    cloud.insert = async (t, rows) => { await orig(t, rows); if (t === 'activity_log') { cloud.insert = orig; throw new Error('fetch failed') } }
    await syncNow(db, cloud, rec.tenantId, 'T')
    const r = await syncNow(db, cloud, rec.tenantId, 'T')
    expect(r.errors).toEqual([]); expect(r.quarantined).toBe(0); expect(live('activity_log')).toHaveLength(localLive('activity_log'))
  })
})

describe('push order', () => {
  it('stock movements go after the machine and curing logs that cause them, and before the rows that point at them', () => {
    const at = (t: string) => PUSH_ORDER.indexOf(t)
    for (const src of ['operations', 'machine_logs', 'curing_logs']) expect(at(src)).toBeLessThan(at('inventory_transactions'))
    for (const ref of ['operation_inputs', 'contract_advances', 'cost_entries']) expect(at(ref)).toBeGreaterThan(at('inventory_transactions'))
    expect(new Set(PUSH_ORDER).size).toBe(PUSH_ORDER.length)
  })
})
