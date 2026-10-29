import { describe, it, expect, beforeEach } from 'vitest'
import { Db, MemoryPersistence, SYNC_ORDER } from '../db/database'
import { SCHEMA_VERSION } from '../db/schema'
import { initialiseFarm, login } from './setup'
import { type Ctx } from './context'
import { createSeason } from './seasons'
import { createSeedbed } from './seedbeds'
import { createField } from './fields'
import { recordTransplant } from './transplants'
import { HUB_WRITE_TABLES, HUB_NO_READ } from './hub'

let db: Db; let o: Ctx
const cols = (d: Db, t: string) => d.all<{ name: string }>(`PRAGMA table_info(${t})`).map(c => c.name)
beforeEach(async () => {
  db = await Db.open(new MemoryPersistence())
  await initialiseFarm(db, { tenantName: 'T', farmName: 'F', ownerName: 'Lovemore', ownerPin: '1234' })
  o = { db, ...(await login(db, 'Lovemore', '1234')).ctx! }
})

describe('schema v19: float tray bays', () => {
  it('is version 19', () => {
    expect(SCHEMA_VERSION).toBe(19)
    expect(db.get<{ value: string }>(`SELECT value FROM meta WHERE key='schema_version'`)!.value).toBe('19')
  })
  it('a fresh database has the tray tables and the new columns', () => {
    expect(cols(db, 'tray_types')).toEqual(expect.arrayContaining(['name', 'cells', 'length_mm', 'width_mm', 'media', 'note', 'farm_id', 'tenant_id']))
    expect(cols(db, 'seedbed_trays')).toEqual(expect.arrayContaining(['seedbed_id', 'tray_type_id', 'code', 'variety', 'sown_on', 'expected_seedlings', 'actual_seedlings', 'status']))
    expect(cols(db, 'seedbeds')).toContain('kind'); expect(cols(db, 'operations')).toContain('tray_id')
    expect(cols(db, 'cost_entries')).toContain('tray_id'); expect(cols(db, 'transplants')).toContain('tray_id'); expect(cols(db, 'transplants')).toContain('crop_season_id')
  })
  it('seedbeds default to open_bed and refuse an unknown kind; tray types need cells above zero and a unique name', () => {
    const s = createSeason(o, { label: '2026/27', starts_on: '2026-09-01', ends_on: '2027-08-31', activate: true })
    const b = createSeedbed(o, { season_id: s, code: 'B1' } as never)
    expect(db.get<{ kind: string }>(`SELECT kind FROM seedbeds WHERE id=?`, [b])!.kind).toBe('open_bed')
    expect(() => db.run(`UPDATE seedbeds SET kind='pond' WHERE id=?`, [b])).toThrow()
    const ins = (id: string, name: string, cells: number) => db.run(`INSERT INTO tray_types(id,tenant_id,farm_id,name,cells) VALUES(?,?,?,?,?)`, [id, o.tenantId, o.farmId, name, cells])
    ins('tt1', '200-cell', 200); expect(() => ins('tt2', '200-cell', 200)).toThrow(); expect(() => ins('tt3', 'zero', 0)).toThrow()
  })
  it('trays: status is checked, the code is unique per bed, seedling counts cannot be negative', () => {
    const s = createSeason(o, { label: '2026/27', starts_on: '2026-09-01', ends_on: '2027-08-31', activate: true })
    const b = createSeedbed(o, { season_id: s, code: 'B1' } as never)
    db.run(`INSERT INTO tray_types(id,tenant_id,farm_id,name,cells) VALUES('tt1',?,?,'200',200)`, [o.tenantId, o.farmId])
    const tray = (id: string, code: string, extra = '') => db.run(`INSERT INTO seedbed_trays(id,tenant_id,farm_id,seedbed_id,tray_type_id,code${extra ? ',' + extra.split('=')[0] : ''}) VALUES(?,?,?,?,?,?${extra ? ',' + extra.split('=')[1] : ''})`, [id, o.tenantId, o.farmId, b, 'tt1', code])
    tray('t1', 'T1'); expect(db.get<{ status: string }>(`SELECT status FROM seedbed_trays WHERE id='t1'`)!.status).toBe('sown')
    expect(() => tray('t2', 'T1')).toThrow(); expect(() => tray('t3', 'T3', `status='x'`.replace('=', '='))).toThrow()
    expect(() => tray('t4', 'T4', 'actual_seedlings=-1')).toThrow()
  })
  it('sync order puts the tray tables after seedbeds, before operations', () => {
    const i = (t: string) => (SYNC_ORDER as readonly string[]).indexOf(t)
    expect(i('tray_types')).toBeGreaterThan(i('seedbeds')); expect(i('seedbed_trays')).toBeGreaterThan(i('tray_types')); expect(i('seedbed_trays')).toBeLessThan(i('operations'))
  })
  it('hub: trays carry no money, so field devices may read them and may not write them', () => {
    for (const t of ['tray_types', 'seedbed_trays']) { expect(HUB_NO_READ.has(t)).toBe(false); expect(HUB_WRITE_TABLES.has(t)).toBe(false) }
  })
  it('an upgrade from v18 keeps seedbeds as open_bed and transplants with no crop season', async () => {
    const s = createSeason(o, { label: '2026/27', starts_on: '2026-09-01', ends_on: '2027-08-31', activate: true })
    const b = createSeedbed(o, { season_id: s, code: 'B1', sown_on: '2026-09-10', actual_seedlings: 1000 } as never)
    const f = createField(o, { field_no: 'F1', area_ha: 1 } as never)
    recordTransplant(o, { season_id: s, seedbed_id: b, field_id: f, occurred_on: '2026-11-01', qty: 100 } as never)
    // rebuild the v18 shape: drop the v19 tables and columns, then stamp the old version
    db.run('PRAGMA foreign_keys = OFF')
    db.run(`DROP TABLE seedbed_trays`); db.run(`DROP TABLE tray_types`)
    for (const [t, c] of [['operations', 'tray_id'], ['cost_entries', 'tray_id'], ['transplants', 'tray_id'], ['transplants', 'crop_season_id'], ['seedbeds', 'kind']]) db.run(`ALTER TABLE ${t} DROP COLUMN ${c}`)
    db.run(`UPDATE meta SET value='18' WHERE key='schema_version'`)
    const p = new MemoryPersistence(); p.data = db.exportBytes(); const up = await Db.open(p)
    expect(up.get<{ value: string }>(`SELECT value FROM meta WHERE key='schema_version'`)!.value).toBe('19')
    expect(up.all<{ kind: string }>(`SELECT kind FROM seedbeds`).map(r => r.kind)).toEqual(['open_bed'])
    expect(up.all<{ crop_season_id: string | null }>(`SELECT crop_season_id FROM transplants`)).toEqual([{ crop_season_id: null }])
    expect(cols(up, 'tray_types')).toContain('cells'); expect(cols(up, 'seedbed_trays')).toContain('tray_type_id'); expect(cols(up, 'operations')).toContain('tray_id'); expect(cols(up, 'cost_entries')).toContain('tray_id')
    const again = new MemoryPersistence(); again.data = up.exportBytes(); await Db.open(again)   // idempotent
  })
})
