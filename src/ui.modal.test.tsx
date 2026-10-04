// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { useState } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Button, Input, Label, Modal } from './ui/kit'

afterEach(cleanup)

function Demo({ autoFocusSecond = false }: { autoFocusSecond?: boolean }) {
  const [open, setOpen] = useState(false); const [inner, setInner] = useState(false)
  return <>
    <Button onClick={() => setOpen(true)}>New thing</Button>
    {open && <Modal title="New thing" onClose={() => setOpen(false)}>
      <Label text="Name"><Input /></Label>
      <Label text="Code" hint="e.g. 2026/27"><Input autoFocus={autoFocusSecond} /></Label>
      <Button onClick={() => setInner(true)}>More</Button>
      <Button variant="primary">Save</Button>
      {inner && <Modal title="Inner" onClose={() => setInner(false)}><Label text="Detail"><Input /></Label></Modal>}
    </Modal>}
  </>
}

describe('Modal focus', () => {
  it('moves focus in, keeps Tab inside both ways, closes on Escape and returns focus to the opener', async () => {
    const u = userEvent.setup(); render(<Demo />)
    const opener = screen.getByRole('button', { name: 'New thing' }); await u.click(opener)
    expect(document.activeElement).toBe(screen.getByLabelText('Name'))
    await u.tab(); await u.tab(); await u.tab()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Save' }))
    await u.tab(); expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }))   // wrapped to the first item
    await u.tab({ shift: true }); expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Save' }))   // and back
    await u.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull(); expect(document.activeElement).toBe(opener)
  })
  it('lets an autoFocus field win', async () => {
    const u = userEvent.setup(); render(<Demo autoFocusSecond />)
    await u.click(screen.getByRole('button', { name: 'New thing' }))
    expect(document.activeElement).toBe(screen.getByLabelText('Code'))
  })
  it('closes only the innermost pop-up on Escape and returns focus inside its parent', async () => {
    const u = userEvent.setup(); render(<Demo />)
    await u.click(screen.getByRole('button', { name: 'New thing' })); const more = screen.getByRole('button', { name: 'More' }); await u.click(more)
    expect(document.activeElement).toBe(screen.getByLabelText('Detail'))
    await u.tab(); await u.tab(); expect(screen.getByRole('dialog', { name: 'Inner' }).contains(document.activeElement)).toBe(true)   // trapped in the inner one
    await u.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: 'Inner' })).toBeNull(); expect(screen.getByRole('dialog', { name: 'New thing' })).toBeTruthy()
    expect(document.activeElement).toBe(more)
  })
})

describe('Label', () => {
  it('names the field by its label alone and describes it with the hint', () => {
    render(<Label text="Code" hint="e.g. 2026/27"><Input /></Label>)
    const field = screen.getByLabelText('Code')   // exact: the hint is no longer part of the name
    expect(document.getElementById(field.getAttribute('aria-describedby')!)!.textContent).toBe('e.g. 2026/27')
  })
})
