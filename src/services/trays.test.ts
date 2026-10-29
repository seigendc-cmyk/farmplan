import { describe, it, expect, beforeEach } from 'vitest'
import { Db, MemoryPersistence } from '../db/database'
import { initialiseFarm, login, createUser } from './setup'
import { type Ctx, PermissionError } from './context'
import { createRole } from './roles'
import { createSeason } from './seasons'
import { createSeedbed, listSeedbeds, updateSeedbed, deleteSeedbed } from './seedbeds'
import { saveTrayType } from './traytypes'
import { createTray, updateTray, deleteTray, listTrays } from './trays'
import { recordTransplant } from './transplants'
import { getProject, projectOfSeason } from './projects'

let db: Db; let o: Ctx; let season: string; let bay: string; let tt: string
beforeEach(async () => {
  db = await Db.open(new MemoryPersistence())
  await initialiseFarm(db, { tenantName: 'T', farmName: 'F', ownerName: 'Lovemore', ownerPin: '1234' })
  o = { db, ...(await login(db, 'Lovemore', '1234')).ctx! }
  season = createSeason(o, { label: '2026/27', starts_on: '2026-09-01', ends_on: '2027-08-31', activate: true })
  bay = createSeedbed(o, { season_id: season, code: 'BAY1', kind: 'float_bay' })
  tt = saveTrayType(o, { name: '200-cell', cells: 200, length_mm: null, width_mm: null, media: null, note: null })
})
const bayRow = () => listSeedbeds(o, season).find(s => s.id === bay)!

describe('float bays', () => {
  it('creates a bay with kind float_bay and null bed fields; default kind is open_bed', () => {
    const open = createSeedbed(o, { season_id: season, code: 'B1', bed_length_m: 10, bed_width_m: 1, bed_count: 2 })
    const l = listSeedbeds(o, season)
    expect(l.find(s => s.id === open)).toMatchObject({ kind: 'open_bed', area_m2: 20, bed_count: 2 })
    expect(bayRow()).toMatchObject({ kind: 'float_bay', bed_length_m: null, bed_width_m: null, area_m2: null, actual_seedlings: null, expected_seedlings: null })
  })
  it('a bay ignores typed dimensions and seedling counts (they come from trays)', () => {
    const b = createSeedbed(o, { season_id: season, code: 'BAY2', kind: 'float_bay', bed_length_m: 5, bed_width_m: 2, actual_seedlings: 99, expected_seedlings: 99 })
    expect(listSeedbeds(o, season).find(s => s.id === b)).toMatchObject({ bed_length_m: null, area_m2: null, actual_seedlings: null, expected_seedlings: null })
    updateSeedbed(o, b, { actual_seedlings: 50, bed_length_m: 3 })
    expect(listSeedbeds(o, season).find(s => s.id === b)).toMatchObject({ bed_length_m: null, actual_seedlings: null })
  })
  it('kind cannot be changed by an update', () => { updateSeedbed(o, bay, { kind: 'open_bed' } as never); expect(bayRow().kind).toBe('float_bay') })
  it('existing open bed behaviour is unchanged (snapshot)', () => {
    const id = createSeedbed(o, { season_id: season, code: 'SB-9', bed_length_m: 10, bed_width_m: 2, bed_count: 2, expected_seedlings: 1000, actual_seedlings: 900, sown_on: '2026-09-05' })
    const r = listSeedbeds(o, season).find(s => s.id === id)!
    const { id: _i, ...rest } = r
    expect(rest).toMatchObject({ season_id: season, code: 'SB-9', kind: 'open_bed', location: null, variety: null, seed_lot: null, seed_supplier: null, bed_length_m: 10, bed_width_m: 2, bed_count: 2,
      area_m2: 40, prepared_on: null, sown_on: '2026-09-05', expected_seedlings: 1000, actual_seedlings: 900, status: 'sown', season_label: '2026/27', transplanted: 0,
      available_seedlings: 900, seedlings_per_bed: 450, achievement_pct: 90, total_cost: 0, cost_per_1000_seedlings: 0 })
  })
  it('bay seedling totals are the sum of tray counts; null when no tray has a count', () => {
    expect(bayRow().actual_seedlings).toBeNull()
    createTray(o, { seedbed_id: bay, tray_type_id: tt, expected_seedlings: 150 })
    expect(bayRow()).toMatchObject({ expected_seedlings: 150, actual_seedlings: null, available_seedlings: null })
    const a = createTray(o, { seedbed_id: bay, tray_type_id: tt, actual_seedlings: 120 })
    createTray(o, { seedbed_id: bay, tray_type_id: tt, actual_seedlings: 80 })
    expect(bayRow()).toMatchObject({ actual_seedlings: 200, expected_seedlings: 550, available_seedlings: 200, bed_count: 1, achievement_pct: 36.36 })
    updateTray(o, a, { actual_seedlings: 100 }); expect(bayRow().actual_seedlings).toBe(180)
  })
})

