import { describe, it, expect, beforeEach } from 'vitest'
import { Db, MemoryPersistence } from '../db/database'
import { initialiseFarm, login, createUser } from '../services/setup'
import type { Ctx } from '../services/context'
import { createSeason } from '../services/seasons'
import { createField } from '../services/fields'
import { recordHarvest } from '../services/harvest'
import { createBarn, createCycle, setCheck, loadCycle, offloadCycle, CHECKLIST_ITEMS } from '../services/curing'
import { createStorageUnit, openStorageUnit } from '../services/storage'
import { saveGrade, createGrading, listGrading, createBales } from '../services/quality'
import { createSale } from '../services/marketing'
import { saveContractor, createContract, activateContract, addObligation, setObligationDone } from '../services/contracts'
import { createInput, recordPurchase } from '../services/inventory'
import { createSeedbed } from '../services/seedbeds'
import { createMachine, logMachine } from '../services/machinery'
import { createRole } from '../services/roles'
import { askBrain, DEFAULT_BRAIN, type BrainSettings } from './ask'
import { availableQuestions } from './catalogue'

/** Dates relative to today: "ready to open" and "overdue" are measured against the real clock. */
const d = (days: number) => new Date(Date.now() + days * 864e5).toISOString().slice(0, 10)
const rules: BrainSettings = { ...DEFAULT_BRAIN, engine: 'rules' }
const MONEY = /cost|value|price|gross|net|balance|advance|amount|pay/i

let db: Db; let o: Ctx; let season: string
const ask = (c: Ctx, q: string) => askBrain(c, q, { settings: rules })
beforeEach(async () => {
  db = await Db.open(new MemoryPersistence())
  await initialiseFarm(db, { tenantName: 'T', farmName: 'F', ownerName: 'Lovemore', ownerPin: '1234' })
  o = { db, ...(await login(db, 'Lovemore', '1234')).ctx! }
  season = createSeason(o, { label: 'This season', starts_on: d(-90), ends_on: d(270), activate: true })
  const field = createField(o, { field_no: 'F-04', area_ha: 4 })
  // the leaf chain: one unit graded and sold under contract, one ready to open, one still maturing
  const h = recordHarvest(o, { field_id: field, season_id: season, harvested_on: d(-40), green_weight_kg: 1000 })
  const { id: cyc } = createCycle(o, { barn_id: createBarn(o, { capacity_kg: 5000 }), season_id: season })
  for (const i of CHECKLIST_ITEMS) setCheck(o, cyc, i, true, d(-39))
  loadCycle(o, { cycle_id: cyc, batch_ids: [h.id], loaded_at: `${d(-39)}T08:00` }); offloadCycle(o, { cycle_id: cyc, offloaded_at: `${d(-33)}T08:00`, cured_weight_kg: 300 })
  const u1 = createStorageUnit(o, { cycle_id: cyc, kind: 'pile', weight_kg: 100, created_on: d(-30), maturity_days: 7 }).id
  createStorageUnit(o, { cycle_id: cyc, kind: 'slate_pack', weight_kg: 100, created_on: d(-30), maturity_days: 7 })
  createStorageUnit(o, { cycle_id: cyc, kind: 'pile', weight_kg: 100, created_on: d(-5), maturity_days: 25 })
  openStorageUnit(o, u1, d(-20))
  createGrading(o, { storage_unit_id: u1, graded_on: d(-19), outputs: [{ grade_id: saveGrade(o, { code: 'A', sort_order: 1 }), weight_kg: 100 }] })
  createBales(o, { output_id: listGrading(o)[0].outputs[0].id, baled_on: d(-18), weights: [100] })
  const k = createContract(o, { season_id: season, contractor_id: saveContractor(o, { name: 'Alliance' }), signed_on: d(-80), target_kg: 400, delivery_deadline: d(60) }).id
  activateContract(o, k)
  createSale(o, { season_id: season, sold_on: d(-10), channel: 'contract', contract_id: k, buyer: 'Alliance', lines: [{ bale_id: db.get<{ id: string }>(`SELECT id FROM bales`)!.id, price_per_kg: 3 }], deductions: [] })
  addObligation(o, { contract_id: k, kind: 'delivery', description: 'Deliver first bales', due_on: d(-3) })
  addObligation(o, { contract_id: k, kind: 'extension', description: 'Attend field day', due_on: d(10) })
  setObligationDone(o, addObligation(o, { contract_id: k, kind: 'production', description: 'Soil test', due_on: d(-5) }), true, d(-6))
  // store, nursery, workshop
  recordPurchase(o, { input_id: createInput(o, { name: 'Compound C', category: 'fertilizer', unit: 'kg' }), qty: 50, unit_cost: 1.2, occurred_on: d(-60), expiry_date: d(30) })
  createSeedbed(o, { season_id: season, code: 'SB-01', variety: 'KRK26', bed_count: 20, sown_on: d(-85), expected_seedlings: 50000, actual_seedlings: 42000, status: 'ready' } as never)
  logMachine(o, { machine_id: createMachine(o, { name: 'MF 375', service_interval_hours: 10, hourly_rate: 5 }), season_id: season, kind: 'use', logged_on: d(-2), hours: 12 })
  logMachine(o, { machine_id: createMachine(o, { name: 'Pump', kind: 'pump', service_interval_hours: 100 }), season_id: season, kind: 'use', logged_on: d(-2), hours: 5 })
})

