import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { Db, MemoryPersistence, type Row } from '../db/database'
import { initialiseFarm, login, isInitialised } from './setup'
import { type Ctx, PermissionError } from './context'
import { createSeason, setSeasonStatus } from './seasons'
import { createField, listFields } from './fields'
import { recordHarvest, listHarvests } from './harvest'
import { recordLabour, listLabour, deleteLabour } from './labour'
import { recordWeather, listWeather } from './weather'
import { setDeviceTag, deviceTag } from './device'
import { joinFarm } from './devices'
import { syncNow, type CloudClient } from './sync'

class FakeCloud implements CloudClient {
  tables = new Map<string, Map<string, Row>>(); clock = 1_800_000_000_000
  async claimTenant() {}
  async upsert(table: string, rows: Record<string, unknown>[]) { const t = this.tables.get(table) ?? new Map(); this.tables.set(table, t); for (const r of rows) t.set(r.id as string, { ...r, updated_at: new Date(this.clock += 1000).toISOString() } as Row) }
  async fetchSince(table: string, since: string | null, limit: number) {
    return [...(this.tables.get(table)?.values() ?? [])].filter(r => !since || String(r.updated_at) > since).sort((a, b) => String(a.updated_at).localeCompare(String(b.updated_at))).slice(0, limit)
  }
}
async function office(): Promise<{ db: Db; ctx: Ctx }> {
  const db = await Db.open(new MemoryPersistence()); await initialiseFarm(db, { tenantName: 'Brechin', farmName: 'Brechin Farm', ownerName: 'Owner', ownerPin: '1234' })
  const r = await login(db, 'Owner', '1234'); return { db, ctx: { db, ...r.ctx! } }
}
const setup = (ctx: Ctx) => ({ season: createSeason(ctx, { label: '2026/27', starts_on: '2026-09-01', ends_on: '2027-08-31', activate: true }), field: createField(ctx, { field_no: 'F-01', area_ha: 3 }) })

/** A stand-in for the Supabase client with just the calls joinFarm makes. */
function fakeSb(src: Db, tenantId: string, roleName: string, tag: string, opts: { member?: boolean } = {}): SupabaseClient {
  const role = src.get<{ id: string; name: string; is_system: number }>(`SELECT * FROM roles WHERE tenant_id=? AND name=?`, [tenantId, roleName])!
  const tenant = src.get<{ name: string }>(`SELECT name FROM tenants WHERE id=?`, [tenantId])!
  return {
    rpc: async (n: string) => n === 'my_farms' ? { data: opts.member === false ? [] : [{ tenant_id: tenantId, tenant_name: tenant.name, role_id: role.id, role_name: role.name }], error: null } : n === 'register_device' ? { data: tag, error: null } : { data: null, error: { message: `rpc ${n}` } },
    from: (t: string) => ({ select: () => ({ eq: async () => ({ data: t === 'roles' ? src.all(`SELECT id,name,is_system FROM roles WHERE tenant_id=?`, [tenantId]).map(r => ({ ...r, is_system: !!r.is_system })) : src.all(`SELECT role_id,permission FROM role_permissions WHERE tenant_id=?`, [tenantId]), error: null }) }) }),
  } as unknown as SupabaseClient
}

