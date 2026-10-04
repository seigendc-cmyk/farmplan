import { describe, it, expect } from 'vitest'
import { Db, MemoryPersistence, type Row } from '../db/database'
import { initialiseFarm, login } from './setup'
import { type Ctx } from './context'
import { createSeason } from './seasons'
import { createField, listFields } from './fields'
import { createInput, recordPurchase } from './inventory'
import { recordOperation } from './operations'
import { syncNow, RowRejectedError, listSyncConflicts, retrySyncConflict, type CloudClient } from './sync'
import { createBarn, createCycle } from './curing'
import { recordHarvest } from './harvest'

class FakeCloud implements CloudClient {
  tables = new Map<string, Map<string, Row>>(); claimed: string[] = []; clock = 1_800_000_000_000
  async claimTenant(id: string) { this.claimed.push(id) }
  async upsert(table: string, rows: Record<string, unknown>[]) {
    const t = this.tables.get(table) ?? new Map(); this.tables.set(table, t)
    for (const r of rows) t.set(r.id as string, { ...r, updated_at: new Date(this.clock += 1000).toISOString() } as Row)
  }
  async fetchSince(table: string, since: string | null, limit: number) {
    return [...(this.tables.get(table)?.values() ?? [])].filter(r => !since || String(r.updated_at) > since)
      .sort((a, b) => String(a.updated_at).localeCompare(String(b.updated_at))).slice(0, limit)
  }
}

async function device(): Promise<{ db: Db; ctx: Ctx }> {
  const db = await Db.open(new MemoryPersistence())
  await initialiseFarm(db, { tenantName: 'T', farmName: 'F', ownerName: 'O', ownerPin: '1234' })
  const r = await login(db, 'O', '1234')
  return { db, ctx: { db, ...r.ctx! } }
}

