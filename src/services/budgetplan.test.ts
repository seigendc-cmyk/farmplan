import { describe, it, expect, beforeEach } from 'vitest'
import { Db, MemoryPersistence } from '../db/database'
import { initialiseFarm, login, createUser } from './setup'
import { type Ctx, PermissionError, ValidationError } from './context'
import { createRole } from './roles'
import { createSeason } from './seasons'
import { setBudget } from './analytics'
import { projectOfSeason } from './projects'
import { approveBaseline, baselineReport, budgetChanged, cashFlow, listVersions, planSummary, recordRevision, setBudgetMonth, setPlan } from './budgetplan'
import { backfillBaselines } from '../db/budgetlink'

let db: Db; let o: Ctx; let season: string; let pid: string
const asRole = async (name: string, perms: string[]) => { await createUser(o, name, '5555', createRole(o, `${name} role`, perms)); return { db, ...(await login(db, name, '5555')).ctx! } as Ctx }
const cost = (category: string, amount: number) => db.insert('cost_entries', { tenant_id: o.tenantId, farm_id: o.farmId, season_id: season, category, amount, occurred_on: '2026-11-01', source_type: 'test' })
beforeEach(async () => {
  db = await Db.open(new MemoryPersistence())
  await initialiseFarm(db, { tenantName: 'T', farmName: 'F', ownerName: 'Lovemore', ownerPin: '1234' })
  o = { db, ...(await login(db, 'Lovemore', '1234')).ctx! }
  season = createSeason(o, { label: '2026/27', starts_on: '2026-09-01', ends_on: '2027-08-31', activate: true }); pid = projectOfSeason(o, season)!.id
})

describe('the plan', () => {
  it('works out expected kg, revenue, margin, cost per hectare and break-even price', () => {
    setBudget(o, season, 'seed', 1000); setBudget(o, season, 'labour', 3000)
    setPlan(o, pid, { plan_ha: 2, plan_yield_kg_ha: 2000, plan_price_kg: 3 })
    expect(planSummary(o, pid)).toMatchObject({ expected_kg: 4000, revenue: 12000, budget_total: 4000, margin: 8000, cost_per_ha: 2000, break_even_kg_price: 1 })
  })
  it('shows what it can: break-even needs no price, revenue and margin do', () => {
    setBudget(o, season, 'seed', 900); setPlan(o, pid, { plan_ha: 3, plan_yield_kg_ha: 1000, plan_price_kg: null })
    expect(planSummary(o, pid)).toMatchObject({ expected_kg: 3000, revenue: null, margin: null, break_even_kg_price: 0.3 })
    setPlan(o, pid, { plan_ha: null, plan_yield_kg_ha: null, plan_price_kg: null }); expect(planSummary(o, pid)).toMatchObject({ expected_kg: null, break_even_kg_price: null, cost_per_ha: null })
  })
  it('rejects zero or negative hectares and yield, accepts a zero price, needs the edit right', async () => {
    expect(() => setPlan(o, pid, { plan_ha: 0, plan_yield_kg_ha: 1, plan_price_kg: 1 })).toThrow(/Planned hectares must be more than zero/)
    expect(() => setPlan(o, pid, { plan_ha: 1, plan_yield_kg_ha: -5, plan_price_kg: 1 })).toThrow(ValidationError)
    expect(() => setPlan(o, pid, { plan_ha: 1, plan_yield_kg_ha: 1, plan_price_kg: -1 })).toThrow(/zero or more/)
    setPlan(o, pid, { plan_ha: 1, plan_yield_kg_ha: 1, plan_price_kg: 0 })
    const viewer = await asRole('Viewer', ['projects.project.view', 'finance.budget.view']); expect(() => setPlan(viewer, pid, { plan_ha: 1, plan_yield_kg_ha: 1, plan_price_kg: 1 })).toThrow(PermissionError)
    expect(planSummary(viewer, pid).plan_ha).toBe(1)
  })
  it('field roles see no plan figures', async () => {
    const field = await asRole('Field', ['projects.project.view']); expect(() => planSummary(field, pid)).toThrow(PermissionError)
  })
})

