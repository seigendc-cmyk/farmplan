import { describe, it, expect, beforeEach } from 'vitest'
import { Db, MemoryPersistence } from '../db/database'
import { initialiseFarm, login } from './setup'
import { type Ctx, PermissionError } from './context'
import { createSeason } from './seasons'
import { createField } from './fields'
import { recordHarvest, listHarvests } from './harvest'
import { recordWeather, listWeather } from './weather'
import { recordLabour } from './labour'
import { createPairing, hubHandle, listHubDevices, revokeHubDevice, setHubEnabled } from './hub'
import { joinHub, lanCloud, normaliseHubUrl, syncViaHub, type FetchLike } from './lan'
import { listSyncConflicts } from './sync'
import { deviceTag } from './device'
import { runMigrations } from '../db/migrations'

let office: Db; let o: Ctx; let season: string; let fieldId: string
const hubFetch = (target: () => Db, down = false): FetchLike => async (url, init) => {
  if (down) throw new TypeError('network down')
  const u = new URL(url); const r = await hubHandle(target(), { method: init?.method ?? 'GET', path: u.pathname + u.search, auth: init?.headers?.Authorization?.replace('Bearer ', 'Bearer ') ?? null, body: init?.body ? JSON.parse(init.body) : undefined })
  const body = JSON.parse(JSON.stringify(r.body)); return { status: r.status, ok: r.status >= 200 && r.status < 300, json: async () => body }
}
const URL_ = 'http://192.168.1.20:7878'
async function newPhone(name: string, label: string, pin = '1111') {
  const db = await Db.open(new MemoryPersistence()); const { code } = await createPairing(o, label)
  const j = await joinHub(db, { hubUrl: URL_, code, name, pin }, hubFetch(() => office)); const r = await login(db, name, pin)
  return { db, tag: j.tag, ctx: { db, ...r.ctx! } as Ctx, report: j.report }
}

beforeEach(async () => {
  office = await Db.open(new MemoryPersistence())
  await initialiseFarm(office, { tenantName: 'T', farmName: 'F', ownerName: 'Lovemore', ownerPin: '1234' })
  const r = await login(office, 'Lovemore', '1234'); o = { db: office, ...r.ctx! }
  season = createSeason(o, { label: '2026/27', starts_on: '2026-09-01', ends_on: '2027-08-31', activate: true })
  fieldId = createField(o, { field_no: 'F-04', area_ha: 4 }); setHubEnabled(office, true)
})

describe('pairing', () => {
  it('pairs a blank phone with a one-time code, copies the farm and issues an L-tag', async () => {
    const p = await newPhone('Tendai', 'Supervisor phone')
    expect(p.tag).toBe('LA'); expect(deviceTag(p.db)).toBe('LA'); expect(p.db.get(`SELECT 1 FROM fields WHERE field_no='F-04'`)).toBeTruthy()
    expect(p.ctx.perms.has('production.harvest.record')).toBe(true); expect(p.ctx.perms.has('settings.users.manage')).toBe(false)
    expect((await newPhone('Rudo', 'Second')).tag).toBe('LB')
    expect(listHubDevices(o).map(d => d.label)).toEqual(['Supervisor phone', 'Second'])
  })
  it('codes are single-use, and 5 wrong guesses lock every pending code', async () => {
    const { code } = await createPairing(o, 'P1'); const f = hubFetch(() => office)
    await joinHub(await Db.open(new MemoryPersistence()), { hubUrl: URL_, code, name: 'A', pin: '1111' }, f)
    await expect(joinHub(await Db.open(new MemoryPersistence()), { hubUrl: URL_, code, name: 'B', pin: '1111' }, f)).rejects.toThrow(/wrong or has expired/)
    const live = await createPairing(o, 'P2')
    for (let i = 0; i < 3; i++) await expect(joinHub(await Db.open(new MemoryPersistence()), { hubUrl: URL_, code: '000000', name: 'X', pin: '1111' }, f)).rejects.toThrow(/wrong or has expired|Too many/)
    await expect(joinHub(await Db.open(new MemoryPersistence()), { hubUrl: URL_, code: '000001', name: 'X', pin: '1111' }, f)).rejects.toThrow(/Too many wrong codes/)
    await expect(joinHub(await Db.open(new MemoryPersistence()), { hubUrl: URL_, code: live.code, name: 'X', pin: '1111' }, f)).rejects.toThrow(/wrong or has expired/)
  })
  it('expired codes fail; only users who manage staff can pair; Owner cannot be paired', async () => {
    const { code } = await createPairing(o, 'P'); office.run(`UPDATE lan_pairings SET expires_at='2000-01-01T00:00:00Z'`)
    await expect(joinHub(await Db.open(new MemoryPersistence()), { hubUrl: URL_, code, name: 'A', pin: '1111' }, hubFetch(() => office))).rejects.toThrow(/expired/)
    await expect(createPairing({ ...o, perms: new Set() }, 'x')).rejects.toBeInstanceOf(PermissionError); await expect(createPairing(o, 'x', 'Owner')).rejects.toThrow(/Owner/)
  })
  it('leaves the phone blank if the hub is unreachable or switched off', async () => {
    const { code } = await createPairing(o, 'P'); const blank = await Db.open(new MemoryPersistence())
    await expect(joinHub(blank, { hubUrl: URL_, code, name: 'A', pin: '1111' }, hubFetch(() => office, true))).rejects.toThrow(/Cannot reach the farm hub/)
    setHubEnabled(office, false); await expect(joinHub(blank, { hubUrl: URL_, code, name: 'A', pin: '1111' }, hubFetch(() => office))).rejects.toThrow(/switched off/)
    expect(blank.get(`SELECT 1 FROM tenants`)).toBeUndefined()
  })
  it('normalises hub addresses', () => {
    expect(normaliseHubUrl('192.168.1.20')).toBe('http://192.168.1.20:7878'); expect(normaliseHubUrl('http://10.0.0.5:9000/')).toBe('http://10.0.0.5:9000'); expect(() => normaliseHubUrl('not an address')).toThrow()
  })
})

