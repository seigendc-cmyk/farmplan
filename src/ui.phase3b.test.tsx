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

const label = (t: string | RegExp) => screen.findByLabelText(t)
const dialog = (name: string | RegExp) => screen.findByRole('dialog', { name })
const setDate = async (el: HTMLElement, v: string) => { const u2 = userEvent.setup(); await u2.clear(el); await u2.type(el, v) }

describe('Phase 3b UI: contract programme', () => {
  it('registers a contractor, runs a contract with an advance and obligation, and settles it', async () => {
    const u = userEvent.setup()
    render(<App />)
    await u.type(await label('Farm name'), 'Home Farm'); await u.type(await label('Owner name'), 'Lovemore')
    await u.type(await label('Owner PIN (4–8 digits)'), '1234'); await u.type(await label('Confirm PIN'), '1234')
    await u.click(screen.getByRole('button', { name: 'Create farm' }))
    await u.type(await label('Name'), 'Lovemore'); await u.type(await label('PIN'), '1234')
    await u.click(screen.getByRole('button', { name: 'Sign in' }))
    await screen.findByText('No active season')
    const ctx = useApp.getState().ctx!
    createSeason(ctx, { label: '2026/27', starts_on: '2026-09-01', ends_on: '2027-08-31', activate: true }); createField(ctx, { field_no: 'F-04', area_ha: 4 }); useApp.getState().bump()

    await u.click(screen.getByRole('link', { name: 'Contractors' }))
    await u.click(await screen.findByRole('button', { name: 'New contractor' }))
    let dlg = await dialog('New contractor')
    await u.type(within(dlg).getByLabelText('Company name'), 'Acme Leaf'); await u.click(within(dlg).getByRole('button', { name: 'Save' }))
    await screen.findByText('Contractor saved'); await screen.findByText('Acme Leaf')

    await u.click(screen.getByRole('link', { name: 'Programmes' }))
    await u.click(await screen.findByRole('button', { name: 'New contract' }))
    dlg = await dialog('New contract')
    await u.type(within(dlg).getByLabelText(/Contractor's contract number/), 'AL/27/1'); await u.type(within(dlg).getByLabelText(/Target production/), '400')
    await u.type(within(dlg).getByLabelText('Date signed'), '2026-10-01'); await u.click(within(dlg).getByLabelText(/F-04/))
    await u.click(within(dlg).getByRole('button', { name: 'Save contract' }))
    await screen.findByText('Contract created'); await screen.findByText('CT-00001')

    await u.click(screen.getByRole('button', { name: 'Open' }))
    dlg = await dialog(/CT-00001/)
    await u.click(within(dlg).getByRole('button', { name: 'Activate' })); await screen.findByText('Contract activated')

    await u.click(within(dlg).getByRole('button', { name: 'Add advance' }))
    const ad = await dialog('Add advance')
    await u.selectOptions(within(ad).getByLabelText('Type'), 'cash'); await u.type(within(ad).getByLabelText('Description'), 'Labour float'); await u.type(within(ad).getByLabelText('Value advanced'), '250')
    await setDate(within(ad).getByLabelText('Date'), '2026-11-05')
    await u.click(within(ad).getByRole('button', { name: 'Save advance' })); await screen.findByText('Advance recorded')

    await u.click(within(dlg).getByRole('button', { name: 'Add obligation' }))
    const ob = await dialog('Add obligation'); await u.type(within(ob).getByLabelText('Obligation'), 'Transplant by 30 Nov'); await u.click(within(ob).getByRole('button', { name: 'Add' }))
    await screen.findByText('Obligation added')
    await u.click(await within(dlg).findByLabelText('Done: Transplant by 30 Nov'))

    await u.click(within(dlg).getByRole('button', { name: 'Settle contract' }))
    const se = await dialog('Settle contract')
    await setDate(within(se).getByLabelText('Settlement date'), '2027-03-01')
    await u.clear(within(se).getByLabelText('Advances recovered')); await u.type(within(se).getByLabelText('Advances recovered'), '0')
    await u.click(within(se).getByRole('button', { name: 'Settle' }))
    await screen.findByText('Contract settled')
    await waitFor(() => expect(within(screen.getByRole('dialog', { name: /CT-00001/ })).getByText(/Advance shortfall carried over/)).toBeTruthy())
    expect(within(screen.getByRole('dialog', { name: /CT-00001/ })).getAllByText('$250.00').length).toBeGreaterThan(0)
  }, 120000)
})
