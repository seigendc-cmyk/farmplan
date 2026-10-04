import { describe, it, expect, beforeEach } from 'vitest'
import { Db, MemoryPersistence } from '../db/database'
import { initialiseFarm, login, createUser } from './setup'
import { type Ctx, PermissionError } from './context'
import { createSeason, setSeasonStatus } from './seasons'
import { createField } from './fields'
import { createInput, stockOf } from './inventory'
import { recordHarvest } from './harvest'
import { createBarn, createCycle, setCheck, loadCycle, offloadCycle, CHECKLIST_ITEMS } from './curing'
import { createStorageUnit, openStorageUnit } from './storage'
import { saveGrade, createGrading, listGrading, createBales, listBales } from './quality'
import { createSale, deleteSale, listSales } from './marketing'
import { saveContractor, listContractors, deleteContractor, createContract, updateContract, activateContract, cancelContract, addAdvance, deleteAdvance, addObligation, setObligationDone,
  listContracts, contractStatement, settleContract, reopenContract } from './contracts'
import { dashboard } from './reports'
import { runMigrations } from '../db/migrations'

let db: Db; let owner: Ctx; let season: string; let field: string; let contractor: string; let urea: string; let bales: string[]
async function ctxFor(name: string, pin: string): Promise<Ctx> { const r = await login(db, name, pin); if (!r.ok) throw new Error(r.reason); return { db, ...r.ctx! } }

beforeEach(async () => {
  db = await Db.open(new MemoryPersistence())
  await initialiseFarm(db, { tenantName: 'T', farmName: 'F', ownerName: 'Lovemore', ownerPin: '1234' })
  owner = await ctxFor('Lovemore', '1234')
  season = createSeason(owner, { label: '2026/27', starts_on: '2026-09-01', ends_on: '2027-08-31', activate: true })
  field = createField(owner, { field_no: 'F-04', area_ha: 4 })
  contractor = saveContractor(owner, { name: 'Acme Leaf', email: 'ops@acme.test', phone: '+263771' })
  urea = createInput(owner, { name: 'Compound D', category: 'fertilizer', unit: 'kg' })
})

/** Produces three baled 100 kg bales ready to sell. */
function makeBales() {
  const h = recordHarvest(owner, { field_id: field, season_id: season, harvested_on: '2027-01-20', green_weight_kg: 1000 })
  const { id: cyc } = createCycle(owner, { barn_id: createBarn(owner, { capacity_kg: 5000 }), season_id: season })
  for (const i of CHECKLIST_ITEMS) setCheck(owner, cyc, i, true, '2027-01-21')
  loadCycle(owner, { cycle_id: cyc, batch_ids: [h.id], loaded_at: '2027-01-22T08:00' }); offloadCycle(owner, { cycle_id: cyc, offloaded_at: '2027-01-28T08:00', cured_weight_kg: 300 })
  const u = createStorageUnit(owner, { cycle_id: cyc, kind: 'pile', weight_kg: 300, created_on: '2027-01-30', maturity_days: 7 }).id; openStorageUnit(owner, u, '2027-02-10')
  const g = saveGrade(owner, { code: 'A' }); createGrading(owner, { storage_unit_id: u, graded_on: '2027-02-12', outputs: [{ grade_id: g, weight_kg: 300 }] })
  createBales(owner, { output_id: listGrading(owner)[0].outputs[0].id, baled_on: '2027-02-15', weights: [100, 100, 100] }); bales = listBales(owner).map(b => b.id)
}
const newContract = (extra = {}) => createContract(owner, { season_id: season, contractor_id: contractor, contract_no: 'AL/2027/9', variety: 'KRK26', area_ha: 4, target_kg: 400, signed_on: '2026-10-01', delivery_deadline: '2027-04-30', field_ids: [field], ...extra })

