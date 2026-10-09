import { describe, it, expect, beforeEach } from 'vitest'
import initSqlJs from 'sql.js'
import { Db, MemoryPersistence } from '../db/database'
import { initialiseFarm, login, createUser } from './setup'
import { type Ctx, PermissionError, ValidationError } from './context'
import { createSeason } from './seasons'
import { createField } from './fields'
import { createInput, recordPurchase, stockOf } from './inventory'
import { createSeedbed, listSeedbeds, updateSeedbed } from './seedbeds'
import { recordTransplant, deleteTransplant, plantingByField } from './transplants'
import { recordHarvest, deleteHarvest, listHarvests, harvestYield } from './harvest'
import { createBarn, createCycle, setCheck, loadCycle, logCuring, offloadCycle, cycleDashboard, listCycles, CHECKLIST_ITEMS, abortCycle, barnPerformance } from './curing'
import { createStorageUnit, listStorage, openStorageUnit, unstoredByCycle } from './storage'
import { seasonCostSummary, dashboard } from './reports'

let db: Db; let owner: Ctx; let season: string; let field: string; let seedbed: string; let barn: string; let fuel: string

async function ctxFor(name: string, pin: string): Promise<Ctx> { const r = await login(db, name, pin); if (!r.ok) throw new Error(r.reason); return { db, ...r.ctx! } }
const allChecks = (ctx: Ctx, cycle: string) => { for (const i of CHECKLIST_ITEMS) setCheck(ctx, cycle, i, true, '2026-12-01') }

beforeEach(async () => {
  db = await Db.open(new MemoryPersistence())
  await initialiseFarm(db, { tenantName: 'T', farmName: 'F', ownerName: 'Lovemore', ownerPin: '1234' })
  owner = await ctxFor('Lovemore', '1234')
  season = createSeason(owner, { label: '2026/27', starts_on: '2026-09-01', ends_on: '2027-08-31', activate: true })
  field = createField(owner, { field_no: 'F-04', area_ha: 4, variety: 'KRK26' })
  seedbed = createSeedbed(owner, { season_id: season, expected_seedlings: 50000, actual_seedlings: 42000, status: 'ready' })
  barn = createBarn(owner, { capacity_kg: 6000, fuel_type: 'wood' })
  fuel = createInput(owner, { name: 'Firewood', category: 'fuel', unit: 'kg' })
  recordPurchase(owner, { input_id: fuel, qty: 5000, unit_cost: 0.1, occurred_on: '2026-11-01' })
})

describe('transplanting', () => {
  it('draws down seedbed stock, blocks over-transplanting, depletes and restores', () => {
    const t = recordTransplant(owner, { seedbed_id: seedbed, field_id: field, occurred_on: '2026-11-10', qty: 18500, mortality: 200, labour_cost: 90, spacing_row_m: 1.2, spacing_plant_m: 0.5 })
    expect(listSeedbeds(owner)[0].available_seedlings).toBe(23500)
    expect(() => recordTransplant(owner, { seedbed_id: seedbed, field_id: field, occurred_on: '2026-11-11', qty: 23501 })).toThrow(/Only 23500/)
    expect(plantingByField(owner, season)[0]).toMatchObject({ established: 18300, plants_per_ha: 4575 })
    expect(seasonCostSummary(owner, season).total).toBe(90)
    recordTransplant(owner, { seedbed_id: seedbed, field_id: field, occurred_on: '2026-11-12', qty: 23500, kind: 'gap_fill' })
    expect(listSeedbeds(owner)[0].status).toBe('depleted')
    deleteTransplant(owner, t)
    expect(listSeedbeds(owner)[0]).toMatchObject({ available_seedlings: 18500, status: 'ready' })
    expect(seasonCostSummary(owner, season).total).toBe(0)
  })
  it('requires actual seedlings and validates mortality', () => {
    const bare = createSeedbed(owner, { season_id: season })
    expect(() => recordTransplant(owner, { seedbed_id: bare, field_id: field, occurred_on: '2026-11-10', qty: 10 })).toThrow(/actual seedlings/)
    expect(() => recordTransplant(owner, { seedbed_id: seedbed, field_id: field, occurred_on: '2026-11-10', qty: 10, mortality: 11 })).toThrow(ValidationError)
    updateSeedbed(owner, bare, { actual_seedlings: 5 }); expect(listSeedbeds(owner).find(s => s.id === bare)!.available_seedlings).toBe(5)
  })
})