describe('trays', () => {
  it('defaults code to next free T-nnn and expected seedlings to the type cells', () => {
    const a = createTray(o, { seedbed_id: bay, tray_type_id: tt, variety: 'K326', sown_on: '2026-09-02' }); createTray(o, { seedbed_id: bay, tray_type_id: tt })
    expect(listTrays(o, bay)).toMatchObject([
      { id: a, code: 'T-001', tray_type: '200-cell', expected_seedlings: 200, actual_seedlings: null, status: 'sown', variety: 'K326', sown_on: '2026-09-02', transplanted: 0, available: null },
      { code: 'T-002', expected_seedlings: 200 }])
  })
  it('refuses a tray on an open bed, unknown type, duplicate code, bad numbers and dates', () => {
    const open = createSeedbed(o, { season_id: season, code: 'B1' })
    expect(() => createTray(o, { seedbed_id: open, tray_type_id: tt })).toThrow(/float bay/i)
    expect(() => createTray(o, { seedbed_id: bay, tray_type_id: 'nope' })).toThrow(/tray type/i)
    createTray(o, { seedbed_id: bay, tray_type_id: tt, code: 'X' })
    expect(() => createTray(o, { seedbed_id: bay, tray_type_id: tt, code: 'X' })).toThrow(/already exists/)
    expect(() => createTray(o, { seedbed_id: bay, tray_type_id: tt, actual_seedlings: -1 })).toThrow(/negative/)
    expect(() => createTray(o, { seedbed_id: bay, tray_type_id: tt, expected_seedlings: 1.5 })).toThrow(/whole/)
    expect(() => createTray(o, { seedbed_id: bay, tray_type_id: tt, sown_on: '09/02' })).toThrow(/date/i)
    expect(listTrays(o, bay)).toHaveLength(1)
  })
  it('update: changes fields, refuses duplicate code, refuses count below transplanted', () => {
    const a = createTray(o, { seedbed_id: bay, tray_type_id: tt, actual_seedlings: 100 }); const b = createTray(o, { seedbed_id: bay, tray_type_id: tt })
    updateTray(o, a, { variety: 'Hybrid', status: 'growing', code: 'A1' }); expect(listTrays(o, bay)[0]).toMatchObject({ code: 'A1', variety: 'Hybrid', status: 'growing' })
    expect(() => updateTray(o, b, { code: 'A1' })).toThrow(/already exists/)
    expect(() => updateTray(o, a, { status: 'bogus' })).toThrow(/status/i)
    db.run(`INSERT INTO transplants(id,tenant_id,farm_id,season_id,seedbed_id,field_id,occurred_on,qty,tray_id) VALUES('t1',?,?,?,?,?,'2026-10-01',60,?)`, [o.tenantId, o.farmId, season, bay,
      db.insert('fields', { tenant_id: o.tenantId, farm_id: o.farmId, field_no: 'F1', area_ha: 1 }), a])
    expect(listTrays(o, bay)[0]).toMatchObject({ transplanted: 60, available: 40 })
    expect(() => updateTray(o, a, { actual_seedlings: 59 })).toThrow(/transplanted/)
    updateTray(o, a, { actual_seedlings: 60 }); expect(listTrays(o, bay)[0].actual_seedlings).toBe(60)
  })
  it('edit with empty counts: status change on an uncounted tray, clearing expected and actual', () => {
    const a = createTray(o, { seedbed_id: bay, tray_type_id: tt, variety: 'K' })
    updateTray(o, a, { status: 'germinating', variety: undefined, sown_on: undefined, expected_seedlings: undefined, actual_seedlings: undefined })
    expect(listTrays(o, bay)[0]).toMatchObject({ status: 'germinating', variety: null, expected_seedlings: null, actual_seedlings: null })
    updateTray(o, a, { actual_seedlings: 90, expected_seedlings: 150, variety: 'K' }); updateTray(o, a, { status: 'growing' })
    expect(listTrays(o, bay)[0]).toMatchObject({ status: 'growing', variety: 'K', expected_seedlings: 150, actual_seedlings: 90 })
    updateTray(o, a, { expected_seedlings: null }); expect(listTrays(o, bay)[0]).toMatchObject({ expected_seedlings: null, actual_seedlings: 90 })
    updateTray(o, a, { actual_seedlings: null }); expect(listTrays(o, bay)[0]).toMatchObject({ actual_seedlings: null, available: null })
  })
  it('clearing the count is refused once seedlings were transplanted from the tray', () => {
    const a = createTray(o, { seedbed_id: bay, tray_type_id: tt, actual_seedlings: 100 })
    db.run(`INSERT INTO transplants(id,tenant_id,farm_id,season_id,seedbed_id,field_id,occurred_on,qty,tray_id) VALUES('t1',?,?,?,?,?,'2026-10-01',10,?)`, [o.tenantId, o.farmId, season, bay,
      db.insert('fields', { tenant_id: o.tenantId, farm_id: o.farmId, field_no: 'F1', area_ha: 1 }), a])
    expect(() => updateTray(o, a, { actual_seedlings: null })).toThrow(/cannot be cleared/)
    expect(() => updateTray(o, a, { actual_seedlings: undefined })).toThrow(/cannot be cleared/)
    updateTray(o, a, { status: 'ready' }); expect(listTrays(o, bay)[0]).toMatchObject({ actual_seedlings: 100, status: 'ready' })
  })
  it('a reused code names the removed tray', () => {
    const a = createTray(o, { seedbed_id: bay, tray_type_id: tt, code: 'Z' }); deleteTray(o, a)
    expect(() => createTray(o, { seedbed_id: bay, tray_type_id: tt, code: 'Z' })).toThrow(/removed tray/)
    const b = createTray(o, { seedbed_id: bay, tray_type_id: tt, code: 'Y' }); expect(() => updateTray(o, b, { code: 'Z' })).toThrow(/removed tray/)
  })
  it('delete: soft deletes, refused when an operation, cost or transplant references it', () => {
    const a = createTray(o, { seedbed_id: bay, tray_type_id: tt }); deleteTray(o, a); expect(listTrays(o, bay)).toEqual([])
    const c = createTray(o, { seedbed_id: bay, tray_type_id: tt, code: 'C' })
    db.run(`INSERT INTO cost_entries(id,tenant_id,farm_id,season_id,category,amount,occurred_on,source_type,tray_id) VALUES('c1',?,?,?,'seed',5,'2026-09-02','manual',?)`, [o.tenantId, o.farmId, season, c])
    expect(() => deleteTray(o, c)).toThrow(/cost/i)
    db.run(`DELETE FROM cost_entries`); db.run(`INSERT INTO operations(id,tenant_id,farm_id,season_id,target_type,seedbed_id,op_type,occurred_on,tray_id) VALUES('o1',?,?,?,'seedbed',?,'Watering','2026-09-03',?)`, [o.tenantId, o.farmId, season, bay, c])
    expect(() => deleteTray(o, c)).toThrow(/operation/i)
    db.run(`DELETE FROM operations`); deleteTray(o, c)
  })
  it('deleting a bay with trays is refused; an empty bay can be deleted', () => {
    const t = createTray(o, { seedbed_id: bay, tray_type_id: tt }); expect(() => deleteSeedbed(o, bay)).toThrow(/tray/)
    expect(bayRow()).toBeTruthy(); deleteTray(o, t); deleteSeedbed(o, bay); expect(listSeedbeds(o, season).find(s => s.id === bay)).toBeUndefined()
  })
  it('transplanting from a bay without a tray is refused clearly, without crashing', () => {
    createTray(o, { seedbed_id: bay, tray_type_id: tt, actual_seedlings: 100 })
    const f = db.insert('fields', { tenant_id: o.tenantId, farm_id: o.farmId, field_no: 'F1', area_ha: 1 })
    expect(() => recordTransplant(o, { seedbed_id: bay, field_id: f, occurred_on: '2026-10-01', qty: 10 })).toThrow(/float bay/i)
  })
  it('writes audit events, activity without money, and enforces permissions', async () => {
    const a = createTray(o, { seedbed_id: bay, tray_type_id: tt, code: 'T9' })
    expect(db.all<{ action: string }>(`SELECT action FROM audit_log WHERE action LIKE 'tray.%'`).map(r => r.action)).toEqual(['tray.create'])
    updateTray(o, a, { variety: 'X' }); deleteTray(o, a)
    expect(db.all<{ action: string }>(`SELECT action FROM audit_log WHERE action LIKE 'tray.%'`).map(r => r.action)).toEqual(['tray.create', 'tray.update', 'tray.delete'])
    expect(db.get(`SELECT 1 FROM outbox WHERE table_name='seedbed_trays'`)).toBeTruthy()
    await createUser(o, 'Viewer', '5555', createRole(o, 'V', ['production.seedbed.view']))
    const v = { db, ...(await login(db, 'Viewer', '5555')).ctx! } as Ctx
    expect(() => createTray(v, { seedbed_id: bay, tray_type_id: tt })).toThrow(PermissionError); expect(listTrays(v, bay)).toEqual([])
    await createUser(o, 'Nobody', '6666', createRole(o, 'N', ['settings.farm.view']))
    const n = { db, ...(await login(db, 'Nobody', '6666')).ctx! } as Ctx
    expect(() => listTrays(n, bay)).toThrow(PermissionError)
  })
})

