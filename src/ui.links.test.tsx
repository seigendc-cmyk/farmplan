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
import { createField } from './services/fields'
import { recordHarvest } from './services/harvest'
import { createBarn, createCycle, setCheck, loadCycle, offloadCycle, CHECKLIST_ITEMS } from './services/curing'
import { createStorageUnit, openStorageUnit } from './services/storage'
import { saveGrade, createGrading, listGrading, createBales } from './services/quality'
import { createBuyer } from './services/buyers'
import { createSale } from './services/marketing'

describe('Connected records UI', () => {
  it('follows one crop from the field page through curing, bales and sale to the buyer, jumping to the right season', async () => {
    const u = userEvent.setup(); render(<App />)
    await u.type(await screen.findByLabelText('Farm name'), 'Home Farm'); await u.type(screen.getByLabelText('Owner name'), 'Lovemore')
    await u.type(screen.getByLabelText('Owner PIN (4–8 digits)'), '1234'); await u.type(screen.getByLabelText('Confirm PIN'), '1234'); await u.click(screen.getByRole('button', { name: 'Create farm' }))
    await u.type(await screen.findByLabelText('Name'), 'Lovemore'); await u.type(screen.getByLabelText('PIN'), '1234'); await u.click(screen.getByRole('button', { name: 'Sign in' }))
    await screen.findByText('No active season')

    // last season's crop, while a new season is active
    const ctx = useApp.getState().ctx!
    const old = createSeason(ctx, { label: '2025/26', starts_on: '2025-09-01', ends_on: '2026-08-31' })
    createSeason(ctx, { label: '2026/27', starts_on: '2026-09-01', ends_on: '2027-08-31', activate: true })
    const field = createField(ctx, { field_no: 'F-04', area_ha: 4 })
    const h = recordHarvest(ctx, { field_id: field, season_id: old, harvested_on: '2026-01-20', green_weight_kg: 1000 })
    const { id: cyc } = createCycle(ctx, { barn_id: createBarn(ctx, { capacity_kg: 5000 }), season_id: old })
    for (const i of CHECKLIST_ITEMS) setCheck(ctx, cyc, i, true, '2026-01-21')
    loadCycle(ctx, { cycle_id: cyc, batch_ids: [h.id], loaded_at: '2026-01-22T08:00' }); offloadCycle(ctx, { cycle_id: cyc, offloaded_at: '2026-01-28T08:00', cured_weight_kg: 200 })
    const unit = createStorageUnit(ctx, { cycle_id: cyc, kind: 'pile', weight_kg: 200, created_on: '2026-01-30', maturity_days: 7 }).id
    openStorageUnit(ctx, unit, '2026-02-10')
    createGrading(ctx, { storage_unit_id: unit, graded_on: '2026-02-12', outputs: [{ grade_id: saveGrade(ctx, { code: 'A', sort_order: 1 }), weight_kg: 200 }] })
    const [bale] = createBales(ctx, { output_id: listGrading(ctx)[0].outputs[0].id, baled_on: '2026-02-14', weights: [100] })
    const buyer = createBuyer(ctx, { name: 'Boka Floors', kind: 'auction_floor' })
    createSale(ctx, { season_id: old, sold_on: '2026-03-01', channel: 'auction', buyer: 'Boka Floors', buyer_id: buyer, lines: [{ bale_id: ctx.db.get<{ id: string }>(`SELECT id FROM bales`)!.id, price_per_kg: 3 }], deductions: [] })
    useApp.getState().bump()

    // the dashboard lists the next step in the chain and goes straight to it
    const list = await screen.findByRole('list', { name: 'Needs attention' })
    await u.click(within(list).getByRole('link', { name: /G-00001 grade A: 100 kg graded but not baled/ }))
    await screen.findByRole('heading', { name: 'Grading' })   // in last season: the season picker jumped there
    expect(within(document.querySelector('tr[aria-current="true"]') as HTMLElement).getByText('G-00001')).toBeTruthy()

    // Fields → the field page, which opens on the active season and can switch to last season
    await u.click(screen.getByRole('link', { name: 'Fields' }))
    await u.click(await screen.findByRole('link', { name: 'F-04' }))
    await screen.findByRole('heading', { name: 'Field F-04' }); await screen.findByText('Nothing harvested from this field.')
    await u.selectOptions(screen.getByLabelText('Season'), old)
    await screen.findByRole('link', { name: 'H-00001' }); expect(screen.getByRole('link', { name: bale })).toBeTruthy()

    // cycle link → Curing, on last season, with that cycle open; its batch links back to Harvest with the row in focus
    await u.click(screen.getByRole('link', { name: 'C-00001' }))
    let dlg = await screen.findByRole('dialog', { name: /C-00001/ })
    expect((screen.getByLabelText('Season') as HTMLSelectElement).value).toBe(old)
    await u.click(within(dlg).getByRole('link', { name: 'H-00001' }))
    await screen.findByRole('heading', { name: 'Harvest' })
    const row = document.querySelector('tr[aria-current="true"]') as HTMLElement
    expect(within(row).getByText('H-00001')).toBeTruthy(); expect((screen.getByLabelText('Season') as HTMLSelectElement).value).toBe(old)

    // harvest → field → bale → its sale (modal opens) → the buyer, whose detail lists the sale
    await u.click(within(row).getByRole('link', { name: 'F-04' })); await screen.findByRole('heading', { name: 'Field F-04' })
    await u.selectOptions(screen.getByLabelText('Season'), old)
    await u.click(await screen.findByRole('link', { name: bale }))
    await screen.findByRole('heading', { name: 'Bales' })
    const baleRow = document.querySelector('tr[aria-current="true"]') as HTMLElement
    await u.click(within(baleRow).getByRole('link', { name: 'ML-00001' }))
    dlg = await screen.findByRole('dialog', { name: /ML-00001/ })
    await u.click(within(dlg).getByRole('link', { name: 'Boka Floors' }))
    dlg = await screen.findByRole('dialog', { name: 'Boka Floors' })
    expect(within(dlg).getByRole('link', { name: 'ML-00001' })).toBeTruthy()

    // closing the modal drops the focus, so it does not reopen
    await u.click(within(dlg).getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).toBeNull(); expect(window.location.hash).toBe('#/buyers')

    // the field's own activity, and the full timeline filtered to it, whose field link leads back
    await u.click(screen.getByRole('link', { name: 'Fields' })); await u.click(await screen.findByRole('link', { name: 'F-04' }))
    await u.selectOptions(await screen.findByLabelText('Season'), old)
    await screen.findByText(/^Recorded harvest batch H-00001/)
    await u.click(screen.getByRole('link', { name: 'Full timeline and notes for F-04' }))
    await screen.findByRole('heading', { name: 'Activity' })
    expect((screen.getByLabelText('Field') as HTMLSelectElement).value).toBe(field)
    await u.click((await screen.findAllByRole('link', { name: 'F-04' }))[0]); await screen.findByRole('heading', { name: 'Field F-04' })
  })
})