describe('harvest', () => {
  it('issues sequential unique batch codes and books labour + transport costs to the field', () => {
    const a = recordHarvest(owner, { field_id: field, season_id: season, harvested_on: '2027-01-20', green_weight_kg: 2400, priming: 1, labour_cost: 60, transport_cost: 25 })
    const b = recordHarvest(owner, { field_id: field, season_id: season, harvested_on: '2027-01-27', green_weight_kg: 2460 })
    expect([a.code, b.code]).toEqual(['H-00001', 'H-00002'])
    expect(listHarvests(owner)[0].variety).toBe('KRK26')
    expect(harvestYield(owner, season)[0]).toMatchObject({ green_kg: 4860, kg_per_ha: 1215 })
    expect(seasonCostSummary(owner, season).by_category.map(c => c.category).sort()).toEqual(['labour', 'transport'])
    deleteHarvest(owner, b.id); expect(recordHarvest(owner, { field_id: field, season_id: season, harvested_on: '2027-02-03', green_weight_kg: 100 }).code).toBe('H-00003')
  })
})

describe('barns, curing and starking — full chain', () => {
  it('runs harvest -> barn -> curing -> storage with every gate enforced', () => {
    const h1 = recordHarvest(owner, { field_id: field, season_id: season, harvested_on: '2027-01-20', green_weight_kg: 2400 })
    const h2 = recordHarvest(owner, { field_id: field, season_id: season, harvested_on: '2027-01-21', green_weight_kg: 2460 })
    const { id: cycle, code } = createCycle(owner, { barn_id: barn, season_id: season, fuel_input_id: fuel })
    expect(code).toBe('C-00001')
    expect(() => createCycle(owner, { barn_id: barn, season_id: season })).toThrow(/open curing cycle/)

    // gate 1: cannot load until every preparation check is done
    expect(() => loadCycle(owner, { cycle_id: cycle, batch_ids: [h1.id], loaded_at: '2027-01-22T08:00' })).toThrow(/preparation check/)
    for (const i of CHECKLIST_ITEMS.slice(0, -1)) setCheck(owner, cycle, i, true, '2027-01-21')
    expect(listCycles(owner)[0]).toMatchObject({ status: 'preparing', checks_done: 8, checks_total: 9 })
    setCheck(owner, cycle, 'Fuel availability', true, '2027-01-21'); expect(listCycles(owner)[0].status).toBe('ready')
    setCheck(owner, cycle, 'Safety', false, '2027-01-21'); expect(listCycles(owner)[0].status).toBe('preparing'); setCheck(owner, cycle, 'Safety', true, '2027-01-21')

    // gate 2: capacity and fuel allocation
    const big = recordHarvest(owner, { field_id: field, season_id: season, harvested_on: '2027-01-22', green_weight_kg: 5000 })
    expect(() => loadCycle(owner, { cycle_id: cycle, batch_ids: [h1.id, h2.id, big.id], loaded_at: '2027-01-22T08:00' })).toThrow(/exceeds the B-01 capacity/)
    expect(() => loadCycle(owner, { cycle_id: cycle, batch_ids: [h1.id, h2.id], loaded_at: '2027-01-22T08:00', fuel_opening_kg: 9999 })).toThrow(/in stock/)
    loadCycle(owner, { cycle_id: cycle, batch_ids: [h1.id, h2.id], loaded_at: '2027-01-22T08:00', slates: 160, labour_cost: 40, fuel_opening_kg: 4000 })
    expect(listHarvests(owner).filter(h => h.status === 'loaded')).toHaveLength(2)
    expect(listHarvests(owner)[0].cycle_code ?? listHarvests(owner)[1].cycle_code).toBe('C-00001')
    expect(() => loadCycle(owner, { cycle_id: cycle, batch_ids: [h1.id], loaded_at: '2027-01-22T09:00' })).toThrow()

    // curing monitor: temps + fuel consume stock and create curing cost
    logCuring(owner, { cycle_id: cycle, logged_at: '2027-01-22T12:00', temperature_c: 31, fuel_added_kg: 400 })
    logCuring(owner, { cycle_id: cycle, logged_at: '2027-01-23T12:00', temperature_c: 58, fuel_added_kg: 750 })
    logCuring(owner, { cycle_id: cycle, logged_at: '2027-01-24T12:00', temperature_c: 42 })
    expect(() => logCuring(owner, { cycle_id: cycle, logged_at: '2027-01-24T13:00', temperature_c: 500 })).toThrow(/between/)
    expect(() => logCuring(owner, { cycle_id: cycle, logged_at: '2027-01-21T13:00', temperature_c: 40 })).toThrow(/earlier than the loading/)
    const d = cycleDashboard(owner, cycle)
    expect(d.temp).toMatchObject({ current: 42, min: 31, max: 58 })
    expect(d.fuel).toEqual({ opening: 4000, used: 1150, remaining: 2850 })
    expect(d.summary.green_weight_kg).toBe(4860); expect(stockOf(owner, fuel)).toBe(3850)
    expect(d.summary.curing_cost).toBe(155) // fuel 1150*0.1=115 + loading labour 40

    // offload
    expect(() => offloadCycle(owner, { cycle_id: cycle, offloaded_at: '2027-01-28T08:00', cured_weight_kg: 5000 })).toThrow(/cannot exceed/)
    offloadCycle(owner, { cycle_id: cycle, offloaded_at: '2027-01-28T08:00', cured_weight_kg: 1580, labour_cost: 20 })
    const done = listCycles(owner)[0]
    expect(done).toMatchObject({ status: 'completed', curing_loss_kg: 3280, recovery_pct: 32.51 })
    expect(barnPerformance(owner, season)[0]).toMatchObject({ barn: 'B-01', cycles: 1, recovery_pct: 32.51 })
    expect(() => logCuring(owner, { cycle_id: cycle, logged_at: '2027-01-29T08:00', temperature_c: 40 })).toThrow(/completed/)

    // starking: storage cannot exceed cured weight; maturity tracking
    const sp = createStorageUnit(owner, { cycle_id: cycle, kind: 'slate_pack', weight_kg: 320, created_on: '2027-01-30' })
    const pile = createStorageUnit(owner, { cycle_id: cycle, kind: 'pile', weight_kg: 1260, created_on: '2027-01-30', maturity_days: 84 })
    expect([sp.code, pile.code]).toEqual(['SP-00001', 'P-00001'])
    expect(() => createStorageUnit(owner, { cycle_id: cycle, kind: 'pile', weight_kg: 1, created_on: '2027-01-30' })).toThrow(/left to store/)
    expect(unstoredByCycle(owner)).toHaveLength(0)
    const early = listStorage(owner, { asOf: '2027-03-01' }).find(u => u.code === 'P-00001')!
    expect(early).toMatchObject({ stage: 'MATURING', age_days: 30, days_to_open: 54 })
    const due = listStorage(owner, { asOf: '2027-04-24' }).find(u => u.code === 'P-00001')!
    expect(due).toMatchObject({ stage: 'READY TO OPEN', next_action: 'OPEN FOR GRADING', age_days: 84 })
    expect(() => openStorageUnit(owner, pile.id, '2027-03-01')).toThrow(/not due until/)
    openStorageUnit(owner, pile.id, '2027-03-01', true)
    expect(listStorage(owner, { asOf: '2027-03-02' }).find(u => u.code === 'P-00001')!.stage).toBe('OPENED')

    const s = seasonCostSummary(owner, season)
    expect(s.by_category.find(c => c.category === 'curing')!.amount).toBe(115)
    expect(dashboard(owner)).toMatchObject({ curing_active: 0 })
  })

  it('cancels unloaded cycles only and releases the barn', () => {
    const { id } = createCycle(owner, { barn_id: barn, season_id: season })
    abortCycle(owner, id); expect(createCycle(owner, { barn_id: barn, season_id: season }).code).toBe('C-00002')
    const h = recordHarvest(owner, { field_id: field, season_id: season, harvested_on: '2027-01-20', green_weight_kg: 100 })
    const c2 = listCycles(owner)[0].id; allChecks(owner, c2); loadCycle(owner, { cycle_id: c2, batch_ids: [h.id], loaded_at: '2027-01-21T08:00' })
    expect(() => abortCycle(owner, c2)).toThrow(/not yet loaded/); expect(() => deleteHarvest(owner, h.id)).toThrow(/already in a barn/)
  })
})

