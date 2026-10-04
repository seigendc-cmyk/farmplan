import { useState, type ReactNode } from 'react'
import { OPERATION_TYPES, recordOperation } from '../services/operations'
import { recordWeather, WEATHER_EVENTS } from '../services/weather'
import { recordHarvest } from '../services/harvest'
import { recordLabour } from '../services/labour'
import { listMachines, logMachine } from '../services/machinery'
import { listFields } from '../services/fields'
import { listInputs } from '../services/inventory'
import { activeSeason } from '../services/seasons'
import { can } from '../services/context'
import { deviceLabel, deviceTag } from '../services/device'
import { syncWithCloud } from '../services/devices'
import { hubUrl, isHubPaired, setHubUrl, syncViaHub } from '../services/lan'
import { loadCloudConfig } from '../lib/cloud'
import { useApp, useToasts } from '../store/app'
import { useCtx, useData, useRun, fmt, today } from '../ui/hooks'
import { Button, Input, Label, NumberInput, Select, Textarea } from '../ui/kit'

type Screen = 'machine' | 'fertilizer' | 'chemical' | 'work' | 'rain' | 'observe' | 'harvest' | 'labour' | 'sync'
const big = 'w-full text-base py-3'

function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="fixed inset-0 z-30 bg-white overflow-y-auto" role="dialog" aria-label={title}>
      <div className="sticky top-0 bg-brand-700 text-white px-4 py-3 flex items-center justify-between"><h2 className="font-semibold text-lg">{title}</h2>
        <button onClick={onClose} aria-label="Close" className="text-2xl leading-none px-2">×</button></div>
      <div className="p-4 max-w-lg mx-auto space-y-4 text-base">{children}</div>
    </div>
  )
}

