import { describe, it, expect, beforeEach } from 'vitest'
import { Db, MemoryPersistence } from '../db/database'
import { initialiseFarm, login, createUser } from './setup'
import { type Ctx, PermissionError } from './context'
import { createInput, updateInput, listInputs, recordPurchase, recordAdjustment } from './inventory'
import { attention } from './attention'
import { createRole } from './roles'
import { askBrain, DEFAULT_BRAIN } from '../brain/ask'

const AS_OF = '2027-03-10'
let db: Db; let o: Ctx
const stockAlerts = (c: Ctx) => attention(c, AS_OF).filter(a => a.area === 'Inventory').map(a => [a.tone, a.text])
beforeEach(async () => {
  db = await Db.open(new MemoryPersistence())
  await initialiseFarm(db, { tenantName: 'T', farmName: 'F', ownerName: 'Lovemore', ownerPin: '1234' })
  o = { db, ...(await login(db, 'Lovemore', '1234')).ctx! }
})

describe('reorder level', () => {
  it('is set on create, changed or cleared on edit, and never negative', () => {
    const id = createInput(o, { name: 'Compound C', category: 'fertilizer', unit: 'kg', reorder_level: 10 })
    expect(listInputs(o)[0].reorder_level).toBe(10)
    updateInput(o, id, { name: 'Compound C', category: 'fertilizer', unit: 'kg', reorder_level: 25 }); expect(listInputs(o)[0].reorder_level).toBe(25)
    updateInput(o, id, { name: 'Compound C', category: 'fertilizer', unit: 'kg' }); expect(listInputs(o)[0].reorder_level).toBe(25)   // not given: kept
    updateInput(o, id, { name: 'Compound C', category: 'fertilizer', unit: 'kg', reorder_level: null }); expect(listInputs(o)[0].reorder_level).toBeNull()
    expect(() => createInput(o, { name: 'Urea', category: 'fertilizer', unit: 'kg', reorder_level: -1 })).toThrow(/cannot be negative/)
    expect(() => updateInput(o, id, { name: 'Compound C', category: 'fertilizer', unit: 'kg', reorder_level: -5 })).toThrow(/cannot be negative/)
  })
  it('needs inventory management to set', async () => {
    const id = createInput(o, { name: 'Compound C', category: 'fertilizer', unit: 'kg' })
    await createUser(o, 'Rudo', '5555', createRole(o, 'Viewer', ['resources.inventory.view']))
    const v = { db, ...(await login(db, 'Rudo', '5555')).ctx! } as Ctx
    expect(() => updateInput(v, id, { name: 'Compound C', category: 'fertilizer', unit: 'kg', reorder_level: 5 })).toThrow(PermissionError)
  })
  it('drives the attention list: ok above the level, low at or below it, out at zero', () => {
    const id = createInput(o, { name: 'Compound C', category: 'fertilizer', unit: 'kg', reorder_level: 10 })
    expect(stockAlerts(o)).toEqual([['red', 'Compound C is out of stock']])   // a level means it is tracked, even before the first purchase
    recordPurchase(o, { input_id: id, qty: 50, unit_cost: 1, occurred_on: '2027-01-01' }); expect(stockAlerts(o)).toEqual([])
    recordAdjustment(o, { input_id: id, qty_delta: -40, occurred_on: '2027-03-01', note: 'used on F-04' })
    expect(stockAlerts(o)).toEqual([['amber', 'Compound C is low: 10 kg left (reorder at 10)']])
    expect(attention(o, AS_OF).find(a => a.area === 'Inventory')!.to).toBe('/inventory?focus=Compound%20C')
    createInput(o, { name: 'Never bought', category: 'chemical', unit: 'L' }); expect(stockAlerts(o)).toHaveLength(1)   // no level, no history: not flagged
  })
  it('shows in the brain stock lookup', async () => {
    const id = createInput(o, { name: 'Compound C', category: 'fertilizer', unit: 'kg', reorder_level: 10 }); recordPurchase(o, { input_id: id, qty: 8, unit_cost: 1, occurred_on: '2027-01-01' })
    const a = await askBrain(o, 'what are we low on', { settings: { ...DEFAULT_BRAIN, engine: 'rules' } })
    expect(a.id).toBe('stock_on_hand'); expect(a.rows[0]).toMatchObject({ input: 'Compound C', on_hand: 8, reorder_at: 10, level: 'low' })
  })
  it('arrives on an existing v12 database without touching its products', async () => {
    createInput(o, { name: 'Compound C', category: 'fertilizer', unit: 'kg' })
    db.run(`ALTER TABLE inputs DROP COLUMN reorder_level`); db.run(`UPDATE meta SET value='12' WHERE key='schema_version'`)
    const p = new MemoryPersistence(); p.data = db.exportBytes(); const up = await Db.open(p)
    expect(up.all<{ name: string }>(`PRAGMA table_info(inputs)`).map(c => c.name)).toContain('reorder_level')
    expect(up.all<{ name: string; reorder_level: number | null }>(`SELECT name, reorder_level FROM inputs`)).toEqual([{ name: 'Compound C', reorder_level: null }])
    expect(up.get<{ value: string }>(`SELECT value FROM meta WHERE key='schema_version'`)!.value).toBe('13')
  })
})
