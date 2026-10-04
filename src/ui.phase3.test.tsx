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
import { createBarn, createCycle, setCheck, loadCycle, offloadCycle, CHECKLIST_ITEMS } from './services/curing'
import { recordHarvest } from './services/harvest'
import { createStorageUnit, openStorageUnit } from './services/storage'

const label = (t: string | RegExp) => screen.findByLabelText(t)
const dialog = (name: string | RegExp) => screen.findByRole('dialog', { name })

describe('Phase 3 UI: grading → bales → sale', () => {
  const setDate = async (el: HTMLElement, v: string) => { const u2 = userEvent.setup(); await u2.clear(el); await u2.type(el, v) }
  it('grades a unit, bales it, traces a bale and records a paid sale', async () => {
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
    const h = recordHarvest(ctx, { field_id: field, season_id: season, harvested_on: '2027-01-20', green_weight_kg: 1000, variety: 'KRK26' })
    const { id: cyc } = createCycle(ctx, { barn_id: createBarn(ctx, { capacity_kg: 5000 }), season_id: season })
    for (const i of CHECKLIST_ITEMS) setCheck(ctx, cyc, i, true, '2027-01-21')
    loadCycle(ctx, { cycle_id: cyc, batch_ids: [h.id], loaded_at: '2027-01-22T08:00' })
    offloadCycle(ctx, { cycle_id: cyc, offloaded_at: '2027-01-28T08:00', cured_weight_kg: 200 })
    const unit = createStorageUnit(ctx, { cycle_id: cyc, kind: 'slate_pack', weight_kg: 200, created_on: '2027-01-30', maturity_days: 7 }).id
    openStorageUnit(ctx, unit, '2027-02-10'); useApp.getState().bump()

    // grade catalogue is empty until the farm defines it
    await u.click(screen.getByRole('link', { name: 'Grading' }))
    await screen.findByText(/grade catalogue is empty/)
    await u.click(screen.getByRole('button', { name: 'Grade catalogue' }))
    let dlg = await dialog('Grade catalogue')
    for (const c of ['A', 'B']) { await u.type(within(dlg).getByLabelText('Code'), c); await u.click(within(dlg).getByRole('button', { name: 'Add grade' })); await screen.findAllByText('Grade added') }
    await u.click(within(dlg).getByRole('button', { name: 'Close' }))

    // variance gate: 150 of 200 kg needs an explanation
    await u.click(await screen.findByRole('button', { name: 'Grade a unit' }))
    dlg = await dialog('Grade a storage unit')
    await setDate(within(dlg).getByLabelText('Grading date'), '2027-02-12')
    await u.type(within(dlg).getByLabelText('Grade A'), '120'); await u.type(within(dlg).getByLabelText('Grade B'), '30')
    await within(dlg).findByText(/explain below/)
    await u.click(within(dlg).getByRole('button', { name: 'Save grading' }))
    await screen.findByText(/Explain the variance to continue/)
    await u.clear(within(dlg).getByLabelText('Grade B')); await u.type(within(dlg).getByLabelText('Grade B'), '78')
    await u.click(within(dlg).getByRole('button', { name: 'Save grading' }))
    await screen.findByText('Grading recorded')

    // bales
    await u.click(screen.getByRole('link', { name: 'Bales' }))
    await u.click(await screen.findByRole('button', { name: 'Create bales' }))
    dlg = await dialog('Create bales')
    await setDate(within(dlg).getByLabelText('Baling date'), '2027-02-15')
    await u.type(within(dlg).getByLabelText('Number of bales'), '2'); await u.type(within(dlg).getByLabelText(/Weight each/), '60')
    await u.click(within(dlg).getByRole('button', { name: 'Create' }))
    await screen.findByText('2 bales created')
    await screen.findByText('TB26-F04-B000001'); await screen.findByText('TB26-F04-B000002')
    await u.click(screen.getAllByRole('button', { name: 'Trace' })[1])
    dlg = await dialog(/^Trace TB26/)
    await within(dlg).findByText(/C-00001/); expect(within(dlg).getByText(/SP-00001/)).toBeTruthy(); expect(within(dlg).getByText(/H-00001/)).toBeTruthy()
    await u.click(within(dlg).getByRole('button', { name: 'Close' }))

    // sale of both bales with a levy, then full payment
    await u.click(screen.getByRole('link', { name: 'Sales' }))
    await u.click(await screen.findByRole('button', { name: 'Record sale' }))
    dlg = await dialog('Record sale')
    await setDate(within(dlg).getByLabelText('Sale date'), '2027-02-20')
    await u.type(within(dlg).getByLabelText('Price for TB26-F04-B000001'), '4'); await u.type(within(dlg).getByLabelText('Price for TB26-F04-B000002'), '4')
    await u.type(within(dlg).getByLabelText('Deduction label'), 'Levy'); await u.type(within(dlg).getByLabelText('Deduction amount'), '20')
    await within(dlg).findByText(/gross/)
    await u.click(within(dlg).getByRole('button', { name: 'Save sale' }))
    await screen.findByText('Sale recorded')
    await u.click(await screen.findByRole('button', { name: 'Open' }))
    dlg = await dialog(/ML-00001/)
    await u.click(within(dlg).getByRole('button', { name: 'Record payment' }))
    await setDate(within(dlg).getByLabelText('Date'), '2027-02-25')
    await u.click(within(dlg).getByRole('button', { name: 'Save' }))
    await screen.findByText('Payment recorded')
    await waitFor(() => expect(within(screen.getByRole('dialog', { name: /ML-00001/ })).getByText('paid')).toBeTruthy())
    expect(within(screen.getByRole('dialog', { name: /ML-00001/ })).getAllByText('$460.00').length).toBeGreaterThan(0) // 120 kg × $4 = $480 gross − $20 levy
  }, 120000)
})