describe('syncing over the hub', () => {
  it('moves a phone\'s records to the office, queues them for the cloud, and fans them out to other phones', async () => {
    const a = await newPhone('Tendai', 'A'); const b = await newPhone('Rudo', 'B'); const f = hubFetch(() => office)
    recordHarvest(a.ctx, { field_id: fieldId, season_id: season, harvested_on: '2027-01-20', green_weight_kg: 500 }); recordWeather(a.ctx, { season_id: season, recorded_on: '2026-11-10', rainfall_mm: 12 })
    const r = await syncViaHub(a.db, a.ctx.tenantId, f); expect(r.errors).toEqual([]); expect(r.pushed).toBeGreaterThanOrEqual(2)
    expect(listHarvests(o)[0]).toMatchObject({ green_weight_kg: 500 }); expect(listHarvests(o)[0].code).toMatch(/-LA-/); expect(listWeather(o)).toHaveLength(1)
    expect(office.pendingSync()).toBeGreaterThan(0)
    expect(office.get(`SELECT COUNT(*) n FROM outbox WHERE table_name='harvest_batches' AND synced_at IS NULL`)).toMatchObject({ n: 1 })
    const rb = await syncViaHub(b.db, b.ctx.tenantId, f); expect(rb.errors).toEqual([]); expect(listHarvests(b.ctx)).toHaveLength(1)
  })
  it('does not lose a row whose own timestamp is older than another phone\'s cursor', async () => {
    const a = await newPhone('Tendai', 'A'); const b = await newPhone('Rudo', 'B'); const f = hubFetch(() => office)
    recordWeather(a.ctx, { season_id: season, recorded_on: '2026-11-10', rainfall_mm: 5 })   // created first (older updated_at)
    recordWeather(b.ctx, { season_id: season, recorded_on: '2026-11-11', rainfall_mm: 7 })
    await syncViaHub(b.db, b.ctx.tenantId, f)                                                  // hub cursor for B moves past B's row
    await syncViaHub(a.db, a.ctx.tenantId, f)                                                  // A's older row reaches the hub afterwards
    await syncViaHub(b.db, b.ctx.tenantId, f); expect(listWeather(b.ctx).map(w => w.rainfall_mm).sort()).toEqual([5, 7])
  })
  it('pulls the office\'s own changes, including ones that arrived from the cloud', async () => {
    const a = await newPhone('Tendai', 'A'); const f = hubFetch(() => office)
    createField(o, { field_no: 'F-09', area_ha: 1 }); await syncViaHub(a.db, a.ctx.tenantId, f); expect(a.db.get(`SELECT 1 FROM fields WHERE field_no='F-09'`)).toBeTruthy()
    office.run(`UPDATE fields SET area_ha=9, updated_at='2099-01-01T00:00:00.000Z' WHERE field_no='F-09'`)
    office.run(`INSERT INTO hub_log(table_name,row_id) SELECT 'fields', id FROM fields WHERE field_no='F-09'`)
    await syncViaHub(a.db, a.ctx.tenantId, f); expect(a.db.get(`SELECT area_ha FROM fields WHERE field_no='F-09'`)).toMatchObject({ area_ha: 9 })
  })
  it('keeps the newer copy when the office already has a later edit (last writer wins)', async () => {
    const a = await newPhone('Tendai', 'A'); const f = hubFetch(() => office)
    const id = recordWeather(a.ctx, { season_id: season, recorded_on: '2026-11-10', rainfall_mm: 5 }); await syncViaHub(a.db, a.ctx.tenantId, f)
    office.run(`UPDATE weather_records SET rainfall_mm=99, updated_at='2099-01-01T00:00:00.000Z' WHERE id=?`, [typeof id === 'string' ? id : (id as { id: string }).id])
    a.db.run(`UPDATE weather_records SET rainfall_mm=6, updated_at='2030-01-01T00:00:00.000Z'`); a.db.run(`INSERT INTO outbox(table_name,row_id,op,payload) SELECT 'weather_records', id, 'upsert', '{}' FROM weather_records`)
    const r = await syncViaHub(a.db, a.ctx.tenantId, f); expect(r.errors).toEqual([]); expect(listWeather(o)[0].rainfall_mm).toBe(99)
  })
})

