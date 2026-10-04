import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Db, MemoryPersistence } from '../db/database'
import { initialiseFarm, login } from './setup'
import { type Ctx, PermissionError } from './context'
import { createSeason } from './seasons'
import { createField } from './fields'
import { recordHarvest } from './harvest'
import { createBarn, createCycle, setCheck, loadCycle, offloadCycle, CHECKLIST_ITEMS } from './curing'
import { createStorageUnit, openStorageUnit } from './storage'
import { saveGrade, createGrading, createBales, listBales, listGrading } from './quality'
import { createSale } from './marketing'
import { createInput, recordPurchase } from './inventory'
import { recordOperation } from './operations'
import { recordLabour } from './labour'
import { recordWeather } from './weather'
import { COST_CATEGORIES, copyBudget, listBudgets, planVsActual, profitability, rainfallVsYield, seasonComparison, setBudget } from './analytics'
import { allowedViews, askQuestion, runSelect, setBiTransport, systemPrompt, validateSelect, type BiTransport } from './bi'
import { runMigrations } from '../db/migrations'

let db: Db; let o: Ctx; let season: string; let f4: string; let f7: string

beforeEach(async () => {
  db = await Db.open(new MemoryPersistence())
  await initialiseFarm(db, { tenantName: 'T', farmName: 'F', ownerName: 'Lovemore', ownerPin: '1234' })
  const r = await login(db, 'Lovemore', '1234'); o = { db, ...r.ctx! }
  season = createSeason(o, { label: '2026/27', starts_on: '2026-09-01', ends_on: '2027-08-31', activate: true })
  f4 = createField(o, { field_no: 'F-04', area_ha: 4 }); f7 = createField(o, { field_no: 'F-07', area_ha: 2 })
  const h1 = recordHarvest(o, { field_id: f4, season_id: season, harvested_on: '2027-01-20', green_weight_kg: 2000 }); const h2 = recordHarvest(o, { field_id: f7, season_id: season, harvested_on: '2027-01-21', green_weight_kg: 800 })
  const barn = createBarn(o, { capacity_kg: 6000 }); const { id: cycle } = createCycle(o, { barn_id: barn, season_id: season })
  for (const i of CHECKLIST_ITEMS) setCheck(o, cycle, i, true, '2027-01-21')
  loadCycle(o, { cycle_id: cycle, batch_ids: [h1.id, h2.id], loaded_at: '2027-01-22T08:00' }); offloadCycle(o, { cycle_id: cycle, offloaded_at: '2027-01-28T08:00', cured_weight_kg: 400 })
  const unit = createStorageUnit(o, { cycle_id: cycle, kind: 'slate_pack', weight_kg: 320, created_on: '2027-01-30', maturity_days: 30 }).id; openStorageUnit(o, unit, '2027-03-05')
  const A = saveGrade(o, { code: 'A', sort_order: 1 }); const B = saveGrade(o, { code: 'B', sort_order: 2 })
  createGrading(o, { storage_unit_id: unit, graded_on: '2027-03-06', labour_cost: 30, outputs: [{ grade_id: A, weight_kg: 200 }, { grade_id: B, weight_kg: 120 }] })
  const outs = listGrading(o)[0].outputs
  createBales(o, { output_id: outs.find(x => x.grade === 'A')!.id, baled_on: '2027-03-08', weights: [100, 100] }); createBales(o, { output_id: outs.find(x => x.grade === 'B')!.id, baled_on: '2027-03-08', weights: [120] })
  const [a1, a2, b1] = listBales(o).sort((a, b) => a.code.localeCompare(b.code))
  createSale(o, { season_id: season, sold_on: '2027-03-10', channel: 'auction', buyer: 'Boka', lines: [{ bale_id: a1.id, price_per_kg: 4 }, { bale_id: a2.id, price_per_kg: 3.5, weight_kg: 98 }, { bale_id: b1.id, price_per_kg: 2 }], deductions: [{ label: 'Levy', amount: 20 }, { label: 'Commission', amount: 30 }] })
  const urea = createInput(o, { name: 'Compound D', category: 'fertilizer', unit: 'kg' }); recordPurchase(o, { input_id: urea, qty: 100, unit_cost: 2, occurred_on: '2026-10-01' })
  recordOperation(o, { target: { type: 'field', id: f7 }, season_id: season, op_type: 'Fertilizing', occurred_on: '2026-10-20', inputs: [{ input_id: urea, qty: 10 }] })
  recordLabour(o, { season_id: season, field_id: f4, worked_on: '2026-11-01', worker_name: 'Tendai', task: 'Weeding', hours: 8, pay_amount: 100 })
  recordWeather(o, { season_id: season, recorded_on: '2026-11-10', rainfall_mm: 50 }); recordWeather(o, { season_id: season, recorded_on: '2026-12-05', rainfall_mm: 30 }); recordWeather(o, { season_id: season, field_id: f4, recorded_on: '2026-12-06', rainfall_mm: 10 })
})
afterEach(() => setBiTransport(null))

