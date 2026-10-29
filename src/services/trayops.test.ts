import { describe, it, expect, beforeEach } from 'vitest'
import { Db, MemoryPersistence } from '../db/database'
import { initialiseFarm, login } from './setup'
import { type Ctx } from './context'
import { createSeason } from './seasons'
import { createSeedbed } from './seedbeds'
import { createField } from './fields'
import { saveTrayType } from './traytypes'
import { createTray, listTrays } from './trays'
import { createInput, recordPurchase, stockOf } from './inventory'
import { createMachine } from './machinery'
import { OPERATION_TYPES, recordOperation, deleteOperation, listOperations } from './operations'

let db: Db; let o: Ctx; let season: string; let bay: string; let bay2: string; let open: string; let t1: string; let t2: string; let other: string; let feed: string; let mf: string
beforeEach(async () => {
  db = await Db.open(new MemoryPersistence())
  await initialiseFarm(db, { tenantName: 'T', farmName: 'F', ownerName: 'Lovemore', ownerPin: '1234' })
  o = { db, ...(await login(db, 'Lovemore', '1234')).ctx! }
  season = createSeason(o, { label: '2026/27', starts_on: '2026-09-01', ends_on: '2027-08-31', activate: true })
  bay = createSeedbed(o, { season_id: season, code: 'BAY1', kind: 'float_bay' }); bay2 = createSeedbed(o, { season_id: season, code: 'BAY2', kind: 'float_bay' })
  open = createSeedbed(o, { season_id: season, code: 'OB1', bed_length_m: 10, bed_width_m: 1, bed_count: 1 })
  const tt = saveTrayType(o, { name: '200-cell', cells: 200, length_mm: null, width_mm: null, media: null, note: null })
  t1 = createTray(o, { seedbed_id: bay, tray_type_id: tt }); t2 = createTray(o, { seedbed_id: bay, tray_type_id: tt }); other = createTray(o, { seedbed_id: bay2, tray_type_id: tt })
  feed = createInput(o, { name: 'Float feed', category: 'fertilizer', unit: 'kg' }); recordPurchase(o, { input_id: feed, qty: 100, unit_cost: 2, occurred_on: '2026-09-01' })
  mf = createMachine(o, { name: 'Pump', hourly_rate: 5 })
})
const costs = (extra = '') => db.all<{ seedbed_id: string | null; tray_id: string | null; field_id: string | null; amount: number; source_type: string; deleted_at: string | null }>(
  `SELECT seedbed_id, tray_id, field_id, amount, source_type, deleted_at FROM cost_entries WHERE deleted_at IS NULL ${extra} ORDER BY source_type`)

