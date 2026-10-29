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

import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from './App'
import { useApp } from './store/app'
import { createSeason } from './services/seasons'
import { createSeedbed } from './services/seedbeds'
import { createTray, updateTray } from './services/trays'
import { saveTrayType } from './services/traytypes'

describe('Seedbeds page in a multi-module farm (walk-through D2, D7, D9)', () => {
  it('is module-aware: seedbed seasons only in the Seedbed module, legacy view in Tobacco; bay status from its trays; BAY-nnn default code', async () => {
    const u = userEvent.setup(); render(<App />)
    await u.type(await screen.findByLabelText('Farm name'), 'Home Farm'); await u.type(screen.getByLabelText('Owner name'), 'Lovemore')
    await u.type(screen.getByLabelText('Owner PIN (4–8 digits)'), '1234'); await u.type(screen.getByLabelText('Confirm PIN'), '1234'); await u.click(screen.getByRole('button', { name: 'Create farm' }))
    await u.type(await screen.findByLabelText('Name'), 'Lovemore'); await u.type(screen.getByLabelText('PIN'), '1234'); await u.click(screen.getByRole('button', { name: 'Sign in' }))
    await screen.findByRole('navigation', { name: 'Main' })
    const ctx = () => useApp.getState().ctx!
    ctx().db.update('farms', ctx().farmId, { modules: 'tobacco,seedbed' }); useApp.getState().setModule('seedbed')
    // R6: with no seedbed season the Seedbed module cannot create beds (and lists none), even though a tobacco season is active
    createSeason(ctx(), { label: '2026/27', starts_on: '2026-09-01', ends_on: '2027-08-31', activate: true, enterprise: 'tobacco' }); useApp.getState().bump()
    await u.click(await screen.findByRole('link', { name: 'Seedbeds' })); await screen.findByRole('heading', { name: 'Seedbeds' })
    expect((screen.getByRole('button', { name: 'New seedbed' }) as HTMLButtonElement).disabled).toBe(true); screen.getByText(/Create a seedbed season first/)
    const sb = createSeason(ctx(), { label: 'SB 2026', starts_on: '2026-08-01', ends_on: '2026-11-30', activate: true, enterprise: 'seedbed' })
    const bay = createSeedbed(ctx(), { season_id: sb, code: 'BAY-001', kind: 'float_bay' })
    const tt = saveTrayType(ctx(), { name: '200-cell', cells: 200, length_mm: null, width_mm: null, media: null, note: null })
    const t1 = createTray(ctx(), { seedbed_id: bay, tray_type_id: tt }); createTray(ctx(), { seedbed_id: bay, tray_type_id: tt })
    useApp.getState().setModule('seedbed'); useApp.getState().bump()

    // Seedbed module: the picker lists only seedbed seasons and defaults to the active one; leaving and coming back keeps the bay on screen
    await screen.findByRole('option', { name: 'SB 2026' })
    const picker = () => (screen.getAllByRole('combobox') as HTMLSelectElement[]).find(c => Array.from(c.options).some(o => /SB 2026|2026\/27/.test(o.text)))!
    expect(Array.from(picker().options).map(o => o.text)).toEqual(['SB 2026']); expect(picker().selectedOptions[0].text).toBe('SB 2026')
    let row = (await screen.findByText('BAY-001')).closest('tr')!
    // D7: the stored status is still "prepared", the row says what the trays are doing
    within(row).getByText('2 trays: sown'); expect(within(row).queryByText('prepared')).toBeNull()
    updateTray(ctx(), t1, { status: 'growing' }); useApp.getState().bump()
    within((await screen.findByText('BAY-001')).closest('tr')!).getByText('2 trays: 1 sown, 1 growing')
    await u.click(screen.getByRole('link', { name: 'Tray types' })); await screen.findByRole('heading', { name: 'Tray types' })
    await u.click(screen.getByRole('link', { name: 'Seedbeds' })); await screen.findByRole('heading', { name: 'Seedbeds' })
    row = (await screen.findByText('BAY-001')).closest('tr')!; expect(screen.queryByText('No seedbeds for this season.')).toBeNull()

    // D9: a new float bay is offered BAY-nnn, an open bed SB-nnn, and a code the person typed is kept
    await u.click(screen.getByRole('button', { name: 'New seedbed' })); let f = await screen.findByRole('dialog', { name: 'New seedbed' })
    expect((within(f).getByLabelText('Seedbed ID') as HTMLInputElement).value).toBe('SB-002')
    await u.selectOptions(within(f).getByLabelText('Kind'), 'float_bay'); expect((within(f).getByLabelText('Seedbed ID') as HTMLInputElement).value).toBe('BAY-002')
    await u.selectOptions(within(f).getByLabelText('Kind'), 'open_bed'); expect((within(f).getByLabelText('Seedbed ID') as HTMLInputElement).value).toBe('SB-002')
    await u.clear(within(f).getByLabelText('Seedbed ID')); await u.type(within(f).getByLabelText('Seedbed ID'), 'MINE')
    await u.selectOptions(within(f).getByLabelText('Kind'), 'float_bay'); expect((within(f).getByLabelText('Seedbed ID') as HTMLInputElement).value).toBe('MINE')
    await u.click(within(f).getByRole('button', { name: 'Cancel' }))

    // Tobacco module: unchanged legacy behaviour, every season in the picker, default = the active season
    useApp.getState().setModule('tobacco'); useApp.getState().bump()
    await screen.findByRole('heading', { name: 'Seedbeds' })
    expect(Array.from(picker().options).map(o => o.text).sort()).toEqual(['2026/27', 'SB 2026']); expect(picker().selectedOptions[0].text).toBe('2026/27')
    // a season picked in Tobacco must not stick when the module changes: the Seedbed module falls back to its own default
    await u.selectOptions(picker(), (Array.from(picker().options).find(o => o.text === '2026/27'))!.value)
    useApp.getState().setModule('seedbed'); useApp.getState().bump()
    await waitFor(() => expect(Array.from(picker().options).map(o => o.text)).toEqual(['SB 2026'])); await screen.findByText('BAY-001')
  })
})
