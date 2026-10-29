import { describe, it, expect, beforeEach } from 'vitest'
import { Db, MemoryPersistence } from '../db/database'
import { initialiseFarm, login } from './setup'
import { type Ctx } from './context'
import { createSeason } from './seasons'
import { createSeedbed } from './seedbeds'
import { createField } from './fields'
import { saveTrayType } from './traytypes'
import { createTray, updateTray, deleteTray } from './trays'
import { seedbedUnitCosts, costPerSeedling } from './seedlingcost'

let db: Db; let o: Ctx; let season: string; let bay: string; let open: string; let tt: string; let field: string
beforeEach(async () => {
  db = await Db.open(new MemoryPersistence())
  await initialiseFarm(db, { tenantName: 'T', farmName: 'F', ownerName: 'Lovemore', ownerPin: '1234' })
  o = { db, ...(await login(db, 'Lovemore', '1234')).ctx! }
  season = createSeason(o, { label: '2026/27', starts_on: '2026-09-01', ends_on: '2027-08-31', activate: true })
  bay = createSeedbed(o, { season_id: season, code: 'BAY1', kind: 'float_bay' })
  open = createSeedbed(o, { season_id: season, code: 'OB1', bed_length_m: 10, bed_width_m: 1, bed_count: 1 })
  tt = saveTrayType(o, { name: '200-cell', cells: 200, length_mm: null, width_mm: null, media: null, note: null })
  field = createField(o, { field_no: 'F1', area_ha: 1 } as never)
})
const tray = (n: number | undefined) => createTray(o, { seedbed_id: bay, tray_type_id: tt, ...(n === undefined ? {} : { actual_seedlings: n }) })
const cost = (amount: number, on: string, extra: { seedbed?: string; tray?: string | null; field?: string | null } = {}) => db.insert('cost_entries', {
  tenant_id: o.tenantId, farm_id: o.farmId, season_id: season, category: 'labour', amount, occurred_on: on, seedbed_id: extra.seedbed ?? bay,
  field_id: extra.field ?? null, tray_id: extra.tray ?? null, source_type: 'test', source_id: null, note: null })
const units = (ctx = o, asOf?: string) => seedbedUnitCosts(ctx, bay, asOf)
const noCostView = () => ({ ...o, perms: new Set(['production.seedbed.view']) }) as Ctx

