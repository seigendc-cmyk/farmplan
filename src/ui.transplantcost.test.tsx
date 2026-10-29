// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { webcrypto } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, it, expect, vi } from 'vitest'

vi.mock('sql.js', async () => {
  const real = await import('sql.js')
  const wasmBinary = readFileSync('node_modules/sql.js/dist/sql-wasm.wasm')
  const init = (real.default ?? real) as (c?: object) => Promise<unknown>
  return { default: (cfg?: object) => init({ ...cfg, wasmBinary }) }
})
Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true })
window.confirm = () => true

import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from './App'
import { useApp } from './store/app'
import { createSeason } from './services/seasons'
import { createSeedbed } from './services/seedbeds'
import { createField } from './services/fields'
import { saveTrayType } from './services/traytypes'
import { createTray } from './services/trays'
import { seedlingCostByField } from './services/seedlingcost'

describe('Cross-season transplanting UI', () => {
  it('records a bay tray into a crop season, refuses over the tray with a toast, shows tray and crop season, attributes cost, and leaves the legacy form unchanged', async () => {
    const u = userEvent.setup(); render(<App />)
    await u.type(await screen.findByLabelText('Farm name'), 'Home Farm'); await u.type(screen.getByLabelText('Owner name'), 'Lovemore')
    await u.type(screen.getByLabelText('Owner PIN (4–8 digits)'), '1234'); await u.type(screen.getByLabelText('Confirm PIN'), '1234'); await u.click(screen.getByRole('button', { name: 'Create farm' }))
    await u.type(await screen.findByLabelText('Name'), 'Lovemore'); await u.type(screen.getByLabelText('PIN'), '1234'); await u.click(screen.getByRole('button', { name: 'Sign in' }))
    await screen.findByRole('navigation', { name: 'Main' })
    const ctx = () => useApp.getState().ctx!
    ctx().db.update('farms', ctx().farmId, { modules: 'tobacco,seedbed' })
    const crop = createSeason(ctx(), { label: '2026/27', starts_on: '2026-09-01', ends_on: '2027-08-31', activate: true })
    const sbs = createSeason(ctx(), { label: 'SB 2026', starts_on: '2026-08-01', ends_on: '2026-11-30', enterprise: 'seedbed' })
    const bay = createSeedbed(ctx(), { season_id: sbs, code: 'BAY1', kind: 'float_bay' })
    const legacy = createSeedbed(ctx(), { season_id: crop, code: 'LB1', bed_length_m: 10, bed_width_m: 1, bed_count: 1, actual_seedlings: 50 })
    const tt = saveTrayType(ctx(), { name: '200-cell', cells: 200, length_mm: null, width_mm: null, media: null, note: null })
    const tray = createTray(ctx(), { seedbed_id: bay, tray_type_id: tt, actual_seedlings: 100 })
    const field = createField(ctx(), { field_no: 'F-04', area_ha: 4 })
    ctx().db.insert('cost_entries', { tenant_id: ctx().tenantId, farm_id: ctx().farmId, season_id: sbs, category: 'labour', amount: 100, occurred_on: '2026-09-10', seedbed_id: bay, tray_id: tray, field_id: null, source_type: 'test', source_id: null, note: null })
    useApp.getState().bump(); useApp.getState().setModule('seedbed')
    await u.click(await screen.findByRole('link', { name: 'Transplanting' })); await screen.findByRole('heading', { name: 'Transplanting' })

    // legacy bed: no Tray, no Crop season
    await u.click(screen.getByRole('button', { name: 'Record transplanting' })); let f = await screen.findByRole('dialog', { name: 'Record transplanting' })
    expect(within(f).queryByLabelText('Tray')).toBeNull(); expect(within(f).queryByLabelText('Crop season')).toBeNull()
    await u.selectOptions(within(f).getByLabelText('Seedbed'), legacy); expect(within(f).queryByLabelText('Tray')).toBeNull(); expect(within(f).queryByLabelText('Crop season')).toBeNull()

    // bay: Tray and Crop season (open crop seasons only, preset to the viewed season) appear
    await u.selectOptions(within(f).getByLabelText('Seedbed'), bay)
    const cs = within(f).getByLabelText('Crop season') as HTMLSelectElement; expect(Array.from(cs.options).map(o => o.text)).toEqual(['Select…', '2026/27']); expect(cs.value).toBe(crop)
    expect(Array.from((within(f).getByLabelText('Tray') as HTMLSelectElement).options).map(o => o.text).join('|')).toMatch(/T-001 \(100 left\)/)
    await u.selectOptions(within(f).getByLabelText('Tray'), tray); await u.selectOptions(within(f).getByLabelText('Field'), field)
    await u.type(within(f).getByLabelText('Seedlings planted'), '150'); await u.click(within(f).getByRole('button', { name: 'Save' }))
    await screen.findByText(/Only 100 seedlings remain in tray T-001/); expect(ctx().db.get(`SELECT 1 FROM transplants`)).toBeUndefined(); expect(screen.getByRole('dialog', { name: 'Record transplanting' })).toBeTruthy()

    // valid quantity
    const qty = within(f).getByLabelText('Seedlings planted'); await u.clear(qty); await u.type(qty, '40'); await u.click(within(f).getByRole('button', { name: 'Save' }))
    await screen.findByText('Transplanting recorded'); expect(screen.queryByRole('dialog', { name: 'Record transplanting' })).toBeNull()
    expect(ctx().db.get(`SELECT tray_id, crop_season_id, season_id, qty FROM transplants`)).toEqual({ tray_id: tray, crop_season_id: crop, season_id: sbs, qty: 40 })
    const row = (await screen.findByText(/BAY1 \/ T-001/)).closest('tr')!; within(row).getByText('→ 2026/27')
    expect(seedlingCostByField(ctx(), crop)).toEqual([{ field_id: field, seedlings: 40, amount: 40, pending: false }])
    await screen.findByText('Seedling cost')

    // delete: attribution vanishes
    await u.click(within(row).getByRole('button', { name: 'Delete' })); await screen.findByText('Record deleted')
    expect(seedlingCostByField(ctx(), crop)).toEqual([]); expect(screen.queryByText(/BAY1 \/ T-001/)).toBeNull()
    void f
  }, 60000)
})
