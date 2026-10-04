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
import { createInput, recordPurchase, stockOf } from './services/inventory'
import { createMachine } from './services/machinery'

describe('Phase D UI: worker and machine lines on an operation', () => {
  it('records an operation whose people and machine become linked entries, with diesel drawn from stock once', async () => {
    const u = userEvent.setup(); render(<App />)
    await u.type(await screen.findByLabelText('Farm name'), 'Home Farm'); await u.type(screen.getByLabelText('Owner name'), 'Lovemore')
    await u.type(screen.getByLabelText('Owner PIN (4–8 digits)'), '1234'); await u.type(screen.getByLabelText('Confirm PIN'), '1234'); await u.click(screen.getByRole('button', { name: 'Create farm' }))
    await u.type(await screen.findByLabelText('Name'), 'Lovemore'); await u.type(screen.getByLabelText('PIN'), '1234'); await u.click(screen.getByRole('button', { name: 'Sign in' }))
    await screen.findByText('No active season')
    const ctx = useApp.getState().ctx!
    createSeason(ctx, { label: '2026/27', starts_on: '2026-09-01', ends_on: '2027-08-31', activate: true }); createField(ctx, { field_no: 'F-04', area_ha: 4 })
    const diesel = createInput(ctx, { name: 'Diesel', category: 'fuel', unit: 'L' }); recordPurchase(ctx, { input_id: diesel, qty: 100, unit_cost: 1.5, occurred_on: '2026-10-01' })
    createMachine(ctx, { name: 'MF 375', hourly_rate: 10, fuel_input_id: diesel }); useApp.getState().bump()

    await u.click(screen.getByRole('link', { name: 'Operations' })); await u.click(await screen.findByRole('button', { name: 'Record operation' }))
    const dlg = await screen.findByRole('dialog', { name: 'Record operation' })
    expect(within(dlg).queryByLabelText('Tractor / equipment')).toBeNull(); expect(within(dlg).queryByLabelText('Labour cost')).toBeNull()   // the retired boxes are gone
    await u.selectOptions(within(dlg).getByLabelText('Field'), within(dlg).getByRole('option', { name: 'Field F-04' }))
    await u.selectOptions(within(dlg).getByLabelText('Stage'), 'land_prep'); await u.selectOptions(within(dlg).getByLabelText('Operation'), 'Ploughing')
    await u.click(within(dlg).getByRole('button', { name: '+ Add worker' }))
    await u.type(within(dlg).getByLabelText('Worker 1 name'), 'Tendai'); await u.type(within(dlg).getByLabelText('Worker 1 hours'), '8'); await u.type(within(dlg).getByLabelText('Worker 1 pay'), '12')
    await u.click(within(dlg).getByRole('button', { name: '+ Add machine' }))
    await u.selectOptions(within(dlg).getByLabelText('Machine 1'), within(dlg).getByRole('option', { name: 'MF 375' }))
    await u.type(within(dlg).getByLabelText('Machine 1 hours'), '4'); await u.type(within(dlg).getByLabelText('Machine 1 litres'), '20')
    expect(within(dlg).getByText('20 L will be drawn from Diesel.')).toBeTruthy()
    await u.click(within(dlg).getByRole('button', { name: 'Record operation' }))
    await screen.findByText('Operation recorded')
    expect(screen.getByText('Workers: Tendai 8 h')).toBeTruthy(); expect(screen.getByText('Machines: MF 375 4 h, 20 L')).toBeTruthy()
    expect(stockOf(useApp.getState().ctx!, diesel)).toBe(80)

    // the linked records show on their own pages
    await u.click(screen.getByRole('link', { name: 'Labour' })); expect(await screen.findByText(/part of Ploughing/)).toBeTruthy()
    await u.click(screen.getByRole('link', { name: 'Machinery' })); await u.click(await screen.findByRole('button', { name: 'Activity log' }))
    expect(await screen.findByText('from Diesel')).toBeTruthy(); expect(screen.getByText(/part of Ploughing/)).toBeTruthy()
  })
})
