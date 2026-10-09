import { useState } from 'react'
import { stagesOf } from '../modules/stages'
import { advanceProject, backProject, editProjectNotes, listProjects, projectHistory, type ProjectRow } from '../services/projects'
import { useCan, useCtx, useData, useRun, fmt } from '../ui/hooks'
import { Badge, Button, Card, Denied, Grid, Label, Modal, NumberInput, PageHeader, Stat, Table, Td, Textarea } from '../ui/kit'
import { planSummary, setPlan } from '../services/budgetplan'

export default function Pipeline() {
  const ctx = useCtx(); const can = useCan(); const run = useRun()
  const projects = useData(c => listProjects(c)); const [openId, setOpenId] = useState<string | null>(null)
  if (!projects) return <Denied what="the project pipeline" />
  const open = projects.find(p => p.id === openId) ?? null
  return (
    <>
      <PageHeader title="Pipeline" sub="Every season is a project that moves through stages, from the first idea to a closed season." />
      <Card><Table head={['Project', 'Stage', 'Since', 'Next step']} empty="No projects yet. Creating a season starts one.">
        {projects.map(p => (
          <tr key={p.id}>
            <Td><button type="button" className="font-medium text-left text-green-800 hover:underline" aria-label={`Open ${p.name}`} onClick={() => setOpenId(p.id)}>{p.name}</button></Td>
            <Td><Badge tone={p.stage === 'closed' ? 'gray' : 'green'}>{p.stage_label}</Badge></Td>
            <Td>{p.since ? fmt.date(p.since) : '—'}</Td>
            <Td>{nextText(p)}</Td>
          </tr>))}
      </Table></Card>
      {open && <ProjectModal p={open} onClose={() => setOpenId(null)} canAdvance={can('projects.stage.advance')} canOverride={can('projects.stage.override')} canEdit={can('projects.project.edit')}
        advance={(o) => run(() => advanceProject(ctx, open.id, o), 'Project moved')} back={(r) => run(() => backProject(ctx, open.id, r), 'Project moved back')}
        saveNotes={(n) => run(() => editProjectNotes(ctx, open.id, n), 'Notes saved')}
        savePlan={(i) => run(() => setPlan(ctx, open.id, i), 'Plan saved')} />}
    </>
  )
}

const nextText = (p: ProjectRow) => p.next === null ? 'Finished' : p.unmet.length ? p.unmet.join('; ') : 'Ready to move on'

