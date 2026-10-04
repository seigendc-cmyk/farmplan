import { describe, it, expect, beforeEach } from 'vitest'
import { Db, MemoryPersistence } from '../db/database'
import { initialiseFarm, login } from './setup'
import { type Ctx, PermissionError } from './context'
import { createSeason, setSeasonStatus } from './seasons'
import { createField } from './fields'
import { recordHarvest } from './harvest'
import { createBarn, createCycle, setCheck, loadCycle, offloadCycle, CHECKLIST_ITEMS } from './curing'
import { createStorageUnit, openStorageUnit } from './storage'
import { saveGrade, listGrades, createGrading, deleteGrading, listGrading, ungradedUnits, gradeMix, createBales, deleteBale, listBales, baleLineage, unbaledOutputs, deleteGrade } from './quality'
import { createSale, recordPayment, deletePayment, deleteSale, listSales, saleDetail, revenueSummary } from './marketing'
import { seasonCostSummary } from './reports'
import { createUser } from './setup'
import { runMigrations } from '../db/migrations'

let db: Db; let owner: Ctx; let season: string; let unit: string; let A: string; let B: string; let W: string
async function ctxFor(name: string, pin: string): Promise<Ctx> { const r = await login(db, name, pin); if (!r.ok) throw new Error(r.reason); return { db, ...r.ctx! } }

beforeEach(async () => {
  db = await Db.open(new MemoryPersistence())
  await initialiseFarm(db, { tenantName: 'T', farmName: 'F', ownerName: 'Lovemore', ownerPin: '1234' })
  owner = await ctxFor('Lovemore', '1234')
  season = createSeason(owner, { label: '2026/27', starts_on: '2026-09-01', ends_on: '2027-08-31', activate: true })
  const f1 = createField(owner, { field_no: 'F-04', area_ha: 4, variety: 'KRK26' }); const f2 = createField(owner, { field_no: 'F-07', area_ha: 2, variety: 'T74' })
  const h1 = recordHarvest(owner, { field_id: f1, season_id: season, harvested_on: '2027-01-20', green_weight_kg: 2000 })
  const h2 = recordHarvest(owner, { field_id: f2, season_id: season, harvested_on: '2027-01-21', green_weight_kg: 800 })
  const barn = createBarn(owner, { capacity_kg: 6000 }); const { id: cycle } = createCycle(owner, { barn_id: barn, season_id: season })
  for (const i of CHECKLIST_ITEMS) setCheck(owner, cycle, i, true, '2027-01-21')
  loadCycle(owner, { cycle_id: cycle, batch_ids: [h1.id, h2.id], loaded_at: '2027-01-22T08:00' })
  offloadCycle(owner, { cycle_id: cycle, offloaded_at: '2027-01-28T08:00', cured_weight_kg: 400 })
  unit = createStorageUnit(owner, { cycle_id: cycle, kind: 'slate_pack', weight_kg: 320, created_on: '2027-01-30', maturity_days: 30 }).id
  openStorageUnit(owner, unit, '2027-03-05')
  A = saveGrade(owner, { code: 'A', sort_order: 1 }); B = saveGrade(owner, { code: 'B', sort_order: 2 }); W = saveGrade(owner, { code: 'C', sort_order: 3 })
})

describe('grade catalogue', () => {
  it('is data: unique codes, deactivation, no delete once used', () => {
    expect(() => saveGrade(owner, { code: 'A' })).toThrow(/already exists/)
    saveGrade(owner, { code: 'A', name: 'Top', sort_order: 0 }, A); expect(listGrades(owner)[0]).toMatchObject({ code: 'A', name: 'Top' })
    createGrading(owner, { storage_unit_id: unit, graded_on: '2027-03-06', outputs: [{ grade_id: A, weight_kg: 320 }] })
    expect(() => deleteGrade(owner, A)).toThrow(/already used/); deleteGrade(owner, W); expect(listGrades(owner)).toHaveLength(2)
  })
})