describe('budgets', () => {
  it('upserts, validates, removes and copies lines', () => {
    setBudget(o, season, 'fertilizer', 20); setBudget(o, season, 'fertilizer', 25); expect(listBudgets(o, season)).toHaveLength(1); expect(listBudgets(o, season)[0].amount).toBe(25)
    expect(() => setBudget(o, season, 'labour', -1)).toThrow(/negative/); expect(() => setBudget(o, season, 'nonsense' as never, 5)).toThrow(/Unknown/)
    setBudget(o, season, 'fertilizer', null); expect(listBudgets(o, season)).toHaveLength(0)
    setBudget(o, season, 'labour', 100); setBudget(o, season, 'seed', 50)
    const s2 = createSeason(o, { label: '2027/28', starts_on: '2027-09-01', ends_on: '2028-08-31' })
    expect(copyBudget(o, season, s2, 1.1)).toBe(2); expect(listBudgets(o, s2).map(b => [b.category, b.amount]).sort()).toEqual([['labour', 110], ['seed', 55]])
    expect(copyBudget(o, season, s2)).toBe(0); expect(() => copyBudget(o, season, season)).toThrow(/different/)
  })
  it('compares plan with actual and flags over / near / unplanned', () => {
    setBudget(o, season, 'fertilizer', 20); setBudget(o, season, 'labour', 80); setBudget(o, season, 'curing', 50)
    const p = planVsActual(o, season)
    const by = Object.fromEntries(p.lines.map(l => [l.category, l]))
    expect(by.fertilizer).toMatchObject({ budget: 20, actual: 20, status: 'near', variance: 0 }); expect(by.labour).toMatchObject({ actual: 130, variance: -50, status: 'over', pct_used: 162.5 })
    expect(by.curing).toMatchObject({ actual: 0, status: 'under' }); expect(by.grading).toBeUndefined()
    expect(p).toMatchObject({ budget_total: 150, actual_total: 150, unplanned_actual: 0, pct_used: 100 })
    setBudget(o, season, 'fertilizer', null); const q = planVsActual(o, season)
    expect(q.lines.find(l => l.category === 'fertilizer')).toMatchObject({ budget: null, actual: 20, status: 'unplanned' }); expect(q.unplanned_actual).toBe(20)
  })
  it('needs the right permissions', () => {
    expect(() => planVsActual({ ...o, perms: new Set(['finance.cost.view']) }, season)).toThrow(PermissionError)
    expect(() => setBudget({ ...o, perms: new Set(['finance.budget.view']) }, season, 'labour', 5)).toThrow(PermissionError)
  })
})

