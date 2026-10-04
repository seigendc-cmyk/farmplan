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
import { setBudget } from './services/analytics'
import { createMachine, logMachine } from './services/machinery'
import { createRole } from './services/roles'
import { createUser } from './services/setup'

const focused = () => document.querySelector('tr[aria-current="true"]') as HTMLElement

describe('Dashboard: needs attention', () => {
  it('lists what needs doing, opens each record highlighted, and shows another role only its own modules', async () => {
    const u = userEvent.setup(); render(<App />)
    await u.type(await screen.findByLabelText('Farm name'), 'Home Farm'); await u.type(screen.getByLabelText('Owner name'), 'Lovemore')
    await u.type(screen.getByLabelText('Owner PIN (4–8 digits)'), '1234'); await u.type(screen.getByLabelText('Confirm PIN'), '1234'); await u.click(screen.getByRole('button', { name: 'Create farm' }))
    await u.type(await screen.findByLabelText('Name'), 'Lovemore'); await u.type(screen.getByLabelText('PIN'), '1234'); await u.click(screen.getByRole('button', { name: 'Sign in' }))
    await screen.findByText(/Nothing flagged/)

    const ctx = useApp.getState().ctx!; const today = new Date().toISOString().slice(0, 10)
    const season = createSeason(ctx, { label: 'This season', starts_on: `${Number(today.slice(0, 4)) - 1}-09-01`, ends_on: `${Number(today.slice(0, 4)) + 1}-08-31`, activate: true })
    recordHarvest(ctx, { field_id: createField(ctx, { field_no: 'F-04', area_ha: 4 }), season_id: season, harvested_on: today, green_weight_kg: 100, labour_cost: 40 })
    setBudget(ctx, season, 'labour', 25)
    logMachine(ctx, { machine_id: createMachine(ctx, { name: 'MF 375', service_interval_hours: 10 }), season_id: season, kind: 'use', logged_on: today, hours: 12 })
    await createUser(ctx, 'Tendai', '5555', createRole(ctx, 'Mechanic', ['resources.machinery.view']))
    useApp.getState().bump()

    let list = await screen.findByRole('list', { name: 'Needs attention' })
    expect(within(list).getAllByRole('link').map(a => a.textContent)).toEqual(['Budgetlabour is over budget: $40.00 spent of $25.00', 'MachineryMF 375 is due for a service (12 h since the last one)'])

    await u.click(within(list).getByRole('link', { name: /over budget/ }))
    await screen.findByRole('heading', { name: 'Budgets' }); expect(within(focused()).getByText('labour')).toBeTruthy()
    await u.click(screen.getByRole('link', { name: 'Dashboard' }))
    await u.click(within(await screen.findByRole('list', { name: 'Needs attention' })).getByRole('link', { name: /MF 375/ }))
    await screen.findByRole('heading', { name: 'Machinery' }); expect(within(focused()).getByText('MF 375')).toBeTruthy()

    // a mechanic sees the service, not the budget
    await u.click(screen.getByRole('button', { name: 'Sign out' }))
    await u.type(await screen.findByLabelText('Name'), 'Tendai'); await u.type(screen.getByLabelText('PIN'), '5555'); await u.click(screen.getByRole('button', { name: 'Sign in' }))
    list = await screen.findByRole('list', { name: 'Needs attention' })
    expect(within(list).getAllByRole('link').map(a => a.textContent)).toEqual(['MachineryMF 375 is due for a service (12 h since the last one)'])
  })
})
