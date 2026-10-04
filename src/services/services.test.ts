import { describe, it, expect, beforeEach } from 'vitest'
import { Db, MemoryPersistence } from '../db/database'
import { initialiseFarm, login, createUser } from './setup'
import { type Ctx, PermissionError, ValidationError } from './context'
import { createSeason, setSeasonStatus } from './seasons'
import { createField, listFields, deleteField } from './fields'
import { createInput, recordPurchase, listInputs, stockOf, recordAdjustment } from './inventory'
import { createSeedbed, listSeedbeds } from './seedbeds'
import { recordOperation, deleteOperation, listOperations } from './operations'
import { seasonCostSummary, dashboard } from './reports'

let db: Db; let owner: Ctx; let seasonId: string

async function ctxFor(name: string, pin: string): Promise<Ctx> {
  const r = await login(db, name, pin)
  if (!r.ok || !r.ctx) throw new Error(r.reason)
  return { db, ...r.ctx }
}

beforeEach(async () => {
  db = await Db.open(new MemoryPersistence())
  await initialiseFarm(db, { tenantName: 'Test Farms', farmName: 'Home Farm', ownerName: 'Lovemore', ownerPin: '1234' })
  owner = await ctxFor('Lovemore', '1234')
  seasonId = createSeason(owner, { label: '2026/27', starts_on: '2026-09-01', ends_on: '2027-08-31', activate: true })
})

describe('auth & RBAC', () => {
  it('rejects wrong PIN and accepts right one', async () => {
    expect((await login(db, 'Lovemore', '0000')).ok).toBe(false)
    expect((await login(db, 'Lovemore', '1234')).ok).toBe(true)
  })
  it('field recorder can record operations but cannot create fields or see costs', async () => {
    const role = db.get<{ id: string }>(`SELECT id FROM roles WHERE name='Field Recorder'`)!.id
    await createUser(owner, 'Tendai', '4321', role)
    const rec = await ctxFor('Tendai', '4321')
    expect(() => createField(rec, { field_no: 'F1', area_ha: 2 })).toThrow(PermissionError)
    expect(() => seasonCostSummary(rec, seasonId)).toThrow(PermissionError)
    createField(owner, { field_no: 'F1', area_ha: 2 })
    expect(listFields(rec)).toHaveLength(1)
  })
  it('non-owners cannot create users', async () => {
    const role = db.get<{ id: string }>(`SELECT id FROM roles WHERE name='Store Clerk'`)!.id
    await createUser(owner, 'Clerk', '1111', role)
    const clerk = await ctxFor('Clerk', '1111')
    await expect(createUser(clerk, 'X', '2222', role)).rejects.toThrow(PermissionError)
  })
})

describe('inventory-linked operations', () => {
  let fieldId: string; let fert: string

  beforeEach(() => {
    fieldId = createField(owner, { field_no: 'F-04', area_ha: 5 })
    fert = createInput(owner, { name: 'Compound D', category: 'fertilizer', unit: 'kg' })
    recordPurchase(owner, { input_id: fert, qty: 500, unit_cost: 1.2, occurred_on: '2026-10-01' })
  })

  it('applying fertilizer consumes stock and creates cost atomically', () => {
    recordOperation(owner, { target: { type: 'field', id: fieldId }, season_id: seasonId, op_type: 'Fertilizing', phase: 'land_prep',
      occurred_on: '2026-10-02', workers: [{ worker_name: 'Crew', pay: 20 }], inputs: [{ input_id: fert, qty: 100 }] })
    expect(stockOf(owner, fert)).toBe(400)
    const s = seasonCostSummary(owner, seasonId)
    expect(s.total).toBe(140) // 100kg*1.2 + 20 labour
    expect(s.by_category.find(c => c.category === 'fertilizer')!.amount).toBe(120)
    expect(s.by_field[0].cost_per_ha).toBe(28)
  })

  it('rolls back everything when stock is insufficient', () => {
    const before = db.get<{ n: number }>(`SELECT COUNT(*) n FROM operations`)!.n
    expect(() => recordOperation(owner, { target: { type: 'field', id: fieldId }, season_id: seasonId, op_type: 'Fertilizing',
      occurred_on: '2026-10-02', workers: [{ worker_name: 'Crew', pay: 50 }], inputs: [{ input_id: fert, qty: 501 }] })).toThrow(/Insufficient stock/)
    expect(db.get<{ n: number }>(`SELECT COUNT(*) n FROM operations`)!.n).toBe(before)
    expect(db.get<{ n: number }>(`SELECT COUNT(*) n FROM cost_entries`)!.n).toBe(0)
    expect(stockOf(owner, fert)).toBe(500)
  })

  it('deleting an operation restores stock and removes costs', () => {
    const op = recordOperation(owner, { target: { type: 'field', id: fieldId }, season_id: seasonId, op_type: 'Fertilizing',
      occurred_on: '2026-10-02', workers: [{ worker_name: 'Crew', pay: 30 }], inputs: [{ input_id: fert, qty: 100 }] })
    deleteOperation(owner, op)
    expect(stockOf(owner, fert)).toBe(500)
    expect(seasonCostSummary(owner, seasonId).total).toBe(0)
    expect(listOperations(owner)).toHaveLength(0)
  })

  it('uses weighted-average cost across purchases', () => {
    recordPurchase(owner, { input_id: fert, qty: 500, unit_cost: 1.4, occurred_on: '2026-10-03' })
    recordOperation(owner, { target: { type: 'field', id: fieldId }, season_id: seasonId, op_type: 'Fertilizing', occurred_on: '2026-10-04', inputs: [{ input_id: fert, qty: 100 }] })
    expect(seasonCostSummary(owner, seasonId).total).toBe(130) // avg 1.30
  })

  it('blocks recording into a closed season and deleting fields with history', () => {
    recordOperation(owner, { target: { type: 'field', id: fieldId }, season_id: seasonId, op_type: 'Weeding', occurred_on: '2026-10-05' })
    expect(() => deleteField(owner, fieldId)).toThrow(ValidationError)
    setSeasonStatus(owner, seasonId, 'closed')
    expect(() => recordOperation(owner, { target: { type: 'field', id: fieldId }, season_id: seasonId, op_type: 'Weeding', occurred_on: '2026-10-06' })).toThrow(/closed/)
  })

  it('stock adjustments need a reason and cannot go negative', () => {
    expect(() => recordAdjustment(owner, { input_id: fert, qty_delta: -10, occurred_on: '2026-10-02', note: ' ' })).toThrow(ValidationError)
    expect(() => recordAdjustment(owner, { input_id: fert, qty_delta: -501, occurred_on: '2026-10-02', note: 'spill' })).toThrow(ValidationError)
    recordAdjustment(owner, { input_id: fert, qty_delta: -10, occurred_on: '2026-10-02', note: 'spill' })
    expect(listInputs(owner)[0].on_hand).toBe(490)
  })
})

