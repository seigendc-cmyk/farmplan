import { describe, it, expect, beforeEach } from 'vitest'
import { Db, MemoryPersistence } from '../db/database'
import { initialiseFarm, login } from './setup'
import { type Ctx, PermissionError } from './context'
import { createSeason } from './seasons'
import { createField } from './fields'
import { recordHarvest } from './harvest'
import { createBarn, createCycle, setCheck, loadCycle, offloadCycle, CHECKLIST_ITEMS } from './curing'
import { createStorageUnit, openStorageUnit } from './storage'
import { saveGrade, createGrading, createBales, listBales, listGrading } from './quality'
import { createSale, listSales, recordPayment } from './marketing'
import { adoptUnlinkedBuyers, buyerAgeing, buyerComparison, buyerPriceHistory, buyerSummary, createBuyer, deleteBuyer, linkSaleBuyer, listBuyers, suggestDeductions, unlinkedBuyerNames, updateBuyer } from './buyers'
import { runMigrations } from '../db/migrations'
import { hubHandle, setHubEnabled, createPairing } from './hub'
import { joinHub, type FetchLike } from './lan'
import { revenueSummary } from './marketing'

let db: Db; let o: Ctx; let season: string; let bales: { id: string; code: string }[]
beforeEach(async () => {
  db = await Db.open(new MemoryPersistence())
  await initialiseFarm(db, { tenantName: 'T', farmName: 'F', ownerName: 'Lovemore', ownerPin: '1234' })
  const r = await login(db, 'Lovemore', '1234'); o = { db, ...r.ctx! }
  season = createSeason(o, { label: '2026/27', starts_on: '2026-09-01', ends_on: '2027-08-31', activate: true })
  const f4 = createField(o, { field_no: 'F-04', area_ha: 4 })
  const h = recordHarvest(o, { field_id: f4, season_id: season, harvested_on: '2027-01-20', green_weight_kg: 2000 })
  const barn = createBarn(o, { capacity_kg: 6000 }); const { id: cycle } = createCycle(o, { barn_id: barn, season_id: season })
  for (const i of CHECKLIST_ITEMS) setCheck(o, cycle, i, true, '2027-01-21')
  loadCycle(o, { cycle_id: cycle, batch_ids: [h.id], loaded_at: '2027-01-22T08:00' }); offloadCycle(o, { cycle_id: cycle, offloaded_at: '2027-01-28T08:00', cured_weight_kg: 400 })
  const unit = createStorageUnit(o, { cycle_id: cycle, kind: 'slate_pack', weight_kg: 320, created_on: '2027-01-30', maturity_days: 30 }).id; openStorageUnit(o, unit, '2027-03-05')
  const A = saveGrade(o, { code: 'A', sort_order: 1 }); const B = saveGrade(o, { code: 'B', sort_order: 2 })
  createGrading(o, { storage_unit_id: unit, graded_on: '2027-03-06', outputs: [{ grade_id: A, weight_kg: 200 }, { grade_id: B, weight_kg: 120 }] })
  const outs = listGrading(o)[0].outputs
  createBales(o, { output_id: outs.find(x => x.grade === 'A')!.id, baled_on: '2027-03-08', weights: [100, 100] }); createBales(o, { output_id: outs.find(x => x.grade === 'B')!.id, baled_on: '2027-03-08', weights: [120] })
  bales = listBales(o).sort((a, b) => a.code.localeCompare(b.code))   // a1, a2 (grade A, 100 kg each), b1 (grade B, 120 kg)
})

const boka = () => createBuyer(o, { name: 'Boka Auction Floors', kind: 'auction_floor', payment_terms_days: 7, credit_limit: 500, deductions: [{ label: 'Levy', kind: 'percent', value: 2.5 }, { label: 'Handling', kind: 'fixed', value: 5 }] })
const merchant = () => createBuyer(o, { name: 'Merchant Ltd', kind: 'merchant' })
/** Boka buys a1 @4 and b1 @2 (gross 640); Merchant buys a2 @3 (gross 300). */
function sell() {
  const b = boka(), m = merchant()
  const s1 = createSale(o, { season_id: season, sold_on: '2027-03-10', channel: 'auction', buyer_id: b, lines: [{ bale_id: bales[0].id, price_per_kg: 4 }, { bale_id: bales[2].id, price_per_kg: 2 }] })
  const s2 = createSale(o, { season_id: season, sold_on: '2027-04-20', channel: 'private', buyer_id: m, lines: [{ bale_id: bales[1].id, price_per_kg: 3 }] })
  return { b, m, s1, s2 }
}

