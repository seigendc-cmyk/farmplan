import { describe, it, expect, beforeEach } from 'vitest'
import { Db, MemoryPersistence } from '../db/database'
import { initialiseFarm, login } from './setup'
import { type Ctx, PermissionError } from './context'
import { createSeason } from './seasons'
import { createSeedbed } from './seedbeds'
import { createField } from './fields'
import { recordTransplant } from './transplants'
import { seedlingAttribution, seedbedLoss } from './seedlingcost'
import { profitability, seasonComparison } from './analytics'
import { fieldRecord } from './fieldrecord'
import { recordHarvest } from './harvest'

let db: Db; let o: Ctx; let crop: string; let sbSeason: string; let other: string; let legacy: string; let open: string; let f1: string; let f2: string
beforeEach(async () => {
  db = await Db.open(new MemoryPersistence())
  await initialiseFarm(db, { tenantName: 'T', farmName: 'F', ownerName: 'Lovemore', ownerPin: '1234' })
  o = { db, ...(await login(db, 'Lovemore', '1234')).ctx! }
  db.run(`UPDATE farms SET modules=? WHERE id=?`, ['tobacco,seedbed', o.farmId])
  crop = createSeason(o, { label: '2026/27', starts_on: '2026-09-01', ends_on: '2027-08-31', activate: true })
  other = createSeason(o, { label: '2025/26', starts_on: '2025-09-01', ends_on: '2026-08-31' })
  sbSeason = createSeason(o, { label: 'SB 2026', starts_on: '2026-08-01', ends_on: '2026-11-30', enterprise: 'seedbed' })
  legacy = createSeedbed(o, { season_id: crop, code: 'LB1', bed_length_m: 10, bed_width_m: 1, bed_count: 1, actual_seedlings: 400 })
  open = createSeedbed(o, { season_id: sbSeason, code: 'OB1', bed_length_m: 10, bed_width_m: 1, bed_count: 1, actual_seedlings: 400 })
  f1 = createField(o, { field_no: 'F1', area_ha: 1 } as never); f2 = createField(o, { field_no: 'F2', area_ha: 2 } as never)
})
const cost = (amount: number, bed: string, season: string, on = '2026-09-01') => db.insert('cost_entries', {
  tenant_id: o.tenantId, farm_id: o.farmId, season_id: season, category: 'labour', amount, occurred_on: on, seedbed_id: bed, field_id: null, tray_id: null, source_type: 'test', source_id: null, note: null })
const fieldCost = (amount: number, field: string, season: string) => db.insert('cost_entries', {
  tenant_id: o.tenantId, farm_id: o.farmId, season_id: season, category: 'fertilizer', amount, occurred_on: '2026-11-01', seedbed_id: null, field_id: field, tray_id: null, source_type: 'test', source_id: null, note: null })
const legacyTp = (qty: number, field = f1) => recordTransplant(o, { seedbed_id: legacy, field_id: field, occurred_on: '2026-10-02', qty } as never)
const crossTp = (qty: number, field = f1, extra: object = {}) => recordTransplant(o, { seedbed_id: open, field_id: field, occurred_on: '2026-10-02', qty, crop_season_id: crop, ...extra } as never)
const noCost = () => ({ ...o, perms: new Set(['production.transplant.view', 'production.seedbed.view']) }) as Ctx
const costOnly = () => ({ ...o, perms: new Set(['finance.cost.view']) }) as Ctx