export default function FieldTerminal() {
  const ctx = useCtx(); const run = useRun(); const push = useToasts(s => s.push); const bump = useApp(s => s.bump); const setFieldMode = useApp(s => s.setFieldMode)
  const signOut = useApp(s => s.signOut); const rev = useApp(s => s.rev)
  const [screen, setScreen] = useState<Screen | null>(null)
  const season = useData(c => activeSeason(c)); const tag = deviceTag(ctx.db)
  const pending = ctx.db.pendingSync(); void rev
  const recent = useData(c => c.db.all<{ seq: number; at: string; action: string }>(`SELECT seq, at, action FROM audit_log WHERE actor=? AND action IN ('operation.record','weather.record','harvest.record','labour.record','machine.log') ORDER BY seq DESC LIMIT 8`, [c.actor?.id ?? '']), []) ?? []
  const close = () => setScreen(null)
  const tile = (key: Screen, label: string, sub: string, perm: string) => can(ctx, perm) &&
    <button key={key} onClick={() => setScreen(key)} className="bg-white border-2 border-brand-200 active:bg-brand-50 rounded-xl p-4 text-left shadow-sm"><div className="text-lg font-semibold text-brand-800">{label}</div><div className="text-sm text-gray-500">{sub}</div></button>

  return (
    <div className="min-h-full bg-gray-50">
      <header className="bg-brand-700 text-white px-4 py-3 flex items-center justify-between">
        <div><div className="font-semibold leading-tight">farmPLAN Field</div><div className="text-xs text-brand-100">{ctx.actor?.name}{tag ? ` · device ${tag}${deviceLabel(ctx.db) ? ` (${deviceLabel(ctx.db)})` : ''}` : ''}</div></div>
        <div className="flex gap-2 items-center">{!tag && <Button small onClick={() => setFieldMode(false)}>Full app</Button>}<Button small onClick={signOut}>Sign out</Button></div>
      </header>
      <main className="p-4 max-w-lg mx-auto space-y-4">
        <div className="text-sm text-gray-600">{season ? <>Season <b>{season.label}</b></> : <span className="text-amber-700">No active season — ask the office to activate one before recording.</span>}</div>
        <div className="grid grid-cols-2 gap-3">
          {tile('fertilizer', 'Fertilizer', 'Apply and deduct stock', 'production.operation.record')}
          {tile('chemical', 'Chemical', 'Spray, pest control', 'production.operation.record')}
          {tile('work', 'Field work', 'Weeding, topping…', 'production.operation.record')}
          {tile('harvest', 'Harvest', 'Green leaf weight', 'production.harvest.record')}
          {tile('rain', 'Rainfall', 'Millimetres', 'production.weather.record')}
          {tile('observe', 'Observation', 'Scouting, hail, frost', 'production.weather.record')}
          {tile('labour', 'Labour', 'Who worked, how long', 'resources.labour.record')}
          {tile('machine', 'Machine', 'Tractor hours, fuel', 'resources.machinery.record')}
        </div>
        <button onClick={() => setScreen('sync')} className={`w-full rounded-xl p-4 font-semibold text-lg border-2 ${pending ? 'bg-amber-50 border-amber-300 text-amber-900' : 'bg-white border-gray-200 text-gray-700'}`}>
          {pending ? `Sync now — ${pending} record${pending > 1 ? 's' : ''} waiting` : 'Sync now — all saved'}</button>
        {recent.length > 0 && <div><h3 className="text-sm font-medium text-gray-500 mb-1">Your recent captures</h3><ul className="text-sm divide-y bg-white rounded-lg border">{recent.map(r => <li key={r.seq} className="px-3 py-2 flex justify-between"><span>{r.action.replace('.record', '').replace('machine.log', 'machine')}</span><span className="text-gray-500">{r.at.slice(5, 16)}</span></li>)}</ul></div>}
      </main>

      {(screen === 'fertilizer' || screen === 'chemical' || screen === 'work') && season && <OperationSheet kind={screen} seasonId={season.id} onClose={close} />}
      {screen === 'harvest' && season && <HarvestSheet seasonId={season.id} onClose={close} />}
      {screen === 'rain' && <WeatherSheet mode="rain" seasonId={season?.id} onClose={close} />}
      {screen === 'observe' && <WeatherSheet mode="observe" seasonId={season?.id} onClose={close} />}
      {screen === 'machine' && season && <MachineSheet seasonId={season.id} onClose={close} />}
      {screen === 'labour' && season && <LabourSheet seasonId={season.id} onClose={close} />}
      {screen === 'sync' && <SyncSheet onClose={close} onDone={() => { bump(); push('ok', 'Synced') }} />}
      {(screen && !season && screen !== 'sync' && screen !== 'rain' && screen !== 'observe') && <Sheet title="No active season" onClose={close}><p>Ask the office to activate a season before recording this.</p></Sheet>}
    </div>
  )

  function FieldPick({ value, onChange, optional }: { value: string; onChange: (v: string) => void; optional?: boolean }) {
    const fields = useData(c => can(c, 'production.field.view') ? listFields(c) : []) ?? []
    return <Label text={optional ? 'Field (optional)' : 'Field'}><Select value={value} onChange={e => onChange(e.target.value)} required={!optional} className={big}><option value="">{optional ? '— none —' : 'Choose field'}</option>{fields.map(f => <option key={f.id} value={f.id}>{f.field_no} ({f.area_ha} ha)</option>)}</Select></Label>
  }

  function OperationSheet({ kind, seasonId, onClose }: { kind: 'fertilizer' | 'chemical' | 'work'; seasonId: string; onClose: () => void }) {
    const types = kind === 'fertilizer' ? ['Fertilizing'] : kind === 'chemical' ? ['Spraying', 'Pest scouting', 'Disease scouting'] : OPERATION_TYPES.field.filter(t => !['Fertilizing', 'Spraying'].includes(t))
    const cat = kind === 'fertilizer' ? 'fertilizer' : kind === 'chemical' ? 'chemical' : null
    const inputs = (useData(c => can(c, 'resources.inventory.view') ? listInputs(c) : []) ?? []).filter(i => i.active && (!cat || i.category === cat))
    const [fieldId, setFieldId] = useState(''); const [op, setOp] = useState(types[0]); const [date, setDate] = useState(today())
    const [lines, setLines] = useState<{ input_id: string; qty?: number }[]>(kind === 'work' ? [] : [{ input_id: '' }]); const [note, setNote] = useState('')
    return (
      <Sheet title={kind === 'fertilizer' ? 'Fertilizer' : kind === 'chemical' ? 'Chemical' : 'Field work'} onClose={onClose}>
        <form className="space-y-4" onSubmit={async e => { e.preventDefault()
          if (await run(() => recordOperation(ctx, { target: { type: 'field', id: fieldId }, season_id: seasonId, op_type: op, occurred_on: date, operator: ctx.actor?.name, remarks: note || undefined,
            inputs: lines.filter(l => l.input_id && l.qty).map(l => ({ input_id: l.input_id, qty: l.qty! })) }), 'Saved on this device')) onClose() }}>
          <FieldPick value={fieldId} onChange={setFieldId} />
          {types.length > 1 && <Label text="Work done"><Select value={op} onChange={e => setOp(e.target.value)} className={big}>{types.map(t => <option key={t}>{t}</option>)}</Select></Label>}
          <Label text="Date"><Input type="date" value={date} onChange={e => setDate(e.target.value)} className={big} required /></Label>
          {kind !== 'work' && lines.map((l, i) => (
            <div key={i} className="grid grid-cols-[1fr_7rem] gap-2">
              <Label text="Product"><Select value={l.input_id} onChange={e => setLines(lines.map((x, j) => j === i ? { ...x, input_id: e.target.value } : x))} className={big}><option value="">Choose product</option>{inputs.map(p => <option key={p.id} value={p.id}>{p.name} — {fmt.num(p.on_hand, 1)} {p.unit} left</option>)}</Select></Label>
              <Label text="Quantity"><NumberInput value={l.qty} step="any" min={0} onChange={n => setLines(lines.map((x, j) => j === i ? { ...x, qty: n } : x))} className={big} /></Label>
            </div>))}
          {kind !== 'work' && <Button type="button" onClick={() => setLines([...lines, { input_id: '' }])}>+ Another product</Button>}
          <Label text="Notes"><Textarea value={note} onChange={e => setNote(e.target.value)} /></Label>
          <Button variant="primary" type="submit" className={big}>Save</Button>
        </form>
      </Sheet>)
  }

  function HarvestSheet({ seasonId, onClose }: { seasonId: string; onClose: () => void }) {
    const [fieldId, setFieldId] = useState(''); const [kg, setKg] = useState<number>(); const [priming, setPriming] = useState<number>(); const [pos, setPos] = useState(''); const [workers, setWorkers] = useState<number>(); const [date, setDate] = useState(today())
    return (
      <Sheet title="Harvest" onClose={onClose}>
        <form className="space-y-4" onSubmit={async e => { e.preventDefault()
          let code = ''
          if (await run(() => { code = recordHarvest(ctx, { field_id: fieldId, season_id: seasonId, harvested_on: date, green_weight_kg: kg ?? 0, priming, leaf_position: pos || undefined, labour_workers: workers }).code }, 'Saved on this device')) { push('ok', `Batch ${code}`); onClose() } }}>
          <FieldPick value={fieldId} onChange={setFieldId} />
          <Label text="Date"><Input type="date" value={date} onChange={e => setDate(e.target.value)} className={big} required /></Label>
          <Label text="Green weight (kg)"><NumberInput value={kg} step="any" min={0} onChange={setKg} className={big} required /></Label>
          <div className="grid grid-cols-2 gap-2"><Label text="Priming no."><NumberInput value={priming} min={1} onChange={setPriming} className={big} /></Label>
            <Label text="Leaf position"><Select value={pos} onChange={e => setPos(e.target.value)} className={big}><option value="">—</option>{['Lugs', 'Cutters', 'Leaf', 'Tips'].map(p => <option key={p}>{p}</option>)}</Select></Label></div>
          <Label text="Workers"><NumberInput value={workers} min={0} onChange={setWorkers} className={big} /></Label>
          <Button variant="primary" type="submit" className={big}>Save batch</Button>
        </form>
      </Sheet>)
  }

  function WeatherSheet({ mode, seasonId, onClose }: { mode: 'rain' | 'observe'; seasonId?: string; onClose: () => void }) {
    const [fieldId, setFieldId] = useState(''); const [mm, setMm] = useState<number>(); const [date, setDate] = useState(today()); const [event, setEvent] = useState<(typeof WEATHER_EVENTS)[number]>('none'); const [obs, setObs] = useState('')
    return (
      <Sheet title={mode === 'rain' ? 'Rainfall' : 'Observation'} onClose={onClose}>
        <form className="space-y-4" onSubmit={async e => { e.preventDefault()
          if (await run(() => recordWeather(ctx, { season_id: seasonId, field_id: fieldId || null, recorded_on: date, rainfall_mm: mode === 'rain' ? mm : undefined, event: mode === 'observe' ? event : 'none', observation: mode === 'observe' ? obs : undefined }), 'Saved on this device')) onClose() }}>
          <Label text="Date"><Input type="date" value={date} onChange={e => setDate(e.target.value)} className={big} required /></Label>
          <FieldPick value={fieldId} onChange={setFieldId} optional />
          {mode === 'rain' ? <Label text="Rainfall (mm)"><NumberInput value={mm} step="any" min={0} onChange={setMm} className={big} required /></Label> : <>
            <Label text="Event"><Select value={event} onChange={e => setEvent(e.target.value as typeof event)} className={big}>{WEATHER_EVENTS.map(x => <option key={x}>{x}</option>)}</Select></Label>
            <Label text="What did you see?"><Textarea value={obs} onChange={e => setObs(e.target.value)} rows={4} /></Label></>}
          <Button variant="primary" type="submit" className={big}>Save</Button>
        </form>
      </Sheet>)
  }

  function LabourSheet({ seasonId, onClose }: { seasonId: string; onClose: () => void }) {
    const [fieldId, setFieldId] = useState(''); const [worker, setWorker] = useState(''); const [task, setTask] = useState(''); const [hours, setHours] = useState<number>(); const [pay, setPay] = useState<number>(); const [date, setDate] = useState(today())
    const showPay = can(ctx, 'finance.cost.edit') || can(ctx, 'finance.cost.view')
    return (
      <Sheet title="Labour" onClose={onClose}>
        <form className="space-y-4" onSubmit={async e => { e.preventDefault()
          if (await run(() => recordLabour(ctx, { season_id: seasonId, field_id: fieldId || null, worked_on: date, worker_name: worker, task, hours, pay_amount: pay }), 'Saved on this device')) onClose() }}>
          <Label text="Worker name"><Input value={worker} onChange={e => setWorker(e.target.value)} className={big} required /></Label>
          <Label text="Task"><Input value={task} onChange={e => setTask(e.target.value)} className={big} placeholder="Weeding, reaping, stringing…" required /></Label>
          <FieldPick value={fieldId} onChange={setFieldId} optional />
          <div className={`grid gap-2 ${showPay ? 'grid-cols-2' : ''}`}><Label text="Hours"><NumberInput value={hours} step="any" min={0} onChange={setHours} className={big} /></Label>
            {showPay && <Label text="Pay"><NumberInput value={pay} step="any" min={0} onChange={setPay} className={big} /></Label>}</div>
          <Label text="Date"><Input type="date" value={date} onChange={e => setDate(e.target.value)} className={big} required /></Label>
          <Button variant="primary" type="submit" className={big}>Save</Button>
        </form>
      </Sheet>)
  }

  function MachineSheet({ seasonId, onClose }: { seasonId: string; onClose: () => void }) {
    const machines = (useData(c => listMachines(c)) ?? []).filter(m => m.active)
    const [machineId, setMachineId] = useState(machines[0]?.id ?? ''); const [kind, setKind] = useState<'use' | 'fuel'>('use'); const [fieldId, setFieldId] = useState('')
    const [hours, setHours] = useState<number>(); const [litres, setLitres] = useState<number>(); const [date, setDate] = useState(today())
    return (
      <Sheet title="Machine" onClose={onClose}>
        <form className="space-y-4" onSubmit={async e => { e.preventDefault()
          if (await run(() => logMachine(ctx, { machine_id: machineId, season_id: seasonId, kind, logged_on: date, field_id: fieldId || null, hours: kind === 'use' ? hours : null, fuel_l: kind === 'fuel' ? litres : null }), 'Saved on this device')) onClose() }}>
          <Label text="Machine"><Select value={machineId} onChange={e => setMachineId(e.target.value)} className={big} required><option value="">Choose machine</option>{machines.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</Select></Label>
          <Label text="What happened"><Select value={kind} onChange={e => setKind(e.target.value as 'use' | 'fuel')} className={big}><option value="use">Hours worked</option><option value="fuel">Fuel put in</option></Select></Label>
          {kind === 'use' ? <Label text="Hours"><NumberInput value={hours} step="any" min={0} onChange={setHours} className={big} required /></Label> : <Label text="Litres"><NumberInput value={litres} step="any" min={0} onChange={setLitres} className={big} required /></Label>}
          <FieldPick value={fieldId} onChange={setFieldId} optional />
          <Label text="Date"><Input type="date" value={date} onChange={e => setDate(e.target.value)} className={big} required /></Label>
          <Button variant="primary" type="submit" className={big}>Save</Button>
        </form>
      </Sheet>)
  }

  function SyncSheet({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
    const [cfg, setCfg] = useState(loadCloudConfig()); const [pw, setPw] = useState(''); const [busy, setBusy] = useState(false); const [msg, setMsg] = useState('')
    const paired = isHubPaired(ctx.db); const [addr, setAddr] = useState(hubUrl(ctx.db)); const [useCloud, setUseCloud] = useState(!paired)
    async function viaHub() {
      setBusy(true); setMsg('')
      try { setHubUrl(ctx.db, addr); const r = await syncViaHub(ctx.db, ctx.tenantId); if (r.errors.length) setMsg(`Failed: ${r.errors.join('; ')}`); else { setMsg(`Sent ${r.pushed}, received ${r.pulled}${r.quarantined ? `; ${r.quarantined} not accepted by the hub` : ''}.`); onDone() } }
      catch (x) { setMsg(x instanceof Error ? x.message : String(x)) } finally { setBusy(false) }
    }
    return (
      <Sheet title="Sync" onClose={onClose}>
        {paired && <div className="space-y-3 mb-4">
          <p className="text-gray-600 text-sm">Connect to the farm Wi-Fi, then sync with the office computer. No internet or password needed.</p>
          <Label text="Farm hub address"><Input value={addr} onChange={e => setAddr(e.target.value)} className={big} placeholder="192.168.1.20:7878" /></Label>
          <Button variant="primary" className={big} disabled={busy || !addr.trim()} onClick={() => void viaHub()}>{busy && !useCloud ? 'Syncing…' : 'Sync with farm hub'}</Button>
          {!useCloud && <button type="button" className="text-sm text-gray-500 underline" onClick={() => setUseCloud(true)}>Use the internet instead</button>}
          {msg && !useCloud && <p className="text-sm">{msg}</p>}
        </div>}
        {useCloud && <>
        <p className="text-gray-600 text-sm">Needs mobile data or Wi-Fi. Your records are safe on this phone until they have been sent.</p>
        <form className="space-y-4" onSubmit={async e => { e.preventDefault(); setBusy(true); setMsg('')
          try { const r = await syncWithCloud(ctx.db, ctx.tenantId, cfg, pw); if (r.errors.length) setMsg(`Failed: ${r.errors.join('; ')}`); else { setMsg(`Sent ${r.pushed}, received ${r.pulled}${r.quarantined ? `; ${r.quarantined} refused by the cloud` : ''}.`); onDone() } }
          catch (x) { setMsg(x instanceof Error ? x.message : String(x)) } finally { setBusy(false); setPw('') } }}>
          <Label text="Project URL"><Input value={cfg.url ?? ''} onChange={e => setCfg({ ...cfg, url: e.target.value })} className={big} required /></Label>
          <Label text="Publishable key"><Input value={cfg.key ?? ''} onChange={e => setCfg({ ...cfg, key: e.target.value })} className={big} required /></Label>
          <Label text="Email"><Input type="email" value={cfg.email ?? ''} onChange={e => setCfg({ ...cfg, email: e.target.value })} className={big} required /></Label>
          <Label text="Password"><Input type="password" value={pw} onChange={e => setPw(e.target.value)} className={big} required /></Label>
          <Button variant="primary" type="submit" disabled={busy} className={big}>{busy ? 'Syncing…' : 'Sync now'}</Button>
          {msg && <p className="text-sm">{msg}</p>}
        </form></>}
      </Sheet>)
  }
}