describe('buyer register', () => {
  it('creates, validates and edits buyers with default deductions', () => {
    const id = boka(); const b = listBuyers(o)[0]
    expect(b).toMatchObject({ id, name: 'Boka Auction Floors', kind: 'auction_floor', payment_terms_days: 7, credit_limit: 500, active: true, sales: 0 }); expect(b.deductions).toEqual([{ label: 'Handling', kind: 'fixed', value: 5 }, { label: 'Levy', kind: 'percent', value: 2.5 }])
    expect(() => createBuyer(o, { name: '  boka auction floors ' })).toThrow(/already exists/); expect(() => createBuyer(o, { name: '' })).toThrow(/name is required/)
    expect(() => createBuyer(o, { name: 'X', email: 'nope' })).toThrow(/valid email/); expect(() => createBuyer(o, { name: 'X', payment_terms_days: 2.5 })).toThrow(/whole number/)
    expect(() => createBuyer(o, { name: 'X', credit_limit: -1 })).toThrow(/cannot be negative/); expect(() => createBuyer(o, { name: 'X', deductions: [{ label: 'Levy', kind: 'percent', value: 120 }] })).toThrow(/exceed 100/)
    updateBuyer(o, id, { phone: '+263 77 000 0000', credit_limit: null, deductions: [{ label: 'Levy', kind: 'percent', value: 3 }], active: false })
    expect(listBuyers(o)[0]).toMatchObject({ phone: '+263 77 000 0000', credit_limit: null, active: false, deductions: [{ label: 'Levy', kind: 'percent', value: 3 }] }); expect(listBuyers(o, { activeOnly: true })).toHaveLength(0)
  })
  it('turns defaults into amounts for a sale value', () => { const id = boka(); expect(suggestDeductions(o, id, 640)).toEqual([{ label: 'Handling', amount: 5 }, { label: 'Levy', amount: 16 }]) })
  it('hides bank details from people who can only view buyers, and needs permissions', () => {
    createBuyer(o, { name: 'Boka', bank_name: 'CBZ', account_no: '123456', settlement_notes: 'Pays Fridays' })
    const view = { ...o, perms: new Set(['marketing.buyer.view']) }; expect(listBuyers(view)[0]).toMatchObject({ bank_name: '', account_no: '', settlement_notes: '' }); expect(listBuyers(o)[0]).toMatchObject({ bank_name: 'CBZ', account_no: '123456' })
    expect(() => createBuyer(view, { name: 'Y' })).toThrow(PermissionError); expect(() => listBuyers({ ...o, perms: new Set() })).toThrow(PermissionError)
  })
  it('cannot delete a buyer with sales (deactivate instead), but can delete an unused one', () => {
    const { b } = sell(); expect(() => deleteBuyer(o, b)).toThrow(/Mark the buyer inactive/); const x = createBuyer(o, { name: 'Unused' }); deleteBuyer(o, x); expect(listBuyers(o).map(v => v.name)).not.toContain('Unused')
  })
})