describe('seedling cost', () => {
  it('splits bay cost 300.00 over 100/200 seedlings, 1.00 each', () => {
    tray(100); tray(200); cost(300, '2026-10-01')
    const u = units()
    expect(u.map(x => [x.unit, x.code, x.seedlings, x.cost, x.per_seedling, x.pending])).toEqual([['tray', 'T-001', 100, 100, 1, false], ['tray', 'T-002', 200, 200, 1, false]])
  })
  it('cents sum exactly: 100.00 over three equal trays', () => {
    tray(50); tray(50); tray(50); cost(100, '2026-10-01')
    const c = units().map(x => x.cost!)
    expect(c).toEqual([33.34, 33.33, 33.33]); expect(Math.round(c.reduce((a, b) => a + b, 0) * 100)).toBe(10000)
    expect(units()[0].per_seedling).toBe(0.6668)
  })
  it('tray-only cost stays on that tray', () => {
    const a = tray(100); tray(100); cost(40, '2026-10-01', { tray: a })
    const u = units(); expect(u.map(x => x.cost)).toEqual([40, 0]); expect(u[0].per_seedling).toBe(0.4); expect(u[1].per_seedling).toBe(0)
  })
  it('own cost plus share of bay cost', () => {
    const a = tray(100); tray(100); cost(40, '2026-10-01', { tray: a }); cost(100, '2026-10-02')
    expect(units().map(x => x.cost)).toEqual([90, 50])
  })
  it('asOf excludes later entries; no asOf includes all', () => {
    tray(100); cost(10, '2026-10-01'); cost(5, '2026-10-10')
    expect(units(o, '2026-10-05')[0].cost).toBe(10); expect(units(o, '2026-10-10')[0].cost).toBe(15); expect(units()[0].cost).toBe(15)
  })
  it('deleted cost entries are excluded', () => {
    tray(100); const id = cost(10, '2026-10-01'); cost(5, '2026-10-02'); db.softDelete('cost_entries', id)
    expect(units()[0].cost).toBe(5)
  })
  it('removed trays take no share and are not listed', () => {
    tray(100); const b = tray(100); cost(100, '2026-10-01'); deleteTray(o, b)
    const u = units(); expect(u).toHaveLength(1); expect(u[0].cost).toBe(100)
  })
  it('transplant labour (entry with field_id) is not seedbed cost', () => {
    tray(100); cost(10, '2026-10-01'); cost(99, '2026-10-02', { field })
    expect(units()[0].cost).toBe(10)
  })
  it('zero-seedling tray: no cost -> not pending; own cost -> pending; gets no share', () => {
    const z = tray(0); tray(100); cost(60, '2026-10-01')
    let u = units(); expect(u[0]).toMatchObject({ seedlings: 0, cost: 0, per_seedling: null, pending: false }); expect(u[1].cost).toBe(60)
    cost(7, '2026-10-02', { tray: z })
    u = units(); expect(u[0]).toMatchObject({ cost: 7, per_seedling: null, pending: true })
  })
  it('no tray counted: every tray pending with null per seedling; uncounted tray without own cost is not pending when others are counted', () => {
    tray(undefined); tray(undefined); cost(80, '2026-10-01')
    let u = units(); expect(u.every(x => x.pending && x.per_seedling === null && x.seedlings === null)).toBe(true)
    expect(costPerSeedling(o, { seedbed_id: bay }, '2026-12-01')).toEqual({ per_seedling: null, pending: true })
    expect(costPerSeedling(o, { seedbed_id: bay, tray_id: u[0].id }, '2026-12-01')).toEqual({ per_seedling: null, pending: true })
    const c = tray(100); u = units(); expect(u.find(x => x.id === c)).toMatchObject({ cost: 80, per_seedling: 0.8, pending: false })
    expect(u.filter(x => x.id !== c).every(x => x.cost === 0 && !x.pending && x.per_seedling === null)).toBe(true)
  })
  it('uncounted tray with own cost is pending and gets no share', () => {
    const a = tray(undefined); tray(100); cost(10, '2026-10-01', { tray: a }); cost(50, '2026-10-02')
    const u = units(); expect(u[0]).toMatchObject({ cost: 10, per_seedling: null, pending: true }); expect(u[1]).toMatchObject({ cost: 50, per_seedling: 0.5 })
  })
  it('changing a tray count recomputes (nothing stored)', () => {
    const a = tray(100); tray(100); cost(100, '2026-10-01')
    expect(units().map(x => x.cost)).toEqual([50, 50])
    updateTray(o, a, { actual_seedlings: 300 })
    expect(units().map(x => x.cost)).toEqual([75, 25])
  })
  it('without finance.cost.view money is null but seedlings still show', () => {
    tray(100); cost(10, '2026-10-01')
    const u = units(noCostView()); expect(u[0]).toMatchObject({ seedlings: 100, cost: null, per_seedling: null })
    expect(costPerSeedling(noCostView(), { seedbed_id: bay }, '2026-12-01').per_seedling).toBeNull()
  })
  it('requires seedbed view', () => {
    expect(() => units({ ...o, perms: new Set() } as Ctx)).toThrow(/Permission denied/)
  })
  it('open bed: one unit "bed" using its own count', () => {
    db.update('seedbeds', open, { actual_seedlings: 400 }); cost(100, '2026-10-01', { seedbed: open }); cost(1, '2026-10-02', { seedbed: open, field })
    const u = seedbedUnitCosts(o, open)
    expect(u).toEqual([{ unit: 'bed', id: open, code: 'OB1', seedlings: 400, cost: 100, per_seedling: 0.25, pending: false }])
    expect(costPerSeedling(o, { seedbed_id: open }, '2026-12-01')).toEqual({ per_seedling: 0.25, pending: false })
    expect(costPerSeedling(o, { seedbed_id: open }, '2026-10-01').per_seedling).toBe(0.25)
  })
  it('open bed without a count is pending', () => {
    cost(100, '2026-10-01', { seedbed: open })
    expect(seedbedUnitCosts(o, open)[0]).toMatchObject({ seedlings: null, cost: 100, per_seedling: null, pending: true })
  })
  it('costPerSeedling for a tray, and for a bay without tray_id (bay total / summed seedlings)', () => {
    const a = tray(100); tray(300); cost(20, '2026-10-01', { tray: a }); cost(80, '2026-10-02')
    expect(costPerSeedling(o, { seedbed_id: bay, tray_id: a }, '2026-12-01')).toEqual({ per_seedling: 0.4, pending: false })
    expect(costPerSeedling(o, { seedbed_id: bay }, '2026-12-01')).toEqual({ per_seedling: 0.25, pending: false })
    expect(costPerSeedling(o, { seedbed_id: bay, tray_id: a }, '2026-10-01')).toEqual({ per_seedling: 0.2, pending: false })
  })
  it('unknown seedbed or foreign tray is refused', () => {
    expect(() => seedbedUnitCosts(o, 'nope')).toThrow(/Seedbed not found/)
    expect(() => costPerSeedling(o, { seedbed_id: bay, tray_id: 'nope' }, '2026-12-01')).toThrow(/Tray not found/)
  })
})
