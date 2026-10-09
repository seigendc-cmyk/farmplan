import { useEffect, useState } from 'react'
import { COST_CATEGORIES } from '../services/analytics'
import { approveRequest, createRequest, declineRequest, deleteDraft, deleteEvent, fundingPack, fundingSummary, linkContract, recordDisbursement, recordRepayment, setFundingNotNeeded, submitRequest, updateRequest, withdrawRequest,
  FUNDER_KINDS, type FundingLine, type FundingStatus, type RequestInput } from '../services/funding'
import { listInputs } from '../services/inventory'
import { getProject, listProjects } from '../services/projects'
import { useCan, useCtx, useData, useRun, fmt, today } from '../ui/hooks'
import { Badge, Button, Card, Denied, Grid, Input, Label, Modal, NumberInput, PageHeader, Select, Stat, Table, Td, Textarea } from '../ui/kit'

const TONE: Record<FundingStatus, 'gray' | 'blue' | 'amber' | 'green' | 'red'> = { draft: 'gray', submitted: 'blue', approved: 'amber', disbursed: 'green', repaid: 'gray', declined: 'red', withdrawn: 'gray' }
type Dlg = { kind: 'new' } | { kind: 'edit' | 'approve' | 'decline' | 'receive' | 'repay' | 'pack' | 'open'; id: string }
const blank = (): RequestInput => ({ funder_kind: 'lender', funder_name: '', purpose: '', amount_requested: 0, needed_by: '', repayment_source: '', repayment_due: '', interest_pct: 0, terms: '', covers: [], notes: '' })

