import { describe, it, expect, beforeEach } from 'vitest'
import { Db, MemoryPersistence } from '../db/database'
import { initialiseFarm, login, createUser } from './setup'
import { type Ctx, PermissionError } from './context'
import { createSeason } from './seasons'
import { createField } from './fields'
import { recordHarvest } from './harvest'
import { createBarn, createCycle, setCheck, loadCycle, offloadCycle, CHECKLIST_ITEMS } from './curing'
import { createStorageUnit, openStorageUnit } from './storage'
import { saveGrade, createGrading, listGrading, createBales } from './quality'
import { createSale } from './marketing'
import { createBuyer } from './buyers'
import { recordLabour } from './labour'
import { createMachine, logMachine } from './machinery'
import { recordWeather } from './weather'
import { createRole } from './roles'
import { locate, recordHref } from './links'
import { fieldRecord } from './fieldrecord'
import { recordNote } from './activity'
import { createInput } from './inventory'
import { setBudget } from './analytics'

let db: Db; let owner: Ctx; let s1: string; let s2: string; let f4: string; let f7: string; let bales: string[]
async function ctxFor(name: string, pin: string): Promise<Ctx> { const r = await login(db, name, pin); if (!r.ok) throw new Error(r.reason); return { db, ...r.ctx! } }

beforeEach(async () => {
  db = await Db.open(new MemoryPersistence())
  await initialiseFarm(db, { tenantName: 'T', farmName: 'F', ownerName: 'Lovemore', ownerPin: '1234' })
  owner = await ctxFor('Lovemore', '1234')
  s1 = createSeason(owner, { label: '2025/26', starts_on: '2025-09-01', ends_on: '2026-08-31' })
  s2 = createSeason(owner, { label: '2026/27', starts_on: '2026-09-01', ends_on: '2027-08-31', activate: true })
  f4 = createField(owner, { field_no: 'F-04', area_ha: 4 }); f7 = createField(owner, { field_no: 'F-07', area_ha: 2 })
  const h = recordHarvest(owner, { field_id: f4, season_id: s1, harvested_on: '2026-01-20', green_weight_kg: 2000, labour_cost: 40 })
  recordHarvest(owner, { field_id: f7, season_id: s1, harvested_on: '2026-01-21', green_weight_kg: 500 })
  const { id: cycle } = createCycle(owner, { barn_id: createBarn(owner, { capacity_kg: 6000 }), season_id: s1 })
  for (const i of CHECKLIST_ITEMS) setCheck(owner, cycle, i, true, '2026-01-21')
  loadCycle(owner, { cycle_id: cycle, batch_ids: [h.id], loaded_at: '2026-01-22T08:00' })
  offloadCycle(owner, { cycle_id: cycle, offloaded_at: '2026-01-28T08:00', cured_weight_kg: 300 })
  const unit = createStorageUnit(owner, { cycle_id: cycle, kind: 'pile', weight_kg: 300, created_on: '2026-01-30', maturity_days: 30 }).id
  openStorageUnit(owner, unit, '2026-03-05')
  createGrading(owner, { storage_unit_id: unit, graded_on: '2026-03-06', outputs: [{ grade_id: saveGrade(owner, { code: 'A', sort_order: 1 }), weight_kg: 300 }] })
  bales = createBales(owner, { output_id: listGrading(owner)[0].outputs[0].id, baled_on: '2026-03-08', weights: [100, 100] })
  const buyer = createBuyer(owner, { name: 'Boka Floors', kind: 'auction_floor' })
  const baleIds = db.all<{ id: string }>(`SELECT id FROM bales ORDER BY code`).map(b => b.id)
  createSale(owner, { season_id: s1, sold_on: '2026-04-01', channel: 'auction', buyer: 'Boka Floors', buyer_id: buyer, lines: [{ bale_id: baleIds[0], price_per_kg: 3 }], deductions: [] })
  recordLabour(owner, { season_id: s1, field_id: f4, worked_on: '2026-01-10', worker_name: 'Tendai', task: 'weeding', hours: 8, pay_amount: 10 })
  recordLabour(owner, { season_id: s1, field_id: f7, worked_on: '2026-01-10', worker_name: 'Rudo', task: 'weeding', hours: 8 })
  logMachine(owner, { machine_id: createMachine(owner, { name: 'MF 375', hourly_rate: 5 }), season_id: s1, kind: 'use', logged_on: '2026-01-12', field_id: f4, hours: 2 })
  recordWeather(owner, { season_id: s1, field_id: f4, recorded_on: '2026-01-05', rainfall_mm: 20 })
  recordWeather(owner, { season_id: s1, recorded_on: '2026-01-06', rainfall_mm: 5 })              // farm-wide: counts for every field
  recordWeather(owner, { season_id: s1, field_id: f7, recorded_on: '2026-01-07', rainfall_mm: 99 })  // another field: never counted on F-04
})