describe('contractors and contract set-up', () => {
  it('registers contractors, validates, and protects contractors that have contracts', () => {
    expect(() => saveContractor(owner, { name: 'acme leaf' })).toThrow(/already registered/); expect(() => saveContractor(owner, { name: 'X', email: 'nope' })).toThrow(/valid email/)
    const c = newContract(); expect(c.code).toBe('CT-00001'); expect(listContractors(owner)[0].contracts).toBe(1)
    expect(() => deleteContractor(owner, contractor)).toThrow(/has contracts/)
    expect(() => newContract()).toThrow(/already exists/)
    expect(() => createContract(owner, { season_id: season, contractor_id: contractor, area_ha: 0 })).toThrow(/above zero/)
    expect(() => createContract(owner, { season_id: season, contractor_id: contractor, signed_on: '2026-10-01', delivery_deadline: '2026-09-01' })).toThrow(/cannot precede/)
    expect(listContracts(owner)[0]).toMatchObject({ status: 'draft', contractor: 'Acme Leaf', target_kg: 400, delivered_kg: 0 })
    updateContract(owner, c.id, { season_id: season, contractor_id: contractor, contract_no: 'AL/2027/9', target_kg: 500, field_ids: [] })
    expect(contractStatement(owner, c.id)).toMatchObject({ linked_ha: 0, summary: { target_kg: 500 } })
  })
  it('needs signing date and target before activation; cancel only when clean', () => {
    const c = createContract(owner, { season_id: season, contractor_id: contractor }); expect(() => activateContract(owner, c.id)).toThrow(/signing date/)
    cancelContract(owner, c.id); expect(listContracts(owner)[0].status).toBe('cancelled'); expect(() => activateContract(owner, c.id)).toThrow(/cancelled/)
  })
})

describe('advances feed inventory', () => {
  it('input advances are received into stock and block removal once used', () => {
    const c = newContract(); activateContract(owner, c.id)
    expect(() => addAdvance(owner, { contract_id: c.id, kind: 'input', value: 500, advanced_on: '2026-11-01' })).toThrow(/Choose the input/)
    const a = addAdvance(owner, { contract_id: c.id, kind: 'input', input_id: urea, qty: 1000, value: 800, advanced_on: '2026-11-01' })
    addAdvance(owner, { contract_id: c.id, kind: 'cash', description: 'Labour float', value: 200, advanced_on: '2026-11-05' })
    expect(stockOf(owner, urea)).toBe(1000)
    const st = contractStatement(owner, c.id); expect(st.advances_by_kind).toEqual([{ kind: 'input', value: 800 }, { kind: 'cash', value: 200 }, { kind: 'service', value: 0 }]); expect(st.summary.advances_total).toBe(1000)
    db.run(`INSERT INTO inventory_transactions(id,tenant_id,farm_id,input_id,kind,qty_delta,unit_cost,occurred_on) VALUES('u1',?,?,?,'consumption',-600,0.8,'2026-12-01')`, [owner.tenantId, owner.farmId, urea])
    expect(() => deleteAdvance(owner, a)).toThrow(/already been used/)
  })
  it('reverses stock when an unused advance is removed', () => {
    const c = newContract(); const a = addAdvance(owner, { contract_id: c.id, kind: 'input', input_id: urea, qty: 100, value: 80, advanced_on: '2026-11-01' })
    deleteAdvance(owner, a); expect(stockOf(owner, urea)).toBe(0)
  })
})