describe('tray operations', () => {
  it('offers the float tray types', () => {
    expect(OPERATION_TYPES.float_tray).toEqual(['Tray filling', 'Seed placement', 'Float water top-up', 'Float water fertilizer', 'Water quality check', 'Clipping', 'Tray hardening', 'Tray cleaning', 'Other'])
  })
  it('a bay-level operation books seedbed_id only (tray_id null) with input, labour and machine costs', () => {
    const id = recordOperation(o, { target: { type: 'seedbed', id: bay }, op_type: 'Float water top-up', occurred_on: '2026-10-01', inputs: [{ input_id: feed, qty: 5 }],
      workers: [{ worker_name: 'Rudo', hours: 2, pay: 10 }], machines: [{ machine_id: mf, hours: 2 }] })
    const c = costs(); expect(c.map(x => x.source_type).sort()).toEqual(['machine_log', 'operation_input', 'labour_entry'].sort())
    for (const x of c) { expect(x.seedbed_id).toBe(bay); expect(x.tray_id).toBeNull(); expect(x.field_id).toBeNull() }
    expect(db.get<{ tray_id: string | null; seedbed_id: string }>(`SELECT tray_id, seedbed_id FROM operations WHERE id=?`, [id])).toEqual({ tray_id: null, seedbed_id: bay })
    expect(stockOf(o, feed)).toBe(95)
  })
  it('a tray operation books tray_id and the tray bay on the operation and every cost, and lists the tray code', () => {
    const id = recordOperation(o, { target: { type: 'seedbed', id: bay, tray_id: t1 }, op_type: 'Float water fertilizer', occurred_on: '2026-10-01', inputs: [{ input_id: feed, qty: 5 }],
      workers: [{ worker_name: 'Rudo', hours: 2, pay: 10 }], machines: [{ machine_id: mf, hours: 2 }] })
    expect(db.get(`SELECT tray_id, seedbed_id, target_type FROM operations WHERE id=?`, [id])).toEqual({ tray_id: t1, seedbed_id: bay, target_type: 'seedbed' })
    const c = costs(); expect(c).toHaveLength(3)
    for (const x of c) { expect(x.tray_id).toBe(t1); expect(x.seedbed_id).toBe(bay) }
    expect(c.reduce((s, x) => s + x.amount, 0)).toBe(30)
    expect(stockOf(o, feed)).toBe(95)
    const row = listOperations(o).find(r => r.id === id)!; expect(row).toMatchObject({ target_code: 'BAY1', tray_code: 'T-001', cost: 30 })
    const bayOnly = recordOperation(o, { target: { type: 'seedbed', id: bay }, op_type: 'Tray cleaning', occurred_on: '2026-10-02' })
    expect(listOperations(o, { targetType: 'seedbed', targetId: bay }).map(r => [r.id, r.tray_code])).toEqual(expect.arrayContaining([[id, 'T-001'], [bayOnly, null]]))
  })
  it('refuses a tray of another bay, an unknown/removed tray, a tray on an open bed or a field target', () => {
    const base = { op_type: 'Tray cleaning', occurred_on: '2026-10-01' }
    expect(() => recordOperation(o, { ...base, target: { type: 'seedbed', id: bay, tray_id: other } })).toThrow(/Tray not found in this seedbed/)
    expect(() => recordOperation(o, { ...base, target: { type: 'seedbed', id: bay, tray_id: 'nope' } })).toThrow(/Tray not found in this seedbed/)
    expect(() => recordOperation(o, { ...base, target: { type: 'seedbed', id: open, tray_id: t1 } })).toThrow(/Tray not found in this seedbed/)
    const f = createField(o, { field_no: 'F-01', area_ha: 1 })
    expect(() => recordOperation(o, { ...base, season_id: season, target: { type: 'field', id: f, tray_id: t1 } })).toThrow(/Trays belong to a float bay/)
    db.softDelete('seedbed_trays', t2); expect(() => recordOperation(o, { ...base, target: { type: 'seedbed', id: bay, tray_id: t2 } })).toThrow(/Tray not found/)
    expect(db.get(`SELECT 1 FROM operations`)).toBeUndefined(); expect(costs()).toHaveLength(0)
  })
  it('insufficient stock writes nothing', () => {
    expect(() => recordOperation(o, { target: { type: 'seedbed', id: bay, tray_id: t1 }, op_type: 'Float water fertilizer', occurred_on: '2026-10-01', inputs: [{ input_id: feed, qty: 500 }] })).toThrow(/Insufficient stock/)
    expect(db.get(`SELECT 1 FROM operations`)).toBeUndefined(); expect(stockOf(o, feed)).toBe(100)
  })
  it('deleting reverses stock, operation and every tray cost', () => {
    const id = recordOperation(o, { target: { type: 'seedbed', id: bay, tray_id: t1 }, op_type: 'Float water fertilizer', occurred_on: '2026-10-01', inputs: [{ input_id: feed, qty: 5 }],
      workers: [{ worker_name: 'Rudo', hours: 2, pay: 10 }], machines: [{ machine_id: mf, hours: 2 }] })
    expect(costs()).toHaveLength(3); deleteOperation(o, id)
    expect(costs()).toHaveLength(0); expect(stockOf(o, feed)).toBe(100); expect(listOperations(o)).toHaveLength(0)
    expect(db.get(`SELECT 1 FROM cost_entries WHERE tray_id=? AND deleted_at IS NULL`, [t1])).toBeUndefined()
  })
  it('Sowing or Seed placement on a tray sets its sown_on only when empty, with an audit entry; a bay-level op does not', () => {
    recordOperation(o, { target: { type: 'seedbed', id: bay, tray_id: t1 }, op_type: 'Sowing', occurred_on: '2026-10-03' })
    expect(listTrays(o, bay).find(t => t.id === t1)!.sown_on).toBe('2026-10-03')
    recordOperation(o, { target: { type: 'seedbed', id: bay, tray_id: t1 }, op_type: 'Sowing', occurred_on: '2026-10-09' })
    expect(listTrays(o, bay).find(t => t.id === t1)!.sown_on).toBe('2026-10-03')
    recordOperation(o, { target: { type: 'seedbed', id: bay, tray_id: t2 }, op_type: 'Seed placement', occurred_on: '2026-10-04' })
    expect(listTrays(o, bay).find(t => t.id === t2)!.sown_on).toBe('2026-10-04')
    expect(db.get(`SELECT 1 FROM audit_log WHERE action='tray.update' AND row_id=?`, [t1])).toBeTruthy()
    recordOperation(o, { target: { type: 'seedbed', id: bay }, op_type: 'Sowing', occurred_on: '2026-10-05' })
    expect(db.get<{ sown_on: string | null; status: string }>(`SELECT sown_on, status FROM seedbeds WHERE id=?`, [bay])).toEqual({ sown_on: null, status: 'prepared' })
    recordOperation(o, { target: { type: 'seedbed', id: bay, tray_id: t1 }, op_type: 'Tray cleaning', occurred_on: '2026-10-06' })
    expect(listTrays(o, bay).find(t => t.id === t1)!.sown_on).toBe('2026-10-03')
  })
  it('open-bed operations are unchanged: tray_id null on every row and outbox payload, bed sown_on set by Sowing', () => {
    const id = recordOperation(o, { target: { type: 'seedbed', id: open }, op_type: 'Sowing', occurred_on: '2026-10-01', inputs: [{ input_id: feed, qty: 5 }], workers: [{ worker_name: 'Rudo', hours: 2, pay: 10 }], machines: [{ machine_id: mf, hours: 2 }] })
    expect(db.get(`SELECT tray_id, seedbed_id, field_id, target_type, phase FROM operations WHERE id=?`, [id])).toEqual({ tray_id: null, seedbed_id: open, field_id: null, target_type: 'seedbed', phase: 'seedbed' })
    const c = costs(); expect(c).toHaveLength(3); for (const x of c) expect(x).toMatchObject({ tray_id: null, seedbed_id: open, field_id: null })
    expect(db.get(`SELECT sown_on, status FROM seedbeds WHERE id=?`, [open])).toEqual({ sown_on: '2026-10-01', status: 'sown' })
    const payloads = db.all<{ payload: string }>(`SELECT payload FROM outbox WHERE table_name IN ('operations','cost_entries','labour_entries','machine_logs')`).map(r => r.payload)
    expect(payloads.length).toBeGreaterThan(0); for (const p of payloads) { const j = JSON.parse(p); if ('tray_id' in j) expect(j.tray_id).toBeNull() }
    expect(listOperations(o).find(r => r.id === id)).toMatchObject({ target_code: 'OB1', tray_code: null, cost: 30 })
  })
})