describe('seedling cost in profitability', () => {
  it('legacy same-season transplant: field_cost +400, shared_cost -400, total_cost unchanged, nothing transferred in', () => {
    cost(400, legacy, crop); fieldCost(100, f1, crop)
    const a = profitability(o, crop)
    expect(a).toMatchObject({ total_cost: 500, field_cost: 100, shared_cost: 400 })
    legacyTp(400)
    const b = profitability(o, crop)
    expect(b).toMatchObject({ total_cost: 500, field_cost: 500, shared_cost: 0, seedling_cost: 400, transfer_in: 0, seedling_pending: 0 })
    expect(b.by_field.find(f => f.field_no === 'F1')).toMatchObject({ seedling_cost: 400, field_cost: 500 })
  })
  it('a field with only seedling cost still appears in the by-field table', () => {
    cost(400, legacy, crop); legacyTp(100, f2)
    expect(profitability(o, crop).by_field.map(f => [f.field_no, f.field_cost, f.seedling_cost])).toEqual([['F2', 100, 100]])
  })
  it('cross-season: total_cost up by transfer_in (= attribution), shared_cost unchanged', () => {
    cost(400, open, sbSeason); fieldCost(100, f1, crop)
    const a = profitability(o, crop)
    crossTp(100)
    const b = profitability(o, crop)
    expect(b.transfer_in).toBe(100); expect(b.seedling_cost).toBe(100)
    expect(b.total_cost).toBe(a.total_cost + 100); expect(b.field_cost).toBe(a.field_cost + 100); expect(b.shared_cost).toBe(a.shared_cost)
    expect(b.by_field[0]).toMatchObject({ field_no: 'F1', seedling_cost: 100, field_cost: 200 })
    expect(profitability(o, sbSeason).total_cost).toBe(400) // the seedbed season keeps its own spend; the transfer is shown separately
  })
  it('legacy and cross-season together: only the cross part is transfer_in', () => {
    cost(400, legacy, crop); cost(400, open, sbSeason); legacyTp(200); crossTp(100)
    const p = profitability(o, crop)
    expect(p).toMatchObject({ seedling_cost: 300, transfer_in: 100, total_cost: 500, field_cost: 300, shared_cost: 200 })
  })
  it('attributed amounts plus seedbedLoss equal the seedbed spend (exact cents)', () => {
    cost(400, open, sbSeason)
    crossTp(100); crossTp(150, f2)
    const sum = seedlingAttribution(o, crop).reduce((s, r) => s + r.amount!, 0)
    expect(sum).toBe(250); expect(seedbedLoss(o, open)).toBe(150); expect(Math.round((sum + seedbedLoss(o, open)!) * 100)).toBe(40000)
  })
  it('awkward cents: 100.00 over 300 seedlings planted in thirds still reconciles to the cent (loss absorbs the drift)', () => {
    db.run(`UPDATE seedbeds SET actual_seedlings=300 WHERE id=?`, [open]); cost(100, open, sbSeason)
    crossTp(100); crossTp(100, f2); crossTp(100, f1, { kind: 'gap_fill' } as never)
    const sum = seedlingAttribution(o, crop).reduce((s, r) => s + r.amount!, 0)
    expect(Math.round((sum + seedbedLoss(o, open)!) * 100)).toBe(10000)
  })
  it('pending adds nothing and is counted', () => {
    db.run(`UPDATE seedbeds SET actual_seedlings=NULL WHERE id=?`, [open]); cost(50, open, sbSeason); fieldCost(10, f1, crop)
    const a = profitability(o, crop)
    db.insert('transplants', { tenant_id: o.tenantId, farm_id: o.farmId, season_id: sbSeason, seedbed_id: open, field_id: f1, occurred_on: '2026-10-02', qty: 10, crop_season_id: crop })
    const b = profitability(o, crop)
    expect(b).toMatchObject({ seedling_pending: 1, seedling_cost: 0, transfer_in: 0, total_cost: a.total_cost, field_cost: a.field_cost, shared_cost: a.shared_cost })
    expect(seedlingAttribution(o, crop)).toEqual([{ field_id: f1, seedlings: 10, amount: 0, cross_amount: 0, pending: true, pending_count: 1 }])
  })
  it('a pending transplant adds nothing but the same field\'s costed transplants still count; pending_count counts transplants', () => {
    cost(400, open, sbSeason); crossTp(100, f1); crossTp(100, f2)
    db.run(`UPDATE seedbeds SET actual_seedlings=NULL WHERE id=?`, [legacy]); cost(5, legacy, crop)
    db.insert('transplants', { tenant_id: o.tenantId, farm_id: o.farmId, season_id: crop, seedbed_id: legacy, field_id: f1, occurred_on: '2026-10-02', qty: 10 })
    db.insert('transplants', { tenant_id: o.tenantId, farm_id: o.farmId, season_id: crop, seedbed_id: legacy, field_id: f1, occurred_on: '2026-10-03', qty: 5 })
    const p = profitability(o, crop)
    expect(p).toMatchObject({ seedling_pending: 2, seedling_cost: 200, transfer_in: 200 })
    expect(p.by_field.map(f => [f.field_no, f.seedling_cost, f.seedling_pending])).toEqual([['F1', 100, 2], ['F2', 100, 0]])
  })
  it('seasons without transplants are unchanged: seasonComparison and profitability add nothing', () => {
    fieldCost(70, f1, other); cost(30, legacy, other)
    const before = seasonComparison(o); const row = before.find(r => r.season_id === other)!
    expect(row.total_cost).toBe(100); expect(Object.keys(row)).not.toContain('seedling_cost')
    cost(400, open, sbSeason); crossTp(100)
    const after = seasonComparison(o)
    expect(after.find(r => r.season_id === other)).toEqual(row)
    expect(after.find(r => r.season_id === crop)!.total_cost).toBe(before.find(r => r.season_id === crop)!.total_cost + 100)
    expect(profitability(o, other)).toMatchObject({ seedling_cost: 0, transfer_in: 0, seedling_pending: 0, total_cost: 100, field_cost: 70, shared_cost: 30 })
  })
  it('permissions: profitability still refuses users without finance.cost.view; attribution amounts are hidden; cost-only users still get the report', () => {
    cost(400, open, sbSeason); crossTp(100)
    expect(() => profitability(noCost(), crop)).toThrow(PermissionError)
    expect(seedlingAttribution(noCost(), crop)).toEqual([{ field_id: f1, seedlings: 100, amount: null, cross_amount: null, pending: false, pending_count: 0 }])
    expect(profitability(costOnly(), crop)).toMatchObject({ seedling_cost: 100, transfer_in: 100 })
  })
  it('field record exposes seedling cost for a season only with cost access', () => {
    cost(400, legacy, crop); legacyTp(400)
    expect(fieldRecord(o, 'F1', crop).totals.seedling_cost).toBe(400)
    expect(fieldRecord(o, 'F1').totals.seedling_cost).toBeNull()
    const ctx = { ...o, perms: new Set(['production.field.view', 'production.transplant.view']) } as Ctx
    expect(fieldRecord(ctx, 'F1', crop).totals.seedling_cost).toBeNull()
  })
})

