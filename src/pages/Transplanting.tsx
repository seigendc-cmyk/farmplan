import { useState } from 'react'
import { deleteTransplant, listTransplants, plantingByField, recordTransplant, type TransplantInput } from '../services/transplants'
import { listSeedbeds } from '../services/seedbeds'
import { listFields } from '../services/fields'
import { useCan, useCtx, useData, useRun, fmt, today } from '../ui/hooks'
import { useSeasonPicker } from '../ui/season'
import { Badge, Button, Card, Denied, Grid, Input, Label, Modal, NumberInput, PageHeader, Select, Stat, Table, Td, Textarea } from '../ui/kit'
import { RecLink } from '../ui/links'

export default function Transplanting() {
  const ctx = useCtx(); const can = useCan(); const run = useRun()
  const { sid, picker } = useSeasonPicker()
  const rows = useData(c => listTransplants(c, { seasonId: sid || undefined }), [sid])
  const byField = useData(c => sid ? plantingByField(c, sid) : [], [sid]) ?? []
  const beds = useData(c => listSeedbeds(c, sid || undefined), [sid]) ?? []
  const fields = useData(c => listFields(c)) ?? []
  const [edit, setEdit] = useState<Partial<TransplantInput> | null>(null)
  if (!rows) return <Denied what="transplanting" />
  const showCost = can('finance.cost.view'); const record = can('production.transplant.record')
  const established = rows.reduce((s, r) => s + r.established, 0)
  const bed = beds.find(b => b.id === edit?.seedbed_id)

  async function save() {
    const e = edit!
    if (await run(() => recordTransplant(ctx, { ...e, occurred_on: e.occurred_on ?? today(), qty: e.qty ?? 0 } as TransplantInput), 'Transplanting recorded')) setEdit(null)
  }
  return (
    <>
      <PageHeader title="Transplanting" sub="Seedbed → field, with gap filling and mortality" actions={<>{picker}
        {record && <Button variant="primary" disabled={!sid} onClick={() => setEdit({ occurred_on: today(), kind: 'transplant', mortality: 0 })}>Record transplanting</Button>}</>} />
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-4">
        <Stat label="Operations" value={rows.length} /><Stat label="Plants established" value={fmt.num(established)} />
        <Stat label="Fields planted" value={byField.length} />
      </div>
      {byField.length > 0 && <Card className="mb-4"><Table head={['Field', { label: 'Area ha', right: true }, { label: 'Established', right: true }, { label: 'Plants / ha', right: true }]}>
        {byField.map(f => <tr key={f.field_no}><Td className="font-medium"><RecLink kind="field" code={f.field_no} /></Td><Td right>{fmt.num(f.area_ha, 2)}</Td><Td right>{fmt.num(f.established)}</Td><Td right>{fmt.num(f.plants_per_ha)}</Td></tr>)}</Table></Card>}
      <Card><Table head={['Date', 'Type', 'Seedbed', 'Field', { label: 'Qty', right: true }, { label: 'Mortality', right: true }, { label: 'Established', right: true }, 'Spacing', ...(showCost ? [{ label: 'Labour', right: true }] : []), 'Remarks', '']} empty="No transplanting recorded for this season.">
        {rows.map(r => <tr key={r.id} className="hover:bg-gray-50"><Td>{fmt.date(r.occurred_on)}</Td><Td><Badge tone={r.kind === 'gap_fill' ? 'amber' : 'blue'}>{r.kind === 'gap_fill' ? 'gap fill' : 'transplant'}</Badge></Td>
          <Td>{r.seedbed_code}</Td><Td><RecLink kind="field" code={r.field_no} /></Td><Td right>{fmt.num(r.qty)}</Td><Td right>{fmt.num(r.mortality)}</Td><Td right>{fmt.num(r.established)}</Td>
          <Td>{r.spacing_row_m && r.spacing_plant_m ? `${r.spacing_row_m} × ${r.spacing_plant_m} m` : '—'}</Td>
          {showCost && <Td right>{fmt.money(r.labour_cost)}</Td>}<Td>{r.remarks ?? ''}</Td>
          <Td className="text-right">{record && <Button small variant="danger" onClick={() => { if (window.confirm('Delete this transplanting record? Seedlings return to the seedbed.')) void run(() => deleteTransplant(ctx, r.id), 'Record deleted') }}>Delete</Button>}</Td></tr>)}</Table></Card>

      {edit && <Modal title="Record transplanting" onClose={() => setEdit(null)} wide>
        <form className="space-y-3" onSubmit={e => { e.preventDefault(); void save() }}>
          <Grid cols={3}>
            <Label text="Seedbed"><Select value={edit.seedbed_id ?? ''} onChange={e => setEdit({ ...edit, seedbed_id: e.target.value })} required><option value="">Select…</option>
              {beds.map(b => <option key={b.id} value={b.id}>{b.code} ({fmt.num(b.available_seedlings)} left)</option>)}</Select></Label>
            <Label text="Field"><Select value={edit.field_id ?? ''} onChange={e => setEdit({ ...edit, field_id: e.target.value })} required><option value="">Select…</option>
              {fields.map(f => <option key={f.id} value={f.id}>{f.field_no} ({fmt.num(f.area_ha, 1)} ha)</option>)}</Select></Label>
            <Label text="Type"><Select value={edit.kind} onChange={e => setEdit({ ...edit, kind: e.target.value as 'transplant' | 'gap_fill' })}><option value="transplant">Transplanting</option><option value="gap_fill">Gap filling</option></Select></Label>
            <Label text="Date"><Input type="date" value={edit.occurred_on ?? ''} onChange={e => setEdit({ ...edit, occurred_on: e.target.value })} required /></Label>
            <Label text="Seedlings planted" hint={bed ? `${fmt.num(bed.available_seedlings)} available in ${bed.code}` : undefined}><NumberInput min={1} value={edit.qty} onChange={n => setEdit({ ...edit, qty: n })} required /></Label>
            <Label text="Mortality"><NumberInput min={0} value={edit.mortality} onChange={n => setEdit({ ...edit, mortality: n })} /></Label>
            <Label text="Row spacing (m)"><NumberInput step="0.01" value={edit.spacing_row_m} onChange={n => setEdit({ ...edit, spacing_row_m: n })} /></Label>
            <Label text="Plant spacing (m)"><NumberInput step="0.01" value={edit.spacing_plant_m} onChange={n => setEdit({ ...edit, spacing_plant_m: n })} /></Label>
            <Label text="Workers"><NumberInput min={0} value={edit.labour_workers} onChange={n => setEdit({ ...edit, labour_workers: n })} /></Label>
            {can('finance.cost.view') && <Label text="Labour cost"><NumberInput step="0.01" min={0} value={edit.labour_cost} onChange={n => setEdit({ ...edit, labour_cost: n })} /></Label>}
            <Label text="Weather"><Input value={edit.weather ?? ''} onChange={e => setEdit({ ...edit, weather: e.target.value })} /></Label>
            <Label text="Soil condition"><Input value={edit.soil_condition ?? ''} onChange={e => setEdit({ ...edit, soil_condition: e.target.value })} /></Label>
          </Grid>
          <Label text="Remarks"><Textarea value={edit.remarks ?? ''} onChange={e => setEdit({ ...edit, remarks: e.target.value })} /></Label>
          <div className="flex justify-end gap-2"><Button type="button" onClick={() => setEdit(null)}>Cancel</Button><Button variant="primary" type="submit">Save</Button></div>
        </form></Modal>}
    </>
  )
}
