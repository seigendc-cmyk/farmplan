import { describe, it, expect, beforeEach } from 'vitest'
import { Db, MemoryPersistence } from '../db/database'
import { initialiseFarm, login } from './setup'
import { type Ctx } from './context'
import { createSeason } from './seasons'
import { createSeedbed } from './seedbeds'
import { createField } from './fields'
import { saveTrayType } from './traytypes'
import { createTray } from './trays'
import { recordTransplant, deleteTransplant, listTransplants, plantingByField } from './transplants'
import { seedlingCostByField, seedbedLoss } from './seedlingcost'

let db: Db; let o: Ctx; let crop: string; let sbSeason: string; let open: string; let bay: string; let tt: string; let f1: string; let f2: string
beforeEach(async () => {
  db = await Db.open(new MemoryPersistence())
  await initialiseFarm(db, { tenantName: 'T', farmName: 'F', ownerName: 'Lovemore', ownerPin: '1234' })
  o = { db, ...(await login(db, 'Lovemore', '1234')).ctx! }
  db.run(`UPDATE farms SET modules=? WHERE id=?`, ['tobacco,seedbed', o.farmId])
  crop = createSeason(o, { label: '2026/27', starts_on: '2026-09-01', ends_on: '2027-08-31', activate: true })
  sbSeason = createSeason(o, { label: 'SB 2026', starts_on: '2026-08-01', ends_on: '2026-11-30', enterprise: 'seedbed' })
  open = createSeedbed(o, { season_id: sbSeason, code: 'OB1', bed_length_m: 10, bed_width_m: 1, bed_count: 1, actual_seedlings: 400 })
  bay = createSeedbed(o, { season_id: sbSeason, code: 'BAY1', kind: 'float_bay' })
  tt = saveTrayType(o, { name: '200-cell', cells: 200, length_mm: null, width_mm: null, media: null, note: null })
  f1 = createField(o, { field_no: 'F1', area_ha: 1 } as never); f2 = createField(o, { field_no: 'F2', area_ha: 2 } as never)
})
const cost = (amount: number, on: string, bed = open, tray: string | null = null, season = sbSeason) => db.insert('cost_entries', {
  tenant_id: o.tenantId, farm_id: o.farmId, season_id: season, category: 'labour', amount, occurred_on: on, seedbed_id: bed, field_id: null, tray_id: tray,
  source_type: 'test', source_id: null, note: null })
const tp = (extra: object = {}) => recordTransplant(o, { seedbed_id: open, field_id: f1, occurred_on: '2026-10-02', qty: 100, crop_season_id: crop, ...extra } as never)
const noCost = () => ({ ...o, perms: new Set(['production.transplant.view', 'production.seedbed.view']) }) as Ctx

describe('cross-season transplant rules', () => {
  it('a seedbed-module bed requires a crop season', () => {
    expect(() => tp({ crop_season_id: undefined })).toThrow(/crop season/i)
  })
  it('refuses a crop season that is itself a seedbed season, is closed, or is unknown; and a closed source season', () => {
    expect(() => tp({ crop_season_id: sbSeason })).toThrow(/crop season/i)
    expect(() => tp({ crop_season_id: 'nope' })).toThrow(/Season not found/)
    db.run(`UPDATE seasons SET status='closed' WHERE id=?`, [crop]); expect(() => tp()).toThrow(/closed/)
    db.run(`UPDATE seasons SET status='active' WHERE id=?`, [crop]); db.run(`UPDATE seasons SET status='closed' WHERE id=?`, [sbSeason]); expect(() => tp()).toThrow(/closed/)
  })
  it('refuses an unknown field and an over-the-bed quantity', () => {
    expect(() => tp({ field_id: 'nope' })).toThrow(/Field not found/)
    expect(() => tp({ qty: 401 })).toThrow(/Only 400/)
  })
  it('stores crop_season_id and books labour on the crop season', () => {
    const id = tp({ labour_cost: 25 })
    expect(db.get(`SELECT crop_season_id, tray_id, season_id FROM transplants WHERE id=?`, [id])).toMatchObject({ crop_season_id: crop, tray_id: null, season_id: sbSeason })
    expect(db.get<{ season_id: string; field_id: string }>(`SELECT season_id, field_id FROM cost_entries WHERE source_id=?`, [id])).toMatchObject({ season_id: crop, field_id: f1 })
  })
  it('a legacy (tobacco-season) bed works as before: no crop season stored, labour on the bed season', () => {
    const lb = createSeedbed(o, { season_id: crop, code: 'LB', bed_length_m: 10, bed_width_m: 1, bed_count: 1, actual_seedlings: 50 })
    const id = recordTransplant(o, { seedbed_id: lb, field_id: f1, occurred_on: '2026-10-02', qty: 10, labour_cost: 5, crop_season_id: sbSeason } as never)
    expect(db.get(`SELECT crop_season_id, tray_id FROM transplants WHERE id=?`, [id])).toMatchObject({ crop_season_id: null, tray_id: null })
    expect(db.get<{ season_id: string }>(`SELECT season_id FROM cost_entries WHERE source_id=?`, [id])!.season_id).toBe(crop)
    expect(seedlingCostByField(o, crop)).toEqual([])
  })
  it('a bed without counts is still refused', () => {
    const b = createSeedbed(o, { season_id: sbSeason, code: 'OB2', bed_length_m: 10, bed_width_m: 1, bed_count: 1 })
    expect(() => tp({ seedbed_id: b })).toThrow(/actual seedlings/)
  })
  it('closed seasons also block deleting', () => {
    const id = tp(); db.run(`UPDATE seasons SET status='closed' WHERE id=?`, [crop]); expect(() => deleteTransplant(o, id)).toThrow(/closed/)
  })
})

