import { describe, it, expect, beforeEach } from 'vitest'
import { Db, MemoryPersistence } from '../db/database'
import { initialiseFarm, login, createUser } from './setup'
import type { Ctx } from './context'
import { createSeason } from './seasons'
import { createField } from './fields'
import { recordHarvest } from './harvest'
import { createBarn, createCycle, setCheck, loadCycle, offloadCycle, CHECKLIST_ITEMS } from './curing'
import { createStorageUnit } from './storage'
import { saveContractor, createContract, activateContract, addObligation } from './contracts'
import { createBuyer } from './buyers'
import { createSale } from './marketing'
import { saveGrade, createGrading, createBales, listGrading } from './quality'
import { openStorageUnit } from './storage'
import { setBudget } from './analytics'
import { createMachine, logMachine } from './machinery'
import { createInput, recordPurchase } from './inventory'
import { createRole } from './roles'
import { attention } from './attention'

const AS_OF = '2027-03-10'
let db: Db; let owner: Ctx; let season: string; let field: string
async function ctxFor(name: string, pin: string): Promise<Ctx> { const r = await login(db, name, pin); if (!r.ok) throw new Error(r.reason); return { db, ...r.ctx! } }
const areas = (c: Ctx) => attention(c, AS_OF).map(a => a.area)

beforeEach(async () => {
  db = await Db.open(new MemoryPersistence())
  await initialiseFarm(db, { tenantName: 'T', farmName: 'F', ownerName: 'Lovemore', ownerPin: '1234' })
  owner = await ctxFor('Lovemore', '1234')
  season = createSeason(owner, { label: '2026/27', starts_on: '2026-09-01', ends_on: '2027-08-31', activate: true })
  field = createField(owner, { field_no: 'F-04', area_ha: 4 })
})

