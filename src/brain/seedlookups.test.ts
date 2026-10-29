import { describe, it, expect, beforeEach } from 'vitest'
import { Db, MemoryPersistence } from '../db/database'
import { initialiseFarm, login, createUser } from '../services/setup'
import type { Ctx } from '../services/context'
import { createSeason } from '../services/seasons'
import { createSeedbed } from '../services/seedbeds'
import { createField } from '../services/fields'
import { saveTrayType } from '../services/traytypes'
import { createTray, updateTray } from '../services/trays'
import { recordTransplant } from '../services/transplants'
import { recordOperation } from '../services/operations'
import { createRole } from '../services/roles'
import { askBrain, DEFAULT_BRAIN, type BrainSettings } from './ask'
import { availableQuestions } from './catalogue'

const d = (days: number) => new Date(Date.now() + days * 864e5).toISOString().slice(0, 10)
const rules: BrainSettings = { ...DEFAULT_BRAIN, engine: 'rules' }
let db: Db; let o: Ctx; let season: string; let bay: string; let open: string; let tt: string; let t1: string; let t2: string; let field: string
const ask = (c: Ctx, q: string) => askBrain(c, q, { settings: rules })
const cost = (amount: number, on: string, seedbed: string, tray: string | null = null) => db.insert('cost_entries', {
  tenant_id: o.tenantId, farm_id: o.farmId, season_id: season, category: 'labour', amount, occurred_on: on, seedbed_id: seedbed,
  field_id: null, tray_id: tray, source_type: 'test', source_id: null, note: null })
const user = async (name: string, perms: string[]) => { await createUser(o, name, '5555', createRole(o, name + ' role', perms)); return { db, ...(await login(db, name, '5555')).ctx! } as Ctx }

beforeEach(async () => {
  db = await Db.open(new MemoryPersistence())
  await initialiseFarm(db, { tenantName: 'T', farmName: 'F', ownerName: 'Lovemore', ownerPin: '1234' })
  o = { db, ...(await login(db, 'Lovemore', '1234')).ctx! }
  season = createSeason(o, { label: '2026/27', starts_on: d(-90), ends_on: d(270), activate: true })
  field = createField(o, { field_no: 'F-04', area_ha: 4 })
  bay = createSeedbed(o, { season_id: season, code: 'BAY1', kind: 'float_bay' })
  open = createSeedbed(o, { season_id: season, code: 'OB1', bed_length_m: 10, bed_width_m: 1, bed_count: 1, actual_seedlings: 100 })
  tt = saveTrayType(o, { name: '200-cell', cells: 200, length_mm: null, width_mm: null, media: null, note: null })
  t1 = createTray(o, { seedbed_id: bay, tray_type_id: tt, sown_on: d(-60), actual_seedlings: 100, expected_seedlings: 120 })
  t2 = createTray(o, { seedbed_id: bay, tray_type_id: tt, sown_on: d(-50), actual_seedlings: 200 })
  cost(300, d(-40), bay); cost(50, d(-40), open)
})

describe('seedbed cost lookups', () => {
  it('seedbed_cost: a row per tray (bay cost split by seedlings) and per open bed', async () => {
    const a = await ask(o, 'how much have the seedbeds cost')
    expect(a.id).toBe('seedbed_cost')
    expect(a.rows).toEqual([{ seedbed: 'BAY1', unit: 'T-001', seedlings: 100, cost: 100 }, { seedbed: 'BAY1', unit: 'T-002', seedlings: 200, cost: 200 }, { seedbed: 'OB1', unit: 'whole bed', seedlings: 100, cost: 50 }])
  })
  it('cost_per_seedling: per unit, and the word "pending" (never a number) when there is cost but no count', async () => {
    const a = await ask(o, 'cost per seedling in the float bay')
    expect(a.id).toBe('cost_per_seedling')
    expect(a.rows).toEqual([{ seedbed: 'BAY1', unit: 'T-001', per_seedling: 1 }, { seedbed: 'BAY1', unit: 'T-002', per_seedling: 1 }, { seedbed: 'OB1', unit: 'whole bed', per_seedling: 0.5 }])
    const nocount = createSeedbed(o, { season_id: season, code: 'OB2', bed_length_m: 5, bed_width_m: 1, bed_count: 1 }); cost(20, d(-30), nocount)
    const b = await ask(o, 'cost per seedling in the float bay')
    expect(b.rows.find(r => r.seedbed === 'OB2')).toEqual({ seedbed: 'OB2', unit: 'whole bed', per_seedling: 'pending' })
    expect(b.rows.filter(r => r.seedbed !== 'OB2').every(r => typeof r.per_seedling === 'number')).toBe(true)
    const c = await ask(o, 'how much have the seedbeds cost'); expect(c.rows.find(r => r.seedbed === 'OB2')).toMatchObject({ seedlings: null, cost: 20 })
  })
  it('a role without finance.cost.view cannot run the cost lookups, and the money-free ones still run', async () => {
    const m = await user('Nursery', ['brain.chat.ask', 'production.seedbed.view', 'production.operation.view'])
    const ids = availableQuestions(m).map(q => q.id)
    expect(ids).toEqual(expect.arrayContaining(['tray_survival', 'bay_operations', 'seedbeds_status'])); expect(ids).not.toContain('seedbed_cost'); expect(ids).not.toContain('cost_per_seedling')
    const c = await ask(m, 'how much have the seedbeds cost'); expect(c.id).not.toBe('seedbed_cost'); expect(c.rows.every(r => !('cost' in r) && !('per_seedling' in r))).toBe(true)
    expect((await ask(m, 'which tray had the best germination')).id).toBe('tray_survival')
  })
  it('season param: an earlier season answers with its own beds', async () => {
    const s0 = createSeason(o, { label: '2025/26', starts_on: d(-500), ends_on: d(-300) }); const b0 = createSeedbed(o, { season_id: s0, code: 'OLD', bed_length_m: 2, bed_width_m: 1, bed_count: 1, actual_seedlings: 10 })
    db.insert('cost_entries', { tenant_id: o.tenantId, farm_id: o.farmId, season_id: s0, category: 'labour', amount: 5, occurred_on: d(-400), seedbed_id: b0, field_id: null, tray_id: null, source_type: 'test', source_id: null, note: null })
    const a = await ask(o, 'seedbed cost for 2025/26'); expect(a.id).toBe('seedbed_cost'); expect(a.rows).toEqual([{ seedbed: 'OLD', unit: 'whole bed', seedlings: 10, cost: 5 }])
  })
})