describe('sync engine', () => {
  it('pushes in FK-safe order, marks outbox synced, and is idempotent', async () => {
    const { db, ctx } = await device(); const cloud = new FakeCloud()
    const s = createSeason(ctx, { label: '2026/27', starts_on: '2026-09-01', ends_on: '2027-08-31', activate: true })
    const f = createField(ctx, { field_no: 'F1', area_ha: 3 })
    const i = createInput(ctx, { name: 'Urea', category: 'fertilizer', unit: 'kg' })
    recordPurchase(ctx, { input_id: i, qty: 50, unit_cost: 1, occurred_on: '2026-10-01' })
    recordOperation(ctx, { target: { type: 'field', id: f }, season_id: s, op_type: 'Fertilizing', occurred_on: '2026-10-02', inputs: [{ input_id: i, qty: 10 }] })
    const r1 = await syncNow(db, cloud, ctx.tenantId, 'T')
    expect(r1.errors).toEqual([]); expect(db.pendingSync()).toBe(0)
    expect(cloud.tables.get('operations')!.size).toBe(1); expect(cloud.tables.get('cost_entries')!.size).toBe(1)
    expect(cloud.tables.get('fields')!.get(f)!.irrigated).toBe(false)
    const r2 = await syncNow(db, cloud, ctx.tenantId, 'T'); expect(r2.pushed).toBe(0)
  })

  it('second device receives data; local newer edits win; deletes propagate', async () => {
    const a = await device(); const cloud = new FakeCloud()
    const field = createField(a.ctx, { field_no: 'F1', area_ha: 3 })
    await syncNow(a.db, cloud, a.ctx.tenantId, 'T')
    // device B shares the tenant + farm identity (as after a cloud restore)
    const b = await Db.open(new MemoryPersistence())
    b.run(`INSERT INTO tenants(id,name) VALUES(?,?)`, [a.ctx.tenantId, 'T'])
    const rb = await syncNow(b, cloud, a.ctx.tenantId, 'T')
    expect(rb.errors).toEqual([]); expect(b.get<{ n: number }>(`SELECT COUNT(*) n FROM fields`)!.n).toBe(1)
    // B's role-less ctx is only used for reading here
    const ctxB: Ctx = { db: b, tenantId: a.ctx.tenantId, farmId: a.ctx.farmId, actor: null, perms: new Set(['*']) }
    expect(listFields(ctxB)[0].field_no).toBe('F1')
    b.update('fields', field, { area_ha: 9 })
    await syncNow(b, cloud, a.ctx.tenantId, 'T'); await syncNow(a.db, cloud, a.ctx.tenantId, 'T')
    expect(a.db.get<{ area_ha: number }>(`SELECT area_ha FROM fields WHERE id=?`, [field])!.area_ha).toBe(9)
    a.db.softDelete('fields', field)
    await syncNow(a.db, cloud, a.ctx.tenantId, 'T'); await syncNow(b, cloud, a.ctx.tenantId, 'T')
    expect(listFields(ctxB)).toHaveLength(0)
  })

  it('reports errors without losing the outbox', async () => {
    const { db, ctx } = await device(); createField(ctx, { field_no: 'F1', area_ha: 1 })
    const bad: CloudClient = { claimTenant: async () => {}, upsert: async () => { throw new Error('offline') }, fetchSince: async () => [] }
    const r = await syncNow(db, bad, ctx.tenantId, 'T')
    expect(r.errors[0]).toContain('offline'); expect(db.pendingSync()).toBeGreaterThan(0)
  })

  it('pushes the curing chain tables in FK order', async () => {
    const { db, ctx } = await device(); const cloud = new FakeCloud()
    const s = createSeason(ctx, { label: '2026/27', starts_on: '2026-09-01', ends_on: '2027-08-31', activate: true })
    const f = createField(ctx, { field_no: 'F1', area_ha: 3 })
    recordHarvest(ctx, { field_id: f, season_id: s, harvested_on: '2026-12-01', green_weight_kg: 500 })
    const b = createBarn(ctx, { capacity_kg: 5000 }); createCycle(ctx, { barn_id: b, season_id: s })
    const r = await syncNow(db, cloud, ctx.tenantId, 'T')
    expect(r.errors).toEqual([]); expect(db.pendingSync()).toBe(0)
    expect(cloud.tables.get('harvest_batches')!.size).toBe(1); expect(cloud.tables.get('curing_cycles')!.size).toBe(1); expect(cloud.tables.get('curing_cycle_checks')!.size).toBe(9)
  })

  it('quarantines only the refused row, syncs the rest, and can retry', async () => {
    const { db, ctx } = await device()
    const cloud = new FakeCloud(); let refuse = true
    const orig = cloud.upsert.bind(cloud)
    cloud.upsert = async (table, rows) => { if (table === 'fields' && refuse && rows.some(r => r.field_no === 'BAD')) throw new RowRejectedError('fields: check violated'); return orig(table, rows) }
    createField(ctx, { field_no: 'OK', area_ha: 1 }); const bad = createField(ctx, { field_no: 'BAD', area_ha: 1 })
    const r = await syncNow(db, cloud, ctx.tenantId, 'T')
    expect(r.errors).toEqual([]); expect(r.quarantined).toBe(1); expect(cloud.tables.get('fields')!.size).toBe(1); expect(db.pendingSync()).toBe(0)
    const c = listSyncConflicts(db); expect(c).toHaveLength(1); expect(c[0].row_id).toBe(bad)
    refuse = false; retrySyncConflict(db, c[0].id)
    const r2 = await syncNow(db, cloud, ctx.tenantId, 'T')
    expect(r2.quarantined).toBe(0); expect(cloud.tables.get('fields')!.size).toBe(2); expect(listSyncConflicts(db)).toHaveLength(0)
  })

  it('a network-style failure aborts without quarantining', async () => {
    const { db, ctx } = await device(); createField(ctx, { field_no: 'F1', area_ha: 1 })
    const bad: CloudClient = { claimTenant: async () => {}, upsert: async () => { throw new Error('fetch failed') }, fetchSince: async () => [] }
    const r = await syncNow(db, bad, ctx.tenantId, 'T')
    expect(r.errors[0]).toContain('fetch failed'); expect(listSyncConflicts(db)).toHaveLength(0)
  })
})

describe('sync order', () => {
  it('every synced table is pushed after the synced tables it references', async () => {
    const { db } = await device(); const { SYNC_ORDER } = await import('../db/database')
    const bad: string[] = []
    SYNC_ORDER.forEach((t, i) => {
      for (const fk of db.all<{ table: string }>(`PRAGMA foreign_key_list(${t})`)) {
        const j = (SYNC_ORDER as readonly string[]).indexOf(fk.table)
        if (j > i) bad.push(`${t} -> ${fk.table}`)
        if (j < 0 && !['tenants', 'roles', 'local_users'].includes(fk.table)) bad.push(`${t} -> ${fk.table} (not synced)`)
      }
    })
    expect(bad).toEqual([])
  })
})
