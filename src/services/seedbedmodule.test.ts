import { describe, it, expect, beforeEach } from 'vitest'
import { Db, MemoryPersistence } from '../db/database'
import { initialiseFarm, login, createUser } from './setup'
import { type Ctx, can } from './context'
import { createRole } from './roles'
import { createSeason, activeSeason } from './seasons'
import { accessibleModules } from './modules'
import { getProject, projectOfSeason } from './projects'
import { stagesOf } from '../modules/stages'
import { approveBaseline } from './budgetplan'

let db: Db; let o: Ctx; let season: string; let pid: string
const ins = (t: string, r: Record<string, string | number | null>) => db.insert(t, { tenant_id: o.tenantId, farm_id: o.farmId, ...r })
const at = (stage: string) => db.run(`UPDATE projects SET stage=? WHERE id=?`, [stage, pid])
const unmet = () => getProject(o, pid).unmet
beforeEach(async () => {
  db = await Db.open(new MemoryPersistence())
  await initialiseFarm(db, { tenantName: 'T', farmName: 'F', ownerName: 'Lovemore', ownerPin: '1234' })
  o = { db, ...(await login(db, 'Lovemore', '1234')).ctx! }
  db.run(`UPDATE farms SET modules=? WHERE id=?`, ['tobacco,seedbed', o.farmId])
  season = createSeason(o, { label: 'S1', starts_on: '2026-08-01', ends_on: '2026-11-30', enterprise: 'seedbed' }); pid = projectOfSeason(o, season)!.id
})

describe('seedbed module', () => {
  it('has the nine stages in order', () => {
    expect(stagesOf('seedbed').map(s => s.id)).toEqual(['idea', 'planning', 'budget', 'funding', 'sowing', 'growing', 'hardening', 'dispatched', 'closed'])
  })
  it('a seedbed season starts a project at idea', () => { expect(getProject(o, pid)).toMatchObject({ module: 'seedbed', stage: 'idea' }) })
  it('activating a seedbed season leaves the active tobacco season active', () => {
    const t = createSeason(o, { label: '2026/27', starts_on: '2026-09-01', ends_on: '2027-08-31', activate: true })
    const s2 = createSeason(o, { label: 'S2', starts_on: '2026-09-01', ends_on: '2026-12-31', enterprise: 'seedbed', activate: true })
    expect(activeSeason(o, 'tobacco')?.id).toBe(t); expect(activeSeason(o, 'seedbed')?.id).toBe(s2)
  })
  it('is open to roles holding a seedbed permission and closed to others', async () => {
    await createUser(o, 'Rec', '5555', createRole(o, 'Rec role', ['production.seedbed.view']))
    const r = { db, ...(await login(db, 'Rec', '5555')).ctx! } as Ctx
    expect(accessibleModules(r, p => can(r, p))).toEqual(expect.arrayContaining(['seedbed']))
    await createUser(o, 'Other', '6666', createRole(o, 'Other role', ['settings.farm.view']))
    const x = { db, ...(await login(db, 'Other', '6666')).ctx! } as Ctx
    expect(accessibleModules(x, p => can(x, p))).not.toContain('seedbed')
  })
})

describe('seedbed gates', () => {
  it('budget and funding match tobacco', () => {
    at('budget'); expect(unmet()).toEqual(['Approve the budget as the baseline'])
    ins('budgets', { season_id: season, category: 'seed', amount: 100 }); approveBaseline(o, season); expect(unmet()).toEqual([])
    at('funding'); expect(unmet()).toEqual(['Raise a funding request, or mark that no funding is needed'])
    db.run(`UPDATE projects SET funding_not_needed=1 WHERE id=?`, [pid]); expect(unmet()).toEqual([])
  })
  it('sowing needs a seedbed, growing needs a sowing date, hardening none, dispatched needs a transplant', () => {
    at('sowing'); expect(unmet()).toEqual(['Record at least one seedbed or bay'])
    const sb = ins('seedbeds', { season_id: season, code: 'SB1' }); expect(unmet()).toEqual([])
    at('growing'); expect(unmet()).toEqual(['Record a sowing date on a seedbed'])
    db.run(`UPDATE seedbeds SET sown_on='2026-08-10' WHERE id=?`, [sb]); expect(unmet()).toEqual([])
    at('hardening'); expect(unmet()).toEqual([])
    at('dispatched'); expect(unmet()).toEqual(['Record at least one transplant from this season\'s seedbeds'])
    const field = ins('fields', { field_no: 'F1', area_ha: 2 })
    ins('transplants', { season_id: season, seedbed_id: sb, field_id: field, occurred_on: '2026-09-20', qty: 10 }); expect(unmet()).toEqual([])
  })
})
