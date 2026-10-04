import { describe, it, expect, beforeEach } from 'vitest'
import { Db, MemoryPersistence } from '../db/database'
import { initialiseFarm, login, createUser } from './setup'
import type { Ctx } from './context'
import { createSeason } from './seasons'
import { createField } from './fields'
import { recordHarvest, deleteHarvest } from './harvest'
import { recordWeather } from './weather'
import { createRole, setRolePermissions } from './roles'
import { accessFilter, activityActors, canSeeAnyActivity, listActivity, recordNote } from './activity'
import { BRAIN_LEVELS, brainLevelOf } from '../lib/permissions'
import { runMigrations } from '../db/migrations'
import { hubHandle, setHubEnabled, createPairing } from './hub'
import { joinHub, syncViaHub, type FetchLike } from './lan'
import { backfillActivity } from '../db/activity'

let db: Db; let o: Ctx; let season: string; let fieldId: string
const asUser = async (name: string, role: string) => {
  const rid = db.get<{ id: string }>(`SELECT id FROM roles WHERE name=?`, [role])!.id
  await createUser(o, name, '1111', rid); const r = await login(db, name, '1111'); const c = { db, ...r.ctx! } as Ctx; await login(db, 'Lovemore', '1234'); return c
}
beforeEach(async () => {
  db = await Db.open(new MemoryPersistence())
  await initialiseFarm(db, { tenantName: 'T', farmName: 'F', ownerName: 'Lovemore', ownerPin: '1234' })
  const r = await login(db, 'Lovemore', '1234'); o = { db, ...r.ctx! }
  season = createSeason(o, { label: '2026/27', starts_on: '2026-09-01', ends_on: '2027-08-31', activate: true })
  fieldId = createField(o, { field_no: 'F-04', area_ha: 4 })
})

describe('automatic capture', () => {
  it('writes a readable sentence for each save, with the person who did it', () => {
    const h = recordHarvest(o, { field_id: fieldId, season_id: season, harvested_on: '2027-01-20', green_weight_kg: 2000 })
    const ev = listActivity(o, { q: 'harvest' })
    expect(ev[0].summary).toMatch(/2000 kg green from F-04/); expect(ev[0].actor_name).toBe('Lovemore'); expect(ev[0].domain).toBe('ops'); expect(ev[0].field_no).toBe('F-04')
    deleteHarvest(o, h.id); expect(listActivity(o, { q: 'Removed harvest' })).toHaveLength(1)
  })
  it('skips child rows that only repeat their parent, and never puts money in an operations sentence', () => {
    recordHarvest(o, { field_id: fieldId, season_id: season, harvested_on: '2027-01-20', green_weight_kg: 100 })
    const tables = db.all<{ table_name: string }>(`SELECT DISTINCT table_name FROM activity_log WHERE table_name IS NOT NULL`).map(r => r.table_name)
    for (const t of ['cost_entries', 'sale_lines', 'operation_inputs', 'activity_log']) expect(tables).not.toContain(t)
  })
  it('sales are finance-level events and do not state the price', () => {
    const bale = db.get<{ n: number }>(`SELECT COUNT(*) n FROM activity_log WHERE domain='finance' AND summary GLOB '*[$]*'`)!.n; expect(bale).toBe(0)
  })
  it('records role and user changes as admin events', async () => {
    const rid = createRole(o, 'Scout', []); setRolePermissions(o, rid, ['brain.note.record'])
    const admin = listActivity(o, { domain: 'admin' }).map(e => e.summary).join('\n'); expect(admin).toMatch(/Created role Scout/); expect(admin).toMatch(/permissions of role Scout/)
  })
})

describe('access levels', () => {
  it('the owner sees every domain; a manager sees ops and finance but not admin; a recorder sees only their own', async () => {
    const mgr = await asUser('Mary', 'Farm Manager'); const rec = await asUser('Tendai', 'Field Recorder')
    recordHarvest(rec, { field_id: fieldId, season_id: season, harvested_on: '2027-01-20', green_weight_kg: 300 })
    recordHarvest(o, { field_id: fieldId, season_id: season, harvested_on: '2027-01-21', green_weight_kg: 400 })
    const doms = new Set(listActivity(o).map(e => e.domain)); expect(doms.has('ops') && doms.has('admin')).toBe(true)
    expect(listActivity(mgr).some(e => e.domain === 'admin' && e.actor_name !== 'Mary')).toBe(false); expect(listActivity(mgr).some(e => /400 kg/.test(e.summary))).toBe(true)
    const own = listActivity(rec); expect(own.length).toBeGreaterThan(0); expect(own.every(e => e.actor_name === 'Tendai')).toBe(true); expect(own.some(e => /400 kg/.test(e.summary))).toBe(false)
    expect(activityActors(rec)).toEqual(['Tendai'])
  })
  it('a role with no brain access cannot read anything, and the filter is closed by default', async () => {
    const rid = createRole(o, 'Visitor', ['production.field.view']); await createUser(o, 'Vic', '2222', rid); const r = await login(db, 'Vic', '2222'); const v = { db, ...r.ctx! } as Ctx
    expect(canSeeAnyActivity(v)).toBe(false); expect(() => listActivity(v)).toThrow(/access/); expect(accessFilter(v).sql).toBe('0')
  })
  it('admin-assigned levels map back to the permission sets', () => {
    for (const l of BRAIN_LEVELS) expect(brainLevelOf(l.perms)).toBe(l.id)
    expect(brainLevelOf(['brain.log.view_finance'])).toBeNull()
  })
  it('a custom level takes effect when the admin changes a role', async () => {
    const rid = createRole(o, 'Auditor', ['production.field.view']); await createUser(o, 'Ada', '3333', rid)
    const login1 = async () => ({ db, ...(await login(db, 'Ada', '3333')).ctx! }) as Ctx
    expect(canSeeAnyActivity(await login1())).toBe(false)
    await login(db, 'Lovemore', '1234'); setRolePermissions(o, rid, BRAIN_LEVELS.find(l => l.id === 'mgmt')!.perms)
    const a = await login1(); expect(canSeeAnyActivity(a)).toBe(true); expect(listActivity(a).some(e => e.domain === 'admin' && e.actor_name !== 'Ada')).toBe(false)
  })
})

