import type { ReactNode } from 'react'
import { Link, useParams } from 'react-router-dom'
import { fieldRecord } from '../services/fieldrecord'
import { useData, fmt } from '../ui/hooks'
import { useSeasonPicker } from '../ui/season'
import { RecLink } from '../ui/links'
import { Badge, Card, Denied, Grid, PageHeader, Stat, Table, Td } from '../ui/kit'

function Section({ title, show, children }: { title: string; show: unknown; children: ReactNode }) {
  if (show == null) return null
  return <Card className="mb-4"><h2 className="px-4 pt-3 font-medium">{title}</h2>{children}</Card>
}

/** One field, every module: what was planted, done, harvested, cured, baled and sold there, and what it cost. */
export default function FieldRecord() {
  const { fieldNo = '' } = useParams()
  const { sid, picker, season } = useSeasonPicker()
  const r = useData(c => { try { return { ok: fieldRecord(c, fieldNo, sid || undefined) } } catch (e) { return { err: e instanceof Error ? e.message : String(e) } } }, [fieldNo, sid])
  if (!r) return <Denied what="fields" />
  const back = <Link to="/fields" className="text-sm text-brand-700 underline">← All fields</Link>
  if ('err' in r) return <>{back}<Card className="p-8 mt-3 text-center text-gray-500">{r.err}</Card></>
  const { field: f, totals: t } = r.ok; const money = t.cost != null
  const facts = [f.block_name && `Block ${f.block_name}`, `${fmt.num(f.area_ha, 2)} ha`, f.soil_type, f.variety, f.tenure, f.irrigated ? 'irrigated' : 'dryland'].filter(Boolean).join(' · ')

  return (
    <>
      {back}
      <PageHeader title={`Field ${f.field_no}`} sub={`${facts}${season ? ` — season ${season.label}` : ''}`} actions={picker} />
      {r.ok.contracts && r.ok.contracts.length > 0 && <Card className="p-3 mb-4 flex flex-wrap gap-x-4 gap-y-1 items-center"><span className="text-sm text-gray-500">Under contract:</span>
        {r.ok.contracts.map(c => <span key={c.code} className="text-sm"><RecLink kind="contract" code={c.code} /> · {c.contractor} <Badge tone={c.status === 'active' ? 'green' : 'gray'}>{c.status}</Badge></span>)}</Card>}

      <Grid cols={4}>
        {t.established != null && <Stat label="Plants established" value={fmt.num(t.established)} sub={t.plants_per_ha ? `${fmt.num(t.plants_per_ha)} / ha` : undefined} />}
        {t.green_kg != null && <Stat label="Green leaf" value={`${fmt.num(t.green_kg)} kg`} sub={t.green_kg_per_ha ? `${fmt.num(t.green_kg_per_ha)} kg / ha` : undefined} />}
        {t.rain_mm != null && <Stat label="Rain" value={`${fmt.num(t.rain_mm, 1)} mm`} sub="field + farm-wide records" />}
        {t.sold_kg != null && <Stat label="Sold" value={`${fmt.num(t.sold_kg)} kg`} sub={t.net_revenue != null ? `net ${fmt.money(t.net_revenue)}` : undefined} />}
        {money && <Stat label="Direct cost" value={fmt.money(t.cost)} sub={t.cost_per_ha != null ? `${fmt.money(t.cost_per_ha)} / ha` : undefined} />}
        {t.shared_cost != null && <Stat label="Shared costs allocated" value={fmt.money(t.shared_cost)} />}
        {t.full_margin != null && <Stat label="Full margin" value={fmt.money(t.full_margin)} sub="net revenue − direct − shared" />}
      </Grid>
      <div className="mt-4" />

      <Section title="Planting" show={r.ok.transplants}>
        <Table head={['Date', 'Type', 'Seedbed', { label: 'Planted', right: true }, { label: 'Mortality', right: true }, { label: 'Established', right: true }]} empty="Nothing transplanted on this field.">
          {r.ok.transplants?.map(x => <tr key={x.id}><Td>{fmt.date(x.occurred_on)}</Td><Td>{x.kind === 'gap_fill' ? 'gap fill' : 'transplant'}</Td><Td>{x.seedbed_code}</Td><Td right>{fmt.num(x.qty)}</Td><Td right>{fmt.num(x.mortality)}</Td><Td right>{fmt.num(x.established)}</Td></tr>)}</Table></Section>

      <Section title="Field work" show={r.ok.operations}>
        <Table head={['Date', 'Operation', 'Inputs', 'Operator', ...(money ? [{ label: 'Cost', right: true }] : []), 'Remarks']} empty="No operations recorded on this field.">
          {r.ok.operations?.map(o => <tr key={o.id}><Td>{fmt.date(o.occurred_on)}</Td><Td>{o.op_type}</Td><Td>{o.inputs || '—'}</Td><Td>{o.operator ?? '—'}</Td>{money && <Td right>{fmt.money(o.cost)}</Td>}<Td>{o.remarks ?? ''}</Td></tr>)}</Table></Section>

      <Section title="Harvest and curing" show={r.ok.harvests}>
        <Table head={['Batch', 'Date', 'Priming', 'Position', { label: 'Green kg', right: true }, 'Status', 'Curing cycle']} empty="Nothing harvested from this field.">
          {r.ok.harvests?.map(h => <tr key={h.id}><Td className="font-medium"><RecLink kind="harvest" code={h.code} /></Td><Td>{fmt.date(h.harvested_on)}</Td><Td>{h.priming ?? '—'}</Td><Td>{h.leaf_position ?? '—'}</Td>
            <Td right>{fmt.num(h.green_weight_kg, 1)}</Td><Td><Badge tone={h.status === 'harvested' ? 'amber' : 'green'}>{h.status}</Badge></Td><Td><RecLink kind="cycle" code={h.cycle_code} /></Td></tr>)}</Table></Section>

      <Section title="Bales and sales" show={r.ok.bales}>
        <p className="px-4 text-xs text-gray-500">Bales whose leaf came mainly from this field.</p>
        <Table head={['Bale', 'Grade', { label: 'kg', right: true }, 'Baled', 'Grading lot', 'Sale']} empty="No bales from this field yet.">
          {r.ok.bales?.map(b => <tr key={b.id}><Td className="font-mono text-xs"><RecLink kind="bale" code={b.code} /></Td><Td>{b.grade}</Td><Td right>{fmt.num(b.weight_kg, 1)}</Td><Td>{fmt.date(b.baled_on)}</Td>
            <Td><RecLink kind="lot" code={b.lot_code} /></Td><Td>{b.sale_code ? <RecLink kind="sale" code={b.sale_code} /> : <Badge tone="green">in stock</Badge>}</Td></tr>)}</Table></Section>

      <Section title="Labour" show={r.ok.labour}>
        <Table head={['Date', 'Worker', 'Task', { label: 'Hours', right: true }, ...(money ? [{ label: 'Pay', right: true }] : [])]} empty="No labour booked to this field.">
          {r.ok.labour?.map(l => <tr key={l.id}><Td>{fmt.date(l.worked_on)}</Td><Td>{l.worker_name}</Td><Td>{l.task}</Td><Td right>{fmt.num(l.hours, 1)}</Td>{money && <Td right>{fmt.money(l.pay_amount)}</Td>}</tr>)}</Table></Section>

      <Section title="Machinery" show={r.ok.machine}>
        <Table head={['Date', 'Machine', 'Type', { label: 'Hours', right: true }, { label: 'Fuel L', right: true }, ...(money ? [{ label: 'Cost', right: true }] : [])]} empty="No machine work logged on this field.">
          {r.ok.machine?.map(m => <tr key={m.id}><Td>{fmt.date(m.logged_on)}</Td><Td>{m.machine}</Td><Td className="capitalize">{m.kind}</Td><Td right>{fmt.num(m.hours, 1)}</Td><Td right>{fmt.num(m.fuel_l, 0)}</Td>{money && <Td right>{fmt.money(m.cost)}</Td>}</tr>)}</Table></Section>

      <Section title="Rain and observations" show={r.ok.weather}>
        <Table head={['Date', 'Applies to', { label: 'Rain mm', right: true }, 'Event', 'Observation']} empty="No weather recorded.">
          {r.ok.weather?.map(w => <tr key={w.id}><Td>{fmt.date(w.recorded_on)}</Td><Td>{w.farm_wide ? 'whole farm' : 'this field'}</Td><Td right>{fmt.num(w.rainfall_mm, 1)}</Td><Td>{w.event && w.event !== 'none' ? w.event : '—'}</Td><Td>{w.observation ?? ''}</Td></tr>)}</Table></Section>

      <Section title="Activity and notes" show={r.ok.activity}>
        <ul className="divide-y divide-gray-100 px-4 pb-1">{r.ok.activity?.map(a => <li key={a.id} className="py-2"><div className="text-gray-800">{a.summary}</div>{a.body && <div className="text-gray-600 whitespace-pre-wrap">{a.body}</div>}
          <div className="text-xs text-gray-500">{a.occurred_at.replace('T', ' ').slice(0, 16)}{a.actor_name && ` · ${a.actor_name}`}{a.kind === 'note' && ' · note'}</div></li>)}</ul>
        {r.ok.activity?.length === 0 && <p className="text-center text-gray-500 py-6">Nothing in the activity log for this field yet.</p>}
        <p className="px-4 pb-3 text-sm"><Link className="text-brand-700 underline" to={`/activity?field=${encodeURIComponent(f.id)}`}>Full timeline and notes for {f.field_no}</Link></p></Section>

      <Section title="Direct costs by category" show={r.ok.costs}>
        <Table head={['Category', { label: 'Amount', right: true }]} empty="No costs booked to this field.">
          {r.ok.costs?.map(c => <tr key={c.category}><Td className="capitalize">{c.category}</Td><Td right>{fmt.money(c.amount)}</Td></tr>)}</Table>
        <p className="px-4 pb-3 text-xs text-gray-500">Shared costs (curing, grading, overheads…) are spread under Finance → Profitability → Allocation rules.</p></Section>
    </>
  )
}
