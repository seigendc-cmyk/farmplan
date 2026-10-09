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
import { enabledModules } from './services/modules'


describe('Modules UI', () => {
  it('lists modules, hides the picker with one module, and switches the menu when two are on', async () => {
    const u = userEvent.setup(); render(<App />)
    await u.type(await screen.findByLabelText('Farm name'), 'Home Farm'); await u.type(screen.getByLabelText('Owner name'), 'Lovemore')
    await u.type(screen.getByLabelText('Owner PIN (4–8 digits)'), '1234'); await u.type(screen.getByLabelText('Confirm PIN'), '1234'); await u.click(screen.getByRole('button', { name: 'Create farm' }))
    await u.type(await screen.findByLabelText('Name'), 'Lovemore'); await u.type(screen.getByLabelText('PIN'), '1234'); await u.click(screen.getByRole('button', { name: 'Sign in' }))
    await screen.findByRole('navigation', { name: 'Main' })
    expect(screen.queryByLabelText('Module')).toBeNull()                       // one module: no picker
    await u.click(await screen.findByRole('link', { name: 'Modules' }))
    expect((await screen.findByLabelText(/Tobacco/)) as HTMLInputElement).toHaveProperty('checked', true)
    expect(screen.getByLabelText(/Orchards/)).toHaveProperty('disabled', true)
    expect(screen.getAllByText('coming soon').length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: 'Save modules' })).toHaveProperty('disabled', true)   // nothing changed
    const ctx = useApp.getState().ctx!; expect(enabledModules(ctx)).toEqual(['tobacco'])

    // A second module (turned on in the data, since none besides Tobacco can be saved yet) brings the picker and filters the menu.
    ctx.db.update('farms', ctx.farmId, { modules: 'tobacco,orchards' }); useApp.getState().bump()
    const picker = await screen.findByLabelText('Module'); expect(within(picker).getAllByRole('option')).toHaveLength(2)
    expect(screen.getByRole('link', { name: 'Buyers' })).toBeTruthy()
    await u.selectOptions(picker, 'orchards')
    expect(screen.queryByRole('link', { name: 'Buyers' })).toBeNull()          // Tobacco's menu is hidden in the Orchards module
    expect(screen.getByRole('link', { name: 'Modules' })).toBeTruthy()         // shared settings stay
    await u.selectOptions(screen.getByLabelText('Module'), 'tobacco')
    expect(screen.getByRole('link', { name: 'Buyers' })).toBeTruthy()
  })
})
