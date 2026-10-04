import { useState } from 'react'
import { profitability, rainfallVsYield, seasonComparison } from '../services/analytics'
import { listSeasons } from '../services/seasons'
import { can } from '../services/context'
import { useCtx, useData, useRun, fmt } from '../ui/hooks'
import { Button, Card, Denied, Modal, PageHeader, Select, Stat, Table, Td } from '../ui/kit'
import { RecLink } from '../ui/links'
import { ALLOCATION_BASES, BASIS_LABEL, listAllocationRules, setAllocationRule, type AllocationBasis } from '../services/allocation'

type Tab = 'season' | 'compare' | 'rain'
const Bar = ({ v, max, tone = 'bg-brand-600' }: { v: number; max: number; tone?: string }) => <div className="h-1.5 bg-gray-100 rounded w-28"><div className={`h-1.5 rounded ${tone}`} style={{ width: `${max ? Math.max(2, Math.min(100, (v / max) * 100)) : 0}%` }} /></div>

export default function Profitability() {
  const ctx = useCtx(); const run = useRun(); const [rulesOpen, setRulesOpen] = useState(false); const seasons = useData(c => listSeasons(c)) ?? []
  const [tab, setTab] = useState<Tab>('season'); const [sid, setSid] = useState('')
  const id = sid || seasons.find(s => s.status === 'active')?.id || seasons[0]?.id || ''
  const cur = ctx.db.get<{ currency: string }>(`SELECT currency FROM farms WHERE id=?`, [ctx.farmId])?.currency ?? 'USD'
  const p = useData(c => id ? profitability(c, id) : null, [id])
  const cmp = useData(c => tab === 'compare' ? seasonComparison(c) : [], [tab])
  const rain = useData(c => tab === 'rain' && id && can(c, 'production.weather.view') && can(c, 'production.harvest.view') ? rainfallVsYield(c, id) : null, [tab, id])
  const rules = useData(c => rulesOpen && can(c, 'finance.budget.view') ? listAllocationRules(c) : [], [rulesOpen])
  if (p === undefined) return <Denied what="profitability" />
  const money = (n: number | null) => fmt.money(n, cur)
  return (
    <>
      <PageHeader title="Profitability" sub="Cost, revenue and margin — by field, by contract, season over season, and against the rain." actions={<>
        {tab !== 'compare' && seasons.length > 0 && <Select value={id} onChange={e => setSid(e.target.value)} className="w-40">{seasons.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}</Select>}</>} />
      <div className="flex gap-1 mb-3">{([['season', 'Season'], ['compare', 'Season vs season'], ['rain', 'Rainfall vs yield']] as const).map(([k, l]) => <Button key={k} small variant={tab === k ? 'primary' : 'secondary'} onClick={() => setTab(k)}>{l}</Button>)}</div>

      {tab === 'season' && (!p ? <Card className="p-6 text-gray-500">Create a season first.</Card> : <>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3">
          <Stat label="Total cost" value={money(p.total_cost)} sub={`${money(p.field_cost)} on fields · ${money(p.shared_cost)} shared`} />
          <Stat label="Net revenue" value={p.net_revenue == null ? '—' : money(p.net_revenue)} sub={p.sold_kg ? `${fmt.num(p.sold_kg, 1)} kg sold` : 'No sales yet'} />
          <Stat label="Margin" value={p.margin == null ? '—' : money(p.margin)} sub={p.margin_pct == null ? undefined : `${p.margin_pct}% of revenue`} />
          <Stat label="Margin per ha" value={money(p.margin_per_ha)} sub={`${fmt.num(p.harvested_ha, 2)} ha harvested`} />
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-4"><Stat label="Cost per ha" value={money(p.cost_per_ha)} /><Stat label="Cost per kg sold" value={money(p.cost_per_kg_sold)} /><Stat label="Net price per kg" value={money(p.net_per_kg)} /></div>
        <Card className="mb-4"><div className="p-4 pb-0 flex items-start justify-between gap-3"><div><h2 className="font-medium">By field</h2><p className="text-xs text-gray-500">Field margin = net revenue − costs recorded against the field. Full margin also carries each field's share of shared costs (curing, grading, overhead…) under your allocation rules.{p.unallocated_cost > 0 && ` ${money(p.unallocated_cost)} of shared cost could not be allocated yet.`}</p></div>
          {can(ctx, 'finance.budget.view') && <Button small onClick={() => setRulesOpen(true)}>Allocation rules</Button>}</div>
          <Table head={['Field', { label: 'ha', right: true }, { label: 'Green kg/ha', right: true }, { label: 'Direct cost', right: true }, { label: 'Shared share', right: true }, { label: 'Full cost/ha', right: true }, { label: 'Sold kg', right: true }, { label: 'Net revenue', right: true }, { label: 'Field margin', right: true }, { label: 'Full margin', right: true }]} empty="No field activity this season.">
            {p.by_field.map(f => <tr key={f.field_no}><Td className="font-medium"><RecLink kind="field" code={f.field_no} /></Td><Td right>{fmt.num(f.area_ha, 2)}</Td><Td right>{fmt.num(f.green_kg_per_ha, 0)}</Td><Td right>{money(f.field_cost)}</Td><Td right>{money(f.allocated_cost)}</Td><Td right>{money(f.full_cost_per_ha)}</Td>
              <Td right>{fmt.num(f.sold_kg, 1)}</Td><Td right>{f.net_revenue == null ? '—' : money(f.net_revenue)}</Td><Td right className={f.field_margin != null && f.field_margin < 0 ? 'text-red-700' : ''}>{f.field_margin == null ? '—' : money(f.field_margin)}</Td><Td right className={f.full_margin != null && f.full_margin < 0 ? 'text-red-700' : ''}>{f.full_margin == null ? '—' : money(f.full_margin)}</Td></tr>)}</Table></Card>
        {p.by_contract.length > 0 && <Card><div className="p-4 pb-0"><h2 className="font-medium">By contract</h2></div>
          <Table head={['Contract', { label: 'Sold kg', right: true }, { label: 'Gross', right: true }, { label: 'Net', right: true }]}>{p.by_contract.map(c => <tr key={c.contract}><Td className="font-medium"><RecLink kind="contract" code={c.contract} /></Td><Td right>{fmt.num(c.sold_kg, 1)}</Td><Td right>{money(c.gross)}</Td><Td right>{money(c.net)}</Td></tr>)}</Table></Card>}
      </>)}

      {tab === 'compare' && (cmp === undefined ? <Denied what="season comparison" /> : <Card><Table head={['Season', { label: 'ha', right: true }, { label: 'Green kg/ha', right: true }, { label: 'Sold kg', right: true }, { label: 'Avg price/kg', right: true }, { label: 'Cost', right: true }, { label: 'Cost/ha', right: true }, { label: 'Cost/kg sold', right: true }, { label: 'Net revenue', right: true }, { label: 'Margin', right: true }]} empty="No seasons yet.">
        {cmp.map(s => <tr key={s.season_id}><Td className="font-medium">{s.label}</Td><Td right>{fmt.num(s.harvested_ha, 2)}</Td><Td right>{fmt.num(s.green_kg_per_ha, 0)}</Td><Td right>{fmt.num(s.sold_kg, 1)}</Td><Td right>{money(s.avg_price_per_kg)}</Td>
          <Td right>{money(s.total_cost)}</Td><Td right>{money(s.cost_per_ha)}</Td><Td right>{money(s.cost_per_kg_sold)}</Td><Td right>{s.net_revenue == null ? '—' : money(s.net_revenue)}</Td><Td right className={s.margin != null && s.margin < 0 ? 'text-red-700' : ''}>{s.margin == null ? '—' : money(s.margin)}</Td></tr>)}</Table></Card>)}

      {tab === 'rain' && (!rain ? <Card className="p-6 text-gray-500">Rainfall vs yield needs weather and harvest access and a season.</Card> : <div className="grid md:grid-cols-2 gap-4">
        <Card><div className="p-4 pb-0"><h2 className="font-medium">Rain by month</h2></div>
          <Table head={['Month', { label: 'mm', right: true }, { label: 'Rain days', right: true }, '']} empty="No rainfall recorded for this season.">{rain.by_month.map(m => <tr key={m.month}><Td>{m.month}</Td><Td right>{fmt.num(m.mm, 1)}</Td><Td right>{m.rain_days}</Td><Td><Bar v={m.mm} max={Math.max(...rain.by_month.map(x => x.mm))} tone="bg-blue-500" /></Td></tr>)}</Table></Card>
        <Card><div className="p-4 pb-0"><h2 className="font-medium">Across seasons</h2><p className="text-xs text-gray-500">Season rainfall against green leaf yield per hectare.</p></div>
          <Table head={['Season', { label: 'Rain mm', right: true }, { label: 'Green kg/ha', right: true }]} empty="No seasons.">{rain.by_season.map(s => <tr key={s.label}><Td className="font-medium">{s.label}</Td><Td right>{fmt.num(s.rain_mm, 1)}</Td><Td right>{fmt.num(s.green_kg_per_ha, 0)}</Td></tr>)}</Table></Card>
        <Card className="md:col-span-2"><div className="p-4 pb-0"><h2 className="font-medium">By field (this season)</h2><p className="text-xs text-gray-500">Rain = field-specific records plus farm-wide records.</p></div>
          <Table head={['Field', { label: 'Rain mm', right: true }, { label: 'Green kg/ha', right: true }, '']} empty="No harvests this season.">{rain.by_field.map(f => <tr key={f.field_no}><Td className="font-medium"><RecLink kind="field" code={f.field_no} /></Td><Td right>{fmt.num(f.rain_mm, 1)}</Td><Td right>{fmt.num(f.green_kg_per_ha, 0)}</Td><Td><Bar v={f.green_kg_per_ha ?? 0} max={Math.max(...rain.by_field.map(x => x.green_kg_per_ha ?? 0))} /></Td></tr>)}</Table></Card>
      </div>)}

      {rulesOpen && <Modal title="Shared-cost allocation rules" onClose={() => setRulesOpen(false)}>
        <p className="text-xs text-gray-500 mb-2">Costs recorded without a field are spread over the fields harvested in the season, using the basis chosen for their category. Rules apply to every season.</p>
        <Table head={['Category', 'Spread by']}>{(rules ?? []).map(r => <tr key={r.category}><Td className="font-medium capitalize">{r.category}{r.is_default && <span className="text-xs text-gray-500"> · default</span>}</Td>
          <Td><Select value={r.basis} disabled={!can(ctx, 'finance.budget.edit')} aria-label={`Basis for ${r.category}`} onChange={e => run(() => setAllocationRule(ctx, r.category, e.target.value as AllocationBasis), 'Rule saved')}>{ALLOCATION_BASES.map(b => <option key={b} value={b}>{BASIS_LABEL[b]}</option>)}</Select></Td></tr>)}</Table>
        <div className="flex justify-end mt-3"><Button onClick={() => setRulesOpen(false)}>Close</Button></div></Modal>}
    </>
  )
}