describe('seedbeds', () => {
  it('derives area, auto-codes, tracks cost per 1000 seedlings and sowing side-effects', () => {
    const sb = createSeedbed(owner, { season_id: seasonId, bed_length_m: 10, bed_width_m: 1.2, bed_count: 20, expected_seedlings: 50000 })
    const seed = createInput(owner, { name: 'KRK26 seed', category: 'seed', unit: 'g' })
    recordPurchase(owner, { input_id: seed, qty: 100, unit_cost: 2, occurred_on: '2026-09-10' })
    recordOperation(owner, { target: { type: 'seedbed', id: sb }, op_type: 'Sowing', occurred_on: '2026-09-15', workers: [{ worker_name: 'Crew', pay: 10 }], inputs: [{ input_id: seed, qty: 50 }] })
    const row = listSeedbeds(owner)[0]
    expect(row.code).toBe('SB-001'); expect(row.area_m2).toBe(240)
    expect(row.status).toBe('sown'); expect(row.sown_on).toBe('2026-09-15'); expect(row.total_cost).toBe(110)
  })
  it('never leaks cost to roles without finance access', async () => {
    createSeedbed(owner, { season_id: seasonId })
    const role = db.get<{ id: string }>(`SELECT id FROM roles WHERE name='Field Recorder'`)!.id
    await createUser(owner, 'Rec', '5555', role)
    const rec = await ctxFor('Rec', '5555')
    const row = listSeedbeds(rec)[0] as unknown as Record<string, unknown>
    expect(row.total_cost).toBeNull(); expect('cost' in row).toBe(false)
    expect(listOperations(rec).every(o => o.cost === null)).toBe(true)
    expect(dashboard(rec).season_cost).toBeNull()
  })
})

describe('sync journal & persistence', () => {
  it('journals every write and survives export/reload', async () => {
    createField(owner, { field_no: 'F9', area_ha: 1 })
    expect(db.get<{ n: number }>(`SELECT COUNT(*) n FROM outbox WHERE synced_at IS NULL AND table_name<>'activity_log'`)!.n).toBe(3) // farm + season + field
    expect(db.get<{ n: number }>(`SELECT COUNT(*) n FROM outbox WHERE synced_at IS NULL AND table_name='activity_log'`)!.n).toBeGreaterThanOrEqual(3) // each save also leaves a readable event
    const p = new MemoryPersistence(); p.data = db.exportBytes()
    const db2 = await Db.open(p)
    expect(db2.get<{ n: number }>(`SELECT COUNT(*) n FROM fields`)!.n).toBe(1)
    expect(db2.get<{ v: number }>(`PRAGMA foreign_keys`)).toBeDefined()
  })
})

describe('roles', () => {
  it('custom roles drive access; owner is protected', async () => {
    const { createRole, setRolePermissions, listRoles } = await import('./roles')
    const id = createRole(owner, 'Extension Officer', ['production.field.view', 'production.operation.view'])
    await createUser(owner, 'Ext', '7777', id)
    const ext = await ctxFor('Ext', '7777')
    createField(owner, { field_no: 'F1', area_ha: 1 })
    expect(listFields(ext)).toHaveLength(1)
    expect(() => seasonCostSummary(ext, seasonId)).toThrow(PermissionError)
    setRolePermissions(owner, id, [])
    const ext2 = await ctxFor('Ext', '7777')
    expect(() => listFields(ext2)).toThrow(PermissionError)
    const ownerRole = listRoles(owner).find(r => r.name === 'Owner')!
    expect(() => setRolePermissions(owner, ownerRole.id, [])).toThrow(ValidationError)
  })
})