describe('Phase 2 permissions', () => {
  it('field recorder can log harvest and curing readings but not load barns, offload or see costs', async () => {
    const role = db.get<{ id: string }>(`SELECT id FROM roles WHERE name='Field Recorder'`)!.id
    await createUser(owner, 'Tendai', '4321', role); const rec = await ctxFor('Tendai', '4321')
    const h = recordHarvest(rec, { field_id: field, season_id: season, harvested_on: '2027-01-20', green_weight_kg: 500, labour_cost: 10 })
    expect(listHarvests(rec)[0].labour_cost).toBeNull()
    const { id } = createCycle(owner, { barn_id: barn, season_id: season, fuel_input_id: fuel }); allChecks(owner, id)
    expect(() => loadCycle(rec, { cycle_id: id, batch_ids: [h.id], loaded_at: '2027-01-21T08:00' })).toThrow(PermissionError)
    loadCycle(owner, { cycle_id: id, batch_ids: [h.id], loaded_at: '2027-01-21T08:00' })
    logCuring(rec, { cycle_id: id, logged_at: '2027-01-21T12:00', temperature_c: 35 })
    expect(() => offloadCycle(rec, { cycle_id: id, offloaded_at: '2027-01-25T08:00', cured_weight_kg: 100 })).toThrow(PermissionError)
    expect(listCycles(rec)[0].curing_cost).toBeNull()
    expect(() => createBarn(rec, {})).toThrow(PermissionError)
  })
})

