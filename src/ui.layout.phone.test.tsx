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
// a 390 px phone: narrower than the 768 px breakpoint
window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia

import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from './App'

describe('Phone layout', () => {
  it('keeps the menu in a drawer: closed and unreachable by Tab, opens with focus inside, closes on Escape or after choosing a page', async () => {
    const u = userEvent.setup(); render(<App />)
    await u.type(await screen.findByLabelText('Farm name'), 'Home Farm'); await u.type(screen.getByLabelText('Owner name'), 'Lovemore')
    await u.type(screen.getByLabelText('Owner PIN (4–8 digits)'), '1234'); await u.type(screen.getByLabelText('Confirm PIN'), '1234'); await u.click(screen.getByRole('button', { name: 'Create farm' }))
    await u.type(await screen.findByLabelText('Name'), 'Lovemore'); await u.type(screen.getByLabelText('PIN'), '1234'); await u.click(screen.getByRole('button', { name: 'Sign in' }))

    const menu = await screen.findByRole('button', { name: 'Open menu' }); const sidebar = document.getElementById('sidebar')!
    expect(menu.getAttribute('aria-expanded')).toBe('false'); expect(sidebar.hasAttribute('inert')).toBe(true)

    await u.click(menu)
    expect(menu.getAttribute('aria-expanded')).toBe('true'); expect(sidebar.hasAttribute('inert')).toBe(false)
    expect(document.activeElement).toBe(within(sidebar).getByRole('button', { name: 'Close menu' }))
    await u.keyboard('{Escape}')
    expect(sidebar.hasAttribute('inert')).toBe(true); expect(document.activeElement).toBe(menu)

    await u.click(menu); await u.click(within(sidebar).getByRole('link', { name: 'Fields' }))
    await screen.findByRole('heading', { name: 'Fields' }); expect(sidebar.hasAttribute('inert')).toBe(true)
    expect(screen.getByText(/0 fields ·/)).toBeTruthy()
  })
})
