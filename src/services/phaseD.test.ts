import { describe, it, expect, beforeEach } from 'vitest'
import { Db, MemoryPersistence } from '../db/database'
import { SCHEMA_VERSION } from '../db/schema'
import { initialiseFarm, login, createUser } from './setup'
import { type Ctx, PermissionError } from './context'
import { createSeason } from './seasons'
import { createField } from './fields'
import { createInput, recordPurchase, stockOf } from './inventory'
import { createMachine, updateMachine, logMachine, deleteMachineLog, listMachines, listMachineLogs } from './machinery'
import { listLabour, deleteLabour } from './labour'
import { recordOperation, deleteOperation, listOperations } from './operations'
import { seasonCostSummary } from './reports'
import { createRole } from './roles'
import { createPairing, hubHandle, setHubEnabled } from './hub'
import { joinHub, syncViaHub, type FetchLike } from './lan'

let db: Db; let o: Ctx; let season: string; let field: string; let diesel: string; let fert: string; let tractor: string
const costs = (c: Ctx = o) => Object.fromEntries(seasonCostSummary(c, season).by_category.map(x => [x.category, x.amount]))
const total = () => seasonCostSummary(o, season).total
beforeEach(async () => {
  db = await Db.open(new MemoryPersistence())
  await initialiseFarm(db, { tenantName: 'T', farmName: 'F', ownerName: 'Lovemore', ownerPin: '1234' })
  o = { db, ...(await login(db, 'Lovemore', '1234')).ctx! }
  season = createSeason(o, { label: '2026/27', starts_on: '2026-09-01', ends_on: '2027-08-31', activate: true })
  field = createField(o, { field_no: 'F-04', area_ha: 4 })
  diesel = createInput(o, { name: 'Diesel', category: 'fuel', unit: 'L' }); recordPurchase(o, { input_id: diesel, qty: 100, unit_cost: 1.5, occurred_on: '2026-10-01' })
  fert = createInput(o, { name: 'Compound C', category: 'fertilizer', unit: 'kg' }); recordPurchase(o, { input_id: fert, qty: 50, unit_cost: 2, occurred_on: '2026-10-01' })
  tractor = createMachine(o, { name: 'MF 375', hourly_rate: 10, fuel_input_id: diesel })
})

describe('fuel from the store', () => {
  it('a fuel log draws its litres from the machine’s fuel product at the average cost, once', () => {
    logMachine(o, { machine_id: tractor, season_id: season, kind: 'fuel', logged_on: '2026-10-05', fuel_l: 20, field_id: field })
    expect(stockOf(o, diesel)).toBe(80); expect(costs()).toEqual({ fuel: 30 })
    expect(listMachineLogs(o)[0]).toMatchObject({ fuel_l: 20, cost: 30, fuel_name: 'Diesel' }); expect(listMachines(o)[0].fuel_l).toBe(20)
  })
  it('a use log costs hours × rate as machinery and its litres as fuel', () => {
    logMachine(o, { machine_id: tractor, season_id: season, kind: 'use', logged_on: '2026-10-05', hours: 3, fuel_l: 10 })
    expect(stockOf(o, diesel)).toBe(90); expect(costs()).toEqual({ machinery: 30, fuel: 15 }); expect(listMachineLogs(o)[0].cost).toBe(45)
  })
  it('fuel bought outside the store keeps the typed cost and leaves stock alone', () => {
    logMachine(o, { machine_id: tractor, season_id: season, kind: 'fuel', logged_on: '2026-10-05', fuel_l: 20, cost: 36, input_id: null })
    expect(stockOf(o, diesel)).toBe(100); expect(costs()).toEqual({ fuel: 36 }); expect(listMachineLogs(o)[0].fuel_name).toBeNull()
    const pump = createMachine(o, { name: 'Pump', kind: 'pump' })   // no fuel product: same as before Phase D
    logMachine(o, { machine_id: pump, season_id: season, kind: 'fuel', logged_on: '2026-10-05', fuel_l: 5, cost: 9 }); expect(stockOf(o, diesel)).toBe(100)
  })
  it('refuses a typed cost on store fuel, a non-fuel product, and more litres than are on hand (writing nothing)', () => {
    expect(() => logMachine(o, { machine_id: tractor, season_id: season, kind: 'fuel', logged_on: '2026-10-05', fuel_l: 5, cost: 99 })).toThrow(/costed at its average price/)
    expect(() => logMachine(o, { machine_id: tractor, season_id: season, kind: 'fuel', logged_on: '2026-10-05', fuel_l: 5, input_id: fert })).toThrow(/not a fuel product/)
    expect(() => updateMachine(o, tractor, { name: 'MF 375', fuel_input_id: fert })).toThrow(/not a fuel product/)
    expect(() => logMachine(o, { machine_id: tractor, season_id: season, kind: 'fuel', logged_on: '2026-10-05', fuel_l: 101 })).toThrow(/Insufficient stock of Diesel/)
    expect(listMachineLogs(o)).toEqual([]); expect(stockOf(o, diesel)).toBe(100); expect(total()).toBe(0)
  })
  it('deleting a log puts the litres back and removes both costs', () => {
    const { id } = logMachine(o, { machine_id: tractor, season_id: season, kind: 'use', logged_on: '2026-10-05', hours: 3, fuel_l: 10 })
    deleteMachineLog(o, id); expect(stockOf(o, diesel)).toBe(100); expect(total()).toBe(0)
  })
})