describe('selling to a buyer', () => {
  it('records the buyer on the sale, keeps the name in step on rename, and blocks inactive buyers', () => {
    const { b, s1 } = sell(); expect(listSales(o).find(s => s.id === s1.id)).toMatchObject({ buyer: 'Boka Auction Floors', buyer_id: b, due_on: '2027-03-17' })
    updateBuyer(o, b, { name: 'Boka Floors' }); expect(listSales(o).find(s => s.id === s1.id)!.buyer).toBe('Boka Floors')
    updateBuyer(o, b, { active: false }); const spare = listBales(o, { status: 'baled' }); expect(spare).toHaveLength(0)
    expect(() => createSale(o, { season_id: season, sold_on: '2027-05-01', channel: 'auction', buyer_id: b, lines: [{ bale_id: bales[0].id, price_per_kg: 1 }] })).toThrow(/inactive|already sold/)
    expect(() => createSale(o, { season_id: season, sold_on: '2027-05-01', channel: 'auction', buyer_id: 'nope', lines: [{ bale_id: bales[0].id, price_per_kg: 1 }] })).toThrow(/Buyer not found/)
  })
  it('warns (without blocking) when a sale would pass the credit limit', () => {
    const b = createBuyer(o, { name: 'Boka', credit_limit: 500 })
    const first = createSale(o, { season_id: season, sold_on: '2027-03-10', channel: 'auction', buyer_id: b, lines: [{ bale_id: bales[0].id, price_per_kg: 3 }] }); expect(first.warnings).toEqual([])   // owes 300
    const second = createSale(o, { season_id: season, sold_on: '2027-03-11', channel: 'auction', buyer_id: b, lines: [{ bale_id: bales[1].id, price_per_kg: 3 }] })  // would owe 600
    expect(second.warnings[0]).toMatch(/would owe 600 against a credit limit of 500/); expect(listSales(o)).toHaveLength(2)
    recordPayment(o, first.id, { paid_on: '2027-03-12', amount: 300 })
    expect(createSale(o, { season_id: season, sold_on: '2027-03-13', channel: 'auction', buyer_id: b, lines: [{ bale_id: bales[2].id, price_per_kg: 1 }] }).warnings).toEqual([])   // owes 300 + 120
  })
})

describe('analysis', () => {
  it('summarises sales, prices and payment speed per buyer', () => {
    const { s1 } = sell(); recordPayment(o, s1.id, { paid_on: '2027-03-20', amount: 100 }); recordPayment(o, s1.id, { paid_on: '2027-04-09', amount: 100 })   // 10 days and 30 days, equal weight
    const st = Object.fromEntries(buyerSummary(o, { seasonId: season, asOf: '2027-05-01' }).map(s => [s.name, s]))
    expect(st['Boka Auction Floors']).toMatchObject({ sales: 1, kg: 220, gross: 640, net: 640, avg_price: 2.91, paid: 200, outstanding: 440, avg_days_to_pay: 20, overdue: 440 })
    expect(st['Merchant Ltd']).toMatchObject({ sales: 1, kg: 100, gross: 300, avg_price: 3, outstanding: 300, avg_days_to_pay: null, overdue: 0 })   // no terms → never overdue
  })
  it('buckets balances by age and flags overdue against payment terms', () => {
    sell(); const a = Object.fromEntries(buyerAgeing(o, '2027-05-15').map(x => [x.name, x]))
    expect(a['Boka Auction Floors']).toMatchObject({ current: 0, d31_60: 0, d61_plus: 640, total: 640, overdue: 640, oldest_days: 66 }); expect(a['Merchant Ltd']).toMatchObject({ current: 300, total: 300, overdue: 0 })
    expect(buyerAgeing(o, '2027-04-25').find(x => x.name === 'Boka Auction Floors')).toMatchObject({ d31_60: 640 })
  })
  it('paid-up sales leave the ageing report', () => { const { s2 } = sell(); recordPayment(o, s2.id, { paid_on: '2027-04-21', amount: 300 }); expect(buyerAgeing(o, '2027-05-15').map(x => x.name)).toEqual(['Boka Auction Floors']) })
  it('lists price history by season and grade', () => {
    const { b } = sell(); expect(buyerPriceHistory(o, b)).toEqual([{ season: '2026/27', grade: 'A', kg: 100, avg_price: 4 }, { season: '2026/27', grade: 'B', kg: 120, avg_price: 2 }])
  })
  it('compares buyers on a grade-adjusted basis so grade mix does not flatter anyone', () => {
    sell(); const c = buyerComparison(o, { seasonId: season })
    expect(c.map(x => [x.name, x.grade_adjusted_pct, x.rank])).toEqual([['Boka Auction Floors', 8.47, 1], ['Merchant Ltd', -14.29, 2]])
  })
  it('shows typed-name buyers in the analysis too', () => {
    createSale(o, { season_id: season, sold_on: '2027-03-10', channel: 'private', buyer: ' walk-in ', lines: [{ bale_id: bales[0].id, price_per_kg: 2 }] })
    expect(buyerSummary(o).map(s => [s.name, s.buyer_id])).toEqual([['walk-in', null]]); expect(buyerAgeing(o, '2027-03-15')[0]).toMatchObject({ name: 'walk-in', total: 200 })
  })
  it('needs both buyer and sales access', () => { expect(() => buyerSummary({ ...o, perms: new Set(['marketing.buyer.view']) })).toThrow(PermissionError); expect(() => buyerAgeing({ ...o, perms: new Set(['marketing.sale.view']) })).toThrow(PermissionError) })
})

