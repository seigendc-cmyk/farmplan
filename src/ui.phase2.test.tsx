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
import { createField } from './services/fields'
import { createBarn } from './services/curing'
import { recordHarvest } from './services/harvest'

const label = (t: string | RegExp) => screen.findByLabelText(t)

describe('Phase 2 UI: harvest → curing → starking', () => {
  it('runs a leaf batch through the barn and into storage', async () => {
    const u = userEvent.setup()
    render(<App />)
    await u.type(await label('Farm name'), 'Home Farm'); await u.type(await label('Owner name'), 'Lovemore')
    await u.type(await label('Owner PIN (4–8 digits)'), '1234'); await u.type(await label('Confirm PIN'), '1234')
    await u.click(screen.getByRole('button', { name: 'Create farm' }))
    await u.type(await label('Name'), 'Lovemore'); await u.type(await label('PIN'), '1234')
    await u.click(screen.getByRole('button', { name: 'Sign in' }))
    await screen.findByText('No active season')

    const ctx = useApp.getState().ctx!
    const season = createSeason(ctx, { label: '2026/27', starts_on: '2026-09-01', ends_on: '2027-08-31', activate: true })
    const field = createField(ctx, { field_no: 'F-04', area_ha: 4 })
    createBarn(ctx, { code: 'B-01', capacity_kg: 5000 })
    recordHarvest(ctx, { field_id: field, season_id: season, harvested_on: '2026-12-01', green_weight_kg: 1000 })
    useApp.getState().bump()

    // harvest page lists the coded batch
    await u.click(screen.getByRole('link', { name: 'Harvest' }))
    await screen.findByText('H-00001')

    // create cycle
    await u.click(screen.getByRole('link', { name: 'Curing cycles' }))
    await u.click(await screen.findByRole('button', { name: 'New cycle' }))
    await u.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Create' }))
    await screen.findByText(/Cycle created/)
    await u.click(await screen.findByRole('button', { name: 'Open' }))
    let dlg = await screen.findByRole('dialog', { name: /C-00001/ })

    // loading is gated by the checklist
    expect(within(dlg).queryByRole('button', { name: 'Load barn' })).toBeNull()
    for (const box of within(dlg).getAllByRole('checkbox')) await u.click(box)
    await u.click(await within(dlg).findByRole('button', { name: 'Load barn' }))
    const load = (await screen.findAllByRole('dialog')).find(d => d.getAttribute('aria-label') === 'Load barn')!
    await u.click(within(load).getByRole('checkbox'))
    await u.click(within(load).getByRole('button', { name: 'Start curing' }))
    await screen.findByText('Barn loaded')

    // temperature log
    dlg = await screen.findByRole('dialog', { name: /C-00001/ })
    await u.click(await within(dlg).findByRole('button', { name: 'Add temperature / fuel log' }))
    const log = (await screen.findAllByRole('dialog')).find(d => d.getAttribute('aria-label') === 'Curing log')!
    await u.type(within(log).getByLabelText('Temperature (°C)'), '42')
    await u.click(within(log).getByRole('button', { name: 'Save log' }))
    await screen.findByText('Log saved')
    await waitFor(() => expect(within(screen.getByRole('dialog', { name: /C-00001/ })).getByText('42 °C')).toBeTruthy())

    // offload 200 kg → 20% recovery
    await u.click(within(screen.getByRole('dialog', { name: /C-00001/ })).getByRole('button', { name: 'Offload' }))
    const off = (await screen.findAllByRole('dialog')).find(d => d.getAttribute('aria-label') === 'Offload barn')!
    await u.type(within(off).getByLabelText(/Cured weight/), '200')
    await u.click(within(off).getByRole('button', { name: 'Complete cycle' }))
    await screen.findByText('Cycle completed')
    await waitFor(() => expect(within(screen.getByRole('dialog', { name: /C-00001/ })).getByText('20%')).toBeTruthy())
    await u.click(screen.getByRole('button', { name: 'Close' }))

    // starking: warning, then store, then maturing
    await u.click(screen.getByRole('link', { name: 'Starking' }))
    await screen.findByText('Cured leaf not yet stored')
    await u.click(screen.getByRole('button', { name: 'Store cured leaf' }))
    const st = await screen.findByRole('dialog', { name: 'Store cured leaf' })
    await u.type(within(st).getByLabelText(/Weight/), '200')
    await u.click(within(st).getByRole('button', { name: 'Save' }))
    await screen.findByText('Stored — maturing started')
    await screen.findByText('MATURING')
    expect(screen.queryByText('Cured leaf not yet stored')).toBeNull()
  }, 90000)
})
