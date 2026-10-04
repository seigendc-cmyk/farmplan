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

describe('Ask the brain UI', () => {
  it("answers, offers Claude only when allowed, and saves engine settings", async () => {
    const u = userEvent.setup(); render(<App />)
    await u.type(await screen.findByLabelText('Farm name'), 'Home Farm'); await u.type(screen.getByLabelText('Owner name'), 'Lovemore')
    await u.type(screen.getByLabelText('Owner PIN (4–8 digits)'), '1234'); await u.type(screen.getByLabelText('Confirm PIN'), '1234'); await u.click(screen.getByRole('button', { name: 'Create farm' }))
    await u.type(await screen.findByLabelText('Name'), 'Lovemore'); await u.type(screen.getByLabelText('PIN'), '1234'); await u.click(screen.getByRole('button', { name: 'Sign in' }))
    await u.click(await screen.findByRole('link', { name: 'Ask' })); await screen.findByRole('heading', { name: 'Ask' })
    await u.type(screen.getByLabelText('Your question'), 'what is the meaning of life'); await u.click(screen.getByRole('button', { name: 'Ask' }))
    await screen.findByText(/did not match any of them/); expect(screen.getByRole('button', { name: 'Ask Claude instead' })).toBeTruthy()
    await u.click(screen.getByRole('button', { name: 'Engine settings' })); const dlg = await screen.findByRole('dialog', { name: 'Engine settings' })
    await u.click(within(dlg).getByLabelText('Use a local model on this computer')); expect(within(dlg).getByLabelText(/^Local server address/)).toBeTruthy(); expect(within(dlg).getByLabelText(/^Model name/)).toBeTruthy()
    await u.click(within(dlg).getByRole('button', { name: 'Done' })); expect(JSON.parse(localStorage.getItem('farmplan.brain')!).localEnabled).toBe(true)
  })
})