describe('record links', () => {
  it('finds a record by its visible code, with the season it belongs to', () => {
    expect(locate(owner, 'harvest', 'H-00001')).toMatchObject({ season_id: s1 })
    expect(locate(owner, 'bale', bales[0])).toMatchObject({ season_id: s1 })
    expect(locate(owner, 'sale', 'ML-00001')).toMatchObject({ season_id: s1 })
    expect(locate(owner, 'buyer', 'boka floors')).toMatchObject({ season_id: null })
    expect(locate(owner, 'field', 'F-04')).toEqual({ id: f4, season_id: null })
    expect(locate(owner, 'harvest', 'H-99999')).toBeNull(); expect(locate(owner, 'harvest', '')).toBeNull()
    expect(recordHref('field', 'F 04/a')).toBe('/fields/F%2004%2Fa'); expect(recordHref('cycle', 'C-00001')).toBe('/curing?focus=C-00001')
  })
  it('finds machines by id, inputs across the tenant by name, and a budget line within a given season', () => {
    const m = db.get<{ id: string }>(`SELECT id FROM machines`)!.id
    expect(locate(owner, 'machine', m)).toEqual({ id: m, season_id: null }); expect(locate(owner, 'machine', 'MF 375')).toBeNull()
    createInput(owner, { name: 'Compound C', category: 'fertilizer', unit: 'kg' }); expect(locate(owner, 'input', 'Compound C')).not.toBeNull()
    setBudget(owner, s1, 'labour', 10); setBudget(owner, s2, 'labour', 20)
    expect(locate(owner, 'budget', 'labour', s2)).toMatchObject({ season_id: s2 }); expect(locate(owner, 'budget', 'labour', s1)).toMatchObject({ season_id: s1 })
    expect(recordHref('budget', 'labour', s2)).toBe(`/budgets?focus=labour&season=${s2}`)
  })
  it('never finds a record the reader may not open', async () => {
    const role = createRole(owner, 'Scout', ['production.field.view'])
    await createUser(owner, 'Scout', '5555', role); const scout = await ctxFor('Scout', '5555')
    expect(locate(scout, 'field', 'F-04')).not.toBeNull()
    expect(locate(scout, 'sale', 'ML-00001')).toBeNull(); expect(locate(scout, 'harvest', 'H-00001')).toBeNull()
  })
})

