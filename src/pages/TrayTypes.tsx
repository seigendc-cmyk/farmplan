import { useState } from 'react'
import { deleteTrayType, listTrayTypes, saveTrayType, type TrayType } from '../services/traytypes'
import { useCan, useCtx, useData, useRun, fmt } from '../ui/hooks'
import { Button, Card, Denied, Grid, Input, Label, Modal, NumberInput, PageHeader, Table, Td } from '../ui/kit'

type Draft = { id?: string; name: string; cells?: number; length_mm?: number; width_mm?: number; media: string; note: string }
const blank = (): Draft => ({ name: '', media: '', note: '' })
const EXAMPLE: Draft = { name: '200-cell tray', cells: 200, media: '', note: 'Example. Edit or remove it.' }

export default function TrayTypes() {
  const ctx = useCtx(); const can = useCan(); const run = useRun()
  const rows = useData(c => listTrayTypes(c)); const [edit, setEdit] = useState<Draft | null>(null)
  if (!rows) return <Denied what="tray types" />
  const manage = can('production.seedbed.edit')
  const save = (d: Draft, ok?: string) => run(() => saveTrayType(ctx, { id: d.id, name: d.name, cells: d.cells as number, length_mm: d.length_mm ?? null, width_mm: d.width_mm ?? null, media: d.media, note: d.note }), ok ?? (d.id ? 'Tray type updated' : 'Tray type saved'))
  const open = (t: TrayType) => setEdit({ id: t.id, name: t.name, cells: t.cells, length_mm: t.length_mm ?? undefined, width_mm: t.width_mm ?? undefined, media: t.media ?? '', note: t.note ?? '' })
  return (
    <>
      <PageHeader title="Tray types" sub="The seedling trays this farm uses. Trays in a float bay pick one of these."
        actions={manage && <Button variant="primary" onClick={() => setEdit(blank())}>Add tray type</Button>} />
      <Card><Table head={['Name', { label: 'Cells', right: true }, 'Size (mm)', 'Media', 'Note', '']} empty="No tray types yet">
        {rows.map(t => <tr key={t.id} className="hover:bg-gray-50">
          <Td className="font-medium">{t.name}</Td><Td right>{t.cells}</Td>
          <Td>{t.length_mm && t.width_mm ? `${fmt.num(t.length_mm)} × ${fmt.num(t.width_mm)}` : t.length_mm || t.width_mm ? fmt.num((t.length_mm || t.width_mm)!) : '—'}</Td>
          <Td>{t.media ?? '—'}</Td><Td>{t.note ?? '—'}</Td>
          <Td className="text-right space-x-1 whitespace-nowrap">{manage && <>
            <Button small onClick={() => open(t)} aria-label={`Edit ${t.name}`}>Edit</Button>
            <Button small variant="danger" aria-label={`Delete ${t.name}`} onClick={() => confirm(`Delete tray type ${t.name}?`) && run(() => deleteTrayType(ctx, t.id), 'Tray type removed')}>Delete</Button></>}</Td></tr>)}
      </Table>
        {rows.length === 0 && manage && <div className="text-center pb-8"><Button onClick={() => void save(EXAMPLE, 'Example tray type added')}>Add example</Button>
          <p className="text-xs text-gray-500 mt-1">Adds one editable 200-cell tray to start from.</p></div>}
      </Card>
      {edit && <Modal title={edit.id ? `Edit ${edit.name}` : 'Add tray type'} onClose={() => setEdit(null)}>
        <form noValidate className="space-y-3" onSubmit={async e => { e.preventDefault(); if (await save(edit)) setEdit(null) }}>
          <Grid><Label text="Name"><Input value={edit.name} onChange={e => setEdit({ ...edit, name: e.target.value })} autoFocus /></Label>
            <Label text="Cells per tray"><NumberInput step="any" min={1} value={edit.cells} onChange={n => setEdit({ ...edit, cells: n })} /></Label></Grid>
          <Grid><Label text="Length (mm)"><NumberInput step="any" min={0} value={edit.length_mm} onChange={n => setEdit({ ...edit, length_mm: n })} /></Label>
            <Label text="Width (mm)"><NumberInput step="any" min={0} value={edit.width_mm} onChange={n => setEdit({ ...edit, width_mm: n })} /></Label></Grid>
          <Label text="Media"><Input value={edit.media} onChange={e => setEdit({ ...edit, media: e.target.value })} /></Label>
          <Label text="Note"><Input value={edit.note} onChange={e => setEdit({ ...edit, note: e.target.value })} /></Label>
          <div className="flex justify-end gap-2"><Button type="button" onClick={() => setEdit(null)}>Cancel</Button><Button variant="primary" type="submit">Save</Button></div>
        </form></Modal>}
    </>
  )
}