describe('float bay transplants', () => {
  it('requires a tray, one of this bay, with counts; open beds refuse a tray', () => {
    const t = createTray(o, { seedbed_id: bay, tray_type_id: tt, actual_seedlings: 100 }); const uncounted = createTray(o, { seedbed_id: bay, tray_type_id: tt })
    expect(() => tp({ seedbed_id: bay })).toThrow(/tray/i)
    expect(() => tp({ seedbed_id: bay, tray_id: uncounted })).toThrow(/actual seedlings/)
    expect(() => tp({ seedbed_id: bay, tray_id: 'nope' })).toThrow(/Tray not found/)
    expect(() => tp({ tray_id: t })).toThrow(/tray/i)
  })
  it('caps at the tray remaining seedlings, including earlier transplants and gap-fill', () => {
    const a = createTray(o, { seedbed_id: bay, tray_type_id: tt, actual_seedlings: 100 }); const b = createTray(o, { seedbed_id: bay, tray_type_id: tt, actual_seedlings: 100 })
    const id = tp({ seedbed_id: bay, tray_id: a, qty: 60 })
    expect(db.get(`SELECT tray_id, crop_season_id FROM transplants WHERE id=?`, [id])).toMatchObject({ tray_id: a, crop_season_id: crop })
    expect(() => tp({ seedbed_id: bay, tray_id: a, qty: 41 })).toThrow(/Only 40/)
    tp({ seedbed_id: bay, tray_id: a, qty: 40, kind: 'gap_fill' }); expect(() => tp({ seedbed_id: bay, tray_id: a, qty: 1 })).toThrow(/Only 0/)
    tp({ seedbed_id: bay, tray_id: b, qty: 100 })
    deleteTransplant(o, id); tp({ seedbed_id: bay, tray_id: a, qty: 60 })
  })
  it('tray cost is attributed from that tray: 100 seedlings at 1.00 and 100 at 3.00', () => {
    const a = createTray(o, { seedbed_id: bay, tray_type_id: tt, actual_seedlings: 100 }); const b = createTray(o, { seedbed_id: bay, tray_type_id: tt, actual_seedlings: 100 })
    cost(100, '2026-09-01', bay, a); cost(300, '2026-09-01', bay, b)
    tp({ seedbed_id: bay, tray_id: a, qty: 50 }); tp({ seedbed_id: bay, tray_id: b, qty: 50, field_id: f2 })
    expect(seedlingCostByField(o, crop)).toEqual([{ field_id: f1, seedlings: 50, amount: 50, pending: false }, { field_id: f2, seedlings: 50, amount: 150, pending: false }])
  })
})

