import { useState } from 'react'
import { deleteHarvest, harvestYield, listHarvests, recordHarvest, type HarvestInput } from '../services/harvest'
import { listFields } from '../services/fields'
import { useCan, useCtx, useData, useRun, fmt, today } from '../ui/hooks'
import { useSeasonPicker } from '../ui/season'
import { RecLink, useFocus } from '../ui/links'
import { Badge, Button, Card, Denied, Grid, Input, Label, Modal, NumberInput, PageHeader, Select, Stat, Table, Td, Textarea } from '../ui/kit'

export default function Harvest() {
  const ctx = useCtx(); const can = useCan(); const run = useRun()
  const focus = useFocus('harvest'); const { sid, picker } = useSeasonPicker(focus.seasonId)
  const rows = useData(c => listHarvests(c, { seasonId: sid || undefined }), [sid])
  const yields = useData(c => sid ? harvestYield(c, sid) : [], [sid]) ?? []
  const fields = useData(c => listFields(c)) ?? []
  const [edit, setEdit] = useState<Partial<HarvestInput> | null>(null)
  if (!rows) return <Denied what="harvest" />
  const showCost = can('finance.cost.view'); const record = can('production.harvest.record')
  const total = rows.reduce((s, r) => s + r.green_weight_kg, 0)

  async function save() {
    const e = edit!
    if (await run(() => recordHarvest(ctx, { ...e, season_id: sid, harvested_on: e.harvested_on ?? today(), green_weight_kg: e.green_weight_kg ?? 0 } as HarvestInput), 'Harvest batch created')) setEdit(null)
  }
  return (
    <>
      <PageHeader title="Harvest" sub="Each harvest creates a uniquely coded batch that is traced through curing to sale" actions={<>{picker}
        {record && <Button variant="primary" disabled={!sid} onClick={() => setEdit({ harvested_on: today() })}>Record harvest</Button>}</>} />
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-4">
        <Stat label="Batches" value={rows.length} /><Stat label="Green leaf" value={`${fmt.num(total)} kg`} />
        <Stat label="Awaiting curing" value={rows.filter(r => r.status === 'harvested').length} />
      </div>
      {yields.length > 0 && <Card className="mb-4"><Table head={['Field', { label: 'Area ha', right: true }, { label: 'Batches', right: true }, { label: 'Green kg', right: true }, { label: 'kg / ha', right: true }]}>
        {yields.map(y => <tr key={y.field_no}><Td className="font-medium"><RecLink kind="field" code={y.field_no} /></Td><Td right>{fmt.num(y.area_ha, 2)}</Td><Td right>{y.batches}</Td><Td right>{fmt.num(y.green_kg, 1)}</Td><Td right>{fmt.num(y.kg_per_ha)}</Td></tr>)}</Table></Card>}
      <Card><Table head={['Batch', 'Date', 'Field', 'Variety', 'Priming', 'Position', { label: 'Green kg', right: true }, { label: 'Bundles', right: true }, ...(showCost ? [{ label: 'Labour', right: true }, { label: 'Transport', right: true }] : []), 'Status', 'Cycle', '']} empty="No harvest batches for this season.">
        {rows.map(r => <tr key={r.id} {...focus.row(r.code)}><Td className="font-medium">{r.code}</Td><Td>{fmt.date(r.harvested_on)}</Td><Td><RecLink kind="field" code={r.field_no} /></Td><Td>{r.variety ?? '—'}</Td><Td>{r.priming ?? '—'}</Td><Td>{r.leaf_position ?? '—'}</Td>
          <Td right>{fmt.num(r.green_weight_kg, 1)}</Td><Td right>{fmt.num(r.bundles)}</Td>
          {showCost && <><Td right>{fmt.money(r.labour_cost)}</Td><Td right>{fmt.money(r.transport_cost)}</Td></>}
          <Td><Badge tone={r.status === 'harvested' ? 'amber' : 'green'}>{r.status}</Badge></Td><Td><RecLink kind="cycle" code={r.cycle_code} /></Td>
          <Td className="text-right">{record && r.status === 'harvested' && <Button small variant="danger" onClick={() => { if (window.confirm(`Delete batch ${r.code}?`)) void run(() => deleteHarvest(ctx, r.id), 'Batch deleted') }}>Delete</Button>}</Td></tr>)}</Table></Card>

      {edit && <Modal title="Record harvest" onClose={() => setEdit(null)} wide>
        <form className="space-y-3" onSubmit={e => { e.preventDefault(); void save() }}>
          <Grid cols={3}>
            <Label text="Field"><Select value={edit.field_id ?? ''} onChange={e => setEdit({ ...edit, field_id: e.target.value })} required><option value="">Select…</option>{fields.map(f => <option key={f.id} value={f.id}>{f.field_no}</option>)}</Select></Label>
            <Label text="Harvest date"><Input type="date" value={edit.harvested_on ?? ''} onChange={e => setEdit({ ...edit, harvested_on: e.target.value })} required /></Label>
            <Label text="Variety"><Input value={edit.variety ?? ''} onChange={e => setEdit({ ...edit, variety: e.target.value })} /></Label>
            <Label text="Priming number"><NumberInput min={1} value={edit.priming} onChange={n => setEdit({ ...edit, priming: n })} /></Label>
            <Label text="Leaf position"><Select value={edit.leaf_position ?? ''} onChange={e => setEdit({ ...edit, leaf_position: e.target.value || undefined })}><option value="">—</option>{['lugs', 'cutters', 'leaf', 'tips'].map(p => <option key={p}>{p}</option>)}</Select></Label>
            <Label text="Green weight (kg)"><NumberInput step="0.1" min={0} value={edit.green_weight_kg} onChange={n => setEdit({ ...edit, green_weight_kg: n })} required /></Label>
            <Label text="Bundles"><NumberInput min={0} value={edit.bundles} onChange={n => setEdit({ ...edit, bundles: n })} /></Label>
            <Label text="Workers"><NumberInput min={0} value={edit.labour_workers} onChange={n => setEdit({ ...edit, labour_workers: n })} /></Label>
            <Label text="Intended barn"><Input value={edit.barn_destination ?? ''} onChange={e => setEdit({ ...edit, barn_destination: e.target.value })} /></Label>
            {can('finance.cost.view') && <><Label text="Labour cost"><NumberInput step="0.01" min={0} value={edit.labour_cost} onChange={n => setEdit({ ...edit, labour_cost: n })} /></Label>
              <Label text="Transport cost"><NumberInput step="0.01" min={0} value={edit.transport_cost} onChange={n => setEdit({ ...edit, transport_cost: n })} /></Label></>}
          </Grid>
          <Label text="Remarks"><Textarea value={edit.remarks ?? ''} onChange={e => setEdit({ ...edit, remarks: e.target.value })} /></Label>
          <div className="flex justify-end gap-2"><Button type="button" onClick={() => setEdit(null)}>Cancel</Button><Button variant="primary" type="submit">Save batch</Button></div>
        </form></Modal>}
    </>
  )
}