describe('hub safety', () => {
  it('rejects unauthenticated, revoked and forged requests', async () => {
    const a = await newPhone('Tendai', 'A'); const f = hubFetch(() => office); expect((await hubHandle(office, { method: 'GET', path: '/pull?table=fields' })).status).toBe(401)
    expect((await hubHandle(office, { method: 'GET', path: '/pull?table=fields', auth: 'Bearer ' + 'a'.repeat(64) })).status).toBe(401)
    revokeHubDevice(o, listHubDevices(o)[0].id); expect((await syncViaHub(a.db, a.ctx.tenantId, f)).errors[0]).toMatch(/not authorised/)
    expect(listHubDevices(o)[0].revoked).toBe(true)
  })
  it('quarantines rows the phone may not write instead of blocking its sync', async () => {
    const a = await newPhone('Tendai', 'A'); const f = hubFetch(() => office)
    a.db.insert('budgets', { tenant_id: a.ctx.tenantId, farm_id: a.ctx.farmId, season_id: season, category: 'seed', amount: 5 })
    recordWeather(a.ctx, { season_id: season, recorded_on: '2026-11-10', rainfall_mm: 5 })
    const r = await syncViaHub(a.db, a.ctx.tenantId, f); expect(r.errors).toEqual([]); expect(r.quarantined).toBe(1); expect(listSyncConflicts(a.db)[0].reason).toMatch(/may not write this table/); expect(listWeather(o)).toHaveLength(1)
    expect(office.get(`SELECT 1 FROM budgets`)).toBeUndefined()
  })
  it('rejects forged tenants and unknown columns (no SQL injection through column names)', async () => {
    const a = await newPhone('Tendai', 'A'); const tok = a.db.get<{ value: string }>(`SELECT value FROM meta WHERE key='hub_token'`)!.value; const auth = `Bearer ${tok}`
    const base = { id: 'x1', updated_at: '2027-01-01T00:00:00.000Z', farm_id: a.ctx.farmId, season_id: season, recorded_on: '2027-01-01' }
    const other = await hubHandle(office, { method: 'POST', path: '/push', auth, body: { table: 'weather_records', rows: [{ ...base, tenant_id: 'someone-else' }] } }); expect(other.status).toBe(422)
    const inj = await hubHandle(office, { method: 'POST', path: '/push', auth, body: { table: 'weather_records', rows: [{ ...base, tenant_id: a.ctx.tenantId, 'id) VALUES (1); DROP TABLE fields; --': 1 }] } }); expect(inj.status).toBe(422)
    expect(office.get(`SELECT COUNT(*) n FROM fields`)).toMatchObject({ n: 1 }); expect(listWeather(o)).toHaveLength(0)
    expect((await hubHandle(office, { method: 'GET', path: '/pull?table=local_users', auth })).status).toBe(422)
    const bad = lanCloud(URL_, tok, hubFetch(() => office)); await expect(bad.claimTenant('another-tenant', 'x')).rejects.toThrow(/different farm/)
  })
  it('is atomic per request: a bad row in a batch applies nothing', async () => {
    const a = await newPhone('Tendai', 'A'); const tok = a.db.get<{ value: string }>(`SELECT value FROM meta WHERE key='hub_token'`)!.value
    const good = { id: 'g1', tenant_id: a.ctx.tenantId, farm_id: a.ctx.farmId, season_id: season, recorded_on: '2027-01-01', rainfall_mm: 1, updated_at: '2027-01-01T00:00:00.000Z', created_at: '2027-01-01T00:00:00.000Z', version: 1 }
    const r = await hubHandle(office, { method: 'POST', path: '/push', auth: `Bearer ${tok}`, body: { table: 'weather_records', rows: [good, { ...good, id: 'g2', farm_id: 'no-such-farm' }] } })
    expect(r.status).toBe(422); expect(listWeather(o)).toHaveLength(0)
  })
  it('backfills the change feed when upgrading from schema 8', async () => {
    office.run(`DELETE FROM hub_log`); runMigrations(office, 8); expect(office.get(`SELECT COUNT(*) n FROM hub_log WHERE table_name='fields'`)).toMatchObject({ n: 1 })
  })
})
