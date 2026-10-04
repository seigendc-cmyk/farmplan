import { useState } from 'react'
import { Link } from 'react-router-dom'
import { createField, deleteField, ensureBlock, listBlocks, listFields, updateField, type FieldInput } from '../services/fields'
import { recordHref } from '../services/links'
import { useCan, useCtx, useData, useRun, fmt, plural } from '../ui/hooks'
import { RecLink } from '../ui/links'
import { Badge, Button, Card, Denied, Grid, Input, Label, Modal, NumberInput, PageHeader, Select, Table, Td, Textarea } from '../ui/kit'

const blank: FieldInput & { block_name?: string | null } = { field_no: '', area_ha: 0, tenure: 'owned', irrigated: 0 }

export default function Fields() {
  const ctx = useCtx(); const can = useCan(); const run = useRun()
  const fields = useData(c => listFields(c)); const blocks = useData(c => listBlocks(c)) ?? []
  const [edit, setEdit] = useState<(FieldInput & { id?: string; block_name?: string | null }) | null>(null)
  if (!fields) return <Denied what="fields" />
  const manage = can('production.field.edit')
  const total = fields.reduce((s, f) => s + f.area_ha, 0)

  async function save() {
    const e = edit!
    const ok = await run(() => {
      const block_id = e.block_name?.trim() ? ensureBlock(ctx, e.block_name) : null
      const input = { ...e, block_id }
      if (e.id) updateField(ctx, e.id, input); else createField(ctx, input)
    }, e.id ? 'Field updated' : 'Field created')
    if (ok) setEdit(null)
  }

  return (
    <>
      <PageHeader title="Fields" sub={`${plural(fields.length, 'field')} · ${fmt.num(total, 1)} ha`} actions={manage && <Button variant="primary" onClick={() => setEdit({ ...blank })}>New field</Button>} />
      <Card><Table head={['Field', 'Block', { label: 'Area (ha)', right: true }, 'Soil', 'Current crop', 'Variety', 'Irrigation', 'Tenure', '']} empty="No fields yet. Add your first field.">
        {fields.map(f => (
          <tr key={f.id} className="hover:bg-gray-50">
            <Td className="font-medium"><RecLink kind="field" code={f.field_no} /></Td><Td>{f.block_name ?? '—'}</Td><Td right>{fmt.num(f.area_ha, 2)}</Td><Td>{f.soil_type ?? '—'}</Td>
            <Td>{f.current_crop ?? '—'}</Td><Td>{f.variety ?? '—'}</Td><Td>{f.irrigated ? <Badge tone="blue">irrigated</Badge> : <span className="text-gray-500">dryland</span>}</Td>
            <Td className="capitalize">{f.tenure}</Td>
            <Td className="text-right space-x-1 whitespace-nowrap">
              <Link to={recordHref('field', f.field_no)} className="inline-flex items-center px-2.5 py-1 text-xs font-medium rounded-md text-gray-700 hover:bg-gray-100">Open</Link>
              {manage && <Button small onClick={() => setEdit({ ...f })}>Edit</Button>}
              {manage && <Button small variant="danger" onClick={() => confirm(`Delete field ${f.field_no}?`) && run(() => deleteField(ctx, f.id), 'Field deleted')}>Delete</Button>}</Td></tr>))}
      </Table></Card>

      {edit && <Modal title={edit.id ? `Edit field ${edit.field_no}` : 'New field'} onClose={() => setEdit(null)} wide>
        <form className="space-y-3" onSubmit={e => { e.preventDefault(); void save() }}>
          <Grid cols={3}>
            <Label text="Field number"><Input value={edit.field_no} onChange={e => setEdit({ ...edit, field_no: e.target.value })} required autoFocus /></Label>
            <Label text="Area (ha)"><NumberInput step="0.01" min={0} value={edit.area_ha || undefined} onChange={n => setEdit({ ...edit, area_ha: n ?? 0 })} required /></Label>
            <Label text="Block" hint="Type a new name to create one"><Input list="blocks" value={edit.block_name ?? (blocks.find(b => b.id === edit.block_id)?.name ?? '')} onChange={e => setEdit({ ...edit, block_name: e.target.value })} />
              <datalist id="blocks">{blocks.map(b => <option key={b.id} value={b.name} />)}</datalist></Label>
          </Grid>
          <Grid cols={3}>
            <Label text="Soil type"><Input value={edit.soil_type ?? ''} onChange={e => setEdit({ ...edit, soil_type: e.target.value })} /></Label>
            <Label text="Previous crop"><Input value={edit.previous_crop ?? ''} onChange={e => setEdit({ ...edit, previous_crop: e.target.value })} /></Label>
            <Label text="Current crop"><Input value={edit.current_crop ?? ''} onChange={e => setEdit({ ...edit, current_crop: e.target.value })} /></Label>
          </Grid>
          <Grid cols={3}>
            <Label text="Variety"><Input value={edit.variety ?? ''} onChange={e => setEdit({ ...edit, variety: e.target.value })} /></Label>
            <Label text="Latitude"><NumberInput step="0.000001" value={edit.latitude ?? undefined} onChange={n => setEdit({ ...edit, latitude: n ?? null })} /></Label>
            <Label text="Longitude"><NumberInput step="0.000001" value={edit.longitude ?? undefined} onChange={n => setEdit({ ...edit, longitude: n ?? null })} /></Label>
          </Grid>
          <Grid>
            <Label text="Tenure"><Select value={edit.tenure} onChange={e => setEdit({ ...edit, tenure: e.target.value })}>
              {['owned', 'leased', 'communal', 'other'].map(t => <option key={t} value={t}>{t}</option>)}</Select></Label>
            <label className="flex items-center gap-2 mt-6"><input type="checkbox" checked={!!edit.irrigated} onChange={e => setEdit({ ...edit, irrigated: e.target.checked ? 1 : 0 })} /> Irrigated</label>
          </Grid>
          <Label text="Soil / tenure notes"><Textarea value={edit.soil_notes ?? ''} onChange={e => setEdit({ ...edit, soil_notes: e.target.value })} /></Label>
          <div className="flex justify-end gap-2 pt-2"><Button type="button" onClick={() => setEdit(null)}>Cancel</Button><Button variant="primary" type="submit">Save field</Button></div>
        </form></Modal>}
    </>
  )
}