describe('existing sales with typed buyer names', () => {
  const typed = () => {
    createSale(o, { season_id: season, sold_on: '2027-03-10', channel: 'auction', buyer: 'Boka', lines: [{ bale_id: bales[0].id, price_per_kg: 4 }] })
    createSale(o, { season_id: season, sold_on: '2027-03-11', channel: 'contract', buyer: ' boka ', lines: [{ bale_id: bales[1].id, price_per_kg: 4 }] })
    createSale(o, { season_id: season, sold_on: '2027-03-12', channel: 'private', buyer: 'Walk-in', lines: [{ bale_id: bales[2].id, price_per_kg: 2 }] })
  }
  it('adopts names into buyers, ignoring case and spaces, and reuses existing buyers', () => {
    typed(); expect(unlinkedBuyerNames(o)).toEqual([{ name: 'Boka', sales: 2 }, { name: 'Walk-in', sales: 1 }])
    expect(adoptUnlinkedBuyers(o)).toEqual({ created: 2, linked: 3 }); expect(listBuyers(o).map(b => [b.name, b.kind, b.sales])).toEqual([['Boka', 'auction_floor', 2], ['Walk-in', 'private', 1]]); expect(unlinkedBuyerNames(o)).toEqual([])
    expect(adoptUnlinkedBuyers(o)).toEqual({ created: 0, linked: 0 })
  })
  it('does the same automatically when upgrading a v9 database', () => {
    typed(); db.run(`UPDATE sales SET buyer_id=NULL`); runMigrations(db, 9); expect(listBuyers(o).map(b => b.name)).toEqual(['Boka', 'Walk-in']); expect(listSales(o).every(s => s.buyer_id)).toBe(true)
    expect(db.get(`SELECT COUNT(*) n FROM outbox WHERE table_name='buyers' AND synced_at IS NULL`)).toMatchObject({ n: 2 })
  })
  it('lets one sale be re-pointed or detached', () => {
    typed(); adoptUnlinkedBuyers(o); const w = listBuyers(o).find(b => b.name === 'Walk-in')!; const s = listSales(o).find(x => x.buyer_id === w.id)!
    const bok = listBuyers(o).find(b => b.name === 'Boka')!; linkSaleBuyer(o, s.id, bok.id); expect(listSales(o).find(x => x.id === s.id)).toMatchObject({ buyer_id: bok.id, buyer: 'Boka' })
    linkSaleBuyer(o, s.id, null); expect(listSales(o).find(x => x.id === s.id)!.buyer_id).toBeNull()
  })
  it('keeps revenue figures unchanged', () => { typed(); const before = revenueSummary(o, season); adoptUnlinkedBuyers(o); expect(revenueSummary(o, season)).toEqual(before) })
})

describe('hub', () => {
  it('never sends buyers (bank details) to phones', async () => {
    boka(); setHubEnabled(db, true); const { code } = await createPairing(o, 'Phone')
    const f: FetchLike = async (url, init) => { const u = new URL(url); const r = await hubHandle(db, { method: init?.method ?? 'GET', path: u.pathname + u.search, auth: init?.headers?.Authorization ?? null, body: init?.body ? JSON.parse(init.body) : undefined }); const body = JSON.parse(JSON.stringify(r.body)); return { status: r.status, ok: r.status < 300, json: async () => body } }
    const phone = await Db.open(new MemoryPersistence()); await joinHub(phone, { hubUrl: 'http://10.0.0.1:7878', code, name: 'Tendai', pin: '1111' }, f)
    expect(phone.get(`SELECT COUNT(*) n FROM buyers`)).toMatchObject({ n: 0 })
  })
})
