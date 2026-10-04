import { useEffect, useState } from 'react'
import { CHECKLIST_ITEMS, abortCycle, createCycle, cycleDashboard, listBarns, listCycles, loadCycle, logCuring, offloadCycle, setCheck, type CycleSummary } from '../services/curing'
import { listHarvests } from '../services/harvest'
import { listInputs } from '../services/inventory'
import { useCan, useCtx, useData, useRun, fmt, today } from '../ui/hooks'
import { useSeasonPicker } from '../ui/season'
import { RecLink, useFocus } from '../ui/links'
import { Badge, Button, Card, Denied, Grid, Input, Label, Modal, NumberInput, PageHeader, Select, Stat, Table, Td, Textarea } from '../ui/kit'

const tone = (s: string) => (s === 'curing' ? 'amber' : s === 'completed' ? 'green' : s === 'aborted' ? 'gray' : 'blue') as 'amber' | 'green' | 'gray' | 'blue'
const nowLocal = () => new Date().toISOString().slice(0, 16)

export default function Curing() {
  const ctx = useCtx(); const can = useCan(); const run = useRun()
  const focus = useFocus('cycle'); const { sid, picker } = useSeasonPicker(focus.seasonId)
  const cycles = useData(c => listCycles(c, sid || undefined), [sid])
  const barns = useData(c => listBarns(c)) ?? []
  const fuels = useData(c => listInputs(c).filter(i => i.category === 'fuel' && i.active)) ?? []
  const [creating, setCreating] = useState<{ barn_id: string; fuel_input_id: string } | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  useEffect(() => { if (focus.id) setOpen(focus.id) }, [focus.id])
  if (!cycles) return <Denied what="curing cycles" />
  const showCost = can('finance.cost.view')
  const free = barns.filter(b => b.active && !b.open_cycle_code)

  return (
    <>
      <PageHeader title="Curing cycles" sub="Preparation checklist → loading → temperature & fuel log → offloading" actions={<>{picker}
        {can('curing.cycle.create') && <Button variant="primary" disabled={!sid || !free.length} reason={!free.length ? 'No free barn' : undefined} onClick={() => setCreating({ barn_id: free[0]?.id ?? '', fuel_input_id: '' })}>New cycle</Button>}</>} />
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
        <Stat label="Cycles" value={cycles.length} /><Stat label="Curing now" value={cycles.filter(c => c.status === 'curing').length} />
        <Stat label="Green loaded" value={`${fmt.num(cycles.reduce((s, c) => s + (c.green_weight_kg ?? 0), 0))} kg`} />
        <Stat label="Cured" value={`${fmt.num(cycles.reduce((s, c) => s + (c.cured_weight_kg ?? 0), 0))} kg`} />
      </div>
      <Card><Table head={['Cycle', 'Barn', 'Status', 'Checklist', 'Loaded', 'Offloaded', { label: 'Green kg', right: true }, { label: 'Cured kg', right: true }, { label: 'Recovery', right: true }, { label: 'Fuel', right: true }, ...(showCost ? [{ label: '$/kg cured', right: true }] : []), '']} empty="No curing cycles for this season.">
        {cycles.map((c: CycleSummary) => <tr key={c.id} {...focus.row(c.code)}><Td className="font-medium">{c.code}</Td><Td>{c.barn_code}</Td><Td><Badge tone={tone(c.status)}>{c.status}</Badge></Td>
          <Td>{c.checks_done}/{c.checks_total}</Td><Td>{fmt.date(c.loaded_at)}</Td><Td>{fmt.date(c.offloaded_at)}</Td><Td right>{fmt.num(c.green_weight_kg, 1)}</Td><Td right>{fmt.num(c.cured_weight_kg, 1)}</Td>
          <Td right>{c.recovery_pct == null ? '—' : `${c.recovery_pct}%`}</Td><Td right>{fmt.num(c.fuel_used, 1)}</Td>{showCost && <Td right>{fmt.money(c.cost_per_kg_cured)}</Td>}
          <Td className="text-right"><Button small onClick={() => setOpen(c.id)}>Open</Button></Td></tr>)}</Table></Card>

      {creating && <Modal title="New curing cycle" onClose={() => setCreating(null)}>
        <form className="space-y-3" onSubmit={e => { e.preventDefault(); void run(() => createCycle(ctx, { barn_id: creating.barn_id, season_id: sid, fuel_input_id: creating.fuel_input_id || undefined }), 'Cycle created — complete the preparation checklist').then(ok => { if (ok) setCreating(null) }) }}>
          <Label text="Barn"><Select value={creating.barn_id} onChange={e => setCreating({ ...creating, barn_id: e.target.value })}>{free.map(b => <option key={b.id} value={b.id}>{b.code}{b.capacity_kg ? ` (${fmt.num(b.capacity_kg)} kg)` : ''}</option>)}</Select></Label>
          <Label text="Fuel product" hint="Fuel added in the log is drawn from this inventory item"><Select value={creating.fuel_input_id} onChange={e => setCreating({ ...creating, fuel_input_id: e.target.value })}><option value="">None</option>{fuels.map(f => <option key={f.id} value={f.id}>{f.name} ({fmt.num(f.on_hand, 1)} {f.unit})</option>)}</Select></Label>
          <div className="flex justify-end gap-2"><Button type="button" onClick={() => setCreating(null)}>Cancel</Button><Button variant="primary" type="submit">Create</Button></div>
        </form></Modal>}
      {open && <CycleModal id={open} seasonId={sid} onClose={() => { setOpen(null); focus.clear() }} />}
    </>
  )
}

