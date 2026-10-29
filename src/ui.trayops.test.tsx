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
import { saveTrayType } from './services/traytypes'
import { createTray } from './services/trays'
import { createInput, recordPurchase, stockOf } from './services/inventory'

describe('Tray operations UI', () => {
  it('records Float water top-up on a tray, a bay-level operation, refuses with a toast, shows empty-tray state, leaves the open-bed form unchanged, deletes', async () => {
    const u = userEvent.setup(); render(<App />)
    await u.type(await screen.findByLabelText('Farm name'), 'Home Farm'); await u.type(screen.getByLabelText('Owner name'), 'Lovemore')
    await u.type(screen.getByLabelText('Owner PIN (4–8 digits)'), '1234'); await u.type(screen.getByLabelText('Confirm PIN'), '1234'); await u.click(screen.getByRole('button', { name: 'Create farm' }))
    await u.type(await screen.findByLabelText('Name'), 'Lovemore'); await u.type(screen.getByLabelText('PIN'), '1234'); await u.click(screen.getByRole('button', { name: 'Sign in' }))
    await screen.findByRole('navigation', { name: 'Main' })
    const ctx = () => useApp.getState().ctx!
    const season = createSeason(ctx(), { label: '2026/27', starts_on: '2026-09-01', ends_on: '2027-08-31', activate: true })
    ctx().db.update('farms', ctx().farmId, { modules: 'tobacco,seedbed' }); useApp.getState().setModule('seedbed')
    const bay = createSeedbed(ctx(), { season_id: season, code: 'BAY1', kind: 'float_bay' }); const emptyBay = createSeedbed(ctx(), { season_id: season, code: 'BAY2', kind: 'float_bay' })
    createSeedbed(ctx(), { season_id: season, code: 'OB1', bed_length_m: 10, bed_width_m: 1, bed_count: 1 })
    const tt = saveTrayType(ctx(), { name: '200-cell', cells: 200, length_mm: null, width_mm: null, media: null, note: null })
    createTray(ctx(), { seedbed_id: bay, tray_type_id: tt }); const t2 = createTray(ctx(), { seedbed_id: bay, tray_type_id: tt })
    const feed = createInput(ctx(), { name: 'Float feed', category: 'fertilizer', unit: 'kg' }); recordPurchase(ctx(), { input_id: feed, qty: 10, unit_cost: 2, occurred_on: '2026-09-01' })
    useApp.getState().bump()
    await u.click(await screen.findByRole('link', { name: 'Operations' })); await screen.findByRole('heading', { name: 'Operations diary' })
    const opTypes = (el: HTMLElement) => Array.from((within(el).getByLabelText('Operation') as HTMLSelectElement).options).map(x => x.text)
    const pick = async (f: HTMLElement, label: string) => { await u.selectOptions(within(f).getByLabelText('Applies to'), 'seedbed'); await u.selectOptions(within(f).getByLabelText('Seedbed'), label) }

    // open bed: no Tray select, the seedbed operation types
    await u.click(screen.getByRole('button', { name: 'Record operation' })); let f = await screen.findByRole('dialog', { name: 'Record operation' })
    await pick(f, 'OB1 (2026/27)'); expect(within(f).queryByLabelText('Tray')).toBeNull(); expect(opTypes(f)).toContain('Bed preparation'); expect(opTypes(f)).not.toContain('Float water top-up')
    await u.click(within(f).getByRole('button', { name: 'Cancel' }))

    // empty bay: float types, a note instead of a tray choice, the operation is bay-level
    await u.click(screen.getByRole('button', { name: 'Record operation' })); f = await screen.findByRole('dialog', { name: 'Record operation' })
    await pick(f, 'BAY2 (2026/27)'); within(f).getByText(/No trays in this bay yet/); expect(within(f).queryByLabelText('Tray')).toBeNull()
    expect(opTypes(f)).toContain('Float water top-up'); expect(opTypes(f)).not.toContain('Bed preparation')
    await u.click(within(f).getByRole('button', { name: 'Cancel' }))

    // tray operation: Tray select appears for BAY1, record Float water top-up on T-002 with an input
    await u.click(screen.getByRole('button', { name: 'Record operation' })); f = await screen.findByRole('dialog', { name: 'Record operation' })
    await pick(f, 'BAY1 (2026/27)')
    const trayOpts = Array.from((within(f).getByLabelText('Tray') as HTMLSelectElement).options).map(x => x.text); expect(trayOpts[0]).toMatch(/Whole bay/); expect(trayOpts.join('|')).toMatch(/T-001.*T-002/)
    // too much stock first: toast, nothing saved, form stays
    await u.selectOptions(within(f).getByLabelText('Tray'), t2); await u.selectOptions(within(f).getByLabelText('Operation'), 'Float water top-up')
    await u.click(within(f).getByRole('button', { name: '+ Add input' }))
    const prod = within(f).getByDisplayValue('Product…') as HTMLSelectElement; await u.selectOptions(prod, feed)
    const qty = within(f).getByPlaceholderText('kg'); await u.type(qty, '50'); await u.click(within(f).getByRole('button', { name: 'Record operation' }))
    await screen.findByText(/Insufficient stock/); expect(ctx().db.get(`SELECT 1 FROM operations`)).toBeUndefined(); expect(screen.getByRole('dialog', { name: 'Record operation' })).toBeTruthy()
    await u.clear(qty); await u.type(qty, '4'); await u.click(within(f).getByRole('button', { name: 'Record operation' }))
    await screen.findByText('Operation recorded'); expect(screen.queryByRole('dialog', { name: 'Record operation' })).toBeNull()
    const op = ctx().db.get<{ id: string; tray_id: string; seedbed_id: string; op_type: string }>(`SELECT id, tray_id, seedbed_id, op_type FROM operations`)!
    expect(op).toMatchObject({ tray_id: t2, seedbed_id: bay, op_type: 'Float water top-up' }); expect(stockOf(ctx(), feed)).toBe(6)
    expect(ctx().db.all<{ tray_id: string; seedbed_id: string; amount: number }>(`SELECT tray_id, seedbed_id, amount FROM cost_entries WHERE deleted_at IS NULL`)).toEqual([{ tray_id: t2, seedbed_id: bay, amount: 8 }])
    const row = screen.getByText('Float water top-up').closest('tr')!; within(row).getByText('BAY1'); within(row).getByText('T-002')

    // bay-level operation (Whole bay): no tray stored
    await u.click(screen.getByRole('button', { name: 'Record operation' })); f = await screen.findByRole('dialog', { name: 'Record operation' })
    await pick(f, 'BAY1 (2026/27)'); expect((within(f).getByLabelText('Tray') as HTMLSelectElement).value).toBe('')
    await u.selectOptions(within(f).getByLabelText('Operation'), 'Tray cleaning'); await u.click(within(f).getByRole('button', { name: 'Record operation' }))
    await vi.waitFor(() => expect(screen.queryByRole('dialog', { name: 'Record operation' })).toBeNull())
    expect(ctx().db.all(`SELECT tray_id, seedbed_id FROM operations WHERE op_type='Tray cleaning'`)).toEqual([{ tray_id: null, seedbed_id: bay }])
    const crow = screen.getByText('Tray cleaning').closest('tr')!; within(crow).getByText('BAY1'); expect(within(crow).queryByText(/T-00/)).toBeNull()

    // switching the seedbed clears a chosen tray
    await u.click(screen.getByRole('button', { name: 'Record operation' })); f = await screen.findByRole('dialog', { name: 'Record operation' })
    await pick(f, 'BAY1 (2026/27)'); await u.selectOptions(within(f).getByLabelText('Tray'), t2); await u.selectOptions(within(f).getByLabelText('Seedbed'), 'OB1 (2026/27)'); expect(within(f).queryByLabelText('Tray')).toBeNull()
    await u.click(within(f).getByRole('button', { name: 'Cancel' }))

    // delete the tray operation: stock and costs reversed
    await u.click(within(screen.getByText('Float water top-up').closest('tr')!).getByRole('button', { name: 'Delete' })); await screen.findByText('Operation reversed')
    expect(stockOf(ctx(), feed)).toBe(10); expect(ctx().db.get(`SELECT 1 FROM cost_entries WHERE tray_id=? AND deleted_at IS NULL`, [t2])).toBeUndefined(); expect(screen.queryByText('Float water top-up')).toBeNull()
    void emptyBay
  }, 60000)
})
