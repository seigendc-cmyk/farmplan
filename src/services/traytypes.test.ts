import { describe, it, expect, beforeEach } from 'vitest'
import { Db, MemoryPersistence } from '../db/database'
import { initialiseFarm, login, createUser } from './setup'
import { type Ctx, PermissionError } from './context'
import { createRole } from './roles'
import { createSeason } from './seasons'
import { createSeedbed } from './seedbeds'
import { listTrayTypes, saveTrayType, deleteTrayType } from './traytypes'

let db: Db; let o: Ctx; let seedbed: string
const asRole = async (name: string, perms: string[]) => { await createUser(o, name, '5555', createRole(o, `${name} role`, perms)); return { db, ...(await login(db, name, '5555')).ctx! } as Ctx }
const tt = (over: Record<string, unknown> = {}) => ({ name: '200-cell polystyrene', cells: 200, length_mm: 670, width_mm: 340, media: 'Composted pine bark', note: null, ...over }) as Parameters<typeof saveTrayType>[1]
const addTray = (typeId: string, code = 'T1') => db.run(`INSERT INTO seedbed_trays(id,tenant_id,farm_id,seedbed_id,tray_type_id,code) VALUES(?,?,?,?,?,?)`, [`tr-${code}`, o.tenantId, o.farmId, seedbed, typeId, code])
beforeEach(async () => {
  db = await Db.open(new MemoryPersistence())
  await initialiseFarm(db, { tenantName: 'T', farmName: 'F', ownerName: 'Lovemore', ownerPin: '1234' })
  o = { db, ...(await login(db, 'Lovemore', '1234')).ctx! }
  const s = createSeason(o, { label: '2026/27', starts_on: '2026-09-01', ends_on: '2027-08-31', activate: true })
  seedbed = createSeedbed(o, { season_id: s, code: 'B1' } as never)
})

describe('tray types', () => {
  it('starts empty (nothing is seeded), then creates and lists', () => {
    expect(listTrayTypes(o)).toEqual([])
    const id = saveTrayType(o, tt())
    expect(listTrayTypes(o)).toEqual([{ id, name: '200-cell polystyrene', cells: 200, length_mm: 670, width_mm: 340, media: 'Composted pine bark', note: null }])
  })
  it('trims text, stores blank optional fields as null, lists by name', () => {
    saveTrayType(o, tt({ name: ' Zed ', media: '  ', note: '', length_mm: null, width_mm: null })); saveTrayType(o, tt({ name: 'Alpha' }))
    const l = listTrayTypes(o); expect(l.map(x => x.name)).toEqual(['Alpha', 'Zed']); expect(l[1]).toMatchObject({ media: null, note: null, length_mm: null, width_mm: null })
  })
  it('refuses a missing name and a duplicate name (any case), but allows keeping its own name on edit', () => {
    expect(() => saveTrayType(o, tt({ name: '  ' }))).toThrow(/name/i)
    const id = saveTrayType(o, tt()); expect(() => saveTrayType(o, tt({ name: '200-CELL polystyrene' }))).toThrow(/already/)
    expect(() => saveTrayType(o, { ...tt(), id })).not.toThrow()
    const b = saveTrayType(o, tt({ name: 'Other' })); expect(() => saveTrayType(o, { ...tt(), id: b })).toThrow(/already/)
  })
  it('refuses cells that are zero, negative, fractional or not a number', () => {
    for (const c of [0, -5, 1.5, NaN]) expect(() => saveTrayType(o, tt({ cells: c }))).toThrow(/whole number/)
    expect(listTrayTypes(o)).toHaveLength(0)
  })
  it('refuses zero or negative dimensions but accepts them blank', () => {
    expect(() => saveTrayType(o, tt({ length_mm: 0 }))).toThrow(/positive/); expect(() => saveTrayType(o, tt({ width_mm: -1 }))).toThrow(/positive/)
    expect(() => saveTrayType(o, tt({ length_mm: null, width_mm: null }))).not.toThrow()
  })
  it('editing keeps trays attached to the same type', () => {
    const id = saveTrayType(o, tt()); addTray(id)
    saveTrayType(o, { ...tt({ name: '200-cell (renamed)', cells: 198 }), id })
    expect(db.get<{ tray_type_id: string }>(`SELECT tray_type_id FROM seedbed_trays WHERE id='tr-T1'`)!.tray_type_id).toBe(id)
    expect(listTrayTypes(o)[0]).toMatchObject({ id, name: '200-cell (renamed)', cells: 198 })
  })
  it('editing an unknown id is refused', () => { expect(() => saveTrayType(o, { ...tt(), id: 'nope' })).toThrow(/not found/) })
  it('delete is refused while a tray uses the type and allowed after the tray is removed', () => {
    const id = saveTrayType(o, tt()); addTray(id)
    expect(() => deleteTrayType(o, id)).toThrow(/in use/); expect(listTrayTypes(o)).toHaveLength(1)
    db.softDelete('seedbed_trays', 'tr-T1'); deleteTrayType(o, id); expect(listTrayTypes(o)).toHaveLength(0)
  })
  it('a removed type cannot be deleted twice, and its name stays reserved with a clear message', () => {
    const id = saveTrayType(o, tt()); deleteTrayType(o, id); expect(() => deleteTrayType(o, id)).toThrow(/not found/)
    expect(() => saveTrayType(o, tt())).toThrow(/already/)
  })
  it('writes go through the outbox and activity log without prices', () => {
    const id = saveTrayType(o, tt()); deleteTrayType(o, id)
    expect(db.all(`SELECT 1 FROM outbox WHERE table_name='tray_types' AND row_id=?`, [id]).length).toBeGreaterThan(0)
    const ev = db.all<{ summary: string }>(`SELECT summary FROM activity_log WHERE table_name='tray_types' ORDER BY rowid`).map(e => e.summary)
    expect(ev[0]).toMatch(/Recorded tray type 200-cell polystyrene/); expect(ev.join(' ')).not.toMatch(/\$|price|cost/i)
  })
  it('a Field Recorder can list but not save or delete; a user without seedbed.view cannot list', async () => {
    const id = saveTrayType(o, tt())
    const fr = await asRole('Tendai', ['production.seedbed.view']); expect(listTrayTypes(fr)).toHaveLength(1)
    expect(() => saveTrayType(fr, tt({ name: 'x' }))).toThrow(PermissionError); expect(() => deleteTrayType(fr, id)).toThrow(PermissionError)
    const none = await asRole('Nobody', ['settings.farm.view']); expect(() => listTrayTypes(none)).toThrow(PermissionError)
  })
})
