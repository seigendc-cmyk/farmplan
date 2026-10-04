import { describe, it, expect, beforeEach } from 'vitest'
import { Db, MemoryPersistence } from '../db/database'
import { initialiseFarm, login } from './setup'
import { type Ctx, PermissionError } from './context'
import { createSeason } from './seasons'
import { createField } from './fields'
import { recordHarvest } from './harvest'
import { addCost } from './util'
import { profitability } from './analytics'
import { allocatedCosts, listAllocationRules, setAllocationRule, splitByWeight } from './allocation'

let db: Db; let o: Ctx; let season: string; let f1: string; let f2: string
const shared = (category: string, amount: number) => addCost(o, { seasonId: season, category, amount, on: '2027-02-01', sourceType: 'manual', sourceId: `s-${category}-${amount}` })

beforeEach(async () => {
  db = await Db.open(new MemoryPersistence())
  await initialiseFarm(db, { tenantName: 'T', farmName: 'F', ownerName: 'Lovemore', ownerPin: '1234' })
  const r = await login(db, 'Lovemore', '1234'); o = { db, ...r.ctx! }
  season = createSeason(o, { label: '2026/27', starts_on: '2026-09-01', ends_on: '2027-08-31', activate: true })
  f1 = createField(o, { field_no: 'F-01', area_ha: 4 }); f2 = createField(o, { field_no: 'F-02', area_ha: 2 })
  recordHarvest(o, { field_id: f1, season_id: season, harvested_on: '2027-01-20', green_weight_kg: 2000 }); recordHarvest(o, { field_id: f2, season_id: season, harvested_on: '2027-01-21', green_weight_kg: 800 })
})

describe('splitByWeight', () => {
  it('always sums exactly, giving leftover cents to the largest remainders', () => {
    const p = splitByWeight(10, [1, 1, 1]); expect(p).toEqual([3.34, 3.33, 3.33]); expect(p.reduce((s, v) => s + v, 0)).toBeCloseTo(10, 10)
    expect(splitByWeight(100, [0, 0])).toEqual([0, 0]); expect(splitByWeight(30, [4, 2])).toEqual([20, 10])
  })
})

describe('shared-cost allocation', () => {
  it('uses sensible defaults per category', () => {
    const r = Object.fromEntries(listAllocationRules(o).map(x => [x.category, x.basis])); expect(r).toMatchObject({ curing: 'green_kg', grading: 'sold_kg', overhead: 'area', labour: 'area' })
    expect(listAllocationRules(o).every(x => x.is_default)).toBe(true)
  })
  it('spreads by area, green kg, and falls back when nothing is sold', () => {
    shared('overhead', 30); shared('curing', 28)
    const a = allocatedCosts(o, season); const by = (id: string) => a.by_field.get(id)
    expect(by(f1)).toBe(20 + 20); expect(by(f2)).toBe(10 + 8); expect(a.allocated).toBe(58); expect(a.unallocated).toBe(0)
  })
  it('puts sold-kg costs in unallocated until something is sold', () => {
    shared('grading', 40); const a = allocatedCosts(o, season)
    expect(a.allocated).toBe(0); expect(a.unallocated).toBe(40); expect(a.lines[0]).toMatchObject({ category: 'grading', basis: 'sold_kg', unallocated: 40 })
  })
  it('honours overrides, "none" and resetting to default', () => {
    shared('overhead', 30); setAllocationRule(o, 'overhead', 'green_kg')
    expect(allocatedCosts(o, season).by_field.get(f1)).toBe(21.43); expect(listAllocationRules(o).find(r => r.category === 'overhead')).toMatchObject({ basis: 'green_kg', is_default: false })
    setAllocationRule(o, 'overhead', 'none'); expect(allocatedCosts(o, season)).toMatchObject({ allocated: 0, unallocated: 30 })
    setAllocationRule(o, 'overhead', null); expect(allocatedCosts(o, season).allocated).toBe(30); expect(listAllocationRules(o).find(r => r.category === 'overhead')!.is_default).toBe(true)
  })
  it('never touches costs already recorded against a field', () => {
    addCost(o, { seasonId: season, category: 'overhead', amount: 50, on: '2027-02-01', sourceType: 'manual', sourceId: 'x', fieldId: f1 }); expect(allocatedCosts(o, season).allocated).toBe(0)
  })
  it('flows into profitability without altering totals', () => {
    shared('overhead', 30); addCost(o, { seasonId: season, category: 'seed', amount: 100, on: '2026-10-01', sourceType: 'manual', sourceId: 'd', fieldId: f1 })
    const p = profitability(o, season); const f = Object.fromEntries(p.by_field.map(x => [x.field_no, x]))
    expect(p).toMatchObject({ total_cost: 130, field_cost: 100, shared_cost: 30, allocated_cost: 30, unallocated_cost: 0 })
    expect(f['F-01']).toMatchObject({ field_cost: 100, allocated_cost: 20, full_cost: 120, full_cost_per_ha: 30 }); expect(f['F-02']).toMatchObject({ field_cost: 0, allocated_cost: 10, full_cost: 10 })
    expect(p.by_field.reduce((s, x) => s + x.full_cost, 0)).toBe(130)
  })
  it('needs finance.budget.edit to change rules', () => {
    expect(() => setAllocationRule({ ...o, perms: new Set(['finance.budget.view']) }, 'overhead', 'area')).toThrow(PermissionError)
    expect(() => setAllocationRule(o, 'bogus', 'area')).toThrow(/Unknown cost category/)
    expect(() => listAllocationRules({ ...o, perms: new Set(['finance.cost.view']) })).toThrow(PermissionError)
  })
})
