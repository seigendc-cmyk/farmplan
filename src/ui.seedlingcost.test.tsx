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
import { recordTransplant } from './services/transplants'
import { profitability } from './services/analytics'

describe('Seedling cost in field cost reports (UI)', () => {
  it('Profitability by-field shows a Seedling cost column and value; the field record shows the seedling cost', async () => {
    const u = userEvent.setup(); render(<App />)
    await u.type(await screen.findByLabelText('Farm name'), 'Home Farm'); await u.type(screen.getByLabelText('Owner name'), 'Lovemore')
    await u.type(screen.getByLabelText('Owner PIN (4–8 digits)'), '1234'); await u.type(screen.getByLabelText('Confirm PIN'), '1234'); await u.click(screen.getByRole('button', { name: 'Create farm' }))
    await u.type(await screen.findByLabelText('Name'), 'Lovemore'); await u.type(screen.getByLabelText('PIN'), '1234'); await u.click(screen.getByRole('button', { name: 'Sign in' }))
    await screen.findByRole('navigation', { name: 'Main' })
    const ctx = () => useApp.getState().ctx!
    const crop = createSeason(ctx(), { label: '2026/27', starts_on: '2026-09-01', ends_on: '2027-08-31', activate: true })
    const bed = createSeedbed(ctx(), { season_id: crop, code: 'LB1', bed_length_m: 10, bed_width_m: 1, bed_count: 1, actual_seedlings: 400 })
    const field = createField(ctx(), { field_no: 'F-04', area_ha: 4 })
    ctx().db.insert('cost_entries', { tenant_id: ctx().tenantId, farm_id: ctx().farmId, season_id: crop, category: 'labour', amount: 400, occurred_on: '2026-09-01', seedbed_id: bed, tray_id: null, field_id: null, source_type: 'test', source_id: null, note: null })
    recordTransplant(ctx(), { seedbed_id: bed, field_id: field, occurred_on: '2026-10-02', qty: 100 } as never)
    expect(profitability(ctx(), crop).by_field[0]).toMatchObject({ field_no: 'F-04', seedling_cost: 100 })
    useApp.getState().bump()

    await u.click(await screen.findByRole('link', { name: 'Profitability' })); await screen.findByRole('heading', { name: 'Profitability' })
    const head = await screen.findByRole('columnheader', { name: 'Seedling cost' })
    const table = head.closest('table')!; const row = within(table).getByText('F-04').closest('tr')!
    const idx = Array.from(head.parentElement!.children).indexOf(head)
    expect(row.children[idx].textContent).toMatch(/100/); expect(row.children[idx - 1].textContent).toMatch(/100/) // direct cost includes it
    expect(screen.getByTestId('seedling-note').textContent).toMatch(/includes .*100.* of seedling cost/)

    await u.click(screen.getByRole('link', { name: 'Fields' })); await screen.findByRole('heading', { name: 'Fields' })
    await u.click(screen.getByRole('link', { name: 'Open' })); await screen.findByRole('heading', { name: 'Field F-04' })
    const stat = (await screen.findByText('Seedling cost')).parentElement!; expect(stat.textContent).toMatch(/100/)
  }, 60000)
})
