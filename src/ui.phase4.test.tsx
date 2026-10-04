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
import { createInput, recordPurchase } from './services/inventory'
import { listLabour } from './services/labour'
import { listWeather } from './services/weather'
import { createMachine, listMachineLogs } from './services/machinery'
import { listHarvests } from './services/harvest'
import { stockOf } from './services/inventory'

const label = (t: string | RegExp) => screen.findByLabelText(t)
const setDate = async (el: HTMLElement, v: string) => { const u = userEvent.setup(); await u.clear(el); await u.type(el, v) }

describe('Phase 4 UI: field terminal', () => {
  it('captures fertilizer, rainfall, harvest and labour with big-button screens, and labour shows in the office', async () => {
    const u = userEvent.setup(); render(<App />)
    await u.type(await label('Farm name'), 'Home Farm'); await u.type(await label('Owner name'), 'Lovemore')
    await u.type(await label('Owner PIN (4–8 digits)'), '1234'); await u.type(await label('Confirm PIN'), '1234')
    await u.click(screen.getByRole('button', { name: 'Create farm' }))
    await u.type(await label('Name'), 'Lovemore'); await u.type(await label('PIN'), '1234'); await u.click(screen.getByRole('button', { name: 'Sign in' }))
    await screen.findByText('No active season')
    const ctx = useApp.getState().ctx!
    createSeason(ctx, { label: '2026/27', starts_on: '2026-09-01', ends_on: '2027-08-31', activate: true }); createField(ctx, { field_no: 'F-04', area_ha: 4 })
    const urea = createInput(ctx, { name: 'Urea', category: 'fertilizer', unit: 'kg' }); recordPurchase(ctx, { input_id: urea, qty: 100, unit_cost: 1, occurred_on: '2026-10-01' })
    useApp.getState().bump()

    await u.click(await screen.findByRole('button', { name: 'Field terminal view' }))
    await screen.findByText('farmPLAN Field'); await screen.findByText(/2026\/27/)

    // fertilizer: deducts stock
    await u.click(screen.getByRole('button', { name: /^Fertilizer/ }))
    let dlg = await screen.findByRole('dialog', { name: 'Fertilizer' })
    await u.selectOptions(within(dlg).getByLabelText('Field'), screen.getAllByRole('option', { name: /F-04/ })[0])
    await setDate(within(dlg).getByLabelText('Date'), '2026-10-12')
    await u.selectOptions(within(dlg).getByLabelText('Product'), within(dlg).getByRole('option', { name: /Urea/ }))
    await u.type(within(dlg).getByLabelText('Quantity'), '25'); await u.click(within(dlg).getByRole('button', { name: 'Save' }))
    await screen.findByText('Saved on this device'); expect(stockOf(ctx, urea)).toBe(75)

    // rainfall
    await u.click(screen.getByRole('button', { name: /^Rainfall/ }))
    dlg = await screen.findByRole('dialog', { name: 'Rainfall' }); await setDate(within(dlg).getByLabelText('Date'), '2026-10-13')
    await u.type(within(dlg).getByLabelText('Rainfall (mm)'), '18'); await u.click(within(dlg).getByRole('button', { name: 'Save' }))
    await screen.findAllByText('Saved on this device'); expect(listWeather(ctx)[0].rainfall_mm).toBe(18)

    // harvest
    await u.click(screen.getByRole('button', { name: /^Harvest/ }))
    dlg = await screen.findByRole('dialog', { name: 'Harvest' })
    await u.selectOptions(within(dlg).getByLabelText('Field'), within(dlg).getByRole('option', { name: /F-04/ })); await setDate(within(dlg).getByLabelText('Date'), '2027-01-15')
    await u.type(within(dlg).getByLabelText('Green weight (kg)'), '120'); await u.click(within(dlg).getByRole('button', { name: 'Save batch' }))
    await screen.findByText('Batch H-00001'); expect(listHarvests(ctx)[0].green_weight_kg).toBe(120)

    // labour
    await u.click(screen.getByRole('button', { name: /^Labour/ }))
    dlg = await screen.findByRole('dialog', { name: 'Labour' }); await setDate(within(dlg).getByLabelText('Date'), '2027-01-15')
    await u.type(within(dlg).getByLabelText('Worker name'), 'Tendai'); await u.type(within(dlg).getByLabelText('Task'), 'Reaping')
    await u.type(within(dlg).getByLabelText('Hours'), '7'); await u.type(within(dlg).getByLabelText('Pay'), '5'); await u.click(within(dlg).getByRole('button', { name: 'Save' }))
    await screen.findAllByText('Saved on this device'); expect(listLabour(ctx)[0]).toMatchObject({ worker_name: 'Tendai', pay_amount: 5 })

    // machine hours (a machine is registered in the office first)
    createMachine(ctx, { name: 'MF 275', hourly_rate: 10 }); useApp.getState().bump()
    await u.click(screen.getByRole('button', { name: /^Machine/ }))
    dlg = await screen.findByRole('dialog', { name: 'Machine' }); await u.selectOptions(within(dlg).getByLabelText('Machine'), within(dlg).getByRole('option', { name: 'MF 275' }))
    await setDate(within(dlg).getByLabelText('Date'), '2027-01-16'); await u.type(within(dlg).getByLabelText('Hours'), '3'); await u.click(within(dlg).getByRole('button', { name: 'Save' }))
    await screen.findAllByText('Saved on this device'); expect(listMachineLogs(ctx)[0]).toMatchObject({ machine: 'MF 275', hours: 3, cost: 30 })

    // the sync button reports what is waiting
    expect(screen.getByRole('button', { name: /Sync now — \d+ records? waiting/ })).toBeTruthy()

    // back in the full app the Labour page lists it
    await u.click(screen.getByRole('button', { name: 'Full app' }))
    await u.click(await screen.findByRole('link', { name: 'Labour' }))
    await screen.findByText('Tendai'); await screen.findByText('Reaping')
  })
})
