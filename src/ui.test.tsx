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

const label = (t: string | RegExp) => screen.findByLabelText(t)

describe('end-to-end UI flow', () => {
  it('sets up a farm, records stock-linked operation and shows cost per hectare', async () => {
    const u = userEvent.setup()
    render(<App />)
    await u.type(await label('Farm name'), 'Home Farm')
    await u.type(await label('Owner name'), 'Lovemore')
    await u.type(await label('Owner PIN (4–8 digits)'), '1234'); await u.type(await label('Confirm PIN'), '1234')
    await u.click(screen.getByRole('button', { name: 'Create farm' }))

    await u.type(await label('Name'), 'Lovemore'); await u.type(await label('PIN'), '1234')
    await u.click(screen.getByRole('button', { name: 'Sign in' }))
    await screen.findByText('No active season')

    // season
    await u.click(screen.getByRole('link', { name: 'Seasons' }))
    await u.click(await screen.findByRole('button', { name: 'New season' }))
    await u.type(await label(/^Label/), '2026/27')
    await u.type(screen.getByLabelText('Starts'), '2026-09-01'); await u.type(screen.getByLabelText('Ends'), '2027-08-31')
    await u.click(screen.getByRole('button', { name: 'Create' }))
    await screen.findByText('Season created')

    // field
    await u.click(screen.getByRole('link', { name: 'Fields' }))
    await u.click(await screen.findByRole('button', { name: 'New field' }))
    await u.type(await label('Field number'), 'F-04'); await u.type(screen.getByLabelText('Area (ha)'), '5')
    await u.click(screen.getByRole('button', { name: 'Save field' }))
    await screen.findByText('Field created')

    // inventory: product + purchase
    await u.click(screen.getByRole('link', { name: 'Inventory' }))
    await u.click(await screen.findByRole('button', { name: 'New product' }))
    await u.type(await label('Product name'), 'Compound D')
    await u.click(screen.getByRole('button', { name: 'Save' }))
    await u.click(await screen.findByRole('button', { name: 'Purchase' }))
    await u.type(await label(/Quantity/), '500'); await u.clear(screen.getByLabelText('Unit cost')); await u.type(screen.getByLabelText('Unit cost'), '1.2')
    await u.click(screen.getByRole('button', { name: 'Receive stock' }))
    await screen.findByText('Stock received')

    // operation consuming 100 kg
    await u.click(screen.getByRole('link', { name: 'Operations' }))
    await u.click(await screen.findByRole('button', { name: 'Record operation' }))
    const dlg = await screen.findByRole('dialog')
    await u.selectOptions(within(dlg).getByLabelText('Field'), within(dlg).getByRole('option', { name: 'Field F-04' }))
    await u.selectOptions(within(dlg).getByLabelText('Operation'), 'Fertilizing')
    await u.click(within(dlg).getByRole('button', { name: '+ Add input' }))
    const sel = within(dlg).getByRole('option', { name: /Compound D/ }).closest('select')!
    await u.selectOptions(sel, within(dlg).getByRole('option', { name: /Compound D/ }))
    await u.type(within(dlg).getByPlaceholderText('kg'), '100')
    await u.click(within(dlg).getByRole('button', { name: 'Record operation' }))
    await screen.findByText('Operation recorded')

    // cost report: 100 kg * 1.2 = 120 over 5 ha = 24/ha
    await u.click(screen.getByRole('link', { name: 'Costs' }))
    await waitFor(() => expect(screen.getAllByText('$120.00').length).toBeGreaterThan(0))
    expect(screen.getAllByText('$24.00').length).toBeGreaterThan(0)
  }, 60000)
})
