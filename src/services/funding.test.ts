import { describe, it, expect, beforeEach } from 'vitest'
import { Db, MemoryPersistence } from '../db/database'
import { initialiseFarm, login, createUser } from './setup'
import { type Ctx, PermissionError } from './context'
import { createRole } from './roles'
import { createSeason } from './seasons'
import { setBudget } from './analytics'
import { advanceProject, getProject, projectOfSeason } from './projects'
import { saveContractor, createContract, addAdvance, activateContract } from './contracts'
import { createInput } from './inventory'
import { approveBaseline, setPlan } from './budgetplan'
import { approveRequest, createRequest, declineRequest, deleteDraft, deleteEvent, fundingPack, fundingSummary, ledger, linkContract, recordDisbursement, recordRepayment, setFundingNotNeeded,
  submitRequest, updateRequest, withdrawRequest, type RequestInput } from './funding'

let db: Db; let o: Ctx; let season: string; let pid: string
const asRole = async (name: string, perms: string[]) => { await createUser(o, name, '5555', createRole(o, `${name} role`, perms)); return { db, ...(await login(db, name, '5555')).ctx! } as Ctx }
const req = (over: Partial<RequestInput> = {}): RequestInput => ({ funder_kind: 'lender', funder_name: 'AgriBank', purpose: 'Seed and fertiliser', amount_requested: 5000, interest_pct: 10, needed_by: '2026-10-15', repayment_source: 'Tobacco sales', repayment_due: '2027-06-30', covers: ['seed', 'fertilizer'], ...over })
const stock = (inputId: string) => db.get<{ n: number }>(`SELECT COALESCE(SUM(qty_delta),0) n FROM inventory_transactions WHERE input_id=? AND deleted_at IS NULL`, [inputId])!.n
const approved = (amount = 5000, extra: Partial<RequestInput> = {}) => { const id = createRequest(o, pid, req(extra)); submitRequest(o, id); approveRequest(o, id, { amount_approved: amount, decided_on: '2026-10-05' }); return id }
beforeEach(async () => {
  db = await Db.open(new MemoryPersistence())
  await initialiseFarm(db, { tenantName: 'T', farmName: 'F', ownerName: 'Lovemore', ownerPin: '1234' })
  o = { db, ...(await login(db, 'Lovemore', '1234')).ctx! }
  season = createSeason(o, { label: '2026/27', starts_on: '2026-09-01', ends_on: '2027-08-31', activate: true }); pid = projectOfSeason(o, season)!.id
})

describe('request lifecycle', () => {
  it('draft → submitted → approved → disbursed → repaid, each step only from the right status', () => {
    const id = createRequest(o, pid, req()); const st = () => fundingSummary(o, pid).requests[0].status
    expect(st()).toBe('draft'); expect(() => approveRequest(o, id, { amount_approved: 1, decided_on: '2026-10-05' })).toThrow(/Only a submitted/); expect(() => recordDisbursement(o, id, { form: 'cash', amount: 1, occurred_on: '2026-10-06' })).toThrow(/approved request/)
    submitRequest(o, id); expect(st()).toBe('submitted'); expect(() => submitRequest(o, id)).toThrow(/Only a draft/)
    approveRequest(o, id, { amount_approved: 4000, decided_on: '2026-10-05' }); expect(st()).toBe('approved')
    recordDisbursement(o, id, { form: 'cash', amount: 1500, occurred_on: '2026-10-10' }); expect(st()).toBe('disbursed')
    recordDisbursement(o, id, { form: 'cash', amount: 2500, occurred_on: '2026-10-10' }); expect(() => recordDisbursement(o, id, { form: 'cash', amount: 1, occurred_on: '2026-10-11' })).toThrow(/more than was approved/)
    recordRepayment(o, id, { amount: 4000, occurred_on: '2026-10-10' }); expect(st()).toBe('repaid')
  })
  it('a draft can be edited and deleted; a submitted request cannot', () => {
    const id = createRequest(o, pid, req()); updateRequest(o, id, req({ amount_requested: 6000 })); expect(fundingSummary(o, pid).requests[0].amount_requested).toBe(6000)
    deleteDraft(o, id); expect(fundingSummary(o, pid).requests).toHaveLength(0)
    const b = createRequest(o, pid, req()); submitRequest(o, b); expect(() => updateRequest(o, b, req())).toThrow(/Only a draft/); expect(() => deleteDraft(o, b)).toThrow(/Only a draft/)
  })
  it('can be declined while submitted, or withdrawn until it pays out, never after', () => {
    const a = createRequest(o, pid, req()); submitRequest(o, a); declineRequest(o, a, '2026-10-05'); expect(() => withdrawRequest(o, a)).toThrow(/not paid out/)
    const b = createRequest(o, pid, req()); withdrawRequest(o, b); expect(() => submitRequest(o, b)).toThrow(/Only a draft/)
    const c = approved(); recordDisbursement(o, c, { form: 'cash', amount: 100, occurred_on: '2026-10-10' }); expect(() => withdrawRequest(o, c)).toThrow(/not paid out/)
  })
  it('validates the request', () => {
    for (const [bad, msg] of [[{ amount_requested: 0 }, /more than zero/], [{ funder_name: ' ' }, /Name the funder/], [{ purpose: '' }, /what the funding is for/], [{ needed_by: '15/10/2026' }, /valid needed-by date/], [{ covers: ['bogus'] }, /Unknown budget category/], [{ interest_pct: -1 }, /cannot be negative/]] as [Partial<RequestInput>, RegExp][])
      expect(() => createRequest(o, pid, req(bad))).toThrow(msg)
  })
  it('a contractor-kind request can be raised, but its money is recorded on the contract', () => {
    const id = approved(2000, { funder_kind: 'contractor', funder_name: 'Boka Tobacco' }); expect(() => recordDisbursement(o, id, { form: 'cash', amount: 100, occurred_on: '2026-10-10' })).toThrow(/Record contractor advances on the contract/)
  })
})

