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
import { Db, MemoryPersistence } from './db/database'
import { initialiseFarm, login } from './services/setup'
import { createSeason } from './services/seasons'
import { createField } from './services/fields'
import { createPairing, hubHandle, setHubEnabled } from './services/hub'
import { listWeather } from './services/weather'

const label = (t: string | RegExp) => screen.findByLabelText(t)

describe('Wi-Fi hub UI', () => {
  it('a blank phone pairs with the office hub, captures rain and syncs over Wi-Fi', async () => {
    const office = await Db.open(new MemoryPersistence()); await initialiseFarm(office, { tenantName: 'T', farmName: 'Home Farm', ownerName: 'Boss', ownerPin: '1234' })
    const oc = { db: office, ...(await login(office, 'Boss', '1234')).ctx! }; createSeason(oc, { label: '2026/27', starts_on: '2026-09-01', ends_on: '2027-08-31', activate: true }); createField(oc, { field_no: 'F-04', area_ha: 4 }); setHubEnabled(office, true)
    const { code } = await createPairing(oc, 'Supervisor phone')
    globalThis.fetch = (async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
      const u = new URL(url); const r = await hubHandle(office, { method: init?.method ?? 'GET', path: u.pathname + u.search, auth: init?.headers?.Authorization ?? null, body: init?.body ? JSON.parse(init.body) : undefined })
      const body = JSON.parse(JSON.stringify(r.body)); return { status: r.status, ok: r.status < 300, json: async () => body }
    }) as unknown as typeof fetch

    const u = userEvent.setup(); render(<App />)
    await u.click(await screen.findByRole('button', { name: 'Join it as a field device' })); await u.click(await screen.findByRole('button', { name: 'Farm Wi-Fi hub' }))
    await u.type(await label(/^Hub address/), '192.168.1.20'); await u.type(await label(/^Pairing code/), code); await u.type(await label(/^Your name/), 'Tendai')
    await u.type(await label('Choose a PIN (4–8 digits)'), '4321'); await u.type(await label('Confirm PIN'), '4321'); await u.click(screen.getByRole('button', { name: 'Pair with hub' }))
    await u.type(await label('Name'), 'Tendai'); await u.type(await label('PIN'), '4321'); await u.click(await screen.findByRole('button', { name: 'Sign in' }))
    await screen.findByText('farmPLAN Field'); await screen.findByText(/2026\/27/)

    await u.click(screen.getByRole('button', { name: /^Rainfall/ })); const dlg = await screen.findByRole('dialog', { name: 'Rainfall' })
    await u.type(within(dlg).getByLabelText('Rainfall (mm)'), '18'); await u.click(within(dlg).getByRole('button', { name: 'Save' }))
    await screen.findAllByText('Saved on this device')
    await u.click(screen.getByRole('button', { name: /Sync/ })); await u.click(await screen.findByRole('button', { name: 'Sync with farm hub' }))
    await screen.findByText("Synced"); expect(listWeather(oc)).toHaveLength(1); expect(listWeather(oc)[0].rainfall_mm).toBe(18)
    expect(useApp.getState().ctx).toBeTruthy()
  })
})