function CycleModal({ id, seasonId, onClose }: { id: string; seasonId: string; onClose: () => void }) {
  const ctx = useCtx(); const can = useCan(); const run = useRun()
  const d = useData(c => cycleDashboard(c, id), [id])
  const unloaded = useData(c => listHarvests(c, { seasonId, onlyUnloaded: true }), [seasonId]) ?? []
  const [load, setLoad] = useState<{ batch_ids: string[]; loaded_at: string; slates?: number; labour_workers?: number; labour_cost?: number; operator?: string; fuel_opening_kg?: number } | null>(null)
  const [log, setLog] = useState<{ logged_at: string; temperature_c?: number; ventilation?: string; fuel_added_kg?: number; operator?: string; remarks?: string } | null>(null)
  const [off, setOff] = useState<{ offloaded_at: string; cured_weight_kg?: number; labour_cost?: number; condition?: string; losses_note?: string } | null>(null)
  if (!d) return null
  const s = d.summary; const showCost = can('finance.cost.view')
  const create = can('curing.cycle.create'); const record = can('curing.cycle.record'); const close = can('curing.cycle.close')
  const picked = unloaded.filter(b => load?.batch_ids.includes(b.id)).reduce((t, b) => t + b.green_weight_kg, 0)

  return (
    <Modal title={`${s.code} — ${s.barn_code}`} onClose={onClose} wide>
      <div className="flex items-center gap-2 mb-3"><Badge tone={tone(s.status)}>{s.status}</Badge>
        {d.hours_elapsed != null && <span className="text-gray-500">{d.hours_elapsed} h since loading</span>}
        {create && (s.status === 'preparing' || s.status === 'ready') && <Button small variant="danger" className="ml-auto" onClick={() => { if (window.confirm('Cancel this cycle?')) void run(() => abortCycle(ctx, id), 'Cycle cancelled').then(ok => ok && onClose()) }}>Cancel cycle</Button>}</div>

      {(s.status === 'preparing' || s.status === 'ready') && <Card className="p-3 mb-3">
        <div className="font-medium mb-2">Preparation checklist <span className="text-gray-500 font-normal">— all items must be ticked before loading</span></div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-1.5">{CHECKLIST_ITEMS.map(item => { const k = d.checks.find(c => c.item === item); return (
          <label key={item} className="flex items-center gap-2"><input type="checkbox" disabled={!create} checked={!!k?.done} onChange={e => void run(() => setCheck(ctx, id, item, e.target.checked, today()))} />{item}</label>) })}</div>
        {create && s.status === 'ready' && <Button variant="primary" className="mt-3" onClick={() => setLoad({ batch_ids: [], loaded_at: nowLocal() })}>Load barn</Button>}
      </Card>}

      {s.status !== 'preparing' && s.status !== 'ready' && <>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3">
          <Stat label="Temperature" value={d.temp.current == null ? '—' : `${d.temp.current} °C`} sub={d.temp.min != null ? `range ${d.temp.min}–${d.temp.max}` : undefined} />
          <Stat label="Fuel used" value={fmt.num(d.fuel.used, 1)} sub={`${fmt.num(d.fuel.remaining, 1)} ${d.fuel_unit ?? ''} remaining`} />
          <Stat label="Green" value={`${fmt.num(s.green_weight_kg, 1)} kg`} sub={d.batches.map(b => b.code).join(', ')} />
          <Stat label="Recovery" value={s.recovery_pct == null ? '—' : `${s.recovery_pct}%`} sub={s.cured_weight_kg != null ? `${fmt.num(s.cured_weight_kg, 1)} kg cured` : undefined} />
        </div>
        {d.batches.length > 0 && <p className="text-sm text-gray-600 mb-3">Harvest batches: {d.batches.map((b, i) => <span key={b.code}>{i > 0 && ', '}<RecLink kind="harvest" code={b.code} /></span>)}</p>}
        {showCost && s.curing_cost != null && <p className="text-gray-600 mb-3">Curing cost {fmt.money(s.curing_cost)}{s.cost_per_kg_cured != null && ` · ${fmt.money(s.cost_per_kg_cured)} per kg cured`}</p>}
        <div className="flex gap-2 mb-2">
          {record && s.status === 'curing' && <Button variant="primary" onClick={() => setLog({ logged_at: nowLocal() })}>Add temperature / fuel log</Button>}
          {close && s.status === 'curing' && <Button onClick={() => setOff({ offloaded_at: nowLocal() })}>Offload</Button>}</div>
        <Table head={['Time', { label: '°C', right: true }, 'Ventilation', { label: 'Fuel added', right: true }, 'Operator', 'Remarks']} empty="No log entries yet.">
          {d.logs.map(l => <tr key={l.id}><Td>{l.logged_at.replace('T', ' ')}</Td><Td right>{l.temperature_c ?? '—'}</Td><Td>{l.ventilation ?? '—'}</Td><Td right>{fmt.num(l.fuel_added_kg, 1)}</Td><Td>{l.operator ?? '—'}</Td><Td>{l.remarks ?? ''}</Td></tr>)}</Table>
      </>}

      {load && <Modal title="Load barn" onClose={() => setLoad(null)} wide>
        <form className="space-y-3" onSubmit={e => { e.preventDefault(); void run(() => loadCycle(ctx, { cycle_id: id, ...load }), 'Barn loaded').then(ok => ok && setLoad(null)) }}>
          <div className="font-medium">Harvest batches <span className="text-gray-500 font-normal">({fmt.num(picked, 1)} kg selected)</span></div>
          <div className="max-h-40 overflow-y-auto border border-gray-200 rounded-md divide-y">{unloaded.length === 0 && <p className="p-3 text-gray-500">No unloaded harvest batches.</p>}
            {unloaded.map(b => <label key={b.id} className="flex items-center gap-2 px-3 py-1.5"><input type="checkbox" checked={load.batch_ids.includes(b.id)}
              onChange={e => setLoad({ ...load, batch_ids: e.target.checked ? [...load.batch_ids, b.id] : load.batch_ids.filter(x => x !== b.id) })} />{b.code} · {b.field_no} · {fmt.num(b.green_weight_kg, 1)} kg · {fmt.date(b.harvested_on)}</label>)}</div>
          <Grid cols={3}>
            <Label text="Loading date/time"><Input type="datetime-local" value={load.loaded_at} onChange={e => setLoad({ ...load, loaded_at: e.target.value })} required /></Label>
            <Label text="Slates"><NumberInput min={0} value={load.slates} onChange={n => setLoad({ ...load, slates: n })} /></Label>
            <Label text="Workers"><NumberInput min={0} value={load.labour_workers} onChange={n => setLoad({ ...load, labour_workers: n })} /></Label>
            {showCost && <Label text="Labour cost"><NumberInput step="0.01" min={0} value={load.labour_cost} onChange={n => setLoad({ ...load, labour_cost: n })} /></Label>}
            <Label text="Barn operator"><Input value={load.operator ?? ''} onChange={e => setLoad({ ...load, operator: e.target.value })} /></Label>
            <Label text="Opening fuel allocated"><NumberInput step="0.1" min={0} value={load.fuel_opening_kg} onChange={n => setLoad({ ...load, fuel_opening_kg: n })} /></Label>
          </Grid>
          <div className="flex justify-end gap-2"><Button type="button" onClick={() => setLoad(null)}>Cancel</Button><Button variant="primary" type="submit">Start curing</Button></div>
        </form></Modal>}

      {log && <Modal title="Curing log" onClose={() => setLog(null)}>
        <form className="space-y-3" onSubmit={e => { e.preventDefault(); void run(() => logCuring(ctx, { cycle_id: id, ...log }), 'Log saved').then(ok => ok && setLog(null)) }}>
          <Grid cols={2}>
            <Label text="Time"><Input type="datetime-local" value={log.logged_at} onChange={e => setLog({ ...log, logged_at: e.target.value })} required /></Label>
            <Label text="Temperature (°C)"><NumberInput step="0.5" value={log.temperature_c} onChange={n => setLog({ ...log, temperature_c: n })} /></Label>
            <Label text="Ventilation"><Input value={log.ventilation ?? ''} onChange={e => setLog({ ...log, ventilation: e.target.value })} placeholder="open / half / closed" /></Label>
            <Label text="Fuel added"><NumberInput step="0.1" min={0} value={log.fuel_added_kg} onChange={n => setLog({ ...log, fuel_added_kg: n })} /></Label>
            <Label text="Operator"><Input value={log.operator ?? ''} onChange={e => setLog({ ...log, operator: e.target.value })} /></Label>
          </Grid>
          <Label text="Remarks"><Textarea value={log.remarks ?? ''} onChange={e => setLog({ ...log, remarks: e.target.value })} /></Label>
          <div className="flex justify-end gap-2"><Button type="button" onClick={() => setLog(null)}>Cancel</Button><Button variant="primary" type="submit">Save log</Button></div>
        </form></Modal>}

      {off && <Modal title="Offload barn" onClose={() => setOff(null)}>
        <form className="space-y-3" onSubmit={e => { e.preventDefault(); void run(() => offloadCycle(ctx, { cycle_id: id, ...off, cured_weight_kg: off.cured_weight_kg ?? 0 }), 'Cycle completed').then(ok => ok && setOff(null)) }}>
          <Grid cols={2}>
            <Label text="Offloading date/time"><Input type="datetime-local" value={off.offloaded_at} onChange={e => setOff({ ...off, offloaded_at: e.target.value })} required /></Label>
            <Label text="Cured weight (kg)" hint={`Green loaded: ${fmt.num(s.green_weight_kg, 1)} kg`}><NumberInput step="0.1" min={0} value={off.cured_weight_kg} onChange={n => setOff({ ...off, cured_weight_kg: n })} required /></Label>
            {showCost && <Label text="Labour cost"><NumberInput step="0.01" min={0} value={off.labour_cost} onChange={n => setOff({ ...off, labour_cost: n })} /></Label>}
            <Label text="Leaf condition"><Input value={off.condition ?? ''} onChange={e => setOff({ ...off, condition: e.target.value })} /></Label>
          </Grid>
          <Label text="Losses / notes"><Textarea value={off.losses_note ?? ''} onChange={e => setOff({ ...off, losses_note: e.target.value })} /></Label>
          <p className="text-xs text-gray-500">Completing a cycle locks it. Fuel burned is costed from inventory automatically.</p>
          <div className="flex justify-end gap-2"><Button type="button" onClick={() => setOff(null)}>Cancel</Button><Button variant="primary" type="submit">Complete cycle</Button></div>
        </form></Modal>}
    </Modal>
  )
}
