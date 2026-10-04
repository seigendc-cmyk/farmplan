import { useState } from 'react'
import { OPERATION_TYPES, deleteOperation, listOperations, recordOperation, type OperationInput } from '../services/operations'
import { listFields } from '../services/fields'
import { listSeedbeds } from '../services/seedbeds'
import { listSeasons } from '../services/seasons'
import { listInputs } from '../services/inventory'
import { useCan, useCtx, useData, useRun, fmt, today } from '../ui/hooks'
import { Button, Card, Denied, Grid, Input, Label, Modal, NumberInput, PageHeader, Select, Table, Td, Textarea } from '../ui/kit'
import { RecLink } from '../ui/links'

interface Target { type: 'seedbed' | 'field'; id: string; label: string }

export function RecordOperation({ target, seasonId, onClose }: { target?: Target; seasonId?: string; onClose: () => void }) {
  const ctx = useCtx(); const can = useCan(); const run = useRun()
  const seasons = useData(c => listSeasons(c)) ?? []
  const fields = useData(c => can('production.field.view') ? listFields(c) : []) ?? []
  const seedbeds = useData(c => can('production.seedbed.view') ? listSeedbeds(c) : []) ?? []
  const inputs = (useData(c => can('resources.inventory.view') ? listInputs(c) : []) ?? []).filter(i => i.active)
  const [tType, setTType] = useState<'seedbed' | 'field'>(target?.type ?? 'field')
  const [tId, setTId] = useState(target?.id ?? '')
  const [season, setSeason] = useState(seasonId ?? seasons.find(s => s.status === 'active')?.id ?? '')
  const [phase, setPhase] = useState<'land_prep' | 'field'>('field')
  const [f, setF] = useState<Partial<OperationInput>>({ occurred_on: today(), op_type: '' })
  const [lines, setLines] = useState<{ input_id: string; qty?: number; rate_note?: string }[]>([])
  const effType = target?.type ?? tType
  const types = effType === 'seedbed' ? OPERATION_TYPES.seedbed : OPERATION_TYPES[phase]
  const showCost = can('finance.cost.edit')
  const set = <K extends keyof OperationInput>(k: K, v: OperationInput[K] | undefined) => setF(p => ({ ...p, [k]: v }))
  const options = effType === 'seedbed' ? seedbeds.map(s => ({ id: s.id, label: `${s.code} (${s.season_label})` })) : fields.map(x => ({ id: x.id, label: `Field ${x.field_no}` }))

  async function submit() {
    const ok = await run(() => recordOperation(ctx, {
      ...(f as OperationInput), target: { type: effType, id: target?.id ?? tId }, season_id: effType === 'field' ? season : undefined,
      phase: effType === 'field' ? phase : undefined,
      inputs: lines.filter(l => l.input_id && l.qty).map(l => ({ input_id: l.input_id, qty: l.qty!, rate_note: l.rate_note })) }), 'Operation recorded')
    if (ok) onClose()
  }
  return (
    <Modal title={target ? `Record operation — ${target.label}` : 'Record operation'} onClose={onClose} wide>
      <form className="space-y-4" onSubmit={e => { e.preventDefault(); void submit() }}>
        {!target && <Grid cols={3}>
          <Label text="Applies to"><Select value={tType} onChange={e => { setTType(e.target.value as 'seedbed' | 'field'); setTId(''); set('op_type', '') }}><option value="field">Field</option><option value="seedbed">Seedbed</option></Select></Label>
          <Label text={tType === 'field' ? 'Field' : 'Seedbed'}><Select value={tId} onChange={e => setTId(e.target.value)} required><option value="">Select…</option>{options.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}</Select></Label>
          {tType === 'field' && <Label text="Season"><Select value={season} onChange={e => setSeason(e.target.value)} required>{seasons.filter(s => s.status !== 'closed').map(s => <option key={s.id} value={s.id}>{s.label}</option>)}</Select></Label>}
        </Grid>}
        {target?.type === 'field' && <Label text="Season"><Select value={season} onChange={e => setSeason(e.target.value)} required>{seasons.filter(s => s.status !== 'closed').map(s => <option key={s.id} value={s.id}>{s.label}</option>)}</Select></Label>}
        <Grid cols={3}>
          {effType === 'field' && <Label text="Stage"><Select value={phase} onChange={e => { setPhase(e.target.value as 'land_prep' | 'field'); set('op_type', '') }}><option value="land_prep">Land preparation</option><option value="field">Field operation</option></Select></Label>}
          <Label text="Operation"><Select value={f.op_type} onChange={e => set('op_type', e.target.value)} required><option value="">Select…</option>{types.map(t => <option key={t}>{t}</option>)}</Select></Label>
          <Label text="Date"><Input type="date" value={f.occurred_on} onChange={e => set('occurred_on', e.target.value)} required /></Label>
          {effType === 'field' && <Label text="Area covered (ha)"><NumberInput step="0.01" value={f.area_ha} onChange={n => set('area_ha', n)} /></Label>}
        </Grid>

        <fieldset className="border border-gray-200 rounded-md p-3"><legend className="px-1 text-xs font-medium text-gray-600">Inputs used (deducted from stock)</legend>
          {lines.map((l, i) => {
            const inp = inputs.find(x => x.id === l.input_id)
            return (<div key={i} className="grid grid-cols-12 gap-2 mb-2">
              <div className="col-span-12 sm:col-span-5"><Select value={l.input_id} onChange={e => setLines(lines.map((x, j) => j === i ? { ...x, input_id: e.target.value } : x))}><option value="">Product…</option>
                {inputs.map(p => <option key={p.id} value={p.id}>{p.name} — {fmt.num(p.on_hand, 2)} {p.unit} on hand</option>)}</Select></div>
              <div className="col-span-5 sm:col-span-2"><NumberInput placeholder={inp?.unit ?? 'Qty'} step="0.01" value={l.qty} onChange={n => setLines(lines.map((x, j) => j === i ? { ...x, qty: n } : x))} /></div>
              <div className="col-span-6 sm:col-span-4"><Input placeholder="Rate / label reference" value={l.rate_note ?? ''} onChange={e => setLines(lines.map((x, j) => j === i ? { ...x, rate_note: e.target.value } : x))} /></div>
              <div className="col-span-1"><Button type="button" variant="ghost" onClick={() => setLines(lines.filter((_, j) => j !== i))} aria-label="Remove line">×</Button></div></div>)
          })}
          <Button type="button" small onClick={() => setLines([...lines, { input_id: '' }])}>+ Add input</Button>
          <p className="text-xs text-gray-500 mt-2">Rates must follow the product label and your approved agronomic protocol; the system records what was applied, it does not prescribe rates.</p>
        </fieldset>

        <Grid cols={4}>
          <Label text="Workers"><NumberInput value={f.labour_workers} onChange={n => set('labour_workers', n)} /></Label>
          <Label text="Labour hours"><NumberInput step="0.5" value={f.labour_hours} onChange={n => set('labour_hours', n)} /></Label>
          {showCost && <Label text="Labour cost"><NumberInput step="0.01" value={f.labour_cost} onChange={n => set('labour_cost', n)} /></Label>}
          <Label text="Operator"><Input value={f.operator ?? ''} onChange={e => set('operator', e.target.value)} /></Label>
        </Grid>
        {effType === 'field' && <Grid cols={4}>
          <Label text="Tractor / equipment"><Input value={f.machinery_asset ?? ''} onChange={e => set('machinery_asset', e.target.value)} /></Label>
          <Label text="Machine hours"><NumberInput step="0.1" value={f.machinery_hours} onChange={n => set('machinery_hours', n)} /></Label>
          <Label text="Fuel used (L)"><NumberInput step="0.1" value={f.machinery_fuel_l} onChange={n => set('machinery_fuel_l', n)} /></Label>
          {showCost && <Label text="Machinery cost"><NumberInput step="0.01" value={f.machinery_cost} onChange={n => set('machinery_cost', n)} /></Label>}
        </Grid>}
        <Grid><Label text="Weather"><Input value={f.weather ?? ''} onChange={e => set('weather', e.target.value)} placeholder="e.g. dry, 28°C" /></Label>
          <Label text="Remarks"><Textarea value={f.remarks ?? ''} onChange={e => set('remarks', e.target.value)} /></Label></Grid>
        <div className="flex justify-end gap-2"><Button type="button" onClick={onClose}>Cancel</Button><Button variant="primary" type="submit">Record operation</Button></div>
      </form>
    </Modal>
  )
}

