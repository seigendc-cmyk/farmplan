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
import { listRoles } from './services/roles'
import { brainLevelOf } from './lib/permissions'

describe('Business brain UI', () => {
  it('shows the timeline, adds a note, and lets an admin set a role\'s brain level in one click', async () => {
    const u = userEvent.setup(); render(<App />)
    await u.type(await screen.findByLabelText('Farm name'), 'Home Farm'); await u.type(screen.getByLabelText('Owner name'), 'Lovemore')
    await u.type(screen.getByLabelText('Owner PIN (4–8 digits)'), '1234'); await u.type(screen.getByLabelText('Confirm PIN'), '1234'); await u.click(screen.getByRole('button', { name: 'Create farm' }))
    await u.type(await screen.findByLabelText('Name'), 'Lovemore'); await u.type(screen.getByLabelText('PIN'), '1234'); await u.click(screen.getByRole('button', { name: 'Sign in' }))
    await u.click(await screen.findByRole('link', { name: 'Activity' })); await screen.findByText('Farm set up')
    await u.click(screen.getByRole('button', { name: 'Add note' })); const dlg = await screen.findByRole('dialog', { name: 'Add a note' })
    await u.type(within(dlg).getByLabelText('Note'), 'Frost warning for tonight'); await u.click(within(dlg).getByRole('button', { name: 'Save note' }))
    await screen.findByText('Frost warning for tonight'); await u.type(screen.getByLabelText('Search activity'), 'frost'); await u.click(screen.getByLabelText('Search activity'))
    expect(screen.queryByText(/Farm set up/)).toBeNull()

    await u.click(screen.getByRole('link', { name: 'Users & access' })); await u.click(await screen.findByRole('button', { name: 'Roles & permissions' }))
    await u.click(await screen.findByRole('button', { name: /Field Recorder/ })); const ops = await screen.findByRole('button', { name: 'Operations' })
    await u.click(ops); expect(ops.getAttribute('aria-pressed')).toBe('true'); await u.click(screen.getByRole('button', { name: 'Save changes' })); await screen.findByText('Permissions saved')
    const ctx = useApp.getState().ctx!; const r = listRoles(ctx).find(x => x.name === 'Field Recorder')!
    expect(brainLevelOf(r.permissions)).toBe('ops'); expect(r.permissions).toContain('production.harvest.record')   // only brain keys changed
  })
})
