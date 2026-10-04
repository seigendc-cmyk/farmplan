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
import { listBuyers } from './services/buyers'

describe('Buyers UI', () => {
  it('adds a buyer with terms, credit limit, default deductions and bank details, then edits it', async () => {
    const u = userEvent.setup(); render(<App />)
    await u.type(await screen.findByLabelText('Farm name'), 'Home Farm'); await u.type(screen.getByLabelText('Owner name'), 'Lovemore')
    await u.type(screen.getByLabelText('Owner PIN (4–8 digits)'), '1234'); await u.type(screen.getByLabelText('Confirm PIN'), '1234'); await u.click(screen.getByRole('button', { name: 'Create farm' }))
    await u.type(await screen.findByLabelText('Name'), 'Lovemore'); await u.type(screen.getByLabelText('PIN'), '1234'); await u.click(screen.getByRole('button', { name: 'Sign in' }))
    await u.click(await screen.findByRole('link', { name: 'Buyers' })); await screen.findByText(/No buyers yet/)
    await u.click(screen.getByRole('button', { name: 'Add buyer' })); const dlg = await screen.findByRole('dialog', { name: 'Add buyer' })
    await u.type(within(dlg).getByLabelText('Name'), 'Boka Auction Floors'); await u.selectOptions(within(dlg).getByLabelText('Type'), 'auction_floor')
    await u.type(within(dlg).getByLabelText(/^Payment terms/), '7'); await u.type(within(dlg).getByLabelText(/^Credit limit/), '5000')
    await u.click(within(dlg).getByRole('button', { name: '+ Add default deduction' })); await u.type(within(dlg).getByLabelText('Deduction name'), 'Levy'); await u.type(within(dlg).getByLabelText('Deduction value'), '2.5')
    await u.type(within(dlg).getByLabelText('Bank'), 'CBZ'); await u.type(within(dlg).getByLabelText(/^Account \/ reference/), '00123')
    await u.click(within(dlg).getByRole('button', { name: 'Add buyer' }))
    await screen.findByText('Boka Auction Floors'); await screen.findByText('7 days')
    const ctx = useApp.getState().ctx!; expect(listBuyers(ctx)[0]).toMatchObject({ name: 'Boka Auction Floors', kind: 'auction_floor', payment_terms_days: 7, credit_limit: 5000, bank_name: 'CBZ', account_no: '00123', deductions: [{ label: 'Levy', kind: 'percent', value: 2.5 }] })

    await u.click(screen.getByRole('button', { name: 'Edit' })); const ed = await screen.findByRole('dialog', { name: 'Edit buyer' })
    await u.type(within(ed).getByLabelText('Phone / WhatsApp'), '+263770000000'); await u.click(within(ed).getByRole('button', { name: 'Save changes' }))
    await screen.findByText(/\+263770000000/); expect(listBuyers(ctx)[0].phone).toBe('+263770000000')
    await u.click(screen.getByRole('button', { name: 'Open' })); const det = await screen.findByRole('dialog', { name: 'Boka Auction Floors' }); within(det).getByText(/Levy 2.5%/); within(det).getByText(/CBZ/)
    await u.click(within(det).getByRole('button', { name: /Close|×/ }))
    await u.click(screen.getByRole('button', { name: 'Balances owed' })); await screen.findByText('Nobody owes you anything.')
  })
})
