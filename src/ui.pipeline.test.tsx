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
import { getProject, listProjects } from './services/projects'


describe('Pipeline UI', () => {
  it('lists the season’s project, moves it forward, blocks on an unmet requirement, overrides with a reason, and goes back', async () => {
    const u = userEvent.setup(); render(<App />)
    await u.type(await screen.findByLabelText('Farm name'), 'Home Farm'); await u.type(screen.getByLabelText('Owner name'), 'Lovemore')
    await u.type(screen.getByLabelText('Owner PIN (4–8 digits)'), '1234'); await u.type(screen.getByLabelText('Confirm PIN'), '1234'); await u.click(screen.getByRole('button', { name: 'Create farm' }))
    await u.type(await screen.findByLabelText('Name'), 'Lovemore'); await u.type(screen.getByLabelText('PIN'), '1234'); await u.click(screen.getByRole('button', { name: 'Sign in' }))
    await screen.findByRole('navigation', { name: 'Main' })
    const ctx = useApp.getState().ctx!; createSeason(ctx, { label: '2026/27', starts_on: '2026-09-01', ends_on: '2027-08-31', activate: true })
    await u.click(await screen.findByRole('link', { name: 'Pipeline' }))
    const open = await screen.findByRole('button', { name: 'Open Tobacco 2026/27' }); const row = open.closest('tr')!
    within(row).getByText('Idea'); within(row).getByText('Ready to move on')
    await u.click(within(row).getByRole('button', { name: 'Open Tobacco 2026/27' })); const dlg = await screen.findByRole('dialog', { name: 'Tobacco 2026/27' })
    expect(within(dlg).getByLabelText('Stages').querySelector('[aria-current="step"]')!.textContent).toBe('Idea')
    await u.click(within(dlg).getByRole('button', { name: 'Move to Planning' })); await within(dlg).findByText(/Before leaving Planning:/)
    expect(listProjects(useApp.getState().ctx!)[0].stage).toBe('planning'); within(dlg).getByText(/Idea → Planning/)
    await u.click(within(dlg).getByRole('button', { name: 'Override and move to Budget' })); expect((await screen.findAllByText(/Say why you are moving past/)).length).toBeGreaterThan(0)   // an unmet plan needs a reason
    useApp.getState().ctx!.db.run(`UPDATE projects SET plan_ha=2, plan_yield_kg_ha=2000`); useApp.getState().bump()
    await u.click(await within(dlg).findByRole('button', { name: 'Move to Budget' }))
    await within(dlg).findByText(/Before leaving Budget:/); within(dlg).getByText(/Approve the budget as the baseline/)
    expect(within(dlg).queryByRole('button', { name: 'Move to Funding' })).toBeNull()                       // blocked: no plain advance
    await u.click(within(dlg).getByRole('button', { name: 'Override and move to Funding' }))                // no reason yet
    expect((await screen.findAllByText(/Say why you are moving past an unmet requirement/)).length).toBeGreaterThan(0); expect(getProject(useApp.getState().ctx!, listProjects(ctx)[0].id).stage).toBe('budget')
    await u.type(within(dlg).getByLabelText(/Reason/), 'Budget agreed on paper'); await u.click(within(dlg).getByRole('button', { name: 'Override and move to Funding' }))
    await within(dlg).findByText('override'); within(dlg).getByText(/Budget agreed on paper/); expect(listProjects(useApp.getState().ctx!)[0].stage).toBe('funding')
    within(dlg).getByRole('button', { name: 'Skip Contracted — go to Land and seedbed' })
    await u.click(within(dlg).getByRole('button', { name: 'Back to Budget' })); await screen.findByText(/Say what was wrong/)   // going back needs a reason
    await u.type(within(dlg).getByLabelText(/Reason/), 'Moved too early'); await u.click(within(dlg).getByRole('button', { name: 'Back to Budget' }))
    await within(dlg).findByText('back'); expect(listProjects(useApp.getState().ctx!)[0].stage).toBe('budget')
  })
})
