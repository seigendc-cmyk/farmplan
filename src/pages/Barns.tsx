import { useState } from 'react'
import { barnPerformance, createBarn, listBarns, updateBarn, type BarnInput } from '../services/curing'
import { useCan, useCtx, useData, useRun, fmt } from '../ui/hooks'
import { useSeasonPicker } from '../ui/season'
import { Badge, Button, Card, Denied, Grid, Input, Label, Modal, NumberInput, PageHeader, Table, Td, Textarea } from '../ui/kit'

export default function Barns() {
  const ctx = useCtx(); const can = useCan(); const run = useRun()
  const { sid, picker } = useSeasonPicker()
  const rows = useData(c => listBarns(c))
  const perf = useData(c => sid ? barnPerformance(c, sid) : [], [sid]) ?? []
  const [edit, setEdit] = useState<(BarnInput & { id?: string }) | null>(null)
  if (!rows) return <Denied what="barns" />
  const manage = can('curing.barn.edit'); const showCost = can('finance.cost.view')
  const set = (k: keyof BarnInput, v: string | number | undefined) => setEdit({ ...edit!, [k]: v === '' ? null : v })
  async function save() { const e = edit!; if (await run(() => e.id ? updateBarn(ctx, e.id, e) : createBarn(ctx, e), e.id ? 'Barn updated' : 'Barn created')) setEdit(null) }
  return (
    <>
      <PageHeader title="Barns" sub="Curing barn register and performance" actions={<>{picker}{manage && <Button variant="primary" onClick={() => setEdit({ active: 1 })}>New barn</Button>}</>} />
      <Card className="mb-4"><Table head={['Barn', 'Type', { label: 'Capacity kg', right: true }, 'Furnace', 'Fuel', 'Condition', 'Status', '']} empty="No barns registered yet.">
        {rows.map(b => <tr key={b.id} className="hover:bg-gray-50"><Td className="font-medium">{b.code}</Td><Td>{b.barn_type ?? '—'}</Td><Td right>{fmt.num(b.capacity_kg)}</Td><Td>{b.furnace ?? '—'}</Td><Td>{b.fuel_type ?? '—'}</Td><Td>{b.condition ?? '—'}</Td>
          <Td>{b.open_cycle_code ? <Badge tone="blue">{b.open_cycle_code} · {b.open_cycle_status}</Badge> : <Badge>free</Badge>}</Td>
          <Td className="text-right">{manage && <Button small onClick={() => setEdit({ ...b })}>Edit</Button>}</Td></tr>)}</Table></Card>
      {can('curing.cycle.view') && <Card><div className="px-4 pt-3 font-medium">Barn performance — completed cycles</div>
        <Table head={['Barn', { label: 'Cycles', right: true }, { label: 'Green kg', right: true }, { label: 'Cured kg', right: true }, { label: 'Recovery', right: true }, { label: 'Fuel / kg cured', right: true }, ...(showCost ? [{ label: 'Cost / kg cured', right: true }] : [])]} empty="No completed cycles this season.">
          {perf.map(p => <tr key={p.barn}><Td className="font-medium">{p.barn}</Td><Td right>{p.cycles}</Td><Td right>{fmt.num(p.green_kg, 1)}</Td><Td right>{fmt.num(p.cured_kg, 1)}</Td>
            <Td right>{p.recovery_pct == null ? '—' : `${p.recovery_pct}%`}</Td><Td right>{fmt.num(p.fuel_per_kg_cured, 2)}</Td>{showCost && <Td right>{fmt.money(p.cost_per_kg_cured)}</Td>}</tr>)}</Table></Card>}

      {edit && <Modal title={edit.id ? `Edit ${edit.code}` : 'New barn'} onClose={() => setEdit(null)} wide>
        <form className="space-y-3" onSubmit={e => { e.preventDefault(); void save() }}>
          <Grid cols={3}>
            <Label text="Barn ID"><Input value={edit.code ?? ''} onChange={e => set('code', e.target.value)} required /></Label>
            <Label text="Location"><Input value={edit.location ?? ''} onChange={e => set('location', e.target.value)} /></Label>
            <Label text="Capacity (kg green)"><NumberInput min={0} value={edit.capacity_kg ?? undefined} onChange={n => set('capacity_kg', n)} /></Label>
            <Label text="Barn type"><Input value={edit.barn_type ?? ''} onChange={e => set('barn_type', e.target.value)} placeholder="e.g. rocket, conventional" /></Label>
            <Label text="Furnace"><Input value={edit.furnace ?? ''} onChange={e => set('furnace', e.target.value)} /></Label>
            <Label text="Flues"><Input value={edit.flues ?? ''} onChange={e => set('flues', e.target.value)} /></Label>
            <Label text="Ventilation"><Input value={edit.ventilation ?? ''} onChange={e => set('ventilation', e.target.value)} /></Label>
            <Label text="Sensors"><Input value={edit.sensors ?? ''} onChange={e => set('sensors', e.target.value)} /></Label>
            <Label text="Fuel type"><Input value={edit.fuel_type ?? ''} onChange={e => set('fuel_type', e.target.value)} placeholder="coal, wood…" /></Label>
            <Label text="Condition"><Input value={edit.condition ?? ''} onChange={e => set('condition', e.target.value)} /></Label>
          </Grid>
          <Label text="Notes"><Textarea value={edit.notes ?? ''} onChange={e => set('notes', e.target.value)} /></Label>
          <div className="flex justify-end gap-2"><Button type="button" onClick={() => setEdit(null)}>Cancel</Button><Button variant="primary" type="submit">Save barn</Button></div>
        </form></Modal>}
    </>
  )
}
