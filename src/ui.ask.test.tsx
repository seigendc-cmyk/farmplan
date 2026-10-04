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
import { createUser } from './services/setup'
import { createRole } from './services/roles'
import { setBiTransport } from './services/bi'

describe('One Ask screen', () => {
  it('redirects the old route, answers from the brain first, falls back to Claude, and follows each role’s access', async () => {
    const u = userEvent.setup(); render(<App />)
    const signIn = async (name: string, pin: string) => {
      await u.type(await screen.findByLabelText('Name'), name); await u.type(screen.getByLabelText('PIN'), pin); await u.click(screen.getByRole('button', { name: 'Sign in' }))
      await screen.findByRole('navigation', { name: 'Main' })
    }
    const signOut = () => u.click(screen.getByRole('button', { name: 'Sign out' }))
    await u.type(await screen.findByLabelText('Farm name'), 'Home Farm'); await u.type(screen.getByLabelText('Owner name'), 'Lovemore')
    await u.type(screen.getByLabelText('Owner PIN (4–8 digits)'), '1234'); await u.type(screen.getByLabelText('Confirm PIN'), '1234'); await u.click(screen.getByRole('button', { name: 'Create farm' }))
    await signIn('Lovemore', '1234')
    const ctx = useApp.getState().ctx!
    const manager = ctx.db.get<{ id: string }>(`SELECT id FROM roles WHERE name='Farm Manager'`)!.id
    await createUser(ctx, 'Rudo', '2222', manager)
    await createUser(ctx, 'Agro', '3333', createRole(ctx, 'Cloud only', ['brain.chat.cloud', 'production.field.view']))   // Claude still sees only the views the role may read
    await createUser(ctx, 'Tendai', '4444', createRole(ctx, 'Picker', ['production.harvest.view']))

    // owner: the old "Ask the brain" address lands on the one Ask screen; only one Ask item in the menu
    window.location.hash = '#/brain'
    await screen.findByRole('heading', { name: 'Ask' }); expect(window.location.hash).toBe('#/ask')
    const nav = screen.getByRole('navigation', { name: 'Main' })
    expect(within(nav).getAllByRole('link').map(a => a.textContent).filter(t => /^Ask/.test(t ?? ''))).toEqual(['Ask'])
    // no key yet: asking Claude opens the settings at the key instead of failing silently
    await u.type(screen.getByLabelText('Your question'), 'what is the meaning of life'); await u.click(screen.getByRole('button', { name: 'Ask' }))
    await screen.findByText(/did not match any of them/)
    await u.click(screen.getByRole('button', { name: 'Ask Claude instead' }))
    let dlg = await screen.findByRole('dialog', { name: 'Engine settings' }); await screen.findByText(/Add your Anthropic API key/)
    expect(within(dlg).getByRole('group', { name: 'Claude (fallback)' })).toBeTruthy()
    await u.click(within(dlg).getByRole('button', { name: 'Done' }))

    // Farm Manager: the brain, never Claude
    await signOut(); await signIn('Rudo', '2222')
    await u.click(screen.getByRole('link', { name: 'Ask' }))
    await u.type(await screen.findByLabelText('Your question'), 'what is the meaning of life'); await u.click(screen.getByRole('button', { name: 'Ask' }))
    await screen.findByText(/did not match any of them/); expect(screen.queryByRole('button', { name: 'Ask Claude instead' })).toBeNull()
    await u.click(screen.getByRole('button', { name: 'Engine settings' })); dlg = await screen.findByRole('dialog', { name: 'Engine settings' })
    expect(within(dlg).queryByLabelText('Anthropic API key')).toBeNull(); await u.click(within(dlg).getByRole('button', { name: 'Done' }))

    // Claude-only role: questions go straight to Claude
    localStorage.setItem('farmplan.bi', JSON.stringify({ apiKey: 'sk-test', model: 'claude-sonnet-5-5' }))
    setBiTransport(async () => '{"sql":"SELECT field_no, area_ha FROM bi_fields","explanation":"Every field and its area."}')
    await signOut(); await signIn('Agro', '3333')
    await u.click(screen.getByRole('link', { name: 'Ask' }))
    await u.type(await screen.findByLabelText('Your question'), 'list the fields'); await u.click(screen.getByRole('button', { name: 'Ask' }))
    await screen.findByText('Every field and its area.'); expect(screen.getByText('Claude')).toBeTruthy()
    setBiTransport(null)

    // neither permission: no menu item, and the address shows the access message
    await signOut(); await signIn('Tendai', '4444')
    expect(within(screen.getByRole('navigation', { name: 'Main' })).queryByRole('link', { name: 'Ask' })).toBeNull()
    window.location.hash = '#/ask'; await screen.findByText(/does not include access to Ask/)
  })
})
