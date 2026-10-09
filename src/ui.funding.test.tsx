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
import { listProjects } from './services/projects'
import { fundingSummary } from './services/funding'



describe('Funding UI', () => {
  it('raises a request, records its approval, money received and a repayment, shows the pack, and marks a project independent', async () => {
    const u = userEvent.setup(); render(<App />)
    await u.type(await screen.findByLabelText('Farm name'), 'Home Farm'); await u.type(screen.getByLabelText('Owner name'), 'Lovemore')
    await u.type(screen.getByLabelText('Owner PIN (4–8 digits)'), '1234'); await u.type(screen.getByLabelText('Confirm PIN'), '1234'); await u.click(screen.getByRole('button', { name: 'Create farm' }))
    await u.type(await screen.findByLabelText('Name'), 'Lovemore'); await u.type(screen.getByLabelText('PIN'), '1234'); await u.click(screen.getByRole('button', { name: 'Sign in' }))
    await screen.findByRole('navigation', { name: 'Main' })
    const ctx = () => useApp.getState().ctx!; createSeason(ctx(), { label: '2026/27', starts_on: '2026-09-01', ends_on: '2027-08-31', activate: true })
    const pid = listProjects(ctx())[0].id
    await u.click(await screen.findByRole('link', { name: 'Funding' })); await screen.findByText('No funding requests yet.')
    await u.click(screen.getByRole('button', { name: 'No contractor — independent' })); await screen.findByText(/Marked as an/)
    expect(listProjects(ctx())[0].independent).toBe(true)

    await u.click(screen.getByRole('button', { name: 'New funding request' })); const f = await screen.findByRole('dialog', { name: 'New funding request' })
    await u.type(within(f).getByLabelText('Funder'), 'AgriBank'); await u.type(within(f).getByLabelText('What is it for?'), 'Seed and fertiliser'); await u.type(within(f).getByLabelText(/Amount asked for/), '5000')
    await u.click(within(f).getByLabelText('seed')); await u.click(within(f).getByRole('button', { name: 'Save' })); await screen.findByText('Request saved as a draft')
    await u.click(await screen.findByRole('button', { name: 'Open request from AgriBank' })); let d = await screen.findByRole('dialog', { name: /AgriBank/ })
    within(d).getByText('draft'); await u.click(within(d).getByRole('button', { name: 'Mark as submitted' })); await within(d).findByText('submitted')
    await u.click(within(d).getByRole('button', { name: 'Record approval…' })); const ap = await screen.findByRole('dialog', { name: 'Approve request' })
    await u.click(within(ap).getByRole('button', { name: 'Approve' })); await screen.findByText('Request approved')
    expect(fundingSummary(ctx(), pid).requests[0]).toMatchObject({ status: 'approved', amount_approved: 5000 })

    d = await screen.findByRole('dialog', { name: /AgriBank/ }); await u.click(within(d).getByRole('button', { name: 'Record money received…' })); const rc = await screen.findByRole('dialog', { name: 'Record money received' })
    await u.type(within(rc).getByLabelText(/Value/), '2000'); await u.click(within(rc).getByRole('button', { name: 'Record' })); await screen.findByText('Receipt recorded')
    expect(fundingSummary(ctx(), pid)).toMatchObject({ received: 2000, outstanding: 2000 })
    d = await screen.findByRole('dialog', { name: /AgriBank/ }); within(d).getByText(/owed/)
    await u.click(within(d).getByRole('button', { name: 'Record a repayment…' })); const rp = await screen.findByRole('dialog', { name: 'Record a repayment' })
    await u.type(within(rp).getByLabelText(/Amount/), '99999'); await u.click(within(rp).getByRole('button', { name: 'Record repayment' })); await screen.findByText(/more than is owed/)   // too much is refused
    await u.clear(within(rp).getByLabelText(/Amount/)); await u.type(within(rp).getByLabelText(/Amount/), '500'); await u.click(within(rp).getByRole('button', { name: 'Record repayment' })); await screen.findByText('Repayment recorded')
    expect(fundingSummary(ctx(), pid)).toMatchObject({ received: 2000, repaid: 500 })

    d = await screen.findByRole('dialog', { name: /AgriBank/ }); await u.click(within(d).getByRole('button', { name: 'Funding pack' })); const pk = await screen.findByRole('dialog', { name: 'Funding pack' })
    within(pk).getByText(/Tobacco 2026\/27/); within(pk).getByText(/Asking for/); within(pk).getByRole('button', { name: 'Print' })
  })
})
