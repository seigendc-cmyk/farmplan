import { describe, it, expect, beforeEach } from 'vitest'
import { Db, MemoryPersistence } from '../db/database'
import { initialiseFarm, login } from '../services/setup'
import type { Ctx } from '../services/context'
import { createSeason } from '../services/seasons'
import { createSeedbed } from '../services/seedbeds'
import { saveTrayType } from '../services/traytypes'
import { createTray } from '../services/trays'
import { askBrain, DEFAULT_BRAIN, type BrainSettings } from './ask'
import { cellText, templateSentence } from './catalogue'
import { extractParams, numbersGrounded } from './engine'

const d = (days: number) => new Date(Date.now() + days * 864e5).toISOString().slice(0, 10)
const rules: BrainSettings = { ...DEFAULT_BRAIN, engine: 'rules' }
let db: Db; let o: Ctx; let sbSeason: string
const ask = (q: string) => askBrain(o, q, { settings: rules })

// Walk-through D1/D4: a tobacco season that starts later than the active seedbed season must not hijack the seedbed lookups.
beforeEach(async () => {
  db = await Db.open(new MemoryPersistence())
  await initialiseFarm(db, { tenantName: 'T', farmName: 'F', ownerName: 'Lovemore', ownerPin: '1234' })
  o = { db, ...(await login(db, 'Lovemore', '1234')).ctx! }
  db.update('farms', o.farmId, { modules: 'tobacco,seedbed' })
  createSeason(o, { label: '2026/27', starts_on: d(-30), ends_on: d(300), activate: true })
  sbSeason = createSeason(o, { label: 'SB 2026', starts_on: d(-60), ends_on: d(100), enterprise: 'seedbed', activate: true })
  const bay = createSeedbed(o, { season_id: sbSeason, code: 'BAY-001', kind: 'float_bay' })
  const tt = saveTrayType(o, { name: '200-cell', cells: 200, length_mm: null, width_mm: null, media: null, note: null })
  createTray(o, { seedbed_id: bay, tray_type_id: tt, sown_on: d(-40), actual_seedlings: 180, expected_seedlings: 200 })
  db.insert('cost_entries', { tenant_id: o.tenantId, farm_id: o.farmId, season_id: sbSeason, category: 'labour', amount: 10, occurred_on: d(-20), seedbed_id: bay, field_id: null, tray_id: null, source_type: 'test', source_id: null, note: null })
})

describe('seedbed lookups default to the seedbed module season (D1)', () => {
  for (const [q, id] of [['cost per seedling in the float bay', 'cost_per_seedling'], ['how much have the seedbeds cost', 'seedbed_cost'], ['tray survival in the float bay', 'tray_survival'], ['float water top up in the bay', 'bay_operations']] as const)
    it(`${id}: no season named -> SB 2026`, async () => { const a = await ask(q); expect(a.id).toBe(id); expect(a.params.season).toBe('SB 2026') })
  it('rows come back for the headline question', async () => { const a = await ask('cost per seedling in the float bay'); expect(a.rows).toEqual([{ seedbed: 'BAY-001', unit: 'T-001', per_seedling: 0.0556 }]) })
  it('other lookups keep the newest active season of any module', async () => { expect((await ask('what did we spend by category')).params.season).toBe('2026/27') })
  it('no active seedbed season: no rows, a clear message, no run against the tobacco season, no exception', async () => {
    db.update('seasons', sbSeason, { status: 'closed' })
    for (const q of ['cost per seedling in the float bay', 'how much have the seedbeds cost', 'tray survival in the float bay', 'float water top up in the bay']) {
      const a = await ask(q); expect(a.rows).toEqual([]); expect(a.sentence).toBe('No active seedbed season yet — create one in the Seedbed module')
    }
    expect((await ask('what did we spend by category')).params.season).toBe('2026/27')   // other lookups unaffected
  })
  it('a farm without the seedbed module says the same', async () => {
    db.update('seasons', sbSeason, { status: 'closed' }); db.update('farms', o.farmId, { modules: 'tobacco' })
    const a = await ask('cost per seedling in the float bay'); expect(a.rows).toEqual([]); expect(a.sentence).toMatch(/No active seedbed season yet/)
  })
})

describe('naming a seedbed season (D4)', () => {
  it('extractParams recognises a known label that is not a year pair', () => {
    const i = { question: 'cost per seedling in SB 2026', spec: [], seasons: ['2026/27', 'SB 2026'], fields: [], people: [], today: d(0) }
    expect(extractParams(i).season).toBe('SB 2026'); expect(extractParams({ ...i, question: 'cost per seedling in sb 2026?' }).season).toBe('SB 2026')
    expect(extractParams({ ...i, question: 'cost per seedling' }).season).toBeUndefined()
  })
  it('naming SB 2026 works even when it is not the default, and a shared label resolves inside the seedbed module', async () => {
    db.update('seasons', sbSeason, { status: 'planned' })
    expect((await ask('cost per seedling in SB 2026')).params.season).toBe('SB 2026')
    // same label in both modules: the seedbed lookup reads the seedbed one
    db.update('seasons', sbSeason, { label: '2026/27' })
    const a = await ask('cost per seedling in the float bay for 2026/27'); expect(a.rows).toHaveLength(1)
  })
})

describe('season label matching is conservative (D4 hardening)', () => {
  const x = (question: string, seasons: string[]) => extractParams({ question, spec: [], seasons, fields: [], people: [], today: d(0) }).season
  it('a numeric label is ignored next to a date or a year pair; a common-word label needs a trigger word', () => {
    expect(x('harvest on 2026-09-01', ['2026', '2026/27'])).toBeUndefined(); expect(x('harvest in 2026/28', ['2026'])).toBeUndefined(); expect(x('costs in 2026', ['2026'])).toBe('2026')
    expect(x('main field harvest', ['Main'])).toBeUndefined(); expect(x('costs in Main', ['Main'])).toBe('Main'); expect(x('costs for the main season', ['Main'])).toBe('Main'); expect(x('Main', ['Main'])).toBe('Main')
    expect(x('cost per seedling in SB 2026', ['SB 2026', '2026/27'])).toBe('SB 2026')
  })
})

describe('numbers in a model sentence (D3 hardening)', () => {
  it('only per_seedling may be quoted beyond 2 decimals', () => {
    expect(numbersGrounded('costs 0.0566 each', [{ per_seedling: 0.0566 }])).toBe(true)
    expect(numbersGrounded('costs 12.3456', [{ cost: 12.3456 }])).toBe(false); expect(numbersGrounded('costs 12.35', [{ cost: 12.3456 }])).toBe(true)
  })
})

describe('cost per seedling keeps its precision (D3)', () => {
  it('per_seedling shows 4 decimals, money stays at 2', () => {
    expect(cellText('per_seedling', 0.0566)).toBe('0.0566'); expect(cellText('per_seedling', 1)).toBe('1.0000'); expect(cellText('per_seedling', 'pending')).toBe('pending')
    expect(cellText('cost', 12.3456)).toBe('12.35'); expect(cellText('seedlings', 1200)).toBe('1,200'); expect(cellText('cost', null)).toBe('—')
    expect(templateSentence('Cost per seedling', [{ seedbed: 'B', unit: 'T-001', per_seedling: 0.0566 }])).toContain('0.0566')
  })
})