describe('profitability', () => {
  it('computes cost, revenue, margin, per-ha and per-field figures', () => {
    const p = profitability(o, season)
    expect(p).toMatchObject({ total_cost: 150, field_cost: 120, shared_cost: 30, net_revenue: 933, margin: 783, harvested_ha: 6, green_kg: 2800, sold_kg: 318, cost_per_ha: 25, margin_per_ha: 130.5, cost_per_kg_sold: 0.47 })
    expect(p.margin_pct).toBe(83.92)
    const f = Object.fromEntries(p.by_field.map(x => [x.field_no, x]))
    expect(f['F-04']).toMatchObject({ green_kg_per_ha: 500, field_cost: 100, net_revenue: 933, field_margin: 833 }); expect(f['F-07']).toMatchObject({ green_kg_per_ha: 400, field_cost: 20, field_margin: -20 })
  })
  it('hides revenue without marketing access, and compares seasons', () => {
    const p = profitability({ ...o, perms: new Set(['finance.cost.view']) }, season); expect(p.net_revenue).toBeNull(); expect(p.margin).toBeNull(); expect(p.total_cost).toBe(150)
    createSeason(o, { label: '2027/28', starts_on: '2027-09-01', ends_on: '2028-08-31' })
    const c = seasonComparison(o); expect(c.map(s => s.label)).toEqual(['2026/27', '2027/28'])
    expect(c[0]).toMatchObject({ green_kg_per_ha: 466.67, margin: 783, avg_price_per_kg: 3.09 }); expect(c[1]).toMatchObject({ total_cost: 0, green_kg_per_ha: null, cost_per_ha: null })
  })
})

describe('rainfall vs yield', () => {
  it('summarises rain by month, field and season', () => {
    const r = rainfallVsYield(o, season)
    expect(r.by_month).toEqual([{ month: '2026-11', mm: 50, rain_days: 1 }, { month: '2026-12', mm: 40, rain_days: 2 }])
    expect(r.by_field).toEqual([{ field_no: 'F-04', rain_mm: 90, green_kg_per_ha: 500 }, { field_no: 'F-07', rain_mm: 80, green_kg_per_ha: 400 }])
    expect(r.by_season).toEqual([{ label: '2026/27', rain_mm: 90, green_kg_per_ha: 466.67 }])
  })
})

