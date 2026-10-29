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
import { listTrayTypes } from './services/traytypes'

describe('Tray types UI', () => {
  it('empty state, validation errors, add, edit, delete blocked while in use, then allowed; view-only users see no edit controls', async () => {
    const u = userEvent.setup(); render(<App />)
    await u.type(await screen.findByLabelText('Farm name'), 'Home Farm'); await u.type(screen.getByLabelText('Owner name'), 'Lovemore')
    await u.type(screen.getByLabelText('Owner PIN (4–8 digits)'), '1234'); await u.type(screen.getByLabelText('Confirm PIN'), '1234'); await u.click(screen.getByRole('button', { name: 'Create farm' }))
    await u.type(await screen.findByLabelText('Name'), 'Lovemore'); await u.type(screen.getByLabelText('PIN'), '1234'); await u.click(screen.getByRole('button', { name: 'Sign in' }))
    await screen.findByRole('navigation', { name: 'Main' })
    const ctx = () => useApp.getState().ctx!
    const season = createSeason(ctx(), { label: '2026/27', starts_on: '2026-09-01', ends_on: '2027-08-31', activate: true })
    ctx().db.update('farms', ctx().farmId, { modules: 'tobacco,seedbed' }); useApp.getState().setModule('seedbed')

    // empty state
    await u.click(await screen.findByRole('link', { name: 'Tray types' })); await screen.findByRole('heading', { name: 'Tray types' }); await screen.findByText('No tray types yet')

    // validation errors come from the service and show as toasts; nothing is saved
    await u.click(screen.getByRole('button', { name: 'Add tray type' })); let f = await screen.findByRole('dialog', { name: 'Add tray type' })
    await u.click(within(f).getByRole('button', { name: 'Save' })); await screen.findByText(/Give the tray type a name/)
    await u.type(within(f).getByLabelText('Name'), '200-cell'); await u.type(within(f).getByLabelText('Cells per tray'), '1.5'); await u.click(within(f).getByRole('button', { name: 'Save' }))
    await screen.findByText(/whole number above zero/); expect(listTrayTypes(ctx())).toHaveLength(0); expect(screen.getByRole('dialog', { name: 'Add tray type' })).toBeTruthy()

    // add
    await u.clear(within(f).getByLabelText('Cells per tray')); await u.type(within(f).getByLabelText('Cells per tray'), '200')
    await u.type(within(f).getByLabelText('Length (mm)'), '670'); await u.type(within(f).getByLabelText('Width (mm)'), '340'); await u.type(within(f).getByLabelText('Media'), 'Pine bark')
    await u.click(within(f).getByRole('button', { name: 'Save' })); await screen.findByText('Tray type saved')
    expect(screen.queryByRole('dialog', { name: 'Add tray type' })).toBeNull()
    const row = (await screen.findByText('200-cell')).closest('tr')!; within(row).getByText('200'); within(row).getByText('670 × 340'); within(row).getByText('Pine bark')
    expect(listTrayTypes(ctx())).toMatchObject([{ name: '200-cell', cells: 200, length_mm: 670, width_mm: 340, media: 'Pine bark' }])
    expect(screen.queryByText('No tray types yet')).toBeNull()

    // a duplicate name is refused
    await u.click(screen.getByRole('button', { name: 'Add tray type' })); f = await screen.findByRole('dialog', { name: 'Add tray type' })
    await u.type(within(f).getByLabelText('Name'), '200-cell'); await u.type(within(f).getByLabelText('Cells per tray'), '100'); await u.click(within(f).getByRole('button', { name: 'Save' }))
    await screen.findByText(/already exists/); await u.click(within(f).getByRole('button', { name: 'Cancel' })); expect(listTrayTypes(ctx())).toHaveLength(1)

    // edit
    await u.click(screen.getByRole('button', { name: 'Edit 200-cell' })); f = await screen.findByRole('dialog', { name: 'Edit 200-cell' })
    expect((within(f).getByLabelText('Name') as HTMLInputElement).value).toBe('200-cell')
    await u.clear(within(f).getByLabelText('Cells per tray')); await u.type(within(f).getByLabelText('Cells per tray'), '198'); await u.click(within(f).getByRole('button', { name: 'Save' }))
    await screen.findByText('Tray type updated'); expect(listTrayTypes(ctx())[0]).toMatchObject({ name: '200-cell', cells: 198 })
    within((await screen.findByText('200-cell')).closest('tr')!).getByText('198')

    // delete blocked while a tray uses it
    const id = listTrayTypes(ctx())[0].id; const bed = createSeedbed(ctx(), { season_id: season, code: 'B1' } as never)
    ctx().db.run(`INSERT INTO seedbed_trays(id,tenant_id,farm_id,seedbed_id,tray_type_id,code) VALUES('tr1',?,?,?,?,'T1')`, [ctx().tenantId, ctx().farmId, bed, id])
    await u.click(screen.getByRole('button', { name: 'Delete 200-cell' })); await screen.findByText(/in use by 1 tray/); expect(listTrayTypes(ctx())).toHaveLength(1)

    // view-only user: rows visible, no edit controls
    const full = ctx()
    useApp.setState({ ctx: { ...full, perms: new Set(['production.seedbed.view']) } })
    await screen.findByText('200-cell'); expect(screen.queryByRole('button', { name: 'Add tray type' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Edit 200-cell' })).toBeNull(); expect(screen.queryByRole('button', { name: 'Delete 200-cell' })).toBeNull()
    useApp.setState({ ctx: full })

    // delete allowed once no tray uses it
    ctx().db.softDelete('seedbed_trays', 'tr1'); useApp.getState().bump()
    await u.click(await screen.findByRole('button', { name: 'Delete 200-cell' })); await screen.findByText('Tray type removed')
    await screen.findByText('No tray types yet'); expect(listTrayTypes(ctx())).toHaveLength(0)

    // "Add example" creates one editable example from the empty state
    await u.click(screen.getByRole('button', { name: 'Add example' })); await screen.findByText('Example tray type added')
    expect(listTrayTypes(ctx())).toMatchObject([{ name: '200-cell tray', cells: 200 }]); expect(screen.getByRole('button', { name: 'Edit 200-cell tray' })).toBeTruthy()
  }, 30000)
})
