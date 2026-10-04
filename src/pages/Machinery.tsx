import { useState } from 'react'
import { LOG_KINDS, MACHINE_KINDS, createMachine, deleteMachine, deleteMachineLog, listMachineLogs, listMachines, logMachine, updateMachine, type LogKind, type MachineInput, type MachineLogInput } from '../services/machinery'
import { listFields } from '../services/fields'
import { listSeasons } from '../services/seasons'
import { listInputs } from '../services/inventory'
import { useCan, useCtx, useData, useRun, fmt, today } from '../ui/hooks'
import { Badge, Button, Card, Denied, Grid, Input, Label, Modal, NumberInput, PageHeader, Select, Stat, Table, Td } from '../ui/kit'
import { RecLink, useFocus } from '../ui/links'

export default function Machinery() {
  const ctx = useCtx(); const can = useCan(); const run = useRun()
  const seasons = useData(c => listSeasons(c)) ?? []; const fields = useData(c => can('production.field.view') ? listFields(c) : []) ?? []
  const [sid, setSid] = useState(''); const season = sid || seasons.find(s => s.status === 'active')?.id || seasons[0]?.id || ''
  const machines = useData(c => listMachines(c, { seasonId: season || undefined }), [season]); const logs = useData(c => listMachineLogs(c, { seasonId: season || undefined }), [season]) ?? []
  const focus = useFocus('machine'); const [tab, setTab] = useState<'fleet' | 'log'>('fleet'); const [edit, setEdit] = useState<(MachineInput & { id?: string }) | null>(null); const [rec, setRec] = useState<Partial<MachineLogInput> | null>(null)
  const fuels = (useData(c => can('resources.inventory.view') ? listInputs(c) : []) ?? []).filter(i => i.active && i.category === 'fuel')
  if (!machines) return <Denied what="machinery" />
  const manage = can('resources.machinery.manage'); const record = can('resources.machinery.record'); const cost = can('finance.cost.view')
  const due = machines.filter(m => m.service_due && m.active)
  const noFuel = fuels.length ? machines.filter(m => m.active && !m.fuel_input_id && m.kind !== 'implement') : []
  /** The log's fuel source: undefined = the machine's own fuel product, null = bought outside the store. */
  const recMachine = machines.find(m => m.id === rec?.machine_id); const recFuel = rec?.input_id === undefined ? recMachine?.fuel_input_id ?? null : rec.input_id
  const litresKind = rec?.kind === 'fuel' || rec?.kind === 'use'
  const hours = machines.reduce((s, m) => s + m.total_hours, 0); const fuel = machines.reduce((s, m) => s + m.fuel_l, 0); const spend = machines.reduce((s, m) => s + (m.cost ?? 0), 0)
  return (
    <>
      <PageHeader title="Machinery" sub="Tractors, implements and pumps: hours, fuel, servicing and what they cost." actions={<>
        {seasons.length > 0 && <Select value={season} onChange={e => setSid(e.target.value)} className="w-40">{seasons.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}</Select>}
        {manage && <Button onClick={() => setEdit({ name: '', kind: 'tractor', hourly_rate: 0 })}>Add machine</Button>}
        {record && <Button variant="primary" disabled={!season || !machines.some(m => m.active)} reason={!season ? 'Create a season first' : !machines.some(m => m.active) ? 'Add a machine first' : undefined} onClick={() => setRec({ season_id: season, kind: 'use', logged_on: today(), machine_id: machines.find(m => m.active)?.id })}>Log activity</Button>}</>} />
      {due.length > 0 && <Card className="p-3 mb-3 bg-amber-50 border-amber-200 text-amber-900 text-sm">Service due: {due.map(m => m.name).join(', ')}</Card>}
      {noFuel.length > 0 && manage && <Card className="p-3 mb-3 bg-blue-50 border-blue-200 text-blue-900 text-sm">No fuel product set for {noFuel.map(m => m.name).join(', ')}: their fuel is recorded without coming out of the store. Choose one with Edit so litres are drawn from stock and costed once.</Card>}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-4"><Stat label="Hours this season" value={fmt.num(hours, 1)} /><Stat label="Fuel (litres)" value={fmt.num(fuel, 0)} />{cost && <Stat label="Machinery cost" value={fmt.money(spend)} />}</div>
      <div className="flex gap-1 mb-3">{([['fleet', 'Fleet'], ['log', 'Activity log']] as const).map(([k, l]) => <Button key={k} small variant={tab === k ? 'primary' : 'secondary'} onClick={() => setTab(k)}>{l}</Button>)}</div>

      {tab === 'fleet' && <Card><Table head={['Machine', 'Type', { label: 'Hours', right: true }, { label: 'Fuel L', right: true }, { label: 'L/hr', right: true }, ...(cost ? [{ label: 'Cost', right: true }, { label: 'Cost/hr', right: true }] : []), 'Service', '']} empty="No machines registered yet.">
        {machines.map(m => <tr key={m.id} {...focus.row(m.id, m.active ? '' : 'text-gray-500')}><Td className="font-medium">{m.name}{!m.active && <span className="ml-1 text-xs">(inactive)</span>}<div className="text-xs text-gray-500 font-normal">{[m.make_model, m.reg_no, m.fuel_name && `fuel: ${m.fuel_name}`].filter(Boolean).join(' · ')}</div></Td><Td className="capitalize">{m.kind}</Td>
          <Td right>{fmt.num(m.total_hours, 1)}</Td><Td right>{fmt.num(m.fuel_l, 0)}</Td><Td right>{fmt.num(m.l_per_hour, 1)}</Td>{cost && <><Td right>{fmt.money(m.cost)}</Td><Td right>{fmt.money(m.cost_per_hour)}</Td></>}
          <Td>{m.service_interval_hours == null ? '—' : m.service_due ? <Badge tone="red">due</Badge> : <Badge tone="green">{fmt.num(m.hours_since_service, 0)}/{fmt.num(m.service_interval_hours, 0)} h</Badge>}{m.last_service_on && <div className="text-xs text-gray-500">last {fmt.date(m.last_service_on)}</div>}</Td>
          <Td className="text-right whitespace-nowrap">{manage && <Button small onClick={() => setEdit({ ...m, active: !!m.active })}>Edit</Button>}</Td></tr>)}</Table></Card>}

      {tab === 'log' && <Card><Table head={['Date', 'Machine', 'Type', 'Field', { label: 'Hours', right: true }, { label: 'Fuel L', right: true }, ...(cost ? [{ label: 'Cost', right: true }] : []), 'Notes', '']} empty="No machine activity this season.">
        {logs.map(l => <tr key={l.id}><Td>{fmt.date(l.logged_on)}</Td><Td className="font-medium">{l.machine}</Td><Td className="capitalize">{l.kind}</Td><Td><RecLink kind="field" code={l.field_no} /></Td><Td right>{fmt.num(l.hours, 1)}</Td><Td right>{fmt.num(l.fuel_l, 0)}</Td>
          {cost && <Td right>{fmt.money(l.cost)}</Td>}<Td>{l.description ?? ''}{l.operator ? <span className="text-gray-500"> · {l.operator}</span> : null}
            {(l.fuel_l ?? 0) > 0 && <div className="text-xs text-gray-500">{l.fuel_name ? `from ${l.fuel_name}` : 'fuel not from the store'}</div>}{l.operation && <div className="text-xs text-gray-500">part of {l.operation}</div>}</Td>
          <Td className="text-right">{record && <Button small variant="danger" onClick={() => { if (window.confirm('Delete this entry and its cost?')) void run(() => deleteMachineLog(ctx, l.id), 'Entry deleted') }}>Delete</Button>}</Td></tr>)}</Table></Card>}

      {edit && <Modal title={edit.id ? `Edit ${edit.name}` : 'Add machine'} onClose={() => setEdit(null)} wide>
        <form className="space-y-3" onSubmit={async e => { e.preventDefault(); if (await run(() => edit.id ? updateMachine(ctx, edit.id, edit) : createMachine(ctx, edit), edit.id ? 'Machine updated' : 'Machine added')) setEdit(null) }}>
          <Grid cols={3}>
            <Label text="Name"><Input value={edit.name} onChange={e => setEdit({ ...edit, name: e.target.value })} required autoFocus /></Label>
            <Label text="Type"><Select value={edit.kind ?? 'tractor'} onChange={e => setEdit({ ...edit, kind: e.target.value as MachineInput['kind'] })}>{MACHINE_KINDS.map(k => <option key={k}>{k}</option>)}</Select></Label>
            <Label text="Make / model"><Input value={edit.make_model ?? ''} onChange={e => setEdit({ ...edit, make_model: e.target.value })} /></Label>
            <Label text="Registration"><Input value={edit.reg_no ?? ''} onChange={e => setEdit({ ...edit, reg_no: e.target.value })} /></Label>
            <Label text="Hourly charge rate" hint="Used to cost 'use' logs"><NumberInput step="any" min={0} value={edit.hourly_rate} onChange={n => setEdit({ ...edit, hourly_rate: n ?? 0 })} /></Label>
            <Label text="Service every (hours)"><NumberInput step="any" min={1} value={edit.service_interval_hours ?? undefined} onChange={n => setEdit({ ...edit, service_interval_hours: n ?? null })} /></Label>
            <Label text="Purchased on"><Input type="date" value={edit.purchased_on ?? ''} onChange={e => setEdit({ ...edit, purchased_on: e.target.value || null })} /></Label>
            <Label text="Purchase cost"><NumberInput step="any" min={0} value={edit.purchase_cost ?? undefined} onChange={n => setEdit({ ...edit, purchase_cost: n ?? null })} /></Label>
            {fuels.length > 0 && <Label text="Fuel product" hint="Fuel this machine uses is drawn from this stock"><Select value={edit.fuel_input_id ?? ''} onChange={e => setEdit({ ...edit, fuel_input_id: e.target.value || null })}><option value="">None (not from the store)</option>{fuels.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}</Select></Label>}
            <label className="flex items-center gap-2 pt-6"><input type="checkbox" checked={edit.active !== false} onChange={e => setEdit({ ...edit, active: e.target.checked })} />Active</label>
          </Grid>
          <div className="flex justify-between gap-2"><div>{edit.id && <Button type="button" variant="danger" onClick={() => { if (window.confirm('Delete this machine?')) void run(() => deleteMachine(ctx, edit.id!), 'Machine deleted').then(ok => ok && setEdit(null)) }}>Delete</Button>}</div>
            <div className="flex gap-2"><Button type="button" onClick={() => setEdit(null)}>Cancel</Button><Button variant="primary" type="submit">Save</Button></div></div>
        </form></Modal>}

      {rec && <Modal title="Log machine activity" onClose={() => setRec(null)}>
        <form className="space-y-3" onSubmit={async e => { e.preventDefault(); const r = { ...rec } as MachineLogInput; if (!litresKind) { delete r.input_id; r.fuel_l = null } if (litresKind && recFuel) delete r.cost
          if (await run(() => logMachine(ctx, r), 'Activity logged')) setRec(null) }}>
          <Grid>
            <Label text="Machine"><Select value={rec.machine_id ?? ''} onChange={e => setRec({ ...rec, machine_id: e.target.value, input_id: undefined })}>{machines.filter(m => m.active).map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</Select></Label>
            <Label text="What happened"><Select value={rec.kind} onChange={e => setRec({ ...rec, kind: e.target.value as LogKind })}>{LOG_KINDS.map(k => <option key={k}>{k}</option>)}</Select></Label>
            <Label text="Date"><Input type="date" value={rec.logged_on ?? ''} onChange={e => setRec({ ...rec, logged_on: e.target.value })} required /></Label>
            <Label text="Field (optional)"><Select value={rec.field_id ?? ''} onChange={e => setRec({ ...rec, field_id: e.target.value || null })}><option value="">—</option>{fields.map(f => <option key={f.id} value={f.id}>{f.field_no}</option>)}</Select></Label>
            {(rec.kind === 'use') && <Label text="Hours"><NumberInput step="any" min={0} value={rec.hours ?? undefined} onChange={n => setRec({ ...rec, hours: n ?? null })} /></Label>}
            {litresKind && <Label text={rec.kind === 'use' ? 'Fuel used (L, optional)' : 'Litres'}><NumberInput step="any" min={0} value={rec.fuel_l ?? undefined} onChange={n => setRec({ ...rec, fuel_l: n ?? null })} /></Label>}
            {litresKind && (rec.fuel_l ?? 0) > 0 && !fuels.length && <p className="text-sm text-gray-600 sm:pt-6">{recMachine?.fuel_name ? `Drawn from ${recMachine.fuel_name} in the store.` : 'Not from the store (this machine has no fuel product).'}</p>}
            {litresKind && (rec.fuel_l ?? 0) > 0 && fuels.length > 0 && <Label text="Fuel from"><Select value={recFuel ?? '__outside'} onChange={e => setRec({ ...rec, input_id: e.target.value === '__outside' ? null : e.target.value })}>
              {fuels.map(f => <option key={f.id} value={f.id}>{f.name} (store, {fmt.num(f.on_hand, 0)} {f.unit} on hand)</option>)}<option value="__outside">Bought outside the store</option></Select></Label>}
            {cost && (rec.kind === 'service' || rec.kind === 'repair' || (rec.kind === 'fuel' && !recFuel)) && <Label text="Cost"><NumberInput step="any" min={0} value={rec.cost} onChange={n => setRec({ ...rec, cost: n })} /></Label>}
          </Grid>
          {litresKind && (rec.fuel_l ?? 0) > 0 && recFuel && <p className="text-xs text-gray-600">The litres come out of stock and are costed at the store's average price.</p>}
          {(rec.kind === 'service' || rec.kind === 'repair') && <Label text="Work done"><Input value={rec.description ?? ''} onChange={e => setRec({ ...rec, description: e.target.value })} required /></Label>}
          <div className="flex justify-end gap-2"><Button type="button" onClick={() => setRec(null)}>Cancel</Button><Button variant="primary" type="submit">Save</Button></div>
        </form></Modal>}
    </>
  )
}