describe('BI: read-only view layer and validator', () => {
  const allowed = ['bi_costs', 'bi_fields']; const base = ['cost_entries', 'fields', 'local_users', 'outbox']
  it('accepts plain selects and wraps them in a row limit', () => {
    expect(validateSelect('SELECT category, SUM(amount) FROM bi_costs GROUP BY category;', allowed, base)).toMatch(/^SELECT \* FROM \(SELECT category.*\) LIMIT 500$/)
    expect(validateSelect("WITH t AS (SELECT * FROM bi_costs WHERE note LIKE '%delete%') SELECT COUNT(*) FROM t", allowed, base)).toContain('WITH t AS')
  })
  it.each([
    ['DROP TABLE fields', /Only SELECT/], ['select * from bi_costs; delete from fields', /single statement/], ['select * from cost_entries', /not available/], ['select * from bi_costs, local_users', /not available/],
    ['select * from bi_fields join outbox on 1', /not available/], ['select * from sqlite_master', /not available|System tables/], ["select * from bi_costs where 1=1 -- x", /Comments/],
    ['select * from bi_sales', /not available to you/], ['select 1', /bi_ views/], ['select * from bi_costs union all select * from fields', /not available/],
    ['insert into bi_costs values (1)', /Only SELECT/], ['select load_extension("x")', /Quoted|not read-only/], ['with x as (delete from fields returning *) select * from x', /not read-only/],
    ['select * from pragma_table_info("fields")', /Quoted|not read-only|System/], ['', /No query/],
  ])('refuses %s', (sql, err) => expect(() => validateSelect(sql, allowed, base)).toThrow(err))

  it('runs on the views, returns rows, and leaves the database writable afterwards', () => {
    const r = runSelect(o, 'SELECT category, ROUND(SUM(amount),2) AS total FROM bi_costs GROUP BY category ORDER BY total DESC'); expect(r.rows[0]).toMatchObject({ category: 'labour', total: 130 })
    expect(runSelect(o, 'SELECT field_no, area_ha FROM bi_fields ORDER BY field_no').rows).toEqual([{ field_no: 'F-04', area_ha: 4 }, { field_no: 'F-07', area_ha: 2 }])
    expect(runSelect(o, "SELECT season, SUM(weight_kg) kg, SUM(gross) gross FROM bi_sales GROUP BY season").rows[0]).toMatchObject({ kg: 318, gross: 983 })
    expect(() => runSelect(o, 'SELECT pin_hash FROM bi_fields')).toThrow(); expect(() => runSelect(o, 'SELECT * FROM local_users')).toThrow(/not available/)
    recordLabour(o, { season_id: season, worked_on: '2026-11-02', worker_name: 'X', task: 'y' })   // still writable
  })
  it('limits views by role', () => {
    const rec = { ...o, perms: new Set(['production.field.view', 'production.harvest.view']) }
    expect(allowedViews(rec).map(v => v.name).sort()).toEqual(['bi_fields', 'bi_harvests']); expect(() => runSelect(rec, 'SELECT * FROM bi_costs')).toThrow(/not available to you/)
    expect(allowedViews({ ...o, perms: new Set(['resources.labour.view']) })).toHaveLength(0)
  })
  it('sends the model only table and column names, and repairs a refused query once', async () => {
    const seen: { system: string; n: number }[] = []
    const t: BiTransport = async ({ system, messages }) => { seen.push({ system, n: messages.length }); return messages.length === 1 ? '{"sql":"select * from cost_entries","explanation":"first try"}' : 'Sure: {"sql":"SELECT field_no, ROUND(SUM(amount),2) AS cost FROM bi_costs WHERE field_no IS NOT NULL GROUP BY field_no ORDER BY cost DESC","explanation":"Total cost per field."}' }
    setBiTransport(t)
    const a = await askQuestion(o, 'Which field cost most?', { apiKey: 'k', model: 'm' })
    expect(seen.map(s => s.n)).toEqual([1, 3]); expect(a.result!.rows[0]).toMatchObject({ field_no: 'F-04', cost: 100 }); expect(a.explanation).toBe('Total cost per field.')
    const sys = seen[0].system; for (const secret of ['F-04', 'Tendai', 'Boka', 'Lovemore']) expect(sys).not.toContain(secret)
    expect(sys).toContain('bi_costs(season, category, amount')
    expect(systemPrompt({ ...o, perms: new Set(['production.field.view']) }, 'USD', '2027-01-01')).not.toContain('bi_costs')
  })
  it('gives up after one failed repair, handles unanswerable questions, and requires a key', async () => {
    setBiTransport(async () => '{"sql":"delete from fields","explanation":"x"}'); await expect(askQuestion(o, 'wipe it', { apiKey: 'k', model: 'm' })).rejects.toThrow(/could not be run/)
    expect(db.get(`SELECT 1 FROM fields WHERE deleted_at IS NULL`)).toBeTruthy()
    setBiTransport(async () => '{"sql":null,"explanation":"No data about weather forecasts."}'); expect(await askQuestion(o, 'Will it rain tomorrow?', { apiKey: 'k', model: 'm' })).toMatchObject({ sql: null, result: null })
    setBiTransport(async () => 'not json'); await expect(askQuestion(o, 'anything', { apiKey: 'k', model: 'm' })).rejects.toThrow(/not understood/)
    await expect(askQuestion(o, 'hello there', { apiKey: ' ', model: 'm' })).rejects.toThrow(/API key/)
  })
})

describe('upgrade from schema v5', () => {
  it('adds the budget permissions once and keeps the views queryable', async () => {
    db.run(`DELETE FROM role_permissions WHERE permission LIKE 'finance.budget.%'`); runMigrations(db, 5)
    expect(db.get(`SELECT 1 FROM role_permissions rp JOIN roles r ON r.id=rp.role_id WHERE r.name='Farm Manager' AND rp.permission='finance.budget.edit'`)).toBeTruthy()
    expect(COST_CATEGORIES).toHaveLength(14); expect(runSelect(o, 'SELECT COUNT(*) AS n FROM bi_seasons').rows[0].n).toBe(1)
  })
})
