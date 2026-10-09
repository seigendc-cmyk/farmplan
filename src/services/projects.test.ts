import { describe, it, expect, beforeEach } from 'vitest'
import { Db, MemoryPersistence } from '../db/database'
import { initialiseFarm, login, createUser } from './setup'
import { type Ctx, PermissionError, ValidationError } from './context'
import { createRole } from './roles'
import { createSeason, setSeasonStatus } from './seasons'
import { advanceProject, backProject, editProjectNotes, getProject, listProjects, projectHistory, projectOfSeason } from './projects'
import { stagesOf } from '../modules/stages'
import { approveBaseline } from './budgetplan'

let db: Db; let o: Ctx; let season: string; let pid: string
const ins = (t: string, r: Record<string, string | number | null>) => db.insert(t, { tenant_id: o.tenantId, farm_id: o.farmId, ...r })
const stage = () => getProject(o, pid).stage
const plan = () => db.run(`UPDATE projects SET plan_ha=2, plan_yield_kg_ha=2000 WHERE id=?`, [pid])
beforeEach(async () => {
  db = await Db.open(new MemoryPersistence())
  await initialiseFarm(db, { tenantName: 'T', farmName: 'F', ownerName: 'Lovemore', ownerPin: '1234' })
  o = { db, ...(await login(db, 'Lovemore', '1234')).ctx! }
  season = createSeason(o, { label: '2026/27', starts_on: '2026-09-01', ends_on: '2027-08-31', activate: true }); pid = projectOfSeason(o, season)!.id
})
const asRole = async (name: string, perms: string[]) => { await createUser(o, name, '5555', createRole(o, `${name} role`, perms)); return { db, ...(await login(db, name, '5555')).ctx! } as Ctx }

describe('creating projects', () => {
  it('a new season starts a project at Idea, with its first history row', () => {
    const p = getProject(o, pid)
    expect(p).toMatchObject({ season_id: season, module: 'tobacco', name: 'Tobacco 2026/27', stage: 'idea', stage_label: 'Idea', next: 'planning', skip_to: null })
    expect(projectHistory(o, pid)).toMatchObject([{ kind: 'create', from_stage: null, to_stage: 'idea' }]); expect(listProjects(o)).toHaveLength(1)
  })
  it('a season gets one project only', () => { expect(db.all(`SELECT 1 FROM projects WHERE season_id=?`, [season])).toHaveLength(1) })
  it('tobacco has ten stages and Contracted is the only optional one', () => {
    expect(stagesOf('tobacco').map(s => s.id)).toEqual(['idea', 'planning', 'budget', 'funding', 'contracted', 'land_seedbed', 'growing', 'harvest_curing', 'grading_marketing', 'closed'])
    expect(stagesOf('tobacco').filter(s => s.optional).map(s => s.id)).toEqual(['contracted'])
  })
})