describe('labour', () => {
  it('records pay as a labour cost, and delete reverses it', async () => {
    const { ctx } = await office(); const { season, field } = setup(ctx)
    const id = recordLabour(ctx, { season_id: season, field_id: field, worked_on: '2026-10-05', worker_name: 'Tendai', task: 'Weeding', hours: 8, pay_amount: 6 })
    expect(listLabour(ctx)[0]).toMatchObject({ worker_name: 'Tendai', field_no: 'F-01', hours: 8, pay_amount: 6 })
    expect(ctx.db.get<{ s: number }>(`SELECT SUM(amount) s FROM cost_entries WHERE category='labour' AND deleted_at IS NULL`)!.s).toBe(6)
    expect(() => recordLabour(ctx, { season_id: season, worked_on: '2026-10-05', worker_name: ' ', task: 'x' })).toThrow(/Worker/)
    expect(() => recordLabour(ctx, { season_id: season, worked_on: '2026-10-05', worker_name: 'A', task: 'x', pay_amount: -1 })).toThrow(/negative/)
    deleteLabour(ctx, id); expect(listLabour(ctx)).toHaveLength(0)
    expect(ctx.db.get(`SELECT 1 FROM cost_entries WHERE category='labour' AND deleted_at IS NULL`)).toBeUndefined()
    setSeasonStatus(ctx, season, 'closed'); expect(() => recordLabour(ctx, { season_id: season, worked_on: '2026-10-06', worker_name: 'A', task: 'x' })).toThrow(/closed/)
  })
  it('hides pay without finance access and enforces permissions', async () => {
    const { ctx } = await office(); const { season } = setup(ctx)
    recordLabour(ctx, { season_id: season, worked_on: '2026-10-05', worker_name: 'T', task: 'Weeding', pay_amount: 6 })
    const rec = { ...ctx, perms: new Set(['resources.labour.view', 'resources.labour.record']) }
    expect(listLabour(rec)[0].pay_amount).toBeNull()
    expect(() => recordLabour({ ...ctx, perms: new Set(['resources.labour.view']) }, { season_id: season, worked_on: '2026-10-05', worker_name: 'T', task: 'x' })).toThrow(PermissionError)
  })
})

describe('weather', () => {
  it('captures rainfall and observations with validation', async () => {
    const { ctx } = await office(); const { season, field } = setup(ctx)
    recordWeather(ctx, { season_id: season, recorded_on: '2026-10-10', rainfall_mm: 12.5 })
    recordWeather(ctx, { season_id: season, field_id: field, recorded_on: '2026-10-11', event: 'hail', observation: 'Light hail on lower leaves' })
    const l = listWeather(ctx); expect(l).toHaveLength(2); expect(l[0]).toMatchObject({ event: 'hail', field_no: 'F-01' }); expect(l[1].rainfall_mm).toBe(12.5)
    expect(() => recordWeather(ctx, { recorded_on: '2026-10-10' })).toThrow(/rainfall, temperature, event or note/)
    expect(() => recordWeather(ctx, { recorded_on: '2026-10-10', rainfall_mm: -2 })).toThrow(/negative/)
    expect(() => recordWeather(ctx, { recorded_on: '2026-10-10', temp_min_c: 30, temp_max_c: 10 })).toThrow(/Minimum/)
  })
})