describe('tray_survival and bay_operations', () => {
  it('shows sown / actual / transplanted per tray; mortality only once a tray is depleted or abandoned', async () => {
    recordTransplant(o, { seedbed_id: bay, tray_id: t1, field_id: field, season_id: season, crop_season_id: season, qty: 80, occurred_on: d(-10) } as never)
    let a = await ask(o, 'which tray had the best germination'); expect(a.id).toBe('tray_survival')
    expect(a.rows).toEqual([{ seedbed: 'BAY1', tray: 'T-001', sown: d(-60), actual: 100, transplanted: 80, status: 'sown', mortality_pct: null }, { seedbed: 'BAY1', tray: 'T-002', sown: d(-50), actual: 200, transplanted: 0, status: 'sown', mortality_pct: null }])
    updateTray(o, t1, { status: 'depleted' }); updateTray(o, t2, { status: 'abandoned' })
    a = await ask(o, 'how many seedlings died in each tray')
    expect(a.id).toBe('tray_survival'); expect(a.rows.map(r => [r.tray, r.mortality_pct])).toEqual([['T-001', 20], ['T-002', 100]])
  })
  it('bay_operations: date, type and tray only, no prices, bay (float) beds only', async () => {
    recordOperation(o, { target: { type: 'seedbed', id: bay, tray_id: t1 }, op_type: 'Tray filling', occurred_on: d(-3), workers: [{ worker_name: 'Tendai', hours: 2, pay: 40 }] })
    recordOperation(o, { target: { type: 'seedbed', id: bay }, op_type: 'Float water top-up', occurred_on: d(-2) })
    recordOperation(o, { target: { type: 'seedbed', id: open }, op_type: 'Watering', occurred_on: d(-1) })
    const a = await ask(o, 'what did we do in the float bay last week')
    expect(a.id).toBe('bay_operations'); expect(a.params.days).toBe(7)
    expect(a.rows).toEqual([{ date: d(-2), type: 'Float water top-up', tray: 'whole bay' }, { date: d(-3), type: 'Tray filling', tray: 'T-001' }])
    expect(Object.keys(a.rows[0])).toEqual(['date', 'type', 'tray']); expect(JSON.stringify(a.rows)).not.toMatch(/40|cost|pay/i)
    const old = recordOperation(o, { target: { type: 'seedbed', id: bay }, op_type: 'Tray cleaning', occurred_on: d(-30) }); expect(old).toBeTruthy()
    expect((await ask(o, 'float bay operations')).rows).toHaveLength(3)
  })
  it('bay_operations needs both operation and seedbed view', async () => {
    const m = await user('Seedonly', ['brain.chat.ask', 'production.seedbed.view'])
    expect(availableQuestions(m).map(q => q.id)).not.toContain('bay_operations')
  })
})

describe('keyword routing: 3+ phrasings per lookup', () => {
  const cases: [string, string][] = [
    ['how much have the seedbeds cost', 'seedbed_cost'], ['what did the float bay cost us', 'seedbed_cost'], ['total seedbed cost for 2026/27', 'seedbed_cost'], ['how much have we spent on the seedbeds', 'seedbed_cost'],
    ['cost per seedling in the float bay', 'cost_per_seedling'], ['what does each seedling cost', 'cost_per_seedling'], ['what is the cost per seedling in the open bed', 'cost_per_seedling'],
    ['which tray had the best germination', 'tray_survival'], ['how many seedlings died in each tray', 'tray_survival'], ['survival rate by tray', 'tray_survival'],
    ['what did we do in the float bay last week', 'bay_operations'], ['float bay operations', 'bay_operations'], ['when did we last top up the float water', 'bay_operations'],
  ]
  for (const [q, id] of cases) it(`${q} -> ${id}`, async () => { expect((await ask(o, q)).id).toBe(id) })
})
