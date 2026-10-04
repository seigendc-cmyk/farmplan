import { describe, it, expect, beforeEach } from 'vitest'
import { Db, MemoryPersistence } from '../db/database'
import { initialiseFarm, login } from './setup'
import { type Ctx, PermissionError } from './context'
import { createSeason, setSeasonStatus } from './seasons'
import { createField } from './fields'
import { createMachine, updateMachine, deleteMachine, logMachine, deleteMachineLog, listMachines, listMachineLogs } from './machinery'
import { seasonCostSummary } from './reports'
import { profitability } from './analytics'
import { runSelect } from './bi'
import { runMigrations } from '../db/migrations'

let db: Db; let o: Ctx; let season: string; let field: string; let tractor: string
beforeEach(async () => {
  db = await Db.open(new MemoryPersistence()); await initialiseFarm(db, { tenantName: 'T', farmName: 'F', ownerName: 'Lovemore', ownerPin: '1234' })
  const r = await login(db, 'Lovemore', '1234'); o = { db, ...r.ctx! }
  season = createSeason(o, { label: '2026/27', starts_on: '2026-09-01', ends_on: '2027-08-31', activate: true }); field = createField(o, { field_no: 'F-04', area_ha: 4 })
  tractor = createMachine(o, { name: 'MF 275', kind: 'tractor', make_model: 'Massey Ferguson 275', hourly_rate: 12, service_interval_hours: 100 })
})

describe('machine register', () => {
  it('validates, rejects duplicate names, edits, and blocks deleting a machine with history', () => {
    expect(() => createMachine(o, { name: ' ' })).toThrow(/name/); expect(() => createMachine(o, { name: 'mf 275' })).toThrow(/already exists/)
    expect(() => createMachine(o, { name: 'X', hourly_rate: -1 })).toThrow(/negative/); expect(() => createMachine(o, { name: 'X', service_interval_hours: 0 })).toThrow(/greater than zero/)
    updateMachine(o, tractor, { name: 'MF 275', kind: 'tractor', hourly_rate: 15, service_interval_hours: 100 }); expect(listMachines(o)[0].hourly_rate).toBe(15)
    const plough = createMachine(o, { name: 'Plough', kind: 'implement' }); deleteMachine(o, plough)
    logMachine(o, { machine_id: tractor, season_id: season, kind: 'use', logged_on: '2026-10-01', hours: 5 })
    expect(() => deleteMachine(o, tractor)).toThrow(/inactive instead/)
  })
})