export default function Funding() {
  const ctx = useCtx(); const can = useCan(); const run = useRun()
  const projects = useData(c => listProjects(c)); const [pid, setPid] = useState('')
  useEffect(() => { if (!pid && projects?.length) setPid(projects[0].id) }, [projects, pid])
  const project = useData(c => pid ? getProject(c, pid) : null, [pid]); const sum = useData(c => pid ? fundingSummary(c, pid) : null, [pid])
  const cur = useData(c => c.db.get<{ currency: string }>(`SELECT currency FROM farms WHERE id=?`, [c.farmId])?.currency) ?? 'USD'
  const contracts = useData(c => project ? c.db.all<{ id: string; code: string; contractor: string }>(`SELECT k.id, k.code, c.name contractor FROM contracts k JOIN contractors c ON c.id=k.contractor_id WHERE k.farm_id=? AND k.season_id=? AND k.deleted_at IS NULL AND k.status<>'cancelled' ORDER BY k.code`, [c.farmId, project.season_id]) : [], [project?.season_id]) ?? []
  const [dlg, setDlg] = useState<Dlg | null>(null); const [pick, setPick] = useState('')
  if (projects === undefined || sum === undefined) return <Denied what="funding" />
  const edit = can('projects.funding.edit'); const link = can('projects.project.edit'); const money = (n: number) => fmt.money(n, cur)
  const line = dlg && 'id' in dlg ? sum?.requests.find(r => r.id === dlg.id) : undefined
  return (
    <>
      <PageHeader title="Funding" sub="Ask for funding at any stage, and track what was received and repaid." actions={projects.length > 0 && <Select value={pid} onChange={e => setPid(e.target.value)} className="w-52" aria-label="Project">{projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</Select>} />
      {!project || !sum ? <Card className="p-6 text-gray-500">No project yet. Creating a season starts one.</Card> : <>
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 mb-4">
          <Stat label="Received" value={money(sum.received)} sub="All funders and contractor advances" /><Stat label="Repaid" value={money(sum.repaid)} />
          <Stat label="Outstanding" value={money(sum.outstanding)} sub="Principal" /><Stat label="Interest accrued" value={money(sum.interest)} sub={`to ${fmt.date(sum.asOf)}`} /><Stat label="Asked for" value={money(sum.requested_open)} sub="Drafts and submitted" />
        </div>
        <Card className="p-4 mb-4"><h2 className="font-semibold mb-2">Contractor</h2>
          {sum.contractor ? <>
            <p className="text-sm mb-2">Linked to contract <strong>{sum.contractor.code}</strong> with <strong>{sum.contractor.contractor}</strong>. Their advances are recorded on the contract and appear here as the same rows.</p>
            <Table head={['Advance', 'Date', { label: 'Value', right: true }]} empty="No advances recorded on the contract yet.">{sum.contractor.advances.map(a => <tr key={a.id}><Td>{a.description}</Td><Td>{fmt.date(a.advanced_on)}</Td><Td right>{money(a.value)}</Td></tr>)}</Table>
            <p className="text-sm mt-2">Received {money(sum.contractor.received)} · {sum.contractor.settled ? 'recovered at settlement' : 'to be recovered at settlement'} {money(sum.contractor.recovered)} · outstanding {money(sum.contractor.outstanding)}</p>
            {link && <div className="mt-2"><Button small onClick={() => run(() => linkContract(ctx, pid, { contract_id: null, independent: false }), 'Contract unlinked')}>Unlink contract</Button></div>}</>
          : <>{project.independent ? <p className="text-sm mb-2">Marked as an <strong>independent</strong> project: no contractor.</p> : <p className="text-sm text-gray-600 mb-2">No contract linked yet.</p>}
            {link && <div className="flex flex-wrap items-end gap-2">
              {contracts.length > 0 && <><Label text="Contract of this season"><Select value={pick} onChange={e => setPick(e.target.value)}><option value="">Choose…</option>{contracts.map(k => <option key={k.id} value={k.id}>{k.code} — {k.contractor}</option>)}</Select></Label>
                <Button onClick={() => run(() => linkContract(ctx, pid, { contract_id: pick || null }), 'Contract linked')} disabled={!pick}>Link contract</Button></>}
              {!project.independent && <Button onClick={() => run(() => linkContract(ctx, pid, { contract_id: null, independent: true }), 'Marked independent')}>No contractor — independent</Button>}
              {project.independent && <Button onClick={() => run(() => linkContract(ctx, pid, { contract_id: null, independent: false }), 'Independent mark removed')}>Undo independent</Button>}
            </div>}</>}
        </Card>
        <div className="flex flex-wrap items-center gap-2 mb-2"><h2 className="font-semibold">Requests</h2>
          {project.funding_not_needed && <Badge tone="gray">no funding needed</Badge>}
          <div className="ml-auto flex gap-2">
            {link && sum.requests.length === 0 && <Button onClick={() => run(() => setFundingNotNeeded(ctx, pid, !project.funding_not_needed), project.funding_not_needed ? 'Funding is needed again' : 'Marked: no funding needed')}>{project.funding_not_needed ? 'Funding is needed after all' : 'No funding needed'}</Button>}
            {edit && <Button variant="primary" onClick={() => setDlg({ kind: 'new' })}>New funding request</Button>}</div></div>
        <Card><Table head={['Funder', 'Purpose', { label: 'Asked', right: true }, 'Status', { label: 'Received', right: true }, { label: 'Owed', right: true }]} empty="No funding requests yet.">
          {sum.requests.map(r => <tr key={r.id}>
            <Td><button type="button" className="font-medium text-left text-green-800 hover:underline" aria-label={`Open request from ${r.funder_name}`} onClick={() => setDlg({ kind: 'open', id: r.id })}>{r.funder_name}</button><div className="text-xs text-gray-500 capitalize">{r.funder_kind}</div></Td>
            <Td>{r.purpose}</Td><Td right>{money(r.amount_requested)}</Td><Td><Badge tone={TONE[r.status]}>{r.status}</Badge></Td><Td right>{money(r.received)}</Td><Td right>{r.status === 'disbursed' || r.status === 'repaid' ? money(r.owed) : '—'}</Td></tr>)}
        </Table></Card></>}

      {dlg?.kind === 'new' && <RequestForm title="New funding request" init={blank()} cur={cur} onClose={() => setDlg(null)} save={async v => { if (await run(() => createRequest(ctx, pid, v), 'Request saved as a draft')) setDlg(null) }} />}
      {dlg?.kind === 'edit' && line && <RequestForm title="Edit funding request" init={{ ...line, covers: line.covers ? line.covers.split(',') : [] }} cur={cur} onClose={() => setDlg({ kind: 'open', id: line.id })} save={async v => { if (await run(() => updateRequest(ctx, line.id, v), 'Request updated')) setDlg({ kind: 'open', id: line.id }) }} />}
      {dlg?.kind === 'open' && line && <OpenRequest l={line} cur={cur} edit={edit} onClose={() => setDlg(null)} go={k => setDlg({ kind: k, id: line.id })}
        act={(fn, msg) => run(fn, msg)} ctx={ctx} />}
      {dlg?.kind === 'approve' && line && <Simple title="Approve request" onClose={() => setDlg({ kind: 'open', id: line.id })} submit="Approve" fields={[{ key: 'amount', label: `Amount approved (${cur})`, type: 'number', value: String(line.amount_requested) }, { key: 'date', label: 'Date approved', type: 'date', value: today() }, { key: 'interest', label: 'Interest (% a year)', type: 'number', value: String(line.interest_pct) }, { key: 'terms', label: 'Terms', value: line.terms ?? '' }]}
        onSave={async v => { if (await run(() => approveRequest(ctx, line.id, { amount_approved: Number(v.amount), decided_on: v.date, interest_pct: Number(v.interest), terms: v.terms }), 'Request approved')) setDlg({ kind: 'open', id: line.id }) }} />}
      {dlg?.kind === 'decline' && line && <Simple title="Decline request" onClose={() => setDlg({ kind: 'open', id: line.id })} submit="Decline" fields={[{ key: 'date', label: 'Date declined', type: 'date', value: today() }]} onSave={async v => { if (await run(() => declineRequest(ctx, line.id, v.date), 'Request declined')) setDlg({ kind: 'open', id: line.id }) }} />}
      {dlg?.kind === 'repay' && line && <Simple title="Record a repayment" onClose={() => setDlg({ kind: 'open', id: line.id })} submit="Record repayment" fields={[{ key: 'amount', label: `Amount (${cur})`, type: 'number', value: '' }, { key: 'date', label: 'Date repaid', type: 'date', value: today() }, { key: 'note', label: 'Note', value: '' }]}
        onSave={async v => { if (await run(() => recordRepayment(ctx, line.id, { amount: Number(v.amount), occurred_on: v.date, note: v.note }), 'Repayment recorded')) setDlg({ kind: 'open', id: line.id }) }} />}
      {dlg?.kind === 'receive' && line && <Receive l={line} cur={cur} onClose={() => setDlg({ kind: 'open', id: line.id })} save={async v => { if (await run(() => recordDisbursement(ctx, line.id, v), 'Receipt recorded')) setDlg({ kind: 'open', id: line.id }) }} />}
      {dlg?.kind === 'pack' && line && <Pack id={line.id} cur={cur} onClose={() => setDlg({ kind: 'open', id: line.id })} />}
    </>
  )
}

function RequestForm({ title, init, cur, onClose, save }: { title: string; init: RequestInput; cur: string; onClose: () => void; save: (v: RequestInput) => void }) {
  const [v, setV] = useState(init); const set = <K extends keyof RequestInput>(k: K, x: RequestInput[K]) => setV({ ...v, [k]: x })
  return <Modal title={title} onClose={onClose} wide>
    <form className="space-y-3" onSubmit={e => { e.preventDefault(); save(v) }}>
      <Grid><Label text="Kind of funder"><Select value={v.funder_kind} onChange={e => set('funder_kind', e.target.value as RequestInput['funder_kind'])}>{FUNDER_KINDS.map(k => <option key={k} value={k}>{k}</option>)}</Select></Label>
        <Label text="Funder"><Input value={v.funder_name} onChange={e => set('funder_name', e.target.value)} required /></Label></Grid>
      <Label text="What is it for?"><Input value={v.purpose} onChange={e => set('purpose', e.target.value)} required /></Label>
      <Grid><Label text={`Amount asked for (${cur})`}><NumberInput step="any" min={0} value={v.amount_requested || undefined} onChange={n => set('amount_requested', n ?? 0)} /></Label>
        <Label text="Needed by"><Input type="date" value={v.needed_by ?? ''} onChange={e => set('needed_by', e.target.value)} /></Label></Grid>
      <Grid><Label text="Repayment source"><Input value={v.repayment_source ?? ''} onChange={e => set('repayment_source', e.target.value)} /></Label>
        <Label text="Repay by"><Input type="date" value={v.repayment_due ?? ''} onChange={e => set('repayment_due', e.target.value)} /></Label></Grid>
      <Grid><Label text="Interest (% a year, simple)"><NumberInput step="any" min={0} value={v.interest_pct} onChange={n => set('interest_pct', n ?? 0)} /></Label>
        <Label text="Other terms"><Input value={v.terms ?? ''} onChange={e => set('terms', e.target.value)} /></Label></Grid>
      <fieldset><legend className="text-sm font-medium mb-1">Budget lines it covers</legend><div className="flex flex-wrap gap-x-4 gap-y-1">
        {COST_CATEGORIES.map(c => <label key={c} className="text-sm capitalize flex items-center gap-1"><input type="checkbox" checked={(v.covers ?? []).includes(c)} onChange={e => set('covers', e.target.checked ? [...(v.covers ?? []), c] : (v.covers ?? []).filter(x => x !== c))} />{c}</label>)}</div></fieldset>
      <Label text="Notes"><Textarea value={v.notes ?? ''} onChange={e => set('notes', e.target.value)} /></Label>
      <div className="flex justify-end gap-2"><Button type="button" onClick={onClose}>Cancel</Button><Button variant="primary" type="submit">Save</Button></div>
    </form></Modal>
}

function OpenRequest({ l, cur, edit, onClose, go, act, ctx }: { l: FundingLine; cur: string; edit: boolean; onClose: () => void; go: (k: 'edit' | 'approve' | 'decline' | 'receive' | 'repay' | 'pack') => void; act: (fn: () => unknown, msg: string) => Promise<unknown>; ctx: ReturnType<typeof useCtx> }) {
  const m = (n: number) => fmt.money(n, cur); const left = (l.amount_approved ?? 0) - l.received
  return <Modal title={`${l.funder_name} — ${l.purpose}`} onClose={onClose} wide>
    <p className="mb-2"><Badge tone={TONE[l.status]}>{l.status}</Badge> <span className="text-sm text-gray-600">Asked {m(l.amount_requested)}{l.amount_approved != null && <> · approved {m(l.amount_approved)}</>}{l.interest_pct > 0 && <> · {l.interest_pct}% a year</>}{l.needed_by && <> · needed by {fmt.date(l.needed_by)}</>}</span></p>
    {(l.repayment_source || l.repayment_due) && <p className="text-sm mb-2">Repayment: {l.repayment_source ?? '—'}{l.repayment_due && <> by {fmt.date(l.repayment_due)}</>}</p>}
    {(l.status === 'disbursed' || l.status === 'repaid') && <p className="text-sm mb-2">Received {m(l.received)} · repaid {m(l.repaid)} · principal {m(l.principal)} · interest {m(l.interest)} · <strong>owed {m(l.owed)}</strong></p>}
    <h3 className="text-sm font-semibold mt-2 mb-1">Money received and repaid</h3>
    <Table head={['Date', 'What', { label: 'Amount', right: true }, '']} empty="Nothing recorded yet.">{l.events.map(e => <tr key={e.id}><Td>{fmt.date(e.occurred_on)}</Td><Td>{e.kind === 'repayment' ? 'Repayment' : `Received (${e.form})`}{e.note ? ` — ${e.note}` : ''}</Td><Td right>{m(e.amount)}</Td>
      <Td className="text-right">{edit && <Button small variant="danger" aria-label={`Remove ${e.kind} of ${e.amount}`} onClick={() => confirm('Remove this entry?') && act(() => deleteEvent(ctx, e.id), 'Entry removed')}>Remove</Button>}</Td></tr>)}</Table>
    <div className="flex flex-wrap gap-2 mt-3">
      {edit && l.status === 'draft' && <><Button variant="primary" onClick={() => act(() => submitRequest(ctx, l.id), 'Marked as submitted')}>Mark as submitted</Button><Button onClick={() => go('edit')}>Edit</Button><Button variant="danger" onClick={() => confirm('Delete this draft?') && act(() => deleteDraft(ctx, l.id), 'Draft deleted').then(onClose)}>Delete draft</Button></>}
      {edit && l.status === 'submitted' && <><Button variant="primary" onClick={() => go('approve')}>Record approval…</Button><Button onClick={() => go('decline')}>Declined…</Button></>}
      {edit && (l.status === 'approved' || l.status === 'disbursed') && l.funder_kind !== 'contractor' && left > 0.005 && <Button variant="primary" onClick={() => go('receive')}>Record money received…</Button>}
      {edit && l.status === 'disbursed' && <Button onClick={() => go('repay')}>Record a repayment…</Button>}
      {edit && ['draft', 'submitted', 'approved'].includes(l.status) && <Button onClick={() => confirm('Withdraw this request?') && act(() => withdrawRequest(ctx, l.id), 'Request withdrawn')}>Withdraw</Button>}
      <Button onClick={() => go('pack')}>Funding pack</Button>
    </div>
    {l.funder_kind === 'contractor' && <p className="text-xs text-gray-500 mt-2">Money from a contractor is recorded as an advance on the contract, and appears on this screen by itself.</p>}
  </Modal>
}

function Simple({ title, fields, submit, onClose, onSave }: { title: string; fields: { key: string; label: string; type?: string; value: string }[]; submit: string; onClose: () => void; onSave: (v: Record<string, string>) => void }) {
  const [v, setV] = useState(Object.fromEntries(fields.map(f => [f.key, f.value])))
  return <Modal title={title} onClose={onClose}><form className="space-y-3" onSubmit={e => { e.preventDefault(); onSave(v) }}>
    {fields.map(f => <Label key={f.key} text={f.label}><Input type={f.type ?? 'text'} step={f.type === 'number' ? 'any' : undefined} value={v[f.key]} onChange={e => setV({ ...v, [f.key]: e.target.value })} /></Label>)}
    <div className="flex justify-end gap-2"><Button type="button" onClick={onClose}>Cancel</Button><Button variant="primary" type="submit">{submit}</Button></div></form></Modal>
}

function Receive({ l, cur, onClose, save }: { l: FundingLine; cur: string; onClose: () => void; save: (v: { form: 'cash' | 'inputs'; amount: number; occurred_on: string; input_id?: string; qty?: number; note?: string }) => void }) {
  const inputs = useData(c => listInputs(c)) ?? []; const [v, setV] = useState({ form: 'cash' as 'cash' | 'inputs', amount: undefined as number | undefined, occurred_on: today(), input_id: '', qty: undefined as number | undefined, note: '' })
  return <Modal title="Record money received" onClose={onClose}><form className="space-y-3" onSubmit={e => { e.preventDefault(); save({ form: v.form, amount: v.amount ?? 0, occurred_on: v.occurred_on, input_id: v.input_id || undefined, qty: v.qty, note: v.note }) }}>
    <p className="text-sm text-gray-600">Up to {fmt.money((l.amount_approved ?? 0) - l.received, cur)} still to receive.</p>
    <Label text="Received as"><Select value={v.form} onChange={e => setV({ ...v, form: e.target.value as 'cash' | 'inputs' })}><option value="cash">Cash</option><option value="inputs">Inputs (go into stock)</option></Select></Label>
    <Label text={`Value (${cur})`}><NumberInput step="any" min={0} value={v.amount} onChange={n => setV({ ...v, amount: n })} /></Label>
    {v.form === 'inputs' && <Grid><Label text="Input"><Select value={v.input_id} onChange={e => setV({ ...v, input_id: e.target.value })}><option value="">Choose…</option>{inputs.map(i => <option key={i.id} value={i.id}>{i.name} ({i.unit})</option>)}</Select></Label>
      <Label text="Quantity"><NumberInput step="any" min={0} value={v.qty} onChange={n => setV({ ...v, qty: n })} /></Label></Grid>}
    <Label text="Date"><Input type="date" value={v.occurred_on} onChange={e => setV({ ...v, occurred_on: e.target.value })} /></Label>
    <div className="flex justify-end gap-2"><Button type="button" onClick={onClose}>Cancel</Button><Button variant="primary" type="submit">Record</Button></div></form></Modal>
}

function Pack({ id, cur, onClose }: { id: string; cur: string; onClose: () => void }) {
  const pk = useData(c => fundingPack(c, id), [id]); const m = (n: number) => fmt.money(n, cur)
  return <Modal title="Funding pack" onClose={onClose} wide>{!pk ? <p>You do not have access to the budget and cost figures this pack needs.</p> : <div className="space-y-3 text-sm" aria-label="Funding pack">
    <div><h3 className="text-base font-semibold">{pk.project}</h3><p className="text-gray-600">Stage: {pk.stage} · prepared {fmt.date(pk.generated_on)}</p></div>
    <section><h4 className="font-semibold">The request</h4><p>{pk.request.funder_name} ({pk.request.funder_kind}) — {pk.request.purpose}. Asking for <strong>{m(pk.request.amount_requested)}</strong>{pk.request.needed_by && <>, needed by {fmt.date(pk.request.needed_by)}</>}. {pk.request.interest_pct > 0 && <>Interest {pk.request.interest_pct}% a year (simple). </>}{pk.request.terms}</p>
      {pk.covers.length > 0 && <p>Covers: <span className="capitalize">{pk.covers.join(', ')}</span>.</p>}</section>
    <section><h4 className="font-semibold">Plan</h4><p>{pk.plan.plan_ha ?? '—'} ha at {pk.plan.plan_yield_kg_ha ?? '—'} kg per ha: {pk.plan.expected_kg == null ? 'no expected crop yet' : `${fmt.num(pk.plan.expected_kg)} kg`}. Expected revenue {pk.plan.revenue == null ? '—' : m(pk.plan.revenue)}; budget {m(pk.plan.budget_total)}; expected margin {pk.plan.margin == null ? '—' : m(pk.plan.margin)}; break-even price {pk.plan.break_even_kg_price == null ? '—' : `${m(pk.plan.break_even_kg_price)} per kg`}.</p></section>
    <section><h4 className="font-semibold">Budget{pk.baseline ? ` (baseline approved ${fmt.date(pk.baseline.approved_on)}${pk.latest && pk.latest.version_no > 1 ? `, latest version ${pk.latest.version_no}` : ''})` : ' (not yet approved)'}</h4>
      <Table head={['Category', { label: 'Amount', right: true }]} empty="No budget lines.">{(pk.latest?.lines ?? []).map(l => <tr key={l.category}><Td className="capitalize">{l.category}</Td><Td right>{m(l.amount)}</Td></tr>)}</Table></section>
    <section><h4 className="font-semibold">Monthly cash need</h4><Table head={['Month', { label: 'Needed', right: true }, { label: 'Running total', right: true }]} empty="No budget lines.">{pk.cash_need.map(c => <tr key={c.month ?? 'none'}><Td>{c.month ?? 'No month set'}</Td><Td right>{m(c.amount)}</Td><Td right>{m(c.cumulative)}</Td></tr>)}</Table></section>
    <section><h4 className="font-semibold">Repayment plan</h4><p>{pk.request.repayment_source ? `From ${pk.request.repayment_source}` : 'Repayment source not stated'}{pk.request.repayment_due && <>, by {fmt.date(pk.request.repayment_due)}</>}.</p></section>
    {pk.budget_vs_actual && <section><h4 className="font-semibold">Budget against actual so far</h4><p>Budget {m(pk.budget_vs_actual.budget_total)}, spent {m(pk.budget_vs_actual.actual_total)}.</p></section>}
    <div className="print:hidden"><Button onClick={() => window.print()}>Print</Button></div></div>}</Modal>
}