describe('field record', () => {
  it('gathers every module for one field and season, and nothing from other fields', () => {
    const r = fieldRecord(owner, 'F-04', s1)
    expect(r.harvests!.map(h => h.code)).toEqual(['H-00001']); expect(r.harvests![0].cycle_code).toBe('C-00001')
    expect(r.bales!.map(b => b.code).sort()).toEqual(bales); expect(r.bales!.find(b => b.code === bales[0])!.sale_code).toBe('ML-00001')
    expect(r.labour!.map(l => l.worker_name)).toEqual(['Tendai']); expect(r.machine).toHaveLength(1)
    expect(r.weather!.map(w => w.rainfall_mm).sort()).toEqual([20, 5])
    expect(r.totals).toMatchObject({ green_kg: 2000, green_kg_per_ha: 500, rain_mm: 25, sold_kg: 100, net_revenue: 300 })
    expect(r.costs!.reduce((s, c) => s + c.amount, 0)).toBe(r.totals.cost)
    expect(r.totals.cost).toBe(60)   // harvest labour 40 + labour pay 10 + 2 h machine at 5
  })
  it('keeps seasons apart', () => {
    const r = fieldRecord(owner, 'F-04', s2)
    expect(r.harvests).toEqual([]); expect(r.labour).toEqual([]); expect(r.weather).toEqual([]); expect(r.totals).toMatchObject({ green_kg: 0, cost: 0, sold_kg: 0 })
  })
  it('leaves out what the role cannot see, and money without finance access', async () => {
    const role = createRole(owner, 'Scout', ['production.field.view', 'production.harvest.view', 'production.weather.view'])
    await createUser(owner, 'Scout', '5555', role); const scout = await ctxFor('Scout', '5555')
    const r = fieldRecord(scout, 'F-04', s1)
    expect(r.harvests).toHaveLength(1); expect(r.harvests![0].labour_cost).toBeNull()
    expect(r.labour).toBeNull(); expect(r.bales).toBeNull(); expect(r.costs).toBeNull(); expect(r.contracts).toBeNull()
    expect(r.totals).toMatchObject({ cost: null, net_revenue: null, sold_kg: null, full_margin: null, rain_mm: 25 })
  })
  it('shows revenue and margin only to people who hold the finance permissions', async () => {
    expect(fieldRecord(owner, 'F-04', s1).totals.full_margin).not.toBeNull()
    const role = createRole(owner, 'Seller', ['production.field.view', 'quality.bale.view', 'marketing.sale.view'])
    await createUser(owner, 'Seller', '5555', role); const seller = await ctxFor('Seller', '5555')
    const r = fieldRecord(seller, 'F-04', s1)
    expect(r.totals).toMatchObject({ sold_kg: 100, net_revenue: null, full_margin: null, shared_cost: null, cost: null })
    expect(r.bales!.find(b => b.code === bales[0])!.sale_code).toBe('ML-00001')   // which sale is not money; the price is
  })
  it('reads the field’s activity through accessFilter: all of it for the owner, only their own for an own-activity role', async () => {
    const all = fieldRecord(owner, 'F-04', s1).activity!
    expect(all.map(a => a.summary)).toEqual(expect.arrayContaining([expect.stringMatching(/^Recorded harvest batch H-00001/), expect.stringMatching(/^Recorded labour entry Tendai/)]))
    expect(all.some(a => /Rudo/.test(a.summary))).toBe(false)   // Rudo worked on F-07
    const role = createRole(owner, 'Diarist', ['production.field.view', 'brain.log.view_own', 'brain.note.record'])
    await createUser(owner, 'Diarist', '5555', role); const diarist = await ctxFor('Diarist', '5555')
    recordNote(diarist, { text: 'Hail damage on the lower rows', field_id: f4, season_id: s1 })
    expect(fieldRecord(diarist, 'F-04', s1).activity!.map(a => a.summary)).toEqual(['Hail damage on the lower rows'])
    const blind = createRole(owner, 'Blind', ['production.field.view'])
    await createUser(owner, 'Blind', '6666', blind); expect(fieldRecord(await ctxFor('Blind', '6666'), 'F-04', s1).activity).toBeNull()
  })
  it('needs field access and an existing field', async () => {
    const role = createRole(owner, 'Nobody', ['production.harvest.view'])
    await createUser(owner, 'Nobody', '5555', role); const nobody = await ctxFor('Nobody', '5555')
    expect(() => fieldRecord(nobody, 'F-04', s1)).toThrow(PermissionError)
    expect(() => fieldRecord(owner, 'F-99', s1)).toThrow(/No field F-99/)
  })
})