describe('baseline and versions', () => {
  it('needs a budget line and the approve right; approving locks version 1 with the lines as they were', async () => {
    expect(() => approveBaseline(o, season)).toThrow(/at least one budget line/)
    setBudget(o, season, 'seed', 1000); setBudget(o, season, 'labour', 500)
    const mgr = await asRole('Mgr', ['finance.budget.view', 'finance.budget.edit']); expect(() => approveBaseline(mgr, season)).toThrow(PermissionError)
    approveBaseline(o, season); const [v] = listVersions(o, season)
    expect(v).toMatchObject({ version_no: 1, kind: 'baseline', approved_by: 'Lovemore', total: 1500 }); expect(v.lines.map(l => [l.category, l.amount])).toEqual([['labour', 500], ['seed', 1000]])
    expect(() => approveBaseline(o, season)).toThrow(/already has an approved baseline/)
  })
  it('later edits leave the baseline alone and are flagged until recorded as a revision with a reason', () => {
    setBudget(o, season, 'seed', 1000); approveBaseline(o, season); expect(budgetChanged(o, season)).toBe(false)
    setBudget(o, season, 'seed', 1200); setBudget(o, season, 'fuel', 300)
    expect(budgetChanged(o, season)).toBe(true); expect(listVersions(o, season)[0].total).toBe(1000)
    expect(() => recordRevision(o, season, '  ')).toThrow(/why the budget changed/)
    recordRevision(o, season, 'Fertiliser price rise'); const vs = listVersions(o, season)
    expect(vs.map(v => [v.version_no, v.kind, v.total, v.reason])).toEqual([[1, 'baseline', 1000, null], [2, 'revision', 1500, 'Fertiliser price rise']])
    expect(budgetChanged(o, season)).toBe(false); expect(() => recordRevision(o, season, 'again')).toThrow(/has not changed since version 2/)
  })
  it('a revision needs a baseline first, and a month change counts as a change', () => {
    setBudget(o, season, 'seed', 1000); expect(() => recordRevision(o, season, 'x')).toThrow(/Approve a baseline first/)
    approveBaseline(o, season); setBudgetMonth(o, season, 'seed', '2026-10'); expect(budgetChanged(o, season)).toBe(true)
  })
  it('reports baseline, latest version and actual per category', () => {
    setBudget(o, season, 'seed', 1000); setBudget(o, season, 'labour', 500); approveBaseline(o, season)
    setBudget(o, season, 'seed', 1200); recordRevision(o, season, 'Price rise'); setBudget(o, season, 'fuel', 100)
    cost('seed', 900); cost('fuel', 40)
    const r = baselineReport(o, season)
    expect(r).toMatchObject({ has_baseline: true, latest_version: 2, baseline_total: 1500, latest_total: 1700, actual_total: 940, unsaved_changes: true })
    expect(r.lines.find(l => l.category === 'seed')).toMatchObject({ baseline: 1000, latest: 1200, actual: 900, vs_baseline: 100 })
    expect(r.lines.find(l => l.category === 'fuel')).toMatchObject({ baseline: null, latest: null, actual: 40, vs_baseline: null })
  })
  it('without a baseline the report says so', () => { setBudget(o, season, 'seed', 10); expect(baselineReport(o, season)).toMatchObject({ has_baseline: false, latest_version: null, unsaved_changes: false }) })
})

describe('monthly cash need', () => {
  it('groups lines by expected month with a running total and lists unscheduled lines last', () => {
    setBudget(o, season, 'seed', 1000); setBudget(o, season, 'fertilizer', 2000); setBudget(o, season, 'labour', 500); setBudget(o, season, 'fuel', 100)
    setBudgetMonth(o, season, 'seed', '2026-09'); setBudgetMonth(o, season, 'fertilizer', '2026-11'); setBudgetMonth(o, season, 'labour', '2026-11')
    expect(cashFlow(o, season)).toEqual([{ month: '2026-09', amount: 1000, cumulative: 1000 }, { month: '2026-11', amount: 2500, cumulative: 3500 }, { month: null, amount: 100, cumulative: 3600 }])
  })
  it('validates the month and the line, and can clear a month', () => {
    expect(() => setBudgetMonth(o, season, 'seed', '2026-10')).toThrow(/Set the budget line first/); setBudget(o, season, 'seed', 10)
    for (const bad of ['2026-13', '26-10', 'October', '2026-1']) expect(() => setBudgetMonth(o, season, 'seed', bad)).toThrow(/look like 2026-11/)
    setBudgetMonth(o, season, 'seed', '2026-10'); setBudgetMonth(o, season, 'seed', null); expect(cashFlow(o, season)).toEqual([{ month: null, amount: 10, cumulative: 10 }])
  })
})

describe('existing data', () => {
  it('upgrading from v16 turns each existing season budget into version 1, unchanged, and adds the new columns', async () => {
    setBudget(o, season, 'seed', 1000); setBudget(o, season, 'labour', 500)
    const empty = createSeason(o, { label: 'Empty', starts_on: '2027-09-01', ends_on: '2028-08-31' })
    db.run(`DELETE FROM budget_version_lines`); db.run(`DELETE FROM budget_versions`); db.run(`ALTER TABLE projects DROP COLUMN plan_ha`); db.run(`ALTER TABLE budgets DROP COLUMN expected_month`); db.run(`UPDATE meta SET value='16' WHERE key='schema_version'`)
    const p = new MemoryPersistence(); p.data = db.exportBytes(); const up = await Db.open(p); const u = { ...o, db: up } as Ctx
    expect(up.all<{ name: string }>(`PRAGMA table_info(projects)`).map(c => c.name)).toContain('plan_ha'); expect(up.all<{ name: string }>(`PRAGMA table_info(budgets)`).map(c => c.name)).toContain('expected_month')
    const vs = listVersions(u, season); expect(vs).toHaveLength(1); expect(vs[0]).toMatchObject({ version_no: 1, kind: 'baseline', total: 1500 }); expect(listVersions(u, empty)).toEqual([])
    expect(up.all(`SELECT amount FROM budgets WHERE deleted_at IS NULL ORDER BY category`)).toEqual([{ amount: 500 }, { amount: 1000 }]); expect(budgetChanged(u, season)).toBe(false)
    backfillBaselines(up); expect(listVersions(u, season)).toHaveLength(1)   // running it twice adds nothing
  })
})
