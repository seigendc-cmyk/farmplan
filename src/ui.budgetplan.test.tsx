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

import { render, screen, within, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from './App'
import { useApp } from './store/app'
import { createSeason } from './services/seasons'
import { listProjects } from './services/projects'
import { listVersions } from './services/budgetplan'


describe('Plan and budget versions UI', () => {
  it('saves a plan, sets a budget with a month, approves the baseline, records a revision, and the project can then leave Budget', async () => {
    const u = userEvent.setup(); render(<App />)
    await u.type(await screen.findByLabelText('Farm name'), 'Home Farm'); await u.type(screen.getByLabelText('Owner name'), 'Lovemore')
    await u.type(screen.getByLabelText('Owner PIN (4–8 digits)'), '1234'); await u.type(screen.getByLabelText('Confirm PIN'), '1234'); await u.click(screen.getByRole('button', { name: 'Create farm' }))
    await u.type(await screen.findByLabelText('Name'), 'Lovemore'); await u.type(screen.getByLabelText('PIN'), '1234'); await u.click(screen.getByRole('button', { name: 'Sign in' }))
    await screen.findByRole('navigation', { name: 'Main' })
    createSeason(useApp.getState().ctx!, { label: '2026/27', starts_on: '2026-09-01', ends_on: '2027-08-31', activate: true })

    // Budgets: a line, its month, then approve
    await u.click(await screen.findByRole('link', { name: 'Budgets' })); await screen.findByText('Baseline and versions'); screen.getByText('not approved')
    expect(screen.queryByRole('button', { name: 'Approve as baseline' })).not.toBeNull()
    const seedRow = screen.getByText('seed').closest('tr')!; await u.click(within(seedRow).getByRole('button', { name: 'Set' }))
    const dlg = await screen.findByRole('dialog', { name: 'Budget — seed' }); await u.type(within(dlg).getByLabelText(/Planned amount/), '1000'); await u.click(within(dlg).getByRole('button', { name: 'Save' }))
    await screen.findByText('Budget saved')
    fireEvent.change(screen.getByLabelText('Expected month for seed'), { target: { value: '2026-10' } })
    const cash = screen.getByText('Monthly cash need').closest('div')!; await within(cash).findByText('2026-10')
    await u.click(screen.getByRole('button', { name: 'Approve as baseline' })); await screen.findByText(/baseline approved · version 1/); screen.getByText('v1 baseline')
    expect(screen.queryByRole('button', { name: 'Approve as baseline' })).toBeNull()

    // an edit is flagged and recorded as version 2 only with a reason
    await u.click(within(screen.getAllByText('seed')[0].closest('tr')!).getByRole('button', { name: 'Edit' }))
    const ed = await screen.findByRole('dialog', { name: 'Budget — seed' }); const amt = within(ed).getByLabelText(/Planned amount/); await u.clear(amt); await u.type(amt, '1200'); await u.click(within(ed).getByRole('button', { name: 'Save' }))
    await screen.findByText(/changed since version 1/); expect(listVersions(useApp.getState().ctx!, listProjects(useApp.getState().ctx!)[0].season_id)[0].total).toBe(1000)   // baseline untouched
    await u.click(screen.getByRole('button', { name: 'Record a revision…' })); const rd = await screen.findByRole('dialog', { name: 'Record a budget revision' })
    await u.click(within(rd).getByRole('button', { name: 'Record revision' })); await screen.findByText(/Say why the budget changed/)
    await u.type(within(rd).getByLabelText('Why did the budget change?'), 'Seed price rise'); await u.click(within(rd).getByRole('button', { name: 'Record revision' }))
    await screen.findByText('Seed price rise'); screen.getByText('v2'); expect(screen.queryByText(/changed since version/)).toBeNull()

    // Pipeline: plan, then the project can pass Planning and Budget with no override
    await u.click(screen.getByRole('link', { name: 'Pipeline' })); await u.click(await screen.findByRole('button', { name: 'Open Tobacco 2026/27' })); const pd = await screen.findByRole('dialog', { name: 'Tobacco 2026/27' })
    await u.click(within(pd).getByRole('button', { name: 'Move to Planning' })); await within(pd).findByText(/Before leaving Planning:/)
    await u.type(within(pd).getByLabelText('Planned hectares'), '2'); await u.type(within(pd).getByLabelText('Expected yield (kg per ha)'), '2000'); await u.type(within(pd).getByLabelText(/Expected price/), '3'); await u.click(within(pd).getByRole('button', { name: 'Save plan' }))
    const sum = await within(pd).findByLabelText('Plan summary'); within(sum).getByText('4,000 kg'); within(sum).getByText(/0\.30 \/ kg/)
    await u.click(await within(pd).findByRole('button', { name: 'Move to Budget' })); await u.click(await within(pd).findByRole('button', { name: 'Move to Funding' }))
    expect(listProjects(useApp.getState().ctx!)[0].stage).toBe('funding')
  })
})