describe('money and interest', () => {
  it('simple interest on principal outstanding; repayments pay interest first', () => {
    const r = { interest_pct: 12 }
    expect(ledger(r, [{ kind: 'disbursement', amount: 1000, occurred_on: '2026-01-01' }], '2026-01-01')).toMatchObject({ principal: 1000, interest: 0, owed: 1000 })
    expect(ledger(r, [{ kind: 'disbursement', amount: 1000, occurred_on: '2026-01-01' }], '2027-01-01')).toMatchObject({ received: 1000, principal: 1000, interest: 120, owed: 1120 })   // 365 days at 12%
    const ev = [{ kind: 'disbursement' as const, amount: 1000, occurred_on: '2026-01-01' }, { kind: 'repayment' as const, amount: 620, occurred_on: '2026-07-01' }]   // 181 days: interest 59.51 first, then principal
    expect(ledger(r, ev, '2026-07-01')).toMatchObject({ repaid: 620, interest: 0, principal: 439.51 })
    expect(ledger({ interest_pct: 0 }, ev, '2030-01-01')).toMatchObject({ principal: 380, interest: 0 })
  })
  it('the summary adds up received, repaid, outstanding and interest across funders', () => {
    const a = approved(4000); recordDisbursement(o, a, { form: 'cash', amount: 4000, occurred_on: '2026-10-01' }); recordRepayment(o, a, { amount: 1000, occurred_on: '2026-12-01' })
    const b = approved(1000, { funder_name: 'Cousin', interest_pct: 0 }); recordDisbursement(o, b, { form: 'cash', amount: 1000, occurred_on: '2026-11-01' })
    const s = fundingSummary(o, pid, '2027-01-01'); expect(s).toMatchObject({ received: 5000, repaid: 1000 }); expect(s.interest).toBeGreaterThan(0)
    const [bank, cousin] = s.requests; expect(cousin).toMatchObject({ funder_name: 'Cousin', principal: 1000, interest: 0 })
    expect(bank.principal).toBeGreaterThan(3000); expect(bank.principal).toBeLessThan(3100)   // the repayment paid about 67 of interest first, so a little less than 1000 reached the principal
    expect(s.outstanding).toBe(Math.round((bank.principal + cousin.principal) * 100) / 100); expect(s.interest).toBe(bank.interest)
  })
  it('refuses repaying more than is owed, back-dated repayments, or repaying when nothing was received', () => {
    const id = approved(); expect(() => recordRepayment(o, id, { amount: 1, occurred_on: '2026-10-10' })).toThrow(/nothing to repay/)
    recordDisbursement(o, id, { form: 'cash', amount: 1000, occurred_on: '2026-10-10' })
    expect(() => recordRepayment(o, id, { amount: 1001, occurred_on: '2026-10-10' })).toThrow(/more than is owed/); expect(() => recordRepayment(o, id, { amount: 10, occurred_on: '2026-10-01' })).toThrow(/before an earlier movement/)
  })
  it('inputs received go into stock at their value, and can be taken back out only while unused', () => {
    const fert = createInput(o, { name: 'Compound C', category: 'fertilizer', unit: 'kg' }); const id = approved(1000)
    expect(() => recordDisbursement(o, id, { form: 'inputs', amount: 600, occurred_on: '2026-10-10' })).toThrow(/Choose the input/)
    recordDisbursement(o, id, { form: 'inputs', amount: 600, occurred_on: '2026-10-10', input_id: fert, qty: 300 }); expect(stock(fert)).toBe(300)
    expect(db.get<{ unit_cost: number }>(`SELECT unit_cost FROM inventory_transactions WHERE input_id=? AND kind='purchase'`, [fert])!.unit_cost).toBe(2)
    const ev = fundingSummary(o, pid).requests[0].events[0]; deleteEvent(o, ev.id); expect(stock(fert)).toBe(0); expect(fundingSummary(o, pid).requests[0]).toMatchObject({ status: 'approved', received: 0 })
    recordDisbursement(o, id, { form: 'inputs', amount: 600, occurred_on: '2026-10-10', input_id: fert, qty: 300 })
    db.insert('inventory_transactions', { tenant_id: o.tenantId, farm_id: o.farmId, input_id: fert, kind: 'consumption', qty_delta: -250, unit_cost: 2, occurred_on: '2026-10-20' })
    expect(() => deleteEvent(o, fundingSummary(o, pid).requests[0].events[0].id)).toThrow(/already been used/)
  })
  it('removing a repayment re-opens a repaid request; a disbursement cannot be removed under later repayments', () => {
    const id = approved(); recordDisbursement(o, id, { form: 'cash', amount: 100, occurred_on: '2026-10-10' }); recordRepayment(o, id, { amount: 100, occurred_on: '2026-10-10' })
    const [d, r] = fundingSummary(o, pid).requests[0].events; expect(() => deleteEvent(o, d.id)).toThrow(/Remove the repayments first/)
    deleteEvent(o, r.id); expect(fundingSummary(o, pid).requests[0].status).toBe('disbursed')
  })
})

