import { useState } from 'react'
import { GRADING_TOLERANCE_PCT, createGrading, deleteGrade, deleteGrading, gradeMix, listGrades, listGrading, saveGrade, ungradedUnits, type Grade } from '../services/quality'
import { useCan, useCtx, useData, useRun, fmt, today } from '../ui/hooks'
import { useSeasonPicker } from '../ui/season'
import { RecLink, useFocus } from '../ui/links'
import { Badge, Button, Card, Denied, Grid, Input, Label, Modal, NumberInput, PageHeader, Stat, Table, Td, Textarea } from '../ui/kit'

interface Draft { storage_unit_id: string; graded_on: string; lines: Record<string, number | undefined>; waste_kg?: number; grader?: string; labour_cost?: number; variance_note?: string; notes?: string }

export default function Grading() {
  const ctx = useCtx(); const can = useCan(); const run = useRun()
  const focus = useFocus('lot'); const { sid, picker } = useSeasonPicker(focus.seasonId)
  const rows = useData(c => listGrading(c, sid || undefined), [sid]); const grades = useData(c => listGrades(c)) ?? []
  const waiting = useData(c => ungradedUnits(c)) ?? []; const mix = useData(c => sid ? gradeMix(c, sid) : null, [sid])
  const [draft, setDraft] = useState<Draft | null>(null); const [cat, setCat] = useState(false)
  if (!rows) return <Denied what="grading" />
  const record = can('quality.grading.record'); const showCost = can('finance.cost.view'); const active = grades.filter(g => g.active)
  const unit = waiting.find(u => u.id === draft?.storage_unit_id)
  const total = draft ? Object.values(draft.lines).reduce<number>((s, v) => s + (v ?? 0), 0) + (draft.waste_kg ?? 0) : 0
  const variance = unit ? Math.round((unit.weight_kg - total) * 100) / 100 : 0
  const outside = unit ? Math.abs(variance) > (unit.weight_kg * GRADING_TOLERANCE_PCT) / 100 : false

  async function save() {
    const d = draft!
    const outputs = Object.entries(d.lines).filter(([, w]) => w && w > 0).map(([grade_id, weight_kg]) => ({ grade_id, weight_kg: weight_kg! }))
    if (await run(() => createGrading(ctx, { storage_unit_id: d.storage_unit_id, graded_on: d.graded_on, outputs, waste_kg: d.waste_kg, grader: d.grader, labour_cost: d.labour_cost, variance_note: d.variance_note, notes: d.notes }), 'Grading recorded')) setDraft(null)
  }
  return (
    <>
      <PageHeader title="Grading" sub="Opened storage unit → grading lot → weight per grade" actions={<>{picker}
        {can('quality.grade.edit') && <Button onClick={() => setCat(true)}>Grade catalogue</Button>}
        {record && <Button variant="primary" disabled={!waiting.length || !active.length} reason={!active.length ? 'Add grades to the catalogue first' : !waiting.length ? 'No opened storage units are waiting' : undefined}
          onClick={() => setDraft({ storage_unit_id: waiting[0].id, graded_on: today(), lines: {} })}>Grade a unit</Button>}</>} />
      {!grades.length && <Card className="p-4 mb-4 border-amber-300 bg-amber-50 text-amber-900">The grade catalogue is empty. Add the grades your market uses under “Grade catalogue” — nothing is pre-set.</Card>}
      {waiting.length > 0 && <Card className="p-3 mb-4 border-blue-200 bg-blue-50 text-blue-900"><span className="font-medium">Waiting to be graded:</span> {waiting.map((u, i) => <span key={u.id}>{i > 0 && ', '}<RecLink kind="storage" code={u.code} /> ({fmt.num(u.weight_kg, 1)} kg)</span>)}</Card>}
      {mix && mix.graded_input_kg > 0 && <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4"><Stat label="Graded" value={`${fmt.num(mix.graded_input_kg, 1)} kg`} sub={`waste ${mix.waste_pct ?? 0}%`} />
        {mix.grades.slice(0, 3).map(g => <Stat key={g.grade} label={`Grade ${g.grade}`} value={`${g.pct}%`} sub={`${fmt.num(g.kg, 1)} kg`} />)}</div>}
      <Card><Table head={['Lot', 'Unit', 'Date', { label: 'Input kg', right: true }, 'Grades', { label: 'Waste', right: true }, { label: 'Variance', right: true }, { label: 'Baled kg', right: true }, 'Grader', ...(showCost ? [{ label: 'Labour', right: true }] : []), '']} empty="Nothing graded this season.">
        {rows.map(r => <tr key={r.id} {...focus.row(r.code)}><Td className="font-medium">{r.code}</Td><Td><RecLink kind="storage" code={r.unit_code} /></Td><Td>{fmt.date(r.graded_on)}</Td><Td right>{fmt.num(r.input_kg, 1)}</Td>
          <Td>{r.outputs.map(o => `${o.grade} ${fmt.num(o.weight_kg, 1)}`).join(' · ')}</Td><Td right>{fmt.num(r.waste_kg, 1)}</Td>
          <Td right>{r.variance_flag ? <span title={r.variance_note ?? ''}><Badge tone="amber">{fmt.num(r.variance_kg, 1)} kg · {r.variance_pct}%</Badge></span> : fmt.num(r.variance_kg, 1)}</Td>
          <Td right>{fmt.num(r.baled_kg, 1)}</Td><Td>{r.grader ?? '—'}</Td>{showCost && <Td right>{fmt.money(r.labour_cost)}</Td>}
          <Td className="text-right">{record && r.baled_kg === 0 && <Button small variant="danger" onClick={() => { if (window.confirm(`Delete grading ${r.code}? The unit returns to the waiting list.`)) void run(() => deleteGrading(ctx, r.id), 'Grading deleted') }}>Delete</Button>}</Td></tr>)}</Table></Card>

      {draft && <Modal title="Grade a storage unit" onClose={() => setDraft(null)} wide>
        <form className="space-y-3" onSubmit={e => { e.preventDefault(); void save() }}>
          <Grid cols={3}>
            <Label text="Storage unit"><select className="w-full border border-gray-300 rounded-md px-2.5 py-1.5 bg-white" value={draft.storage_unit_id} onChange={e => setDraft({ ...draft, storage_unit_id: e.target.value, lines: {} })}>
              {waiting.map(u => <option key={u.id} value={u.id}>{u.code} ({fmt.num(u.weight_kg, 1)} kg)</option>)}</select></Label>
            <Label text="Grading date"><Input type="date" value={draft.graded_on} onChange={e => setDraft({ ...draft, graded_on: e.target.value })} required /></Label>
            <Label text="Grader"><Input value={draft.grader ?? ''} onChange={e => setDraft({ ...draft, grader: e.target.value })} /></Label>
          </Grid>
          <div className="font-medium">Weight per grade (kg)</div>
          <Grid cols={4}>{active.map(g => <Label key={g.id} text={`Grade ${g.code}`}><NumberInput step="0.1" min={0} value={draft.lines[g.id]} onChange={n => setDraft({ ...draft, lines: { ...draft.lines, [g.id]: n } })} /></Label>)}
            <Label text="Waste"><NumberInput step="0.1" min={0} value={draft.waste_kg} onChange={n => setDraft({ ...draft, waste_kg: n })} /></Label></Grid>
          <div className={`rounded-md px-3 py-2 text-sm ${outside ? 'bg-amber-50 border border-amber-300 text-amber-900' : 'bg-gray-50 border border-gray-200 text-gray-700'}`}>
            Input {fmt.num(unit?.weight_kg, 1)} kg · accounted for {fmt.num(total, 1)} kg · difference <b>{fmt.num(variance, 2)} kg</b>{outside && ` — more than ${GRADING_TOLERANCE_PCT}%: explain below`}</div>
          {(outside || draft.variance_note) && <Label text="Explanation of variance"><Textarea value={draft.variance_note ?? ''} onChange={e => setDraft({ ...draft, variance_note: e.target.value })} /></Label>}
          {showCost && <Label text="Labour cost"><NumberInput step="0.01" min={0} value={draft.labour_cost} onChange={n => setDraft({ ...draft, labour_cost: n })} /></Label>}
          <div className="flex justify-end gap-2"><Button type="button" onClick={() => setDraft(null)}>Cancel</Button><Button variant="primary" type="submit">Save grading</Button></div>
        </form></Modal>}
      {cat && <Catalogue onClose={() => setCat(false)} />}
    </>
  )
}

