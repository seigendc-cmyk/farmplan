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
import { recordLabour } from './services/labour'
import { recordWeather } from './services/weather'
import { recordHarvest } from './services/harvest'
import { setBiTransport } from './services/bi'

const label = (t: string | RegExp) => screen.findByLabelText(t)

describe('Phase 5 UI: budgets, profitability and the data assistant', () => {
  it('sets a budget, shows plan vs actual, profitability, and answers a question', async () => {
    const u = userEvent.setup(); render(<App />)
    await u.type(await label('Farm name'), 'Home Farm'); await u.type(await label('Owner name'), 'Lovemore')
    await u.type(await label('Owner PIN (4–8 digits)'), '1234'); await u.type(await label('Confirm PIN'), '1234')
    await u.click(screen.getByRole('button', { name: 'Create farm' }))
    await u.type(await label('Name'), 'Lovemore'); await u.type(await label('PIN'), '1234'); await u.click(screen.getByRole('button', { name: 'Sign in' }))
    await screen.findByText('No active season')
    const ctx = useApp.getState().ctx!
    const season = createSeason(ctx, { label: '2026/27', starts_on: '2026-09-01', ends_on: '2027-08-31', activate: true }); const f = createField(ctx, { field_no: 'F-04', area_ha: 4 })
    recordLabour(ctx, { season_id: season, field_id: f, worked_on: '2026-11-01', worker_name: 'Tendai', task: 'Weeding', pay_amount: 120 })
    recordHarvest(ctx, { field_id: f, season_id: season, harvested_on: '2027-01-20', green_weight_kg: 2000 }); recordWeather(ctx, { season_id: season, recorded_on: '2026-11-10', rainfall_mm: 42 })
    useApp.getState().bump()

    await u.click(screen.getByRole('link', { name: 'Budgets' }))
    const row = (await screen.findByText('labour')).closest('tr')!
    await u.click(within(row).getByRole('button', { name: 'Set' }))
    const dlg = await screen.findByRole('dialog', { name: /Budget — labour/ })
    await u.type(within(dlg).getByLabelText(/Planned amount/), '100'); await u.click(within(dlg).getByRole('button', { name: 'Save' }))
    await screen.findByText('Budget saved'); await screen.findByText('over'); await screen.findByText('Over budget')

    await u.click(screen.getByRole('link', { name: 'Profitability' }))
    await screen.findByText('Margin per ha'); await screen.findByText('F-04')
    await u.click(screen.getByRole('button', { name: 'Rainfall vs yield' })); await screen.findByText('2026-11')
    await u.click(screen.getByRole('button', { name: 'Season vs season' })); await screen.findByText('2026/27')

    setBiTransport(async () => '{"sql":"SELECT category, SUM(amount) AS total FROM bi_costs GROUP BY category","explanation":"Total cost per category."}')
    // one Ask screen: the brain answers first; Claude is the fallback, with its key in Engine settings
    await u.click(screen.getByRole('link', { name: 'Ask' }))
    await u.click(await screen.findByRole('button', { name: 'Engine settings' })); const set = await screen.findByRole('dialog', { name: 'Engine settings' })
    await u.type(within(set).getByLabelText('Anthropic API key'), 'sk-test'); await u.click(within(set).getByRole('button', { name: 'Done' }))
    await u.type(screen.getByLabelText('Your question'), 'What did each category cost?'); await u.click(screen.getByRole('button', { name: 'Ask' }))
    await screen.findByText(/^Looked up: Costs by category/)
    await u.click(await screen.findByRole('button', { name: 'Ask Claude instead' }))
    await screen.findByText('Total cost per category.'); expect((await screen.findAllByText('total')).length).toBeGreaterThan(0); expect((await screen.findAllByText('120')).length).toBeGreaterThan(0)
    await u.click(screen.getByRole('button', { name: 'Show the query' })); await screen.findByText(/^SELECT category/)
    setBiTransport(null)
  })
})