describe('operations with worker and machine lines', () => {
  const plough = (extra: object = {}) => recordOperation(o, { target: { type: 'field', id: field }, season_id: season, op_type: 'Ploughing', phase: 'land_prep', occurred_on: '2026-10-06',
    workers: [{ worker_name: 'Tendai', hours: 8, pay: 12 }, { worker_name: 'Rudo', hours: 8, pay: 12 }], machines: [{ machine_id: tractor, hours: 4, fuel_l: 20 }], ...extra })
  it('creates linked labour entries and a machine log in one transaction, each cost booked once', () => {
    const op = plough({ inputs: [{ input_id: fert, qty: 10 }] })
    expect(listLabour(o).map(l => [l.worker_name, l.hours, l.operation_id, l.field_no]).sort()).toEqual([['Rudo', 8, op, 'F-04'], ['Tendai', 8, op, 'F-04']])
    expect(listMachineLogs(o)).toHaveLength(1); expect(listMachineLogs(o)[0]).toMatchObject({ kind: 'use', hours: 4, fuel_l: 20, operation_id: op, operation: 'Ploughing (2026-10-06)' })
    expect(stockOf(o, diesel)).toBe(80); expect(stockOf(o, fert)).toBe(40)
    expect(costs()).toEqual({ labour: 24, machinery: 40, fuel: 30, fertilizer: 20 })
    expect(db.get(`SELECT 1 FROM cost_entries WHERE source_type IN ('operation_labour','operation_machinery')`)).toBeUndefined()   // no second copy on the operation
    const row = listOperations(o)[0]; expect(row).toMatchObject({ cost: 114, labour_hours: 16, machines: 'MF 375 4 h, 20 L', legacy_machinery: null })
    expect(row.workers.split('; ').sort()).toEqual(['Rudo 8 h', 'Tendai 8 h'])
    expect(listMachines(o)[0].hours_since_service).toBe(4)   // operation hours now count towards the service
  })
  it('refuses the retired free-text boxes, and diesel as an input when a machine line has litres', () => {
    expect(() => recordOperation(o, { target: { type: 'field', id: field }, season_id: season, op_type: 'Weeding', occurred_on: '2026-10-06', labour_cost: 20 })).toThrow(/worker lines/)
    expect(() => recordOperation(o, { target: { type: 'field', id: field }, season_id: season, op_type: 'Weeding', occurred_on: '2026-10-06', machinery_asset: 'MF 375' })).toThrow(/machine lines/)
    expect(() => plough({ inputs: [{ input_id: diesel, qty: 5 }] })).toThrow(/put the litres on the machine line/)
    // a fuel input is still fine when no machine line used litres (e.g. a pump that is not registered)
    recordOperation(o, { target: { type: 'field', id: field }, season_id: season, op_type: 'Irrigation', occurred_on: '2026-10-07', inputs: [{ input_id: diesel, qty: 5 }] }); expect(stockOf(o, diesel)).toBe(95)
  })
  it('rolls everything back when the machine’s fuel is short', () => {
    expect(() => plough({ machines: [{ machine_id: tractor, hours: 4, fuel_l: 500 }] })).toThrow(/Insufficient stock of Diesel/)
    expect(listOperations(o)).toEqual([]); expect(listLabour(o)).toEqual([]); expect(total()).toBe(0); expect(stockOf(o, diesel)).toBe(100)
  })
  it('deleting the operation reverses its entries, logs, stock and costs; deleting one linked entry reverses only that', () => {
    const op = plough(); const rudo = listLabour(o).find(l => l.worker_name === 'Rudo')!.id
    deleteLabour(o, rudo); expect(costs().labour).toBe(12); expect(listOperations(o)[0].cost).toBe(82)
    deleteOperation(o, op)
    expect(listLabour(o)).toEqual([]); expect(listMachineLogs(o)).toEqual([]); expect(stockOf(o, diesel)).toBe(100); expect(total()).toBe(0)
  })
  it('a seedbed operation books its worker pay to the seedbed', () => {
    const sb = db.get<{ id: string }>(`SELECT id FROM seedbeds`)?.id ?? (() => { db.run(`INSERT INTO seedbeds(id,tenant_id,farm_id,season_id,code,bed_count,status,created_at,updated_at,version) VALUES('sb1',?,?,?,'SB-001',1,'prepared',datetime('now'),datetime('now'),1)`, [o.tenantId, o.farmId, season]); return 'sb1' })()
    recordOperation(o, { target: { type: 'seedbed', id: sb }, op_type: 'Watering', occurred_on: '2026-10-08', workers: [{ worker_name: 'Tendai', pay: 7 }] })
    expect(seasonCostSummary(o, season).by_seedbed).toEqual([{ code: 'SB-001', cost: 7 }])
  })
  it('needs labour and machinery record rights for the lines', async () => {
    await createUser(o, 'Ops', '5555', createRole(o, 'Ops only', ['production.operation.record', 'production.operation.view']))
    const ops = { db, ...(await login(db, 'Ops', '5555')).ctx! } as Ctx
    expect(() => recordOperation(ops, { target: { type: 'field', id: field }, season_id: season, op_type: 'Weeding', occurred_on: '2026-10-06', workers: [{ worker_name: 'X', pay: 1 }] })).toThrow(PermissionError)
    expect(() => recordOperation(ops, { target: { type: 'field', id: field }, season_id: season, op_type: 'Weeding', occurred_on: '2026-10-06', machines: [{ machine_id: tractor, hours: 1 }] })).toThrow(PermissionError)
  })
})