describe('notes, search and filters', () => {
  it('adds a note with an optional field and visibility, and finds it by words, person, kind, field and date', () => {
    recordNote(o, { text: 'Hail damage along the north edge, about a third of the leaves', field_id: fieldId, visibility: 'finance' })
    recordNote(o, { text: 'Bought tape' }); recordWeather(o, { season_id: season, recorded_on: '2027-01-20', rainfall_mm: 12 })
    expect(listActivity(o, { q: 'hail north' })).toHaveLength(1); expect(listActivity(o, { kind: 'note' })).toHaveLength(2); expect(listActivity(o, { fieldId, kind: 'note' })).toHaveLength(1)
    expect(listActivity(o, { actor: 'lovemore', kind: 'note' })).toHaveLength(2); expect(listActivity(o, { from: '2000-01-01', to: '2000-01-02' })).toHaveLength(0)
    expect(listActivity(o, { q: '100%' })).toHaveLength(0)
  })
  it('long notes keep the full text in the body; empty and over-long notes are refused', () => {
    const id = recordNote(o, { text: 'x'.repeat(300) }); const e = listActivity(o, { kind: 'note' })[0]; expect(e.id).toBe(id); expect(e.summary.length).toBeLessThanOrEqual(160); expect(e.body).toHaveLength(300)
    expect(() => recordNote(o, { text: '  ' })).toThrow(/Write something/); expect(() => recordNote(o, { text: 'x'.repeat(4001) })).toThrow(/4000/)
  })
  it('a note cannot be made readable only at a level its author cannot read themselves', async () => {
    const rec = await asUser('Tendai', 'Field Recorder'); expect(() => recordNote(rec, { text: 'hi', visibility: 'finance' })).toThrow(/level you can read/)
    recordNote(rec, { text: 'Saw a leak at barn 2' }); expect(listActivity(rec, { kind: 'note' })).toHaveLength(1)
  })
})

describe('upgrade and the hub', () => {
  it('backfills a history for an existing farm on upgrade, once', () => {
    recordHarvest(o, { field_id: fieldId, season_id: season, harvested_on: '2027-01-20', green_weight_kg: 500 })
    db.run(`DELETE FROM activity_log`); expect(db.get<{ n: number }>(`SELECT COUNT(*) n FROM activity_log`)!.n).toBe(0)
    runMigrations(db, 10); const n = db.get<{ n: number }>(`SELECT COUNT(*) n FROM activity_log WHERE kind='system'`)!.n; expect(n).toBeGreaterThan(0)
    expect(listActivity(o, { q: '500 kg' })[0].actor_name).toBeNull()
    backfillActivity(db); backfillActivity(db)
  })
  it('a phone event reaches the office through the hub, but the hub never serves the log back', async () => {
    setHubEnabled(db, true); const URL_ = 'http://192.168.1.20:7878'
    const f: FetchLike = async (url, init) => { const u = new URL(url); const r = await hubHandle(db, { method: init?.method ?? 'GET', path: u.pathname + u.search, auth: init?.headers?.Authorization ?? null, body: init?.body ? JSON.parse(init.body) : undefined }); const body = JSON.parse(JSON.stringify(r.body)); return { status: r.status, ok: r.status < 300, json: async () => body } }
    const phone = await Db.open(new MemoryPersistence()); const { code } = await createPairing(o, 'P'); await joinHub(phone, { hubUrl: URL_, code, name: 'Tendai', pin: '1111' }, f)
    const r = await login(phone, 'Tendai', '1111'); const pc = { db: phone, ...r.ctx! } as Ctx
    recordWeather(pc, { season_id: season, recorded_on: '2027-01-20', rainfall_mm: 7 })
    expect((await syncViaHub(phone, pc.tenantId, f)).errors).toEqual([])
    const e = listActivity(o, { q: '7 mm' }); expect(e).toHaveLength(1); expect(e[0].actor_name).toBe('Tendai'); expect(e[0].device_tag).toBe('LA')
    const tok = phone.get<{ value: string }>(`SELECT value FROM meta WHERE key='hub_token'`)!.value
    expect((await hubHandle(db, { method: 'GET', path: '/pull?table=activity_log', auth: 'Bearer ' + tok })).body).toEqual({ rows: [] })
  })
})
