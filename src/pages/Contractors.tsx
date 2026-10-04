import { useState } from 'react'
import { deleteContractor, listContractors, saveContractor, type Contractor, type ContractorInput } from '../services/contracts'
import { useCan, useCtx, useData, useRun } from '../ui/hooks'
import { Badge, Button, Card, Denied, Grid, Input, Label, Modal, PageHeader, Table, Td, Textarea } from '../ui/kit'

export default function Contractors() {
  const ctx = useCtx(); const can = useCan(); const run = useRun()
  const rows = useData(c => listContractors(c))
  const [edit, setEdit] = useState<(ContractorInput & { id?: string }) | null>(null)
  if (!rows) return <Denied what="contractors" />
  const manage = can('contracts.contract.edit')
  return (
    <>
      <PageHeader title="Contractors" sub="Companies you grow or deliver tobacco for" actions={manage && <Button variant="primary" onClick={() => setEdit({ name: '' })}>New contractor</Button>} />
      <Card><Table head={['Name', 'Contact', 'Phone', 'Email', { label: 'Contracts', right: true }, 'Status', '']} empty="No contractors registered yet.">
        {rows.map((c: Contractor) => <tr key={c.id} className="hover:bg-gray-50"><Td className="font-medium">{c.name}</Td><Td>{c.contact_person ?? '—'}</Td><Td>{c.phone ?? '—'}</Td><Td>{c.email ?? '—'}</Td><Td right>{c.contracts}</Td>
          <Td>{c.active ? <Badge tone="green">active</Badge> : <Badge>inactive</Badge>}</Td>
          <Td className="text-right space-x-1">{manage && <><Button small onClick={() => setEdit({ ...c, active: !!c.active })}>Edit</Button>
            {c.contracts === 0 && <Button small variant="danger" onClick={() => { if (window.confirm(`Delete ${c.name}?`)) void run(() => deleteContractor(ctx, c.id), 'Contractor deleted') }}>Delete</Button>}</>}</Td></tr>)}</Table></Card>
      {edit && <Modal title={edit.id ? `Edit ${edit.name}` : 'New contractor'} onClose={() => setEdit(null)}>
        <form className="space-y-3" onSubmit={e => { e.preventDefault(); void run(() => saveContractor(ctx, edit, edit.id), 'Contractor saved').then(ok => ok && setEdit(null)) }}>
          <Grid cols={2}>
            <Label text="Company name"><Input value={edit.name} onChange={e => setEdit({ ...edit, name: e.target.value })} required /></Label>
            <Label text="Contact person"><Input value={edit.contact_person ?? ''} onChange={e => setEdit({ ...edit, contact_person: e.target.value })} /></Label>
            <Label text="Phone / WhatsApp"><Input value={edit.phone ?? ''} onChange={e => setEdit({ ...edit, phone: e.target.value })} /></Label>
            <Label text="Email"><Input type="email" value={edit.email ?? ''} onChange={e => setEdit({ ...edit, email: e.target.value })} /></Label>
          </Grid>
          <Label text="Notes"><Textarea value={edit.notes ?? ''} onChange={e => setEdit({ ...edit, notes: e.target.value })} /></Label>
          {edit.id && <label className="flex items-center gap-2"><input type="checkbox" checked={edit.active !== false} onChange={e => setEdit({ ...edit, active: e.target.checked })} />Active</label>}
          <div className="flex justify-end gap-2"><Button type="button" onClick={() => setEdit(null)}>Cancel</Button><Button variant="primary" type="submit">Save</Button></div>
        </form></Modal>}
    </>
  )
}