describe('contractor link: advances are recorded once', () => {
  let contract: string
  beforeEach(() => {
    const k = saveContractor(o, { name: 'Boka Tobacco' }); contract = createContract(o, { season_id: season, contractor_id: k, signed_on: '2026-09-15', area_ha: 2, target_kg: 4000 }).id; activateContract(o, contract)
  })
  it('links a contract of this season, and rejects another season’s', () => {
    linkContract(o, pid, { contract_id: contract }); expect(getProject(o, pid)).toMatchObject({ contract_id: contract, independent: false })
    const other = createSeason(o, { label: '2027/28', starts_on: '2027-09-01', ends_on: '2028-08-31' }); const k = saveContractor(o, { name: 'Other' }); const c2 = createContract(o, { season_id: other, contractor_id: k, signed_on: '2027-09-15' }).id
    expect(() => linkContract(o, pid, { contract_id: c2 })).toThrow(/contract of this project’s season/)
  })
  it('contract advances show up as a funding source from the same rows, with no copy', () => {
    linkContract(o, pid, { contract_id: contract }); addAdvance(o, { contract_id: contract, kind: 'cash', description: 'Cash advance', value: 3000, advanced_on: '2026-10-01' })
    const fert = createInput(o, { name: 'Compound C', category: 'fertilizer', unit: 'kg' }); addAdvance(o, { contract_id: contract, kind: 'input', input_id: fert, qty: 100, value: 500, advanced_on: '2026-10-02' })
    let s = fundingSummary(o, pid); expect(s.contractor).toMatchObject({ code: expect.any(String), contractor: 'Boka Tobacco', received: 3500, recovered: 0, outstanding: 3500, settled: false }); expect(s).toMatchObject({ received: 3500, outstanding: 3500 })
    expect(db.all(`SELECT 1 FROM funding_events`)).toHaveLength(0)   // nothing was copied into the funding tables
    addAdvance(o, { contract_id: contract, kind: 'cash', description: 'More', value: 500, advanced_on: '2026-11-01' }); s = fundingSummary(o, pid); expect(s.contractor!.received).toBe(4000)   // new advance appears at once
    db.insert('contract_settlements', { tenant_id: o.tenantId, contract_id: contract, settled_on: '2027-06-30', delivered_kg: 1000, delivered_gross: 5000, advances_total: 4000, advances_recovered: 2500, net_payable: 2500 });   // as settleContract writes it, once there are deliveries
     s = fundingSummary(o, pid); expect(s.contractor).toMatchObject({ recovered: 2500, outstanding: 1500, settled: true }); expect(s).toMatchObject({ repaid: 2500, outstanding: 1500 })
  })
  it('independent clears the link, and linking clears independent', () => {
    linkContract(o, pid, { contract_id: null, independent: true }); expect(getProject(o, pid)).toMatchObject({ independent: true, contract_id: null })
    linkContract(o, pid, { contract_id: contract }); expect(getProject(o, pid)).toMatchObject({ independent: false, contractor_id: expect.any(String) })
  })
})