function ProjectModal({ p, onClose, canAdvance, canOverride, canEdit, advance, back, saveNotes, savePlan }: {
  p: ProjectRow; onClose: () => void; canAdvance: boolean; canOverride: boolean; canEdit: boolean
  advance: (o: { to?: string; override?: boolean; reason?: string }) => Promise<unknown>; back: (reason: string) => Promise<unknown>; saveNotes: (n: string) => Promise<unknown>; savePlan: (i: { plan_ha: number | null; plan_yield_kg_ha: number | null; plan_price_kg: number | null }) => Promise<unknown>
}) {
  const cur = useData(c => c.db.get<{ currency: string }>(`SELECT currency FROM farms WHERE id=?`, [c.farmId])?.currency) ?? 'USD'
  const sum = useData(c => planSummary(c, p.id), [p.id, p.plan_ha, p.plan_yield_kg_ha, p.plan_price_kg])
  const [pl, setPl] = useState({ ha: p.plan_ha ?? undefined, y: p.plan_yield_kg_ha ?? undefined, price: p.plan_price_kg ?? undefined })
  const history = useData(c => projectHistory(c, p.id), [p.id, p.stage]) ?? []
  const stages = stagesOf(p.module); const idx = stages.findIndex(s => s.id === p.stage)
  const [reason, setReason] = useState(''); const [notes, setNotes] = useState(p.notes ?? '')
  const blocked = p.unmet.length > 0; const label = (id: string | null) => stages.find(s => s.id === id)?.label ?? ''
  return (
    <Modal title={p.name} onClose={onClose} wide>
      <ol className="flex flex-wrap gap-1 mb-3" aria-label="Stages">
        {stages.map((s, i) => <li key={s.id} aria-current={i === idx ? 'step' : undefined}
          className={`text-xs rounded px-2 py-1 border ${i === idx ? 'bg-green-700 text-white border-green-700' : i < idx ? 'bg-green-50 border-green-200 text-green-800' : 'border-gray-200 text-gray-500'}`}>{s.label}{s.optional ? ' (optional)' : ''}</li>)}
      </ol>
      <p className="text-sm text-gray-600 mb-2">{stages[idx]?.help}</p>
      {p.next && <p className="text-sm mb-2">{blocked ? <><strong>Before leaving {p.stage_label}:</strong> {p.unmet.join('; ')}.</> : <>Ready to move to <strong>{label(p.next)}</strong>.</>}</p>}
      {canAdvance && <div className="space-y-2 mb-3">
        {(blocked || p.skip_to) && <Label text={blocked ? (canOverride ? 'Reason (needed to move past an unmet requirement)' : 'Reason') : 'Reason (optional)'}><Textarea value={reason} onChange={e => setReason(e.target.value)} /></Label>}
        <div className="flex flex-wrap gap-2">
          {p.next && !blocked && <Button variant="primary" onClick={() => advance({ reason }).then(() => setReason(''))}>{`Move to ${label(p.next)}`}</Button>}
          {p.skip_to && !blocked && <Button onClick={() => advance({ to: p.skip_to!, reason }).then(() => setReason(''))}>{`Skip ${label(p.next)} — go to ${label(p.skip_to)}`}</Button>}
          {p.next && blocked && canOverride && <Button variant="danger" onClick={() => advance({ override: true, reason }).then(() => setReason(''))}>{`Override and move to ${label(p.next)}`}</Button>}
          {idx > 0 && <Button onClick={() => { if (!reason.trim()) { void back(''); return } void back(reason).then(() => setReason('')) }}>{`Back to ${label(stages[idx - 1].id)}`}</Button>}
        </div>
        {idx > 0 && !blocked && !p.skip_to && <p className="text-xs text-gray-500">Going back needs a reason.</p>}
      </div>}
      <h3 className="text-sm font-semibold mt-3 mb-1">Plan</h3>
      <Grid cols={3}>
        <Label text="Planned hectares"><NumberInput step="any" min={0} value={pl.ha} onChange={n => setPl({ ...pl, ha: n })} disabled={!canEdit} /></Label>
        <Label text="Expected yield (kg per ha)"><NumberInput step="any" min={0} value={pl.y} onChange={n => setPl({ ...pl, y: n })} disabled={!canEdit} /></Label>
        <Label text={`Expected price (${cur} per kg)`}><NumberInput step="any" min={0} value={pl.price} onChange={n => setPl({ ...pl, price: n })} disabled={!canEdit} /></Label>
      </Grid>
      {canEdit && <div className="mt-2"><Button small onClick={() => void savePlan({ plan_ha: pl.ha ?? null, plan_yield_kg_ha: pl.y ?? null, plan_price_kg: pl.price ?? null })}>Save plan</Button></div>}
      {sum && <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 mt-3" aria-label="Plan summary">
        <Stat label="Expected crop" value={sum.expected_kg == null ? '—' : `${fmt.num(sum.expected_kg)} kg`} />
        <Stat label="Budget" value={fmt.money(sum.budget_total, cur)} sub={sum.cost_per_ha == null ? undefined : `${fmt.money(sum.cost_per_ha, cur)} per ha`} />
        <Stat label="Break-even price" value={sum.break_even_kg_price == null ? '—' : `${fmt.money(sum.break_even_kg_price, cur)} / kg`} />
        <Stat label="Expected revenue" value={sum.revenue == null ? '—' : fmt.money(sum.revenue, cur)} />
        <Stat label="Expected margin" value={sum.margin == null ? '—' : fmt.money(sum.margin, cur)} />
      </div>}
      <Label text="Notes"><Textarea value={notes} onChange={e => setNotes(e.target.value)} disabled={!canEdit} /></Label>
      {canEdit && <div className="mt-2"><Button small onClick={() => void saveNotes(notes)} disabled={notes === (p.notes ?? '')}>Save notes</Button></div>}
      <h3 className="text-sm font-semibold mt-4 mb-1">History</h3>
      <ul className="text-sm divide-y divide-gray-100" aria-label="Stage history">
        {history.length === 0 && <li className="py-1 text-gray-500">No history yet.</li>}
        {[...history].reverse().map(h => <li key={h.id} className="py-1">
          <span className="text-gray-500">{fmt.date(h.changed_on)}</span> — {h.kind === 'create' ? `Started at ${label(h.to_stage)}` : `${label(h.from_stage)} → ${label(h.to_stage)}`}
          {h.kind === 'override' && <> <Badge tone="amber">override</Badge></>}{h.kind === 'back' && <> <Badge tone="blue">back</Badge></>}
          {h.reason && <span className="text-gray-600"> — {h.reason}</span>}{h.actor_name && <span className="text-gray-400"> ({h.actor_name})</span>}</li>)}
      </ul>
    </Modal>
  )
}
