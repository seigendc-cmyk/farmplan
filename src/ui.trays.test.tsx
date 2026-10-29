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
import { listSeedbeds } from './services/seedbeds'
import { listTrays } from './services/trays'
import { saveTrayType } from './services/traytypes'

describe('Float bays and trays UI', () => {
  it('kind choice, bay row, tray dialog: no types link, empty state, validation, add, edit, remove, total updates; open beds unchanged', async () => {
    const u = userEvent.setup(); render(<App />)
    await u.type(await screen.findByLabelText('Farm name'), 'Home Farm'); await u.type(screen.getByLabelText('Owner name'), 'Lovemore')
    await u.type(screen.getByLabelText('Owner PIN (4–8 digits)'), '1234'); await u.type(screen.getByLabelText('Confirm PIN'), '1234'); await u.click(screen.getByRole('button', { name: 'Create farm' }))
    await u.type(await screen.findByLabelText('Name'), 'Lovemore'); await u.type(screen.getByLabelText('PIN'), '1234'); await u.click(screen.getByRole('button', { name: 'Sign in' }))
    await screen.findByRole('navigation', { name: 'Main' })
    const ctx = () => useApp.getState().ctx!
    const season = createSeason(ctx(), { label: '2026/27', starts_on: '2026-09-01', ends_on: '2027-08-31', activate: true })
    ctx().db.update('farms', ctx().farmId, { modules: 'tobacco,seedbed' }); useApp.getState().setModule('seedbed')
    await u.click(await screen.findByRole('link', { name: 'Seedbeds' })); await screen.findByRole('heading', { name: 'Seedbeds' })

    // an open bed is created exactly as before (Kind defaults to Open bed, dimension fields shown)
    await u.click(screen.getByRole('button', { name: 'New seedbed' })); let f = await screen.findByRole('dialog', { name: 'New seedbed' })
    expect((within(f).getByLabelText('Kind') as HTMLSelectElement).value).toBe('open_bed'); within(f).getByLabelText('Bed length (m)')
    await u.clear(within(f).getByLabelText('Seedbed ID')); await u.type(within(f).getByLabelText('Seedbed ID'), 'OB1')
    await u.click(within(f).getByRole('button', { name: 'Save seedbed' })); await screen.findByText('Seedbed created')
    expect(listSeedbeds(ctx(), season)).toMatchObject([{ code: 'OB1', kind: 'open_bed' }]); expect(screen.queryByRole('button', { name: 'Trays OB1' })).toBeNull()

    // choosing Float bay swaps the bed fields away and creates a bay
    await u.click(screen.getByRole('button', { name: 'New seedbed' })); f = await screen.findByRole('dialog', { name: 'New seedbed' })
    await u.selectOptions(within(f).getByLabelText('Kind'), 'float_bay')
    expect(within(f).queryByLabelText('Bed length (m)')).toBeNull(); expect(within(f).queryByLabelText('Actual seedlings')).toBeNull()
    await u.clear(within(f).getByLabelText('Seedbed ID')); await u.type(within(f).getByLabelText('Seedbed ID'), 'BAY1')
    await u.click(within(f).getByRole('button', { name: 'Save seedbed' })); await screen.findAllByText('Seedbed created')
    const bay = listSeedbeds(ctx(), season).find(s => s.code === 'BAY1')!; expect(bay).toMatchObject({ kind: 'float_bay', bed_length_m: null, actual_seedlings: null })
    const bayRow = screen.getByText('BAY1').closest('tr')!; within(bayRow).getByText('Float bay')

    // no tray types yet: an inline link to Tray types, no form
    await u.click(within(bayRow).getByRole('button', { name: 'Trays BAY1' })); let d = await screen.findByRole('dialog', { name: 'BAY1 — trays' })
    within(d).getByText('No trays in this bay yet'); within(d).getByText(/Add a tray type first/)
    expect(within(d).getByRole('link', { name: 'Tray types' }).getAttribute('href')).toBe('#/tray-types'); expect(within(d).queryByRole('button', { name: 'Add tray' })).toBeNull()
    await u.click(within(d).getByRole('link', { name: 'Tray types' })); await screen.findByRole('heading', { name: 'Tray types' })
    await u.click(screen.getByRole('link', { name: 'Seedbeds' })); await screen.findByRole('heading', { name: 'Seedbeds' })

    // with a tray type: add a tray; validation shows as a toast and keeps the form open
    saveTrayType(ctx(), { name: '200-cell', cells: 200, length_mm: null, width_mm: null, media: null, note: null }); useApp.getState().bump()
    await u.click(within(screen.getByText('BAY1').closest('tr')!).getByRole('button', { name: 'Trays BAY1' })); d = await screen.findByRole('dialog', { name: 'BAY1 — trays' })
    within(d).getByText('No trays in this bay yet'); await u.click(within(d).getByRole('button', { name: 'Add tray' })); const tf = await screen.findByRole('dialog', { name: 'Add tray' })
    expect((within(tf).getByLabelText('Code') as HTMLInputElement).placeholder).toBe('T-001')
    await u.type(within(tf).getByLabelText('Actual seedlings'), '-4'); await u.click(within(tf).getByRole('button', { name: 'Save tray' }))
    await screen.findByText(/cannot be negative/); expect(listTrays(ctx(), bay.id)).toHaveLength(0); expect(screen.getByRole('dialog', { name: 'Add tray' })).toBeTruthy()
    await u.clear(within(tf).getByLabelText('Actual seedlings')); await u.type(within(tf).getByLabelText('Actual seedlings'), '150')
    await u.type(within(tf).getByLabelText('Variety'), 'K326'); await u.type(within(tf).getByLabelText('Sown date'), '2026-09-05')
    await u.click(within(tf).getByRole('button', { name: 'Save tray' })); await screen.findByText('Tray added')
    expect(screen.queryByRole('dialog', { name: 'Add tray' })).toBeNull()
    expect(listTrays(ctx(), bay.id)).toMatchObject([{ code: 'T-001', tray_type: '200-cell', variety: 'K326', sown_on: '2026-09-05', expected_seedlings: 200, actual_seedlings: 150 }])
    d = screen.getByRole('dialog', { name: 'BAY1 — trays' }); const tr = within(d).getByText('T-001').closest('tr')!; within(tr).getByText('200-cell'); within(tr).getByText('K326')
    expect(within(d).queryByText('No trays in this bay yet')).toBeNull(); within(d).getByText(/Seedlings in this bay: 150/)

    // edit a tray: the bay total follows
    await u.click(within(d).getByRole('button', { name: 'Edit T-001' })); const ef = await screen.findByRole('dialog', { name: 'Edit T-001' })
    await u.clear(within(ef).getByLabelText('Actual seedlings')); await u.type(within(ef).getByLabelText('Actual seedlings'), '170'); await u.click(within(ef).getByRole('button', { name: 'Save tray' }))
    await screen.findByText('Tray updated'); within(screen.getByRole('dialog', { name: 'BAY1 — trays' })).getByText(/Seedlings in this bay: 170/)
    expect(listSeedbeds(ctx(), season).find(s => s.id === bay.id)!.actual_seedlings).toBe(170)
    await u.click(within(screen.getByRole('dialog', { name: 'BAY1 — trays' })).getByRole('button', { name: 'Close' }))
    within(screen.getByText('BAY1').closest('tr')!).getByText('170')

    // remove a tray
    await u.click(within(screen.getByText('BAY1').closest('tr')!).getByRole('button', { name: 'Trays BAY1' })); d = await screen.findByRole('dialog', { name: 'BAY1 — trays' })
    await u.click(within(d).getByRole('button', { name: 'Remove T-001' })); await screen.findByText('Tray removed')
    within(screen.getByRole('dialog', { name: 'BAY1 — trays' })).getByText('No trays in this bay yet'); expect(listTrays(ctx(), bay.id)).toHaveLength(0)

    // view-only: trays visible, no add/edit/remove
    await u.click(within(screen.getByRole('dialog', { name: 'BAY1 — trays' })).getByRole('button', { name: 'Close' }))
    const full = ctx(); const keep = (await import('./services/trays')).createTray(full, { seedbed_id: bay.id, tray_type_id: listTrayTypesId(full) }); useApp.getState().bump()
    useApp.setState({ ctx: { ...full, perms: new Set(['production.seedbed.view']) } })
    await u.click(await screen.findByRole('button', { name: 'Trays BAY1' })); d = await screen.findByRole('dialog', { name: 'BAY1 — trays' })
    within(d).getByText('T-002'); expect(keep).toBeTruthy()
    expect(within(d).queryByRole('button', { name: 'Add tray' })).toBeNull(); expect(within(d).queryByRole('button', { name: 'Edit T-002' })).toBeNull(); expect(within(d).queryByRole('button', { name: 'Remove T-002' })).toBeNull()
    useApp.setState({ ctx: full })
  }, 40000)
})
import { listTrayTypes } from './services/traytypes'
const listTrayTypesId = (c: Parameters<typeof listTrayTypes>[0]) => listTrayTypes(c)[0].id