describe('grading', () => {
  it('checks input vs output, demands an explanation for variance, blocks double grading, books labour', () => {
    expect(ungradedUnits(owner)).toHaveLength(1)
    expect(() => createGrading(owner, { storage_unit_id: unit, graded_on: '2027-03-06', outputs: [{ grade_id: A, weight_kg: 80 }, { grade_id: B, weight_kg: 110 }] })).toThrow(/Explain the variance/)
    expect(() => createGrading(owner, { storage_unit_id: unit, graded_on: '2027-03-06', outputs: [{ grade_id: A, weight_kg: 300 }, { grade_id: B, weight_kg: 100 }] })).toThrow(/Explain the variance/)
    expect(() => createGrading(owner, { storage_unit_id: unit, graded_on: '2027-03-01', outputs: [{ grade_id: A, weight_kg: 320 }] })).toThrow(/precede opening/)
    expect(() => createGrading(owner, { storage_unit_id: unit, graded_on: '2027-03-06', outputs: [{ grade_id: A, weight_kg: 10 }, { grade_id: A, weight_kg: 10 }] })).toThrow(/twice/)
    const g = createGrading(owner, { storage_unit_id: unit, graded_on: '2027-03-06', grader: 'Tendai', labour_cost: 30,
      outputs: [{ grade_id: A, weight_kg: 80 }, { grade_id: B, weight_kg: 110 }], waste_kg: 20, variance_note: 'Remaining 110 kg set aside as scrap, weighed later' })
    expect(g).toMatchObject({ code: 'G-00001', variance_kg: 110 })
    const row = listGrading(owner)[0]; expect(row).toMatchObject({ unit_code: 'SP-00001', variance_flag: true, input_kg: 320 }); expect(row.outputs).toHaveLength(2)
    expect(() => createGrading(owner, { storage_unit_id: unit, graded_on: '2027-03-07', outputs: [{ grade_id: A, weight_kg: 320 }] })).toThrow(/already been graded/)
    expect(seasonCostSummary(owner, season).total).toBe(30); expect(ungradedUnits(owner)).toHaveLength(0)
    expect(gradeMix(owner, season)).toMatchObject({ graded_input_kg: 320, waste_kg: 20, grades: [{ grade: 'A', kg: 80, pct: 25 }, { grade: 'B', kg: 110, pct: 34.38 }] })
    deleteGrading(owner, g.id); expect(seasonCostSummary(owner, season).total).toBe(0); expect(ungradedUnits(owner)).toHaveLength(1)
  })
  it('accepts a within-tolerance difference silently and rejects unopened units', () => {
    expect(createGrading(owner, { storage_unit_id: unit, graded_on: '2027-03-06', outputs: [{ grade_id: A, weight_kg: 200 }, { grade_id: B, weight_kg: 100 }], waste_kg: 15 }).variance_kg).toBe(5)
  })
})

describe('bales and lineage', () => {
  let outA: string; let outB: string
  beforeEach(() => {
    createGrading(owner, { storage_unit_id: unit, graded_on: '2027-03-06', outputs: [{ grade_id: A, weight_kg: 200 }, { grade_id: B, weight_kg: 120 }] })
    const o = listGrading(owner)[0].outputs; outA = o.find(x => x.grade === 'A')!.id; outB = o.find(x => x.grade === 'B')!.id
  })
  it('issues QR-ready codes with the dominant field, enforces weight, protects sold bales', () => {
    expect(() => createBales(owner, { output_id: outA, baled_on: '2027-03-01', weights: [50] })).toThrow(/precede grading/)
    const codes = createBales(owner, { output_id: outA, baled_on: '2027-03-08', weights: [100, 100] })
    expect(codes).toEqual(['TB26-F04-B000001', 'TB26-F04-B000002'])
    expect(() => createBales(owner, { output_id: outA, baled_on: '2027-03-08', weights: [1] })).toThrow(/left to bale/)
    expect(createBales(owner, { output_id: outB, baled_on: '2027-03-08', weights: [120] })).toEqual(['TB26-F04-B000003'])
    expect(unbaledOutputs(owner)).toHaveLength(0); expect(listGrading(owner)[0].baled_kg).toBe(320)
    const l = baleLineage(owner, codes[0].toLowerCase())
    expect(l).toMatchObject({ season: '2026/27', unit_code: 'SP-00001', cycle_code: 'C-00001', barn_code: 'B-01', lot_code: 'G-00001', fields: ['F-04', 'F-07'], bale: { grade: 'A', weight_kg: 100 } })
    expect(l.harvests.map(h => h.code)).toEqual(['H-00001', 'H-00002']); expect(() => baleLineage(owner, 'TB26-NOPE')).toThrow(/No bale/)
    expect(() => deleteGrading(owner, listGrading(owner)[0].id)).toThrow(/already has bales/)
    const b = listBales(owner, { status: 'baled' })[0]; deleteBale(owner, b.id); expect(unbaledOutputs(owner)).toHaveLength(1)
  })
})