describe('moving between stages', () => {
  it('advances one stage at a time and records who, when and the new stage', () => {
    advanceProject(o, pid); expect(stage()).toBe('planning'); plan(); advanceProject(o, pid, { reason: 'Plan agreed' }); expect(stage()).toBe('budget')
    const h = projectHistory(o, pid); expect(h.map(x => x.to_stage)).toEqual(['idea', 'planning', 'budget']); expect(h[2]).toMatchObject({ kind: 'advance', from_stage: 'planning', reason: 'Plan agreed', actor_name: 'Lovemore' })
  })
  it('will not leave Planning until hectares and yield are set, nor Budget until a baseline is approved', () => {
    advanceProject(o, pid); expect(getProject(o, pid).unmet).toEqual(['Enter the planned hectares and expected yield']); expect(() => advanceProject(o, pid)).toThrow(/Not ready to leave Planning/)
    plan(); advanceProject(o, pid); expect(stage()).toBe('budget')
    expect(getProject(o, pid).unmet).toEqual(['Approve the budget as the baseline'])
    expect(() => advanceProject(o, pid)).toThrow(/Not ready to leave Budget: Approve the budget as the baseline/); expect(stage()).toBe('budget')
    ins('budgets', { season_id: season, category: 'seed', amount: 100 }); expect(getProject(o, pid).unmet).toHaveLength(1)   // a budget line alone is not an approved baseline
    approveBaseline(o, season); expect(getProject(o, pid).unmet).toEqual([]); advanceProject(o, pid); expect(stage()).toBe('funding')
  })
  it('Contracted can be skipped, and the skip is written in the history', () => {
    db.run(`UPDATE projects SET stage='funding' WHERE id=?`, [pid]); expect(getProject(o, pid).skip_to).toBe('land_seedbed')
    expect(() => advanceProject(o, pid, { to: 'growing' })).toThrow(/Cannot move/)
    advanceProject(o, pid, { to: 'land_seedbed' }); expect(stage()).toBe('land_seedbed'); expect(projectHistory(o, pid).at(-1)!.reason).toMatch(/Skipped Contracted \(optional\)/)
  })
  it('a required stage cannot be skipped, and nothing moves past the last stage', () => {
    expect(() => advanceProject(o, pid, { to: 'budget' })).toThrow(/Cannot move/)
    db.run(`UPDATE projects SET stage='closed' WHERE id=?`, [pid]); expect(() => advanceProject(o, pid)).toThrow(/last stage/)
  })
  it('each later requirement reads the season’s own records', () => {
    const field = ins('fields', { field_no: 'F1', area_ha: 2 })
    db.run(`UPDATE projects SET stage='land_seedbed' WHERE id=?`, [pid]); expect(getProject(o, pid).unmet).toEqual(['Record at least one seedbed'])
    const sb = ins('seedbeds', { season_id: season, code: 'SB1' }); expect(getProject(o, pid).unmet).toEqual([])
    db.run(`UPDATE projects SET stage='growing' WHERE id=?`, [pid]); expect(getProject(o, pid).unmet).toEqual(['Record transplanting'])
    ins('transplants', { season_id: season, seedbed_id: sb, field_id: field, occurred_on: '2026-11-01', qty: 100 }); expect(getProject(o, pid).unmet).toEqual([])
    db.run(`UPDATE projects SET stage='harvest_curing' WHERE id=?`, [pid]); expect(getProject(o, pid).unmet).toEqual(['Record at least one harvest batch'])
    ins('harvest_batches', { season_id: season, code: 'H1', field_id: field, harvested_on: '2027-01-10', green_weight_kg: 50 }); expect(getProject(o, pid).unmet).toEqual([])
    db.run(`UPDATE projects SET stage='grading_marketing' WHERE id=?`, [pid]); expect(getProject(o, pid).unmet).toEqual(['Record at least one sale'])
    ins('sales', { season_id: season, code: 'S1', sold_on: '2027-03-01' }); expect(getProject(o, pid).unmet).toEqual(['Close the season'])
    setSeasonStatus(o, season, 'closed'); expect(getProject(o, pid).unmet).toEqual([]); advanceProject(o, pid); expect(stage()).toBe('closed')
  })
  it('another season’s records do not count', () => {
    const other = createSeason(o, { label: '2027/28', starts_on: '2027-09-01', ends_on: '2028-08-31' }); ins('budgets', { season_id: other, category: 'seed', amount: 5 })
    db.run(`UPDATE projects SET stage='budget' WHERE id=?`, [pid]); expect(getProject(o, pid).unmet).toHaveLength(1)
  })
})

describe('going back and overriding', () => {
  it('goes back one stage with a reason, and the history keeps both moves', () => {
    advanceProject(o, pid); expect(() => backProject(o, pid, ' ')).toThrow(/what was wrong/); backProject(o, pid, 'Wrong season picked'); expect(stage()).toBe('idea')
    expect(projectHistory(o, pid).map(h => h.kind)).toEqual(['create', 'advance', 'back']); expect(() => backProject(o, pid, 'again')).toThrow(/first stage/)
  })
  it('an unmet requirement needs the override right and a reason, and the override is logged', async () => {
    db.run(`UPDATE projects SET stage='budget' WHERE id=?`, [pid])
    const mgr = await asRole('Mgr', ['projects.project.view', 'projects.stage.advance'])
    expect(() => advanceProject(mgr, pid)).toThrow(/Not ready/); expect(() => advanceProject(mgr, pid, { override: true, reason: 'x' })).toThrow(PermissionError)
    expect(() => advanceProject(o, pid, { override: true })).toThrow(/Say why/)
    advanceProject(o, pid, { override: true, reason: 'Budget agreed on paper' }); expect(stage()).toBe('funding')
    const h = projectHistory(o, pid).at(-1)!; expect(h.kind).toBe('override'); expect(h.reason).toContain('Budget agreed on paper'); expect(h.reason).toContain('Approve the budget as the baseline')
    const ev = db.all<{ summary: string; verb: string }>(`SELECT summary, verb FROM activity_log WHERE verb='project.override'`); expect(ev).toHaveLength(1); expect(ev[0].summary).toMatch(/Moved past an unmet requirement: Tobacco 2026\/27 from Budget to Funding — .*Budget agreed on paper/)
  })
  it('an ordinary move writes an activity event with no money in it', () => {
    advanceProject(o, pid); const ev = db.all<{ summary: string }>(`SELECT summary FROM activity_log WHERE verb='project.advance'`)
    expect(ev.map(e => e.summary)).toEqual(['Moved: Tobacco 2026/27 from Idea to Planning'])
  })
})

