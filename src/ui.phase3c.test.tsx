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
import { setCloudFactory } from './lib/cloud'
import { makeFakeCloud } from './testing/fakeCloud'

const label = (t: string | RegExp) => screen.findByLabelText(t)

describe('Phase 3c UI: invite a contractor and view the portal', () => {
  it('farmer invites with chosen menus; contractor accepts and sees only those, read-only', async () => {
    const cloud = makeFakeCloud({ portal_fields: [{ id: 'f1', tenant_id: '', field_no: 'F-07', area_ha: 3.5, irrigated: true }] })
    let who = ''; setCloudFactory(() => cloud.client(who))
    const u = userEvent.setup()
    render(<App />)
    await u.type(await label('Farm name'), 'Home Farm'); await u.type(await label('Owner name'), 'Lovemore')
    await u.type(await label('Owner PIN (4–8 digits)'), '1234'); await u.type(await label('Confirm PIN'), '1234')
    await u.click(screen.getByRole('button', { name: 'Create farm' }))
    await u.type(await label('Name'), 'Lovemore'); await u.type(await label('PIN'), '1234')
    await u.click(screen.getByRole('button', { name: 'Sign in' }))
    await screen.findByText('No active season')

    await u.click(screen.getByRole('link', { name: 'Users & access' }))
    await u.click(await screen.findByRole('button', { name: 'Contractor & extension access' }))
    // sign in to cloud as farmer
    who = 'farmer@x.co'
    await u.type(await label('Supabase project URL'), 'https://x.supabase.co'); await u.type(screen.getByLabelText('Publishable key'), 'pk')
    await u.type(screen.getByLabelText('Email'), who); await u.type(screen.getByLabelText(/Password/), 'secret1')
    await u.click(screen.getByRole('button', { name: 'Connect' }))
    await u.click(await screen.findByRole('button', { name: 'Invite someone' }))
    let dlg = await screen.findByRole('dialog', { name: 'Invite someone' })
    await u.type(within(dlg).getByLabelText(/Their email/), 'con@x.co')
    // contractor preset: costs not ticked, fields ticked
    expect((within(dlg).getByLabelText(/^Costs/) as HTMLInputElement).checked).toBe(false)
    expect((within(dlg).getByLabelText(/^Fields/) as HTMLInputElement).checked).toBe(true)
    for (const l of [/^Seedbeds/, /^Field operations/, /^Transplanting/, /^Harvest/, /^Barns/, /^Curing cycles/, /^Starking/, /^Grading/, /^Bales/]) await u.click(within(dlg).getByLabelText(l))
    await u.click(within(dlg).getByRole('button', { name: 'Create invitation' }))
    dlg = await screen.findByRole('dialog', { name: 'Invitation created' })
    const code = (within(dlg).getByLabelText('Invitation code') as HTMLTextAreaElement).value
    expect(code).toMatch(/^[0-9a-f-]{36}\.[0-9a-f]{20,}$/)
    expect(cloud.invitations[0].permissions).toEqual(['production.field.view'])
    await u.click(within(dlg).getByRole('button', { name: 'Done' }))
    cloud.invitations[0].tenant_id = ''; // fake farm id matches portal fixture
    await screen.findByText('con@x.co')

    // contractor side
    await u.click(screen.getByRole('button', { name: 'Sign out' }))
    await u.click(await screen.findByRole('button', { name: 'Contractor / extension portal' }))
    who = 'con@x.co'
    await u.type(await label('Supabase project URL'), 'https://x.supabase.co'); await u.type(screen.getByLabelText('Publishable key'), 'pk')
    const email = screen.getByLabelText('Email'); await u.clear(email); await u.type(email, who)
    await u.type(screen.getByLabelText(/Password/), 'secret2'); await u.click(screen.getByRole('button', { name: 'Connect' }))
    await u.type(await screen.findByPlaceholderText(/Paste the code/), code); await u.click(screen.getByRole('button', { name: 'Accept' }))
    await screen.findByText('Invitation accepted')
    await u.click(await screen.findByRole('button', { name: /Home Farm/ }))
    await screen.findByText('F-07'); await screen.findByText(/view-only access/)
    expect(screen.queryByRole('button', { name: 'Costs' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Fields' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Save|Edit|New/ })).toBeNull()
    setCloudFactory(null)
  })
})