describe('upgrading a Phase 1 database', () => {
  it('adds the cycle_id column and grants new permissions once to built-in roles', async () => {
    const SQL = await initSqlJs()
    const old = new SQL.Database()
    old.run(`CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT); INSERT INTO meta VALUES('schema_version','1');
      CREATE TABLE roles(id TEXT PRIMARY KEY, tenant_id TEXT, name TEXT, is_system INTEGER, created_at TEXT, updated_at TEXT, deleted_at TEXT, version INTEGER);
      CREATE TABLE role_permissions(tenant_id TEXT, role_id TEXT, permission TEXT, PRIMARY KEY(role_id, permission));
      INSERT INTO roles VALUES('r1','t1','Farm Manager',1,'','',NULL,1),('r2','t1','Custom',0,'','',NULL,1);
      INSERT INTO role_permissions VALUES('t1','r1','production.field.view');
      CREATE TABLE cost_entries(id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, farm_id TEXT, season_id TEXT, category TEXT, amount REAL, occurred_on TEXT, seedbed_id TEXT, field_id TEXT, source_type TEXT, source_id TEXT, note TEXT, created_at TEXT, updated_at TEXT, deleted_at TEXT, version INTEGER);`)
    const p = new MemoryPersistence(); p.data = old.export()
    const up = await Db.open(p)
    expect(up.all<{ name: string }>(`PRAGMA table_info(cost_entries)`).map(c => c.name)).toContain('cycle_id')
    const perms = up.all<{ permission: string; role_id: string }>(`SELECT role_id, permission FROM role_permissions`)
    expect(perms.filter(x => x.role_id === 'r1').map(x => x.permission)).toContain('curing.cycle.close')
    expect(perms.filter(x => x.role_id === 'r2')).toHaveLength(0)
    expect(up.get<{ value: string }>(`SELECT value FROM meta WHERE key='schema_version'`)!.value).toBe('17')
    const again = new MemoryPersistence(); again.data = up.exportBytes(); const reopened = await Db.open(again)
    expect(reopened.all(`SELECT 1 FROM role_permissions WHERE role_id='r1'`).length).toBe(perms.filter(x => x.role_id === 'r1').length) // idempotent
  })
})