describe('needs attention', () => {
  it('is empty on a quiet farm', () => { expect(attention(owner, AS_OF)).toEqual([]) })

  it('flags green leaf left out of a barn, but not leaf picked today', () => {
    recordHarvest(owner, { field_id: field, season_id: season, harvested_on: '2027-03-07', green_weight_kg: 900 })
    recordHarvest(owner, { field_id: field, season_id: season, harvested_on: AS_OF, green_weight_kg: 100 })
    const a = attention(owner, AS_OF)
    expect(a).toHaveLength(1); expect(a[0]).toMatchObject({ tone: 'amber', area: 'Harvest', to: '/harvest?focus=H-00001' }); expect(a[0].text).toMatch(/3 days ago/)
  })

  it('walks the chain: unstored cured leaf, storage ready to open, ungraded and unbaled leaf', () => {
    const h = recordHarvest(owner, { field_id: field, season_id: season, harvested_on: '2027-01-20', green_weight_kg: 1000 })
    const { id: cyc } = createCycle(owner, { barn_id: createBarn(owner, { capacity_kg: 5000 }), season_id: season })
    for (const i of CHECKLIST_ITEMS) setCheck(owner, cyc, i, true, '2027-01-21')
    loadCycle(owner, { cycle_id: cyc, batch_ids: [h.id], loaded_at: '2027-01-22T08:00' }); offloadCycle(owner, { cycle_id: cyc, offloaded_at: '2027-01-28T08:00', cured_weight_kg: 300 })
    const u1 = createStorageUnit(owner, { cycle_id: cyc, kind: 'pile', weight_kg: 100, created_on: '2027-01-30', maturity_days: 7 }).id
    createStorageUnit(owner, { cycle_id: cyc, kind: 'pile', weight_kg: 100, created_on: '2027-01-30', maturity_days: 7 })
    expect(attention(owner, AS_OF).map(a => a.text)).toEqual(['C-00001: 100 kg of cured leaf is not yet stored', expect.stringMatching(/^P-00001 is ready to open/), expect.stringMatching(/^P-00002 is ready to open/)])
    expect(attention(owner, AS_OF).map(a => a.to)).toEqual(['/curing?focus=C-00001', '/starking?focus=P-00001', '/starking?focus=P-00002'])
    openStorageUnit(owner, u1, '2027-02-10')
    expect(attention(owner, AS_OF).find(a => a.area === 'Grading')?.to).toBe('/starking?focus=P-00001')
    createGrading(owner, { storage_unit_id: u1, graded_on: '2027-02-12', outputs: [{ grade_id: saveGrade(owner, { code: 'A', sort_order: 1 }), weight_kg: 100 }] })
    createBales(owner, { output_id: listGrading(owner)[0].outputs[0].id, baled_on: '2027-02-14', weights: [60] })
    expect(attention(owner, AS_OF).find(a => a.area === 'Bales')).toMatchObject({ text: 'G-00001 grade A: 40 kg graded but not baled', to: '/grading?focus=G-00001' })
    expect(areas(owner)).not.toContain('Grading')
  })

  it('puts money and commitments at risk first: overdue buyers and contract obligations', () => {
    recordHarvest(owner, { field_id: field, season_id: season, harvested_on: '2027-03-01', green_weight_kg: 900 })   // amber, listed after the reds
    const k = createContract(owner, { season_id: season, contractor_id: saveContractor(owner, { name: 'Alliance' }), signed_on: '2026-10-01', target_kg: 400, area_ha: 4, delivery_deadline: '2027-03-01' }).id
    activateContract(owner, k); addObligation(owner, { contract_id: k, kind: 'delivery', description: 'Deliver first 10 bales', due_on: '2027-03-05' })
    addObligation(owner, { contract_id: k, kind: 'other', description: 'Not due yet', due_on: '2027-04-01' })
    const a = attention(owner, AS_OF)
    expect(a.map(x => [x.tone, x.area])).toEqual([['red', 'Contracts'], ['red', 'Contracts'], ['amber', 'Harvest']])
    expect(a[0]).toMatchObject({ text: 'CT-00001: “Deliver first 10 bales” was due 2027-03-05', to: '/contracts?focus=CT-00001' })
    expect(a[1].text).toMatch(/passed its delivery deadline/)
  })

  it('flags a buyer past their terms, linking to the buyer', () => {
    const h = recordHarvest(owner, { field_id: field, season_id: season, harvested_on: '2027-01-20', green_weight_kg: 1000 })
    const { id: cyc } = createCycle(owner, { barn_id: createBarn(owner, { capacity_kg: 5000 }), season_id: season })
    for (const i of CHECKLIST_ITEMS) setCheck(owner, cyc, i, true, '2027-01-21')
    loadCycle(owner, { cycle_id: cyc, batch_ids: [h.id], loaded_at: '2027-01-22T08:00' }); offloadCycle(owner, { cycle_id: cyc, offloaded_at: '2027-01-28T08:00', cured_weight_kg: 100 })
    const u = createStorageUnit(owner, { cycle_id: cyc, kind: 'pile', weight_kg: 100, created_on: '2027-01-30', maturity_days: 7 }).id; openStorageUnit(owner, u, '2027-02-10')
    createGrading(owner, { storage_unit_id: u, graded_on: '2027-02-12', outputs: [{ grade_id: saveGrade(owner, { code: 'A', sort_order: 1 }), weight_kg: 100 }] })
    createBales(owner, { output_id: listGrading(owner)[0].outputs[0].id, baled_on: '2027-02-14', weights: [100] })
    const buyer = createBuyer(owner, { name: 'Boka Floors', kind: 'auction_floor', payment_terms_days: 7 })
    createSale(owner, { season_id: season, sold_on: '2027-02-20', channel: 'auction', buyer: 'Boka Floors', buyer_id: buyer, lines: [{ bale_id: db.get<{ id: string }>(`SELECT id FROM bales`)!.id, price_per_kg: 3 }], deductions: [] })
    expect(attention(owner, AS_OF).find(a => a.area === 'Buyers')).toMatchObject({ tone: 'red', text: 'Boka Floors is overdue with $300.00', to: '/buyers?focus=Boka%20Floors' })
    expect(attention(owner, '2027-02-25').find(a => a.area === 'Buyers')).toBeUndefined()   // still within terms
  })

  it('flags over-budget categories, services due, and stock that is out or expiring', () => {
    recordHarvest(owner, { field_id: field, season_id: season, harvested_on: AS_OF, green_weight_kg: 100, labour_cost: 40 })
    setBudget(owner, season, 'labour', 25)
    logMachine(owner, { machine_id: createMachine(owner, { name: 'MF 375', service_interval_hours: 10 }), season_id: season, kind: 'use', logged_on: '2027-03-01', hours: 12 })
    const seed = createInput(owner, { name: 'Compound C', category: 'fertilizer', unit: 'kg' }); recordPurchase(owner, { input_id: seed, qty: 50, unit_cost: 1, occurred_on: '2027-01-01', expiry_date: '2027-04-01' })
    createInput(owner, { name: 'Never bought', category: 'chemical', unit: 'L' })   // no stock history: not "out of stock"
    const a = attention(owner, AS_OF)
    expect(a.map(x => x.area)).toEqual(['Budget', 'Machinery', 'Inventory'])
    expect(a[0]).toMatchObject({ text: 'labour is over budget: $40.00 spent of $25.00', to: `/budgets?focus=labour&season=${season}` })
    expect(a[1].text).toMatch(/MF 375 is due for a service \(12 h/); expect(a[1].to).toBe(`/machinery?focus=${db.get<{ id: string }>(`SELECT id FROM machines`)!.id}`)
    expect(a[2]).toMatchObject({ text: 'Compound C expires 2027-04-01', to: '/inventory?focus=Compound%20C' })
  })

  it('shows each role only the modules it can open, and no amounts without finance access', async () => {
    recordHarvest(owner, { field_id: field, season_id: season, harvested_on: '2027-03-01', green_weight_kg: 900, labour_cost: 40 })
    setBudget(owner, season, 'labour', 25)
    const k = createContract(owner, { season_id: season, contractor_id: saveContractor(owner, { name: 'Alliance' }) }).id
    addObligation(owner, { contract_id: k, kind: 'delivery', description: 'Overdue', due_on: '2027-03-05' })
    expect(areas(owner)).toEqual(['Contracts', 'Harvest', 'Budget'])
    const role = createRole(owner, 'Picker', ['production.harvest.view'])
    await createUser(owner, 'Picker', '5555', role)
    expect(areas(await ctxFor('Picker', '5555'))).toEqual(['Harvest'])
  })
})