describe('stage gates', () => {
  const toFunding = () => { setPlan(o, pid, { plan_ha: 2, plan_yield_kg_ha: 2000, plan_price_kg: 3 }); setBudget(o, season, 'seed', 1000); approveBaseline(o, season); advanceProject(o, pid); advanceProject(o, pid); advanceProject(o, pid) }
  it('Funding needs a request or "no funding needed"; Contracted needs a contract or independent', () => {
    toFunding(); expect(getProject(o, pid)).toMatchObject({ stage: 'funding', unmet: ['Raise a funding request, or mark that no funding is needed'] })
    setFundingNotNeeded(o, pid, true); expect(getProject(o, pid).unmet).toEqual([]); setFundingNotNeeded(o, pid, false); createRequest(o, pid, req()); expect(getProject(o, pid).unmet).toEqual([])
    expect(() => setFundingNotNeeded(o, pid, true)).toThrow(/in progress/)
    advanceProject(o, pid); expect(getProject(o, pid)).toMatchObject({ stage: 'contracted', unmet: ['Link a contract, or mark the project as independent'] })
    linkContract(o, pid, { contract_id: null, independent: true }); expect(getProject(o, pid).unmet).toEqual([]); advanceProject(o, pid); expect(getProject(o, pid).stage).toBe('land_seedbed')
  })
})

describe('the pack and permissions', () => {
  it('bundles plan, baseline, cash need and repayment plan; budget against actual only once costs exist', () => {
    setPlan(o, pid, { plan_ha: 2, plan_yield_kg_ha: 2000, plan_price_kg: 3 }); setBudget(o, season, 'seed', 1000); approveBaseline(o, season); const id = createRequest(o, pid, req())
    let pk = fundingPack(o, id); expect(pk).toMatchObject({ project: 'Tobacco 2026/27', covers: ['seed', 'fertilizer'], baseline: { version_no: 1, total: 1000 }, plan: { expected_kg: 4000, revenue: 12000 }, budget_vs_actual: null }); expect(pk.request.repayment_source).toBe('Tobacco sales')
    db.insert('cost_entries', { tenant_id: o.tenantId, farm_id: o.farmId, season_id: season, category: 'seed', amount: 200, occurred_on: '2026-10-05', source_type: 'test' }); pk = fundingPack(o, id); expect(pk.budget_vs_actual!.actual_total).toBe(200)
  })
  it('viewing, editing and linking are separate rights; field roles see no funding', async () => {
    const viewer = await asRole('Viewer', ['projects.project.view', 'projects.funding.view']); const id = createRequest(o, pid, req())
    expect(fundingSummary(viewer, pid).requests).toHaveLength(1); expect(() => createRequest(viewer, pid, req())).toThrow(PermissionError); expect(() => submitRequest(viewer, id)).toThrow(PermissionError); expect(() => linkContract(viewer, pid, { contract_id: null, independent: true })).toThrow(PermissionError)
    const field = await asRole('Field', ['projects.project.view']); expect(() => fundingSummary(field, pid)).toThrow(PermissionError); expect(() => fundingPack(field, id)).toThrow(PermissionError)
    const roles = db.all<{ name: string; permission: string }>(`SELECT r.name, rp.permission FROM roles r JOIN role_permissions rp ON rp.role_id=r.id WHERE rp.permission LIKE 'projects.funding.%'`)
    expect(roles.filter(r => r.name === 'Farm Manager').map(r => r.permission).sort()).toEqual(['projects.funding.edit', 'projects.funding.view']); expect(roles.some(r => r.name === 'Field Recorder')).toBe(false)
  })
  it('funding activity events carry no money', () => {
    const id = approved(); recordDisbursement(o, id, { form: 'cash', amount: 777, occurred_on: '2026-10-10' })
    const ev = db.all<{ summary: string }>(`SELECT summary FROM activity_log WHERE table_name IN ('funding_requests','funding_events')`).map(e => e.summary); expect(ev.length).toBeGreaterThan(2); expect(ev.some(s => /777|5000/.test(s))).toBe(false)
  })
})

describe('existing data', () => {
  it('upgrading from v17 adds the link columns and the funding tables, and grants Farm Managers the funding rights once', async () => {
    const mid = 0; void mid
    db.run(`DELETE FROM role_permissions WHERE permission LIKE 'projects.funding.%'`); db.run(`ALTER TABLE projects DROP COLUMN independent`); db.run(`UPDATE meta SET value='17' WHERE key='schema_version'`)
    const p = new MemoryPersistence(); p.data = db.exportBytes(); const up = await Db.open(p)
    expect(up.all<{ name: string }>(`PRAGMA table_info(projects)`).map(c => c.name)).toEqual(expect.arrayContaining(['contractor_id', 'contract_id', 'independent', 'funding_not_needed']))
    expect(up.all(`SELECT 1 FROM role_permissions rp JOIN roles r ON r.id=rp.role_id WHERE r.name='Farm Manager' AND rp.permission='projects.funding.edit'`)).toHaveLength(1)
    expect(up.get<{ n: number }>(`SELECT COUNT(*) n FROM funding_requests`)!.n).toBe(0)
  })
})