describe('seedling cost attribution', () => {
  it('400 seedlings at 1.00 attribute 400.00 to the field (not via the 4 dp per_seedling)', () => {
    cost(400, '2026-09-01'); tp({ qty: 400 })
    expect(seedlingCostByField(o, crop)).toEqual([{ field_id: f1, seedlings: 400, amount: 400, pending: false }])
  })
  it('does not drift on a recurring rate: 100 over 300 seedlings, 300 planted gives exactly 100.00', () => {
    db.run(`UPDATE seedbeds SET actual_seedlings=300 WHERE id=?`, [open]); cost(100, '2026-09-01'); tp({ qty: 300 })
    expect(seedlingCostByField(o, crop)[0].amount).toBe(100)
  })
  it('groups by field; gap-fill uses the cost per seedling as of its own date', () => {
    cost(400, '2026-09-01'); tp({ qty: 100 }); tp({ field_id: f2, qty: 100, occurred_on: '2026-10-03' })
    cost(400, '2026-10-10'); tp({ qty: 50, kind: 'gap_fill', occurred_on: '2026-10-11' })
    expect(seedlingCostByField(o, crop)).toEqual([{ field_id: f1, seedlings: 150, amount: 200, pending: false }, { field_id: f2, seedlings: 100, amount: 100, pending: false }])
  })
  it('only counts transplants of the given crop season', () => {
    const other = createSeason(o, { label: '2027/28', starts_on: '2027-09-01', ends_on: '2028-08-31' })
    cost(400, '2026-09-01'); tp({ crop_season_id: other, qty: 40 }); tp({ qty: 10 })
    expect(seedlingCostByField(o, crop).map(r => r.seedlings)).toEqual([10]); expect(seedlingCostByField(o, other).map(r => r.seedlings)).toEqual([40])
  })
  it('a transplant whose source cost is pending gives null amount and pending true, not 0', () => {
    db.run(`UPDATE seedbeds SET actual_seedlings=NULL WHERE id=?`, [open]); cost(50, '2026-09-01')
    db.insert('transplants', { tenant_id: o.tenantId, farm_id: o.farmId, season_id: sbSeason, seedbed_id: open, field_id: f1, occurred_on: '2026-10-02', qty: 10, crop_season_id: crop })
    expect(seedlingCostByField(o, crop)).toEqual([{ field_id: f1, seedlings: 10, amount: null, pending: true }])
  })
  it('amount is null without finance.cost.view; seedlings still shown', () => {
    cost(400, '2026-09-01'); tp({ qty: 100 })
    expect(seedlingCostByField(noCost(), crop)).toEqual([{ field_id: f1, seedlings: 100, amount: null, pending: false }])
    expect(seedbedLoss(noCost(), open)).toBeNull()
  })
  it('deleting a transplant removes its attribution and labour cost', () => {
    cost(400, '2026-09-01'); const id = tp({ qty: 100, labour_cost: 20 })
    expect(seedlingCostByField(o, crop)[0].amount).toBe(100)
    deleteTransplant(o, id); expect(seedlingCostByField(o, crop)).toEqual([])
    expect(db.get(`SELECT 1 FROM cost_entries WHERE source_id=? AND deleted_at IS NULL`, [id])).toBeUndefined()
  })
  it('seedbedLoss = bed cost less attributed amounts; all of it when nothing is planted', () => {
    cost(400, '2026-09-01'); expect(seedbedLoss(o, open)).toBe(400)
    tp({ qty: 300 }); expect(seedbedLoss(o, open)).toBe(100)
    tp({ qty: 100 }); expect(seedbedLoss(o, open)).toBe(0)
  })
  it('transplant labour does not enter the bed cost or loss', () => {
    cost(400, '2026-09-01'); tp({ qty: 100, labour_cost: 50 }); expect(seedbedLoss(o, open)).toBe(300)
  })
})

describe('listing', () => {
  it('lists cross-season transplants under the crop season with source tray and crop season, and counts them in plantingByField', () => {
    const a = createTray(o, { seedbed_id: bay, tray_type_id: tt, actual_seedlings: 100 }); tp({ seedbed_id: bay, tray_id: a, qty: 20 })
    const rows = listTransplants(o, { seasonId: crop })
    expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ seedbed_code: 'BAY1', tray_code: 'T-001', crop_season_label: '2026/27', qty: 20 })
    expect(plantingByField(o, crop)).toMatchObject([{ field_no: 'F1', established: 20 }])
  })
  it('legacy rows show null tray and crop season', () => {
    const lb = createSeedbed(o, { season_id: crop, code: 'LB', bed_length_m: 10, bed_width_m: 1, bed_count: 1, actual_seedlings: 50 })
    recordTransplant(o, { seedbed_id: lb, field_id: f1, occurred_on: '2026-10-02', qty: 10 })
    expect(listTransplants(o, { seasonId: crop })[0]).toMatchObject({ tray_code: null, crop_season_label: null })
  })
})