function Catalogue({ onClose }: { onClose: () => void }) {
  const ctx = useCtx(); const run = useRun(); const grades = useData(c => listGrades(c)) ?? []
  const [n, setN] = useState<{ code: string; name: string; sort_order?: number }>({ code: '', name: '' })
  const toggle = (g: Grade) => run(() => saveGrade(ctx, { code: g.code, name: g.name, sort_order: g.sort_order, active: !g.active, notes: g.notes }, g.id))
  return (
    <Modal title="Grade catalogue" onClose={onClose}>
      <p className="text-sm text-gray-500 mb-3">Grades are configuration, not code. Enter the classifications your buyers or floor currently use and retire them when they change.</p>
      <Table head={['Order', 'Code', 'Name', 'Status', '']} empty="No grades yet.">
        {grades.map(g => <tr key={g.id}><Td>{g.sort_order}</Td><Td className="font-medium">{g.code}</Td><Td>{g.name ?? '—'}</Td><Td>{g.active ? <Badge tone="green">active</Badge> : <Badge>retired</Badge>}</Td>
          <Td className="text-right space-x-1"><Button small onClick={() => void toggle(g)}>{g.active ? 'Retire' : 'Reactivate'}</Button>
            <Button small variant="danger" onClick={() => void run(() => deleteGrade(ctx, g.id), 'Grade deleted')}>Delete</Button></Td></tr>)}</Table>
      <form className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-3 items-end" onSubmit={e => { e.preventDefault(); void run(() => saveGrade(ctx, { ...n, sort_order: n.sort_order ?? grades.length + 1 }), 'Grade added').then(ok => ok && setN({ code: '', name: '' })) }}>
        <Label text="Code"><Input value={n.code} onChange={e => setN({ ...n, code: e.target.value })} required /></Label>
        <Label text="Name"><Input value={n.name} onChange={e => setN({ ...n, name: e.target.value })} /></Label>
        <Label text="Order"><NumberInput value={n.sort_order} onChange={v => setN({ ...n, sort_order: v })} /></Label>
        <Button variant="primary" type="submit">Add grade</Button></form>
    </Modal>
  )
}
