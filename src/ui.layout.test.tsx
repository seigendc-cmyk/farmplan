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
import App, { syncLabel } from './App'
import { useApp } from './store/app'
import { createSeason } from './services/seasons'
import { plural } from './ui/hooks'

describe('Desktop layout', () => {
  it('folds the sidebar away and back (remembered on this device), shows why buttons are disabled, and opens the Dashboard at every sign-in', async () => {
    const u = userEvent.setup(); render(<App />)
    await u.type(await screen.findByLabelText('Farm name'), 'Home Farm'); await u.type(screen.getByLabelText('Owner name'), 'Lovemore')
    await u.type(screen.getByLabelText('Owner PIN (4–8 digits)'), '1234'); await u.type(screen.getByLabelText('Confirm PIN'), '1234'); await u.click(screen.getByRole('button', { name: 'Create farm' }))
    await u.type(await screen.findByLabelText('Name'), 'Lovemore'); await u.type(screen.getByLabelText('PIN'), '1234'); await u.click(screen.getByRole('button', { name: 'Sign in' }))
    await screen.findByText('No active season')
    expect(screen.queryByRole('button', { name: 'Open menu' })).toBeNull()   // the sidebar is simply there

    await u.click(screen.getByRole('button', { name: 'Hide menu' }))
    const menu = await screen.findByRole('button', { name: 'Open menu' })
    expect(document.getElementById('sidebar')!.className).toMatch(/\bhidden\b/); expect(localStorage.getItem('fp.sidebar.folded')).toBe('1')
    expect(document.activeElement).toBe(menu)
    await u.click(menu); expect(screen.queryByRole('button', { name: 'Open menu' })).toBeNull(); expect(localStorage.getItem('fp.sidebar.folded')).toBe('0')

    // a disabled button says why, as visible text tied to the button
    createSeason(useApp.getState().ctx!, { label: '2026/27', starts_on: '2026-09-01', ends_on: '2027-08-31', activate: true }); useApp.getState().bump()
    await u.click(screen.getByRole('link', { name: 'Bales' }))
    const make = await screen.findByRole('button', { name: 'Create bales' }); const why = screen.getByText('No graded leaf is waiting to be baled')
    expect((make as HTMLButtonElement).disabled).toBe(true); expect(make.getAttribute('aria-describedby')).toBe(why.id)

    // the next person to sign in starts on the Dashboard, not on Bales
    await u.click(screen.getByRole('button', { name: 'Sign out' }))
    await u.type(await screen.findByLabelText('Name'), 'Lovemore'); await u.type(screen.getByLabelText('PIN'), '1234'); await u.click(screen.getByRole('button', { name: 'Sign in' }))
    await screen.findByRole('heading', { name: 'Home Farm' }); expect(window.location.hash).toBe('#/')
    expect(within(screen.getByRole('navigation', { name: 'Main' })).getByRole('link', { name: 'Dashboard' }).getAttribute('aria-current')).toBe('page')
  })
})

describe('wording', () => {
  it('does not make a farm without cloud sync look broken', () => {
    expect(syncLabel(0, false)).toBe('All changes synced'); expect(syncLabel(1, true)).toBe('1 change awaiting sync')
    expect(syncLabel(8, false)).toBe('8 changes saved on this device · cloud sync not set up')
  })
  it('counts in the singular and plural', () => { expect(plural(1, 'field')).toBe('1 field'); expect(plural(3, 'field')).toBe('3 fields'); expect(plural(2, 'entry', 'entries')).toBe('2 entries') })
})
