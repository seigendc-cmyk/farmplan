import { useEffect, useState } from 'react'
import { COST_CATEGORIES, copyBudget, listBudgets, planVsActual, setBudget, type CostCategory, type PlanLine } from '../services/analytics'
import { listSeasons } from '../services/seasons'
import { approveBaseline, baselineReport, cashFlow, listVersions, recordRevision, setBudgetMonth } from '../services/budgetplan'
import { useCan, useCtx, useData, useRun, fmt } from '../ui/hooks'
import { Badge, Button, Card, Denied, Input, Modal, NumberInput, PageHeader, Select, Stat, Table, Td, Label } from '../ui/kit'
import { useFocus } from '../ui/links'

const TONE = { under: 'green', near: 'amber', over: 'red', unplanned: 'gray' } as const

export default function Budgets() {
  const ctx = useCtx(); const can = useCan(); const run = useRun()
  const seasons = useData(c => listSeasons(c)) ?? []
  const focus = useFocus('budget'); const [sid, setSid] = useState('')
  useEffect(() => { if (focus.seasonId) setSid(focus.seasonId) }, [focus.seasonId])
  const id = sid || seasons.find(s => s.status === 'active')?.id || seasons[0]?.id || ''
  const cur = ctx.db.get<{ currency: string }>(`SELECT currency FROM farms WHERE id=?`, [ctx.farmId])?.currency ?? 'USD'
  const plan = useData(c => id ? planVsActual(c, id) : null, [id])
  const existing = useData(c => id ? listBudgets(c, id) : [], [id]) ?? []
  const months = useData(c => id ? Object.fromEntries(c.db.all<{ category: string; expected_month: string | null }>(`SELECT category, expected_month FROM budgets WHERE season_id=? AND deleted_at IS NULL`, [id]).map(r => [r.category, r.expected_month])) : {}, [id]) ?? {}
  const versions = useData(c => id ? listVersions(c, id) : [], [id]) ?? []; const report = useData(c => id ? baselineReport(c, id) : null, [id]); const cash = useData(c => id ? cashFlow(c, id) : [], [id]) ?? []
  const [rev, setRev] = useState<string | null>(null)
  const [edit, setEdit] = useState<{ category: CostCategory; amount?: number } | null>(null)
  const [copy, setCopy] = useState<{ from: string; factor: number } | null>(null)
  if (plan === undefined) return <Denied what="budgets" />
  const editable = can('finance.budget.edit')
  const others = seasons.filter(s => s.id !== id)

  return (
    <>
      <PageHeader title="Budgets" sub="Plan the season's spending by category and watch it against actual costs." actions={<>
        {seasons.length > 0 && <Select value={id} onChange={e => setSid(e.target.value)} className="w-40">{seasons.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}</Select>}
        {editable && others.length > 0 && <Button onClick={() => setCopy({ from: others[0].id, factor: 1 })}>Copy from season…</Button>}</>} />
      {!plan ? <Card className="p-6 text-gray-500">Create a season first.</Card> : <>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
          <Stat label="Budget" value={fmt.money(plan.budget_total, cur)} /><Stat label="Actual" value={fmt.money(plan.actual_total, cur)} />
          <Stat label={plan.variance >= 0 ? 'Remaining' : 'Over budget'} value={fmt.money(Math.abs(plan.variance), cur)} sub={plan.pct_used == null ? 'No budget set' : `${plan.pct_used}% used`} />
          <Stat label="Unplanned spend" value={fmt.money(plan.unplanned_actual, cur)} sub="Categories with no budget" />
        </div>
        <Card><Table head={['Category', { label: 'Budget', right: true }, 'Month', { label: 'Actual', right: true }, { label: 'Variance', right: true }, 'Used', 'Status', '']} empty="No budget or costs yet for this season.">
          {(COST_CATEGORIES.map(c => plan.lines.find(l => l.category === c) ?? ({ category: c, budget: null, actual: 0, variance: null, pct_used: null, status: 'unplanned' } as PlanLine)).filter(l => editable || l.budget != null || l.actual > 0)).map(l => (
            <tr key={l.category} {...focus.row(l.category, '')}><Td className="capitalize font-medium">{l.category}</Td><Td right>{l.budget == null ? '—' : fmt.money(l.budget, cur)}</Td>
              <Td>{l.budget != null && <Input type="month" aria-label={`Expected month for ${l.category}`} className="w-36" disabled={!editable} value={months[l.category] ?? ''} onChange={e => void run(() => setBudgetMonth(ctx, id, l.category, e.target.value || null))} />}</Td><Td right>{fmt.money(l.actual, cur)}</Td>
              <Td right className={l.variance != null && l.variance < 0 ? 'text-red-700' : ''}>{l.variance == null ? '—' : fmt.money(l.variance, cur)}</Td>
              <Td className="w-40">{l.pct_used == null ? '' : <div className="h-1.5 bg-gray-100 rounded"><div className={`h-1.5 rounded ${l.status === 'over' ? 'bg-red-600' : l.status === 'near' ? 'bg-amber-500' : 'bg-brand-600'}`} style={{ width: `${Math.min(100, l.pct_used)}%` }} /></div>}</Td>
              <Td>{(l.budget != null || l.actual > 0) && <Badge tone={TONE[l.status]}>{l.status === 'unplanned' ? 'no budget' : l.status}</Badge>}</Td>
              <Td className="text-right">{editable && <Button small onClick={() => setEdit({ category: l.category, amount: l.budget ?? undefined })}>{l.budget == null ? 'Set' : 'Edit'}</Button>}</Td></tr>))}
        </Table></Card>
        <Card className="mt-4 p-4" >
          <div className="flex flex-wrap items-center gap-2 mb-2"><h2 className="font-semibold">Baseline and versions</h2>
            {versions.length === 0 ? <Badge tone="amber">not approved</Badge> : <Badge tone="green">{`baseline approved · version ${versions.at(-1)!.version_no}`}</Badge>}
            {report?.unsaved_changes && <Badge tone="amber">changed since version {report.latest_version}</Badge>}</div>
          {versions.length === 0
            ? <p className="text-sm text-gray-600 mb-2">Approving locks today's budget lines as version 1. Budget against actual is then reported against it.</p>
            : <p className="text-sm text-gray-600 mb-2">The baseline never changes. A later change to the budget is recorded as a new version with a reason.</p>}
          <div className="flex flex-wrap gap-2 mb-3">
            {versions.length === 0 && can('finance.budget.approve') && <Button variant="primary" onClick={() => run(() => approveBaseline(ctx, id), 'Baseline approved')}>Approve as baseline</Button>}
            {versions.length > 0 && editable && report?.unsaved_changes && <Button variant="primary" onClick={() => setRev('')}>Record a revision…</Button>}
          </div>
          {versions.length > 0 && <Table head={['Version', 'Approved', 'By', { label: 'Total', right: true }, 'Reason']}>
            {versions.map(v => <tr key={v.id}><Td>{v.version_no === 1 ? 'v1 baseline' : `v${v.version_no}`}</Td><Td>{fmt.date(v.approved_on)}</Td><Td>{v.approved_by ?? '—'}</Td><Td right>{fmt.money(v.total, cur)}</Td><Td>{v.reason ?? ''}</Td></tr>)}
          </Table>}
          {report?.has_baseline && <div className="mt-3"><Table head={['Category', { label: 'Baseline', right: true }, { label: 'Latest', right: true }, { label: 'Actual', right: true }, { label: 'Left of baseline', right: true }]}>
            {report.lines.map(l => <tr key={l.category}><Td className="capitalize">{l.category}</Td><Td right>{l.baseline == null ? '—' : fmt.money(l.baseline, cur)}</Td><Td right>{l.latest == null ? '—' : fmt.money(l.latest, cur)}</Td><Td right>{fmt.money(l.actual, cur)}</Td>
              <Td right className={l.vs_baseline != null && l.vs_baseline < 0 ? 'text-red-700' : ''}>{l.vs_baseline == null ? '—' : fmt.money(l.vs_baseline, cur)}</Td></tr>)}
          </Table></div>}
        </Card>
        <Card className="mt-4 p-4"><h2 className="font-semibold mb-1">Monthly cash need</h2>
          <p className="text-sm text-gray-600 mb-2">From the expected month on each budget line. Lines without a month are listed last.</p>
          <Table head={['Month', { label: 'Needed', right: true }, { label: 'Running total', right: true }]} empty="No budget lines yet.">
            {cash.map(c => <tr key={c.month ?? 'none'}><Td>{c.month ?? 'No month set'}</Td><Td right>{fmt.money(c.amount, cur)}</Td><Td right>{fmt.money(c.cumulative, cur)}</Td></tr>)}
          </Table></Card>
        {existing.length === 0 && <p className="text-xs text-gray-500 mt-2">Tip: copy last season's budget and scale it for inflation, then adjust line by line.</p>}
      </>}

      {rev !== null && <Modal title="Record a budget revision" onClose={() => setRev(null)}>
        <form className="space-y-3" onSubmit={async e => { e.preventDefault(); if (await run(() => recordRevision(ctx, id, rev), 'Revision recorded')) setRev(null) }}>
          <Label text="Why did the budget change?"><Input value={rev} onChange={e => setRev(e.target.value)} autoFocus /></Label>
          <div className="flex justify-end gap-2"><Button type="button" onClick={() => setRev(null)}>Cancel</Button><Button variant="primary" type="submit">Record revision</Button></div>
        </form></Modal>}
      {edit && <Modal title={`Budget — ${edit.category}`} onClose={() => setEdit(null)}>
        <form className="space-y-3" onSubmit={async e => { e.preventDefault(); if (await run(() => setBudget(ctx, id, edit.category, edit.amount ?? null), edit.amount == null ? 'Budget line removed' : 'Budget saved')) setEdit(null) }}>
          <Label text={`Planned amount (${cur})`} hint="Leave blank to remove this line"><NumberInput step="any" min={0} value={edit.amount} onChange={n => setEdit({ ...edit, amount: n })} autoFocus /></Label>
          <div className="flex justify-end gap-2"><Button type="button" onClick={() => setEdit(null)}>Cancel</Button><Button variant="primary" type="submit">Save</Button></div>
        </form></Modal>}
      {copy && <Modal title="Copy budget from another season" onClose={() => setCopy(null)}>
        <form className="space-y-3" onSubmit={async e => { e.preventDefault(); let n = 0; if (await run(() => { n = copyBudget(ctx, copy.from, id, copy.factor) }, 'Budget copied')) setCopy(null); void n }}>
          <Label text="Copy from"><Select value={copy.from} onChange={e => setCopy({ ...copy, from: e.target.value })}>{others.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}</Select></Label>
          <Label text="Scale by" hint="1 = same amounts, 1.1 = 10% more. Lines already set here are kept."><Input type="number" step="0.01" min="0.01" value={copy.factor} onChange={e => setCopy({ ...copy, factor: Number(e.target.value) })} /></Label>
          <div className="flex justify-end gap-2"><Button type="button" onClick={() => setCopy(null)}>Cancel</Button><Button variant="primary" type="submit">Copy</Button></div>
        </form></Modal>}
    </>
  )
}