describe('logging and costs', () => {
  it('costs use at the hourly rate, books fuel and repairs, ties costs to fields and reverses on delete', () => {
    const u = logMachine(o, { machine_id: tractor, season_id: season, kind: 'use', logged_on: '2026-10-01', hours: 6, field_id: field })
    expect(u.cost).toBe(72)
    logMachine(o, { machine_id: tractor, season_id: season, kind: 'use', logged_on: '2026-10-02', hours: 4, cost: 30 })           // explicit override
    logMachine(o, { machine_id: tractor, season_id: season, kind: 'fuel', logged_on: '2026-10-02', fuel_l: 40, cost: 60, field_id: field })
    logMachine(o, { machine_id: tractor, season_id: season, kind: 'repair', logged_on: '2026-10-03', cost: 25, description: 'New hose' })
    const s = seasonCostSummary(o, season); expect(s.total).toBe(72 + 30 + 60 + 25)
    expect(Object.fromEntries(s.by_category.map(c => [c.category, c.amount]))).toEqual({ machinery: 127, fuel: 60 })
    expect(profitability(o, season).by_field.find(f => f.field_no === 'F-04')!.field_cost).toBe(132)
    const m = listMachines(o)[0]; expect(m).toMatchObject({ total_hours: 10, fuel_l: 40, l_per_hour: 4, cost: 187, cost_per_hour: 18.7, service_due: false, hours_since_service: 10 })
    deleteMachineLog(o, u.id); expect(seasonCostSummary(o, season).total).toBe(115); expect(listMachineLogs(o)).toHaveLength(3)
  })
  it('validates each log type and the machine / season state', () => {
    expect(() => logMachine(o, { machine_id: tractor, season_id: season, kind: 'use', logged_on: '2026-10-01' })).toThrow(/hours/)
    expect(() => logMachine(o, { machine_id: tractor, season_id: season, kind: 'fuel', logged_on: '2026-10-01' })).toThrow(/litres/)
    expect(() => logMachine(o, { machine_id: tractor, season_id: season, kind: 'service', logged_on: '2026-10-01' })).toThrow(/Describe/)
    expect(() => logMachine(o, { machine_id: 'nope', season_id: season, kind: 'use', logged_on: '2026-10-01', hours: 1 })).toThrow(/not found/)
    updateMachine(o, tractor, { name: 'MF 275', active: false }); expect(() => logMachine(o, { machine_id: tractor, season_id: season, kind: 'use', logged_on: '2026-10-01', hours: 1 })).toThrow(/inactive/)
    updateMachine(o, tractor, { name: 'MF 275', active: true }); setSeasonStatus(o, season, 'closed')
    expect(() => logMachine(o, { machine_id: tractor, season_id: season, kind: 'use', logged_on: '2026-10-01', hours: 1 })).toThrow(/closed/)
  })
  it('flags service due by hours since the last service', () => {
    for (let d = 1; d <= 5; d++) logMachine(o, { machine_id: tractor, season_id: season, kind: 'use', logged_on: `2026-10-0${d}`, hours: 20 })
    expect(listMachines(o)[0]).toMatchObject({ hours_since_service: 100, service_due: true })
    logMachine(o, { machine_id: tractor, season_id: season, kind: 'service', logged_on: '2026-10-05', description: 'Oil and filters', cost: 40 })
    expect(listMachines(o)[0]).toMatchObject({ service_due: false, last_service_on: '2026-10-05', total_hours: 100 })
    logMachine(o, { machine_id: tractor, season_id: season, kind: 'use', logged_on: '2026-10-06', hours: 30 }); expect(listMachines(o)[0].hours_since_service).toBe(30)
  })
})

describe('permissions and BI', () => {
  it('hides costs from non-finance roles and enforces record / manage', () => {
    logMachine(o, { machine_id: tractor, season_id: season, kind: 'use', logged_on: '2026-10-01', hours: 2 })
    const rec = { ...o, perms: new Set(['resources.machinery.view', 'resources.machinery.record']) }
    expect(listMachines(rec)[0].cost).toBeNull(); expect(listMachineLogs(rec)[0].cost).toBeNull(); expect(logMachine(rec, { machine_id: tractor, season_id: season, kind: 'use', logged_on: '2026-10-02', hours: 1 }).cost).toBe(12)
    expect(() => createMachine(rec, { name: 'Z' })).toThrow(PermissionError); expect(() => listMachines({ ...o, perms: new Set() })).toThrow(PermissionError)
    expect(() => runSelect(rec, 'SELECT * FROM bi_machine_logs')).toThrow(/not available to you/)
  })
  it('exposes a view for questions, and upgrades from v6 once', () => {
    logMachine(o, { machine_id: tractor, season_id: season, kind: 'fuel', logged_on: '2026-10-01', fuel_l: 50, cost: 75 })
    expect(runSelect(o, 'SELECT machine, SUM(fuel_l) AS litres FROM bi_machine_logs GROUP BY machine').rows).toEqual([{ machine: 'MF 275', litres: 50 }])
    db.run(`DELETE FROM role_permissions WHERE permission LIKE 'resources.machinery.%'`); runMigrations(db, 6)
    expect(db.get(`SELECT 1 FROM role_permissions rp JOIN roles r ON r.id=rp.role_id WHERE r.name='Field Recorder' AND rp.permission='resources.machinery.record'`)).toBeTruthy()
    expect(db.get(`SELECT 1 FROM role_permissions rp JOIN roles r ON r.id=rp.role_id WHERE r.name='Field Recorder' AND rp.permission='resources.machinery.manage'`)).toBeUndefined()
  })
})