describe('existing data and devices', () => {
  it('upgrades a v13 database without touching old operations, their costs or their free-text machinery', async () => {
    db.run(`INSERT INTO operations(id,tenant_id,farm_id,season_id,target_type,field_id,op_type,phase,occurred_on,labour_hours,labour_cost,machinery_asset,machinery_hours,machinery_fuel_l,machinery_cost,created_at,updated_at,version)
      VALUES('old1',?,?,?,'field',?,'Discing','land_prep','2026-09-20',6,15,'Old tractor',2,12,25,datetime('now'),datetime('now'),1)`, [o.tenantId, o.farmId, season, field])
    db.run(`INSERT INTO cost_entries(id,tenant_id,farm_id,season_id,category,amount,occurred_on,field_id,source_type,source_id,created_at,updated_at,version) VALUES('c1',?,?,?,'labour',15,'2026-09-20',?,'operation_labour','old1',datetime('now'),datetime('now'),1),('c2',?,?,?,'machinery',25,'2026-09-20',?,'operation_machinery','old1',datetime('now'),datetime('now'),1)`,
      [o.tenantId, o.farmId, season, field, o.tenantId, o.farmId, season, field])
    for (const [t, c] of [['machines', 'fuel_input_id'], ['machine_logs', 'input_id'], ['machine_logs', 'fuel_txn_id'], ['machine_logs', 'operation_id'], ['labour_entries', 'operation_id']]) db.run(`ALTER TABLE ${t} DROP COLUMN ${c}`)
    db.run(`UPDATE meta SET value='13' WHERE key='schema_version'`)
    const p = new MemoryPersistence(); p.data = db.exportBytes(); const up = await Db.open(p); const u = { ...o, db: up }
    expect(up.get<{ value: string }>(`SELECT value FROM meta WHERE key='schema_version'`)!.value).toBe(String(SCHEMA_VERSION))
    expect(up.all<{ name: string }>(`PRAGMA table_info(machine_logs)`).map(c => c.name)).toEqual(expect.arrayContaining(['input_id', 'fuel_txn_id', 'operation_id']))
    expect(listOperations(u)[0]).toMatchObject({ cost: 40, labour_hours: 6, legacy_machinery: 'Old tractor 2 h, 12 L', workers: '', machines: '' })
    expect(listMachines(u)[0]).toMatchObject({ fuel_input_id: null, total_hours: 0 })   // old hours are not counted as machine hours
    deleteOperation(u, 'old1'); expect(seasonCostSummary(u, season).total).toBe(0)
  })
  it('a phone’s fuel log reaches the office over the Wi-Fi hub with its stock movement and cost', async () => {
    setHubEnabled(db, true)
    const fetchHub: FetchLike = async (url, init) => { const x = new URL(url); const r = await hubHandle(db, { method: init?.method ?? 'GET', path: x.pathname + x.search, auth: init?.headers?.Authorization ?? null, body: init?.body ? JSON.parse(init.body) : undefined })
      const body = JSON.parse(JSON.stringify(r.body)); return { status: r.status, ok: r.status >= 200 && r.status < 300, json: async () => body } }
    const phone = await Db.open(new MemoryPersistence()); const { code } = await createPairing(o, 'Tractor phone')
    await joinHub(phone, { hubUrl: 'http://192.168.1.20:7878', code, name: 'Tendai', pin: '1111' }, fetchHub)
    const pc = { db: phone, ...(await login(phone, 'Tendai', '1111')).ctx! } as Ctx
    logMachine(pc, { machine_id: tractor, season_id: season, kind: 'fuel', logged_on: '2026-10-09', fuel_l: 15 })
    const r = await syncViaHub(phone, pc.tenantId, fetchHub); expect(r.errors).toEqual([])
    expect(stockOf(o, diesel)).toBe(85); expect(costs().fuel).toBe(22.5); expect(listMachineLogs(o)[0]).toMatchObject({ fuel_l: 15, fuel_name: 'Diesel' })
  })
})