describe('seedbed project gates with bays', () => {
  let pid: string
  beforeEach(() => {
    db.run(`UPDATE farms SET modules=? WHERE id=?`, ['tobacco,seedbed', o.farmId])
    const s = createSeason(o, { label: 'S1', starts_on: '2026-08-01', ends_on: '2026-11-30', enterprise: 'seedbed' }); pid = projectOfSeason(o, s)!.id
    season = s; bay = createSeedbed(o, { season_id: s, code: 'BAYG', kind: 'float_bay' })
  })
  const at = (stage: string) => db.run(`UPDATE projects SET stage=? WHERE id=?`, [stage, pid])
  it('a bay satisfies the sowing gate; a tray sown_on satisfies the growing gate', () => {
    at('sowing'); expect(getProject(o, pid).unmet).toEqual([])
    at('growing'); expect(getProject(o, pid).unmet).toEqual(['Record a sowing date on a seedbed'])
    createTray(o, { seedbed_id: bay, tray_type_id: tt }); expect(getProject(o, pid).unmet).toEqual(['Record a sowing date on a seedbed'])
    createTray(o, { seedbed_id: bay, tray_type_id: tt, sown_on: '2026-08-10' }); expect(getProject(o, pid).unmet).toEqual([])
  })
  it('a deleted tray no longer counts as a sowing date', () => {
    const t = createTray(o, { seedbed_id: bay, tray_type_id: tt, sown_on: '2026-08-10' }); at('growing'); expect(getProject(o, pid).unmet).toEqual([])
    deleteTray(o, t); expect(getProject(o, pid).unmet).toEqual(['Record a sowing date on a seedbed'])
  })
})