describe('marketing', () => {
  let bales: { id: string; code: string; grade: string }[]
  beforeEach(() => {
    createGrading(owner, { storage_unit_id: unit, graded_on: '2027-03-06', outputs: [{ grade_id: A, weight_kg: 200 }, { grade_id: B, weight_kg: 120 }] })
    const o = listGrading(owner)[0].outputs
    createBales(owner, { output_id: o.find(x => x.grade === 'A')!.id, baled_on: '2027-03-08', weights: [100, 100] }); createBales(owner, { output_id: o.find(x => x.grade === 'B')!.id, baled_on: '2027-03-08', weights: [120] })
    bales = listBales(owner).sort((a, b) => a.code.localeCompare(b.code))
  })
  it('records a sale with deductions and payments, marks bales sold, and reports revenue', () => {
    const [a1, a2, b1] = bales
    expect(() => createSale(owner, { season_id: season, sold_on: '2027-03-01', channel: 'auction', lines: [{ bale_id: a1.id, price_per_kg: 3 }] })).toThrow(/after the sale date/)
    expect(() => createSale(owner, { season_id: season, sold_on: '2027-03-10', channel: 'auction', lines: [{ bale_id: a1.id, price_per_kg: 3 }], deductions: [{ label: 'Levy', amount: 999 }] })).toThrow(/exceed the gross/)
    const s = createSale(owner, { season_id: season, sold_on: '2027-03-10', channel: 'auction', buyer: 'Boka', sale_ref: 'AUC-77',
      lines: [{ bale_id: a1.id, price_per_kg: 4 }, { bale_id: a2.id, price_per_kg: 3.5, weight_kg: 98 }, { bale_id: b1.id, price_per_kg: 2 }], deductions: [{ label: 'Levy', amount: 20 }, { label: 'Commission', amount: 30 }] })
    expect(s).toMatchObject({ code: 'ML-00001', gross: 400 + 343 + 240, net: 933 })
    expect(listBales(owner, { status: 'sold' })).toHaveLength(3)
    expect(() => createSale(owner, { season_id: season, sold_on: '2027-03-11', channel: 'private', lines: [{ bale_id: a1.id, price_per_kg: 1 }] })).toThrow(/already sold/)
    expect(() => createSale(owner, { season_id: season, sold_on: '2027-03-11', channel: 'private', sale_ref: 'AUC-77', lines: [] })).toThrow()
    expect(listSales(owner)[0]).toMatchObject({ status: 'unpaid', outstanding: 933, weight_kg: 318, avg_price: 3.09 })
    expect(() => recordPayment(owner, s.id, { paid_on: '2027-03-12', amount: 1000 })).toThrow(/outstanding/)
    const p1 = recordPayment(owner, s.id, { paid_on: '2027-03-12', amount: 500, method: 'EcoCash' }); expect(listSales(owner)[0].status).toBe('part paid')
    recordPayment(owner, s.id, { paid_on: '2027-03-14', amount: 433 }); expect(listSales(owner)[0]).toMatchObject({ status: 'paid', outstanding: 0 })
    expect(saleDetail(owner, s.id)).toMatchObject({ deductions: [{ label: 'Levy' }, { label: 'Commission' }] })
    const r = revenueSummary(owner, season)
    expect(r).toMatchObject({ kg: 318, gross: 983, net: 933, avg_price_per_kg: 3.09, harvested_ha: 6, net_per_ha: 155.5 })
    expect(r.by_grade.map(g => g.key)).toEqual(['A', 'B']); expect(r.by_grade[0]).toMatchObject({ gross: 743 })
    expect(r.by_field.map(f => f.key)).toEqual(['F-04']); expect(r.by_variety).toHaveLength(1)
    expect(r.by_grade.reduce((t, g) => t + g.net, 0)).toBeCloseTo(933, 1)
    expect(() => deleteSale(owner, s.id)).toThrow(/payments/)
    for (const p of [p1]) deletePayment(owner, p)
    const pays = saleDetail(owner, s.id).payments; for (const p of pays) deletePayment(owner, p.id)
    deleteSale(owner, s.id); expect(listBales(owner, { status: 'baled' })).toHaveLength(3); expect(listSales(owner)).toHaveLength(0)
  })
  it('closed seasons reject sales', () => {
    setSeasonStatus(owner, season, 'closed')
    expect(() => createSale(owner, { season_id: season, sold_on: '2027-03-10', channel: 'auction', lines: [{ bale_id: bales[0].id, price_per_kg: 3 }] })).toThrow(/closed/)
  })
})

describe('Phase 3 permissions and upgrade', () => {
  it('field recorder can look but not grade, bale or see revenue', async () => {
    const role = db.get<{ id: string }>(`SELECT id FROM roles WHERE name='Field Recorder'`)!.id
    await createUser(owner, 'Rudo', '4321', role); const rec = await ctxFor('Rudo', '4321')
    expect(listGrading(rec)).toEqual([]); expect(listBales(rec)).toEqual([])
    expect(() => saveGrade(rec, { code: 'Z' })).toThrow(PermissionError)
    expect(() => createBales(rec, { output_id: 'x', baled_on: '2027-03-08', weights: [1] })).toThrow(PermissionError)
    expect(() => listSales(rec)).toThrow(PermissionError); expect(() => revenueSummary(rec, season)).toThrow(PermissionError)
  })
  it('upgrade from v2 grants Phase 3 permissions once to built-in roles', () => {
    db.run(`DELETE FROM role_permissions WHERE permission LIKE 'quality.%' OR permission LIKE 'marketing.%'`)
    runMigrations(db, 2)
    const n = (name: string) => db.get<{ n: number }>(`SELECT COUNT(*) n FROM role_permissions rp JOIN roles r ON r.id=rp.role_id WHERE r.name=? AND (rp.permission LIKE 'quality.%' OR rp.permission LIKE 'marketing.%')`, [name])!.n
    // 7 Phase 3 permissions + the 2 buyer permissions added at schema v10
    expect(n('Farm Manager')).toBe(9); expect(n('Field Recorder')).toBe(2); expect(n('Store Clerk')).toBe(0)
  })
})