describe('new brain lookups', () => {
  it('contract delivery against target, from the same figures as the contract page', async () => {
    const a = await ask(o, 'how much have we delivered against the contract target')
    expect(a.id).toBe('contract_delivery'); expect(a.rows).toEqual([{ contract: 'CT-00001', contractor: 'Alliance', status: 'active', target_kg: 400, delivered_kg: 100, delivered_pct: 25, deadline: d(60) }])
  })
  it('stock on hand with the next expiry', async () => {
    const a = await ask(o, 'what stock do we have on hand')
    expect(a.id).toBe('stock_on_hand'); expect(a.rows).toEqual([{ input: 'Compound C', category: 'fertilizer', on_hand: 50, unit: 'kg', reorder_at: null, level: 'ok', next_expiry: d(30) }])
  })
  it('seedbeds with achievement and seedlings still available', async () => {
    const a = await ask(o, 'how are the seedbeds doing')
    expect(a.id).toBe('seedbeds_status'); expect(a.rows[0]).toMatchObject({ seedbed: 'SB-01', variety: 'KRK26', expected: 50000, actual: 42000, achieved_pct: 84, available: 42000 })
  })
  it('storage: ready units first, then how long the rest need; opened units are left out', async () => {
    const a = await ask(o, 'which piles are ready to open')
    expect(a.id).toBe('storage_ready')
    expect(a.rows.map(r => [r.unit, r.stage, r.days_to_open])).toEqual([['SP-00001', 'ready to open', 0], ['P-00002', 'maturing', 20]])
  })
  it('machines due for a service first', async () => {
    const a = await ask(o, 'which machines are due for a service')
    expect(a.id).toBe('service_due'); expect(a.rows).toEqual([{ machine: 'MF 375', hours_since_service: 12, interval_hours: 10, last_service: null, due: 'yes' }, { machine: 'Pump', hours_since_service: 5, interval_hours: 100, last_service: null, due: 'no' }])
  })
  it('overdue obligations only: not the done one, not the one still to come', async () => {
    const a = await ask(o, 'which contract obligations are overdue')
    expect(a.id).toBe('obligations_overdue'); expect(a.rows).toEqual([{ contract: 'CT-00001', kind: 'delivery', obligation: 'Deliver first bales', due: d(-3), days_overdue: 3 }])
  })
  it('never returns money, even to the owner', async () => {
    for (const q of ['contract deliveries this season', 'inventory levels', 'how are the seedbeds doing', 'what is maturing in storage', 'machinery maintenance', 'overdue obligations']) {
      const a = await ask(o, q); expect(a.rows.length).toBeGreaterThan(0); expect(Object.keys(a.rows[0]).filter(c => MONEY.test(c))).toEqual([])
    }
  })
  it('follows the permissions of each page: a mechanic gets the service list and nothing else new', async () => {
    await createUser(o, 'Tendai', '5555', createRole(o, 'Mechanic', ['brain.chat.ask', 'resources.machinery.view']))
    const m = { db, ...(await login(db, 'Tendai', '5555')).ctx! } as Ctx
    const mine = availableQuestions(m).map(q => q.id)
    expect(mine).toContain('service_due')
    for (const id of ['contract_delivery', 'stock_on_hand', 'seedbeds_status', 'storage_ready', 'obligations_overdue']) expect(mine).not.toContain(id)
    expect((await ask(m, 'which machines are due for a service')).rows).toHaveLength(2)
    const s = await ask(m, 'what stock do we have on hand'); expect(s.id).toBeNull(); expect(s.rows).toEqual([])
  })
})