describe('permissions and notes', () => {
  it('viewing, advancing and editing notes are separate rights', async () => {
    const none = await asRole('Nobody', ['settings.farm.view']); expect(() => listProjects(none)).toThrow(PermissionError)
    const viewer = await asRole('Viewer', ['projects.project.view']); expect(listProjects(viewer)).toHaveLength(1)
    expect(() => advanceProject(viewer, pid)).toThrow(PermissionError); expect(() => backProject(viewer, pid, 'x')).toThrow(PermissionError); expect(() => editProjectNotes(viewer, pid, 'n')).toThrow(PermissionError)
    editProjectNotes(o, pid, '  Winter crop  '); expect(getProject(o, pid).notes).toBe('Winter crop'); editProjectNotes(o, pid, ''); expect(getProject(o, pid).notes).toBeNull()
  })
  it('a Farm Manager gets view, notes and advance but not override; a Field Recorder sees nothing', async () => {
    const roles = db.all<{ name: string; permission: string }>(`SELECT r.name, rp.permission FROM roles r JOIN role_permissions rp ON rp.role_id=r.id WHERE rp.permission LIKE 'projects.%'`)
    expect(roles.filter(r => r.name === 'Farm Manager').map(r => r.permission).sort()).toEqual(['projects.project.edit', 'projects.project.view', 'projects.stage.advance'])
    expect(roles.some(r => r.name === 'Field Recorder')).toBe(false)
  })
  it('an unknown project id is refused', () => { expect(() => getProject(o, 'nope')).toThrow(ValidationError) })
  it('projects are hidden from field devices on the hub', async () => {
    const { HUB_NO_READ } = await import('./hub'); expect(HUB_NO_READ.has('projects')).toBe(true); expect(HUB_NO_READ.has('project_stage_history')).toBe(true)
  })
})

describe('existing data', () => {
  it('upgrading from v15 gives each tobacco season a project at the stage its data shows, and changes nothing else', async () => {
    const field = ins('fields', { field_no: 'F1', area_ha: 2 })
    const grow = createSeason(o, { label: 'Grow', starts_on: '2025-09-01', ends_on: '2026-08-31' }); const sb = ins('seedbeds', { season_id: grow, code: 'SB1' }); ins('transplants', { season_id: grow, seedbed_id: sb, field_id: field, occurred_on: '2025-11-01', qty: 10 })
    const sold = createSeason(o, { label: 'Sold', starts_on: '2024-09-01', ends_on: '2025-08-31' }); ins('sales', { season_id: sold, code: 'S1', sold_on: '2025-03-01' })
    const done = createSeason(o, { label: 'Done', starts_on: '2023-09-01', ends_on: '2024-08-31' }); setSeasonStatus(o, done, 'closed')
    const bud = createSeason(o, { label: 'Budgeted', starts_on: '2028-09-01', ends_on: '2029-08-31' }); ins('budgets', { season_id: bud, category: 'seed', amount: 10 })
    const before = db.all(`SELECT * FROM cost_entries`).length
    db.run(`DELETE FROM project_stage_history`); db.run(`DELETE FROM projects`); db.run(`UPDATE meta SET value='15' WHERE key='schema_version'`)
    db.run(`DELETE FROM role_permissions WHERE permission LIKE 'projects.%'`)
    const p = new MemoryPersistence(); p.data = db.exportBytes(); const up = await Db.open(p); const u = { ...o, db: up } as Ctx
    const by = Object.fromEntries(listProjects(u).map(x => [x.season, x.stage]))
    expect(by).toEqual({ '2026/27': 'planning', Grow: 'growing', Sold: 'grading_marketing', Done: 'closed', Budgeted: 'budget' })
    expect(projectHistory(u, listProjects(u)[0].id)[0]).toMatchObject({ kind: 'create' })
    expect(up.all(`SELECT * FROM cost_entries`)).toHaveLength(before)
    expect(up.get<{ value: string }>(`SELECT value FROM meta WHERE key='schema_version'`)!.value).toBe('17')
    expect(up.all(`SELECT 1 FROM role_permissions rp JOIN roles r ON r.id=rp.role_id WHERE r.name='Farm Manager' AND rp.permission='projects.stage.advance'`)).toHaveLength(1)
    const again = up.all(`SELECT 1 FROM projects`).length; const { backfillProjects } = await import('../db/projectlink'); backfillProjects(up); expect(up.all(`SELECT 1 FROM projects`)).toHaveLength(again)   // running it twice adds nothing
  })
})
