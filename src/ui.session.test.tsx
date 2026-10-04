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

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from './App'
import { useApp, SESSION_HOURS } from './store/app'

/** A browser reload: the page's memory is gone, the database (IndexedDB) and the tab's sessionStorage remain. */
async function reload(unmount: () => void) {
  await useApp.getState().db?.flush(); unmount()
  useApp.setState({ phase: 'booting', db: null, ctx: null, fieldMode: false })
  return render(<App />).unmount
}

describe('Staying signed in across a reload', () => {
  it('keeps the person and the page after a reload; signing out, deactivation and the time limit end it', async () => {
    const u = userEvent.setup(); let unmount = render(<App />).unmount
    const signIn = async () => { await u.type(await screen.findByLabelText('Name'), 'Lovemore'); await u.type(screen.getByLabelText('PIN'), '1234'); await u.click(screen.getByRole('button', { name: 'Sign in' })) }
    await u.type(await screen.findByLabelText('Farm name'), 'Home Farm'); await u.type(screen.getByLabelText('Owner name'), 'Lovemore')
    await u.type(screen.getByLabelText('Owner PIN (4–8 digits)'), '1234'); await u.type(screen.getByLabelText('Confirm PIN'), '1234'); await u.click(screen.getByRole('button', { name: 'Create farm' }))
    await signIn()
    await u.click(await screen.findByRole('link', { name: 'Fields' })); await screen.findByRole('heading', { name: 'Fields' })

    unmount = await reload(unmount)
    await screen.findByRole('heading', { name: 'Fields' }); expect(window.location.hash).toBe('#/fields')
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeTruthy(); expect(screen.queryByLabelText('PIN')).toBeNull()

    // signing out ends it
    await u.click(screen.getByRole('button', { name: 'Sign out' })); unmount = await reload(unmount)
    expect(await screen.findByLabelText('PIN')).toBeTruthy()

    // the session is only as old as SESSION_HOURS
    await signIn(); await screen.findByRole('button', { name: 'Sign out' })
    const s = JSON.parse(sessionStorage.getItem('fp.session')!); sessionStorage.setItem('fp.session', JSON.stringify({ ...s, at: Date.now() - (SESSION_HOURS * 3600e3 + 1000) }))
    unmount = await reload(unmount); expect(await screen.findByLabelText('PIN')).toBeTruthy(); expect(sessionStorage.getItem('fp.session')).toBeNull()

    // a deactivated user is not resumed
    await signIn(); await screen.findByRole('button', { name: 'Sign out' })
    useApp.getState().db!.run(`UPDATE local_users SET active=0`)
    unmount = await reload(unmount); expect(await screen.findByLabelText('PIN')).toBeTruthy()
    unmount()
  })
})
