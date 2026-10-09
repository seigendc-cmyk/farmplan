import { describe, it, expect, beforeEach } from 'vitest'
import { Db, MemoryPersistence } from '../db/database'
import { initialiseFarm, login, createUser } from './setup'
import { type Ctx, PermissionError, ValidationError, can } from './context'
import { createRole } from './roles'
import { createSeason, setSeasonStatus, activeSeason, listSeasons } from './seasons'
import { enabledModules, currentModule, accessibleModules, setFarmModules } from './modules'
import { parseModules } from '../modules/registry'

let db: Db; let o: Ctx
const enable = (ids: string) => db.run(`UPDATE farms SET modules=? WHERE id=?`, [ids, o.farmId])   // stands in for a module that does not exist yet
beforeEach(async () => {
  db = await Db.open(new MemoryPersistence())
  await initialiseFarm(db, { tenantName: 'T', farmName: 'F', ownerName: 'Lovemore', ownerPin: '1234' })
  o = { db, ...(await login(db, 'Lovemore', '1234')).ctx! }
})

describe('enabled modules', () => {
  it('a new farm runs Tobacco only, and the owner can use it', () => {
    expect(enabledModules(o)).toEqual(['tobacco']); expect(currentModule(o)).toBe('tobacco'); expect(accessibleModules(o, p => can(o, p))).toEqual(['tobacco'])
  })
  it('reads a stored list, drops unknown ids and falls back to Tobacco when empty', () => {
    expect(parseModules('tobacco, orchards,tobacco,nonsense')).toEqual(['tobacco', 'orchards']); expect(parseModules('')).toEqual(['tobacco']); expect(parseModules(null)).toEqual(['tobacco']); expect(parseModules('nonsense')).toEqual(['tobacco'])
  })
  it('the current module is the person’s choice only while it is enabled', () => {
    enable('tobacco,horticulture')
    expect(currentModule({ ...o, module: 'horticulture' })).toBe('horticulture'); expect(currentModule({ ...o, module: 'livestock' })).toBe('tobacco'); expect(currentModule(o)).toBe('tobacco')
  })
  it('only an owner-level right switches modules, and only available modules can be enabled', async () => {
    await createUser(o, 'Mgr', '5555', createRole(o, 'Manager', ['settings.farm.view', 'settings.season.view']))
    const m = { db, ...(await login(db, 'Mgr', '5555')).ctx! } as Ctx
    expect(() => setFarmModules(m, ['tobacco'])).toThrow(PermissionError)
    expect(() => setFarmModules(o, ['tobacco', 'horticulture'])).toThrow(/not available yet/)
    expect(() => setFarmModules(o, ['bogus'])).toThrow(ValidationError)
    expect(() => setFarmModules(o, [])).toThrow(/at least one/)
    setFarmModules(o, ['tobacco']); expect(enabledModules(o)).toEqual(['tobacco'])
  })
  it('refuses to switch a module off while it has an active season, and keeps its records when it is switched off', () => {
    enable('tobacco,horticulture')
    const h = createSeason(o, { label: 'Tomato winter 2027', starts_on: '2027-03-01', ends_on: '2027-08-31', enterprise: 'horticulture', activate: true })
    expect(() => setFarmModules(o, ['tobacco'])).toThrow(/active season/)
    setSeasonStatus(o, h, 'closed'); setFarmModules(o, ['tobacco'])
    expect(enabledModules(o)).toEqual(['tobacco']); expect(listSeasons(o).some(s => s.id === h)).toBe(true)
  })
})

describe('one active season per module', () => {
  it('activating a season in one module leaves the other module’s active season alone', () => {
    enable('tobacco,horticulture')
    const t = createSeason(o, { label: '2026/27', starts_on: '2026-09-01', ends_on: '2027-08-31', activate: true })
    const h1 = createSeason(o, { label: 'Tomato winter 2027', starts_on: '2027-03-01', ends_on: '2027-08-31', enterprise: 'horticulture', activate: true })
    expect(activeSeason(o, 'tobacco')?.id).toBe(t); expect(activeSeason(o, 'horticulture')?.id).toBe(h1)
    const h2 = createSeason(o, { label: 'Onion summer 2027', starts_on: '2027-09-01', ends_on: '2028-02-28', enterprise: 'horticulture' })
    setSeasonStatus(o, h2, 'active')
    expect(activeSeason(o, 'horticulture')?.id).toBe(h2); expect(activeSeason(o, 'tobacco')?.id).toBe(t)
    expect(listSeasons(o).find(s => s.id === h1)?.status).toBe('planned')
  })
  it('activeSeason follows the module the person is working in', () => {
    enable('tobacco,horticulture')
    const t = createSeason(o, { label: '2026/27', starts_on: '2026-09-01', ends_on: '2027-08-31', activate: true })
    const h = createSeason(o, { label: 'Tomato', starts_on: '2027-03-01', ends_on: '2027-08-31', enterprise: 'horticulture', activate: true })
    expect(activeSeason(o)?.id).toBe(t); expect(activeSeason({ ...o, module: 'horticulture' })?.id).toBe(h)
  })
  it('a season cannot be created for a module the farm has not switched on, and defaults to the current module', () => {
    expect(() => createSeason(o, { label: 'X', starts_on: '2027-03-01', ends_on: '2027-08-31', enterprise: 'horticulture' })).toThrow(/not switched on/)
    const id = createSeason(o, { label: '2026/27', starts_on: '2026-09-01', ends_on: '2027-08-31', activate: true })
    expect(listSeasons(o).find(s => s.id === id)?.enterprise).toBe('tobacco')
  })
  it('an unknown season id is refused', () => { expect(() => setSeasonStatus(o, 'nope', 'active')).toThrow(/not found/) })
})

describe('existing data', () => {
  it('upgrades a v14 database: every farm keeps Tobacco only and nothing else changes', async () => {
    const s = createSeason(o, { label: '2026/27', starts_on: '2026-09-01', ends_on: '2027-08-31', activate: true })
    db.run(`ALTER TABLE farms DROP COLUMN modules`); db.run(`UPDATE meta SET value='14' WHERE key='schema_version'`)
    const p = new MemoryPersistence(); p.data = db.exportBytes(); const up = await Db.open(p); const u = { ...o, db: up }
    expect(up.get<{ value: string }>(`SELECT value FROM meta WHERE key='schema_version'`)!.value).toBe('15')
    expect(up.all<{ name: string }>(`PRAGMA table_info(farms)`).map(c => c.name)).toContain('modules')
    expect(enabledModules(u)).toEqual(['tobacco']); expect(activeSeason(u)?.id).toBe(s)
  })
})