describe('device tags and joining a farm', () => {
  it('tagged devices issue collision-free codes', async () => {
    const { db, ctx } = await office(); const { season, field } = setup(ctx)
    expect(recordHarvest(ctx, { field_id: field, season_id: season, harvested_on: '2026-12-01', green_weight_kg: 100 }).code).toBe('H-00001')
    setDeviceTag(db, 'B', 'Phone'); expect(deviceTag(db)).toBe('B')
    expect(recordHarvest(ctx, { field_id: field, season_id: season, harvested_on: '2026-12-02', green_weight_kg: 100 }).code).toBe('H-B-00001')
    expect(recordHarvest(ctx, { field_id: field, season_id: season, harvested_on: '2026-12-03', green_weight_kg: 100 }).code).toBe('H-B-00002')
    setDeviceTag(db, '')   // back to an untagged device: its own series is unaffected by tagged codes
    expect(recordHarvest(ctx, { field_id: field, season_id: season, harvested_on: '2026-12-04', green_weight_kg: 100 }).code).toBe('H-00002')
    expect(listHarvests(ctx).map(h => h.code).sort()).toEqual(['H-00001', 'H-00002', 'H-B-00001', 'H-B-00002'])
  })

  it('a blank phone joins, receives the farm, records offline, and its work syncs back', async () => {
    const o = await office(); const { season, field } = setup(o.ctx); const cloud = new FakeCloud()
    recordHarvest(o.ctx, { field_id: field, season_id: season, harvested_on: '2026-12-01', green_weight_kg: 100 })
    expect((await syncNow(o.db, cloud, o.ctx.tenantId, 'Brechin')).errors).toEqual([])

    const phone = await Db.open(new MemoryPersistence()); expect(isInitialised(phone)).toBe(false)
    await expect(joinFarm(phone, fakeSb(o.db, o.ctx.tenantId, 'Field Recorder', 'B', { member: false }), { tenantId: o.ctx.tenantId, deviceLabel: 'P', name: 'Sam', pin: '4321' }, cloud)).rejects.toThrow(/not a member/)
    expect(isInitialised(phone)).toBe(false)
    await expect(joinFarm(phone, fakeSb(o.db, o.ctx.tenantId, 'Field Recorder', 'B'), { tenantId: o.ctx.tenantId, deviceLabel: 'P', name: 'Sam', pin: '12' }, cloud)).rejects.toThrow(/PIN/)

    const r = await joinFarm(phone, fakeSb(o.db, o.ctx.tenantId, 'Field Recorder', 'B'), { tenantId: o.ctx.tenantId, deviceLabel: 'Supervisor phone', name: 'Sam', pin: '4321' }, cloud)
    expect(r.tag).toBe('B'); expect(r.report.pulled).toBeGreaterThan(0)
    const l = await login(phone, 'Sam', '4321'); expect(l.ok).toBe(true)
    const pc: Ctx = { db: phone, ...l.ctx! }
    expect(l.ctx!.perms.has('production.harvest.record')).toBe(true); expect(l.ctx!.perms.has('settings.users.manage')).toBe(false)
    expect(listFields(pc).map(f => f.field_no)).toEqual(['F-01'])
    // offline capture on the phone with its tag, then sync both ways
    expect(recordHarvest(pc, { field_id: field, season_id: season, harvested_on: '2026-12-05', green_weight_kg: 50 }).code).toBe('H-B-00001')
    recordLabour(pc, { season_id: season, field_id: field, worked_on: '2026-12-05', worker_name: 'Sam', task: 'Reaping', hours: 6 })
    recordWeather(pc, { season_id: season, recorded_on: '2026-12-05', rainfall_mm: 4 })
    expect((await syncNow(phone, cloud, pc.tenantId, 'Brechin')).errors).toEqual([])
    expect((await syncNow(o.db, cloud, o.ctx.tenantId, 'Brechin')).errors).toEqual([])
    expect(listHarvests(o.ctx).map(h => h.code).sort()).toEqual(['H-00001', 'H-B-00001'])
    expect(listLabour(o.ctx)).toHaveLength(1); expect(listWeather(o.ctx)).toHaveLength(1)
    // the office keeps numbering without clashing
    expect(recordHarvest(o.ctx, { field_id: field, season_id: season, harvested_on: '2026-12-06', green_weight_kg: 10 }).code).toBe('H-00002')
    await expect(joinFarm(phone, fakeSb(o.db, o.ctx.tenantId, 'Field Recorder', 'B'), { tenantId: o.ctx.tenantId, deviceLabel: 'P', name: 'X', pin: '1234' }, cloud)).rejects.toThrow(/already belongs/)
  })

  it('rolls back completely when the cloud holds no farm data yet', async () => {
    const o = await office(); const phone = await Db.open(new MemoryPersistence())
    await expect(joinFarm(phone, fakeSb(o.db, o.ctx.tenantId, 'Field Recorder', 'C'), { tenantId: o.ctx.tenantId, deviceLabel: 'P', name: 'Sam', pin: '4321' }, new FakeCloud())).rejects.toThrow(/No farm data/)
    expect(isInitialised(phone)).toBe(false); expect(deviceTag(phone)).toBe('')
  })
})