export default function Operations() {
  const ctx = useCtx(); const can = useCan(); const run = useRun()
  const seasons = useData(c => listSeasons(c)) ?? []
  const [seasonId, setSeasonId] = useState(''); const [type, setType] = useState<'' | 'seedbed' | 'field'>('')
  const rows = useData(c => listOperations(c, { seasonId: seasonId || undefined, targetType: undefined }), [seasonId])
  const [open, setOpen] = useState(false)
  if (!rows) return <Denied what="operations" />
  const shown = type ? rows.filter(r => r.target_type === type) : rows
  const showCost = can('finance.cost.view')
  return (
    <>
      <PageHeader title="Operations diary" sub="Every activity is a transaction: it deducts stock and creates cost."
        actions={<>
          <Select value={seasonId} onChange={e => setSeasonId(e.target.value)} className="w-36"><option value="">All seasons</option>{seasons.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}</Select>
          <Select value={type} onChange={e => setType(e.target.value as '' | 'seedbed' | 'field')} className="w-32"><option value="">All</option><option value="seedbed">Seedbeds</option><option value="field">Fields</option></Select>
          {can('production.operation.record') && <Button variant="primary" onClick={() => setOpen(true)}>Record operation</Button>}</>} />
      <Card><Table head={['Date', 'Season', 'Target', 'Operation', 'Inputs', 'Operator', ...(showCost ? [{ label: 'Cost', right: true }] : []), 'Remarks', '']} empty="No operations recorded.">
        {shown.map(o => (<tr key={o.id} className="hover:bg-gray-50"><Td>{fmt.date(o.occurred_on)}</Td><Td>{o.season_label}</Td><Td className="font-medium">{o.target_type === 'field' ? <>Field <RecLink kind="field" code={o.target_code} /></> : o.target_code}</Td>
          <Td>{o.op_type}</Td><Td className="max-w-xs">{o.inputs || '—'}</Td><Td>{o.operator ?? '—'}</Td>{showCost && <Td right>{fmt.money(o.cost)}</Td>}<Td className="max-w-xs">{o.remarks ?? ''}</Td>
          <Td className="text-right">{can('production.operation.delete') && <Button small variant="danger" onClick={() => confirm('Delete this operation? Stock and costs will be reversed.') && run(() => deleteOperation(ctx, o.id), 'Operation reversed')}>Delete</Button>}</Td></tr>))}
      </Table></Card>
      {open && <RecordOperation onClose={() => setOpen(false)} />}
    </>
  )
}