describe('obligations, deliveries and settlement', () => {
  it('tracks obligations and overdue ones', () => {
    const c = newContract(); const o = addObligation(owner, { contract_id: c.id, kind: 'production', description: 'Transplant by 30 Nov', due_on: '2026-11-30' })
    addObligation(owner, { contract_id: c.id, kind: 'delivery', description: 'Deliver by 30 Apr', due_on: '2027-04-30' })
    expect(contractStatement(owner, c.id, '2026-12-05')).toMatchObject({ obligations_open: 2, obligations_overdue: 1 })
    setObligationDone(owner, o, true, '2026-11-28'); expect(contractStatement(owner, c.id, '2026-12-05')).toMatchObject({ obligations_open: 1, obligations_overdue: 0 })
  })

  it('contract sales count as deliveries; settlement closes the contract and locks it', () => {
    makeBales(); const c = newContract(); activateContract(owner, c.id)
    addAdvance(owner, { contract_id: c.id, kind: 'input', input_id: urea, qty: 1000, value: 800, advanced_on: '2026-11-01' }); addAdvance(owner, { contract_id: c.id, kind: 'cash', description: 'Float', value: 200, advanced_on: '2026-11-05' })
    const other = createContract(owner, { season_id: season, contractor_id: contractor, contract_no: 'DRAFT' })
    expect(() => createSale(owner, { season_id: season, sold_on: '2027-02-20', channel: 'auction', contract_id: other.id, lines: [{ bale_id: bales[0], price_per_kg: 4 }] })).toThrow(/only active contracts/)
    const s = createSale(owner, { season_id: season, sold_on: '2027-02-20', channel: 'auction', contract_id: c.id, buyer: 'Acme Leaf', lines: [{ bale_id: bales[0], price_per_kg: 4 }, { bale_id: bales[1], price_per_kg: 4.5 }], deductions: [{ label: 'Levy', amount: 10 }] })
    expect(listSales(owner)[0]).toMatchObject({ channel: 'contract', contract_id: c.id })
    expect(listContracts(owner).find(x => x.id === c.id)).toMatchObject({ delivered_kg: 200, delivered_pct: 50, delivered_net: 840, advances_total: 1000, balance: -160 })
    expect(contractStatement(owner, c.id)).toMatchObject({ kg_per_contracted_ha: 50, deliveries: [{ code: s.code, kg: 200, gross: 850 }] })
    expect(() => settleContract(owner, c.id, { settled_on: '2027-03-01', advances_recovered: 1500 })).toThrow(/exceeds the advances/)
    expect(() => settleContract(owner, c.id, { settled_on: '2027-03-01', advances_recovered: 800, other_deductions: 500 })).toThrow(/Deductions exceed/)
    settleContract(owner, c.id, { settled_on: '2027-03-01', advances_recovered: 840, notes: 'Shortfall carried to next season' })
    const st = contractStatement(owner, c.id); expect(st.summary.status).toBe('settled')
    expect(st.settlement).toMatchObject({ delivered_kg: 200, delivered_gross: 850, sale_deductions: 10, advances_total: 1000, advances_recovered: 840, net_payable: 0, shortfall: 160 })
    // locked
    expect(() => addAdvance(owner, { contract_id: c.id, kind: 'cash', description: 'x', value: 1, advanced_on: '2027-03-02' })).toThrow(/settled/)
    expect(() => createSale(owner, { season_id: season, sold_on: '2027-03-02', channel: 'auction', contract_id: c.id, lines: [{ bale_id: bales[2], price_per_kg: 4 }] })).toThrow(/only active contracts/)
    expect(() => deleteSale(owner, s.id)).toThrow(/settled contract/)
    expect(() => cancelContract(owner, c.id)).toThrow(/settled/)
    reopenContract(owner, c.id); expect(listContracts(owner).find(x => x.id === c.id)!.status).toBe('active'); expect(contractStatement(owner, c.id).settlement).toBeNull()
  })

  it('pays out the surplus when deliveries exceed advances', () => {
    makeBales(); const c = newContract(); activateContract(owner, c.id); addAdvance(owner, { contract_id: c.id, kind: 'cash', description: 'Float', value: 300, advanced_on: '2026-11-05' })
    createSale(owner, { season_id: season, sold_on: '2027-02-20', channel: 'contract', contract_id: c.id, lines: bales.map(b => ({ bale_id: b, price_per_kg: 4 })) })
    settleContract(owner, c.id, { settled_on: '2027-03-01', advances_recovered: 300, other_deductions: 50 })
    expect(contractStatement(owner, c.id).settlement).toMatchObject({ net_payable: 850, shortfall: 0 })
  })
  it('closed season blocks new contracts', () => { setSeasonStatus(owner, season, 'closed'); expect(() => newContract()).toThrow(/closed/) })
})

describe('contract permissions, dashboard and upgrade', () => {
  it('farm manager edits but cannot settle; field recorder sees nothing', async () => {
    const fm = db.get<{ id: string }>(`SELECT id FROM roles WHERE name='Farm Manager'`)!.id; const fr = db.get<{ id: string }>(`SELECT id FROM roles WHERE name='Field Recorder'`)!.id
    await createUser(owner, 'Mgr', '1111', fm); await createUser(owner, 'Rec', '2222', fr)
    const m = await ctxFor('Mgr', '1111'); const r = await ctxFor('Rec', '2222')
    const c = createContract(m, { season_id: season, contractor_id: contractor, signed_on: '2026-10-01', target_kg: 100 }); activateContract(m, c.id)
    expect(() => settleContract(m, c.id, { settled_on: '2027-03-01', advances_recovered: 0 })).toThrow(PermissionError)
    expect(() => listContracts(r)).toThrow(PermissionError); expect(() => saveContractor(r, { name: 'Z' })).toThrow(PermissionError)
    expect(dashboard(owner).contracts_active).toBe(1); expect(dashboard(r).contracts_active).toBe(0)
  })
  it('upgrade from v3 adds sales.contract_id and grants once', () => {
    db.run(`DELETE FROM role_permissions WHERE permission LIKE 'contracts.%'`); runMigrations(db, 3)
    const n = db.get<{ n: number }>(`SELECT COUNT(*) n FROM role_permissions rp JOIN roles r ON r.id=rp.role_id WHERE r.name='Farm Manager' AND rp.permission LIKE 'contracts.%'`)!.n; expect(n).toBe(2)
    expect(db.all<{ name: string }>(`PRAGMA table_info(sales)`).some(c => c.name === 'contract_id')).toBe(true)
  })
})