describe('allocation does not double count attributed seedbed cost', () => {
  const harvest = (field: string, season: string, kg = 1000) => recordHarvest(o, { field_id: field, season_id: season, harvested_on: season === other ? '2026-01-20' : '2027-01-20', green_weight_kg: kg })
  const sumFull = (p: ReturnType<typeof profitability>) => Math.round(p.by_field.reduce((s, f) => s + f.full_cost, 0) * 100) / 100
  it('legacy: 400 bed, 100 attributed to F1; the other 300 is spread by area (100/200); nothing counted twice', () => {
    cost(400, legacy, crop); harvest(f1, crop); harvest(f2, crop); legacyTp(100)
    const p = profitability(o, crop)
    expect(p).toMatchObject({ total_cost: 400, field_cost: 100, shared_cost: 300, allocated_cost: 300, unallocated_cost: 0, seedling_cost: 100 })
    expect(p.by_field.map(f => [f.field_no, f.field_cost, f.allocated_cost, f.full_cost])).toEqual([['F1', 100, 100, 200], ['F2', 0, 200, 200]])
    expect(sumFull(p) + p.unallocated_cost).toBe(p.total_cost)
    expect(p.allocated_cost + p.unallocated_cost + p.seedling_cost).toBe(p.total_cost)
  })
  it('legacy with an unattributed remainder and mixed categories: pool keeps the remainder, invariant holds', () => {
    cost(300, legacy, crop); db.insert('cost_entries', { tenant_id: o.tenantId, farm_id: o.farmId, season_id: crop, category: 'fuel', amount: 100, occurred_on: '2026-09-02', seedbed_id: legacy, field_id: null, tray_id: null, source_type: 'test', source_id: null, note: null })
    harvest(f1, crop); harvest(f2, crop); legacyTp(100, f1); legacyTp(100, f2)
    const p = profitability(o, crop)
    expect(p).toMatchObject({ total_cost: 400, seedling_cost: 200, field_cost: 200, shared_cost: 200 })
    expect(p.allocated_cost + p.unallocated_cost + p.seedling_cost).toBe(400); expect(sumFull(p) + p.unallocated_cost).toBe(400)
  })
  it('pending legacy transplant stays in the pool (nothing lost)', () => {
    db.run(`UPDATE seedbeds SET actual_seedlings=NULL WHERE id=?`, [legacy]); cost(400, legacy, crop); harvest(f1, crop)
    db.insert('transplants', { tenant_id: o.tenantId, farm_id: o.farmId, season_id: crop, seedbed_id: legacy, field_id: f1, occurred_on: '2026-10-02', qty: 10 })
    const p = profitability(o, crop)
    expect(p).toMatchObject({ seedling_cost: 0, allocated_cost: 400 }); expect(sumFull(p) + p.unallocated_cost).toBe(400)
  })
  it('cross-season crop season: transfer_in is not in the pool; full_cost sums to total_cost', () => {
    cost(400, open, sbSeason); db.insert('cost_entries', { tenant_id: o.tenantId, farm_id: o.farmId, season_id: crop, category: 'overhead', amount: 60, occurred_on: '2026-11-01', seedbed_id: null, field_id: null, tray_id: null, source_type: 'test', source_id: null, note: null })
    harvest(f1, crop); harvest(f2, crop); crossTp(100, f1)
    const p = profitability(o, crop)
    expect(p).toMatchObject({ total_cost: 160, transfer_in: 100, field_cost: 100, shared_cost: 60, allocated_cost: 60, unallocated_cost: 0 })
    expect(p.by_field.map(f => [f.field_no, f.full_cost])).toEqual([['F1', 120], ['F2', 40]])
    expect(sumFull(p) + p.unallocated_cost).toBe(p.total_cost)
    expect(profitability(o, sbSeason)).toMatchObject({ total_cost: 400, allocated_cost: 0, unallocated_cost: 400 })
  })
  it('a season with no transplants keeps its pre-change numbers', () => {
    fieldCost(70, f1, other); cost(30, legacy, other); harvest(f1, other); harvest(f2, other)
    const p = profitability(o, other)
    expect(p).toMatchObject({ total_cost: 100, field_cost: 70, shared_cost: 30, allocated_cost: 30, unallocated_cost: 0, seedling_cost: 0, transfer_in: 0 })
    expect(p.by_field.map(f => [f.field_no, f.field_cost, f.allocated_cost, f.full_cost, f.cost_per_ha])).toEqual([['F1', 70, 10, 80, 70], ['F2', 0, 20, 20, 0]])
    expect(seasonComparison(o).find(r => r.season_id === other)).toMatchObject({ total_cost: 100, transfer_in: 0 })
  })
  it('seasonComparison exposes transfer_in for the crop season', () => {
    cost(400, open, sbSeason); crossTp(100)
    expect(seasonComparison(o).find(r => r.season_id === crop)).toMatchObject({ total_cost: 100, transfer_in: 100 })
  })
})
