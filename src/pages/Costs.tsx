import { useState } from 'react'
import { seasonCostSummary } from '../services/reports'
import { listSeasons } from '../services/seasons'
import { useCtx, useData, fmt } from '../ui/hooks'
import { Card, Denied, PageHeader, Select, Stat, Table, Td } from '../ui/kit'
import { RecLink } from '../ui/links'

export default function Costs() {
  const ctx = useCtx(); const seasons = useData(c => listSeasons(c)) ?? []
  const [sid, setSid] = useState(''); const id = sid || seasons.find(s => s.status === 'active')?.id || seasons[0]?.id || ''
  const cur = ctx.db.get<{ currency: string }>(`SELECT currency FROM farms WHERE id=?`, [ctx.farmId])?.currency ?? 'USD'
  const s = useData(c => id ? seasonCostSummary(c, id) : null, [id])
  if (s === undefined) return <Denied what="costs" />
  return (
    <>
      <PageHeader title="Season costs" sub="Costs flow automatically from recorded operations and stock use."
        actions={seasons.length > 0 && <Select value={id} onChange={e => setSid(e.target.value)} className="w-40">{seasons.map(x => <option key={x.id} value={x.id}>{x.label}</option>)}</Select>} />
      {!s ? <Card className="p-6 text-gray-500">Select a season.</Card> : <>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-4">
          <Stat label="Total cost" value={fmt.money(s.total, cur)} />
          <Stat label="Field cost per hectare" value={fmt.money(s.cost_per_ha, cur)} sub={`${fmt.num(s.field_area_costed_ha, 2)} ha with recorded costs`} />
          <Stat label="Seedbed cost" value={fmt.money(s.by_seedbed.reduce((a, b) => a + b.cost, 0), cur)} />
        </div>
        <div className="grid md:grid-cols-2 gap-4">
          <Card className="p-4"><h2 className="font-medium mb-3">By category</h2>
            {!s.by_category.length && <p className="text-gray-500">No costs recorded.</p>}
            <div className="space-y-2.5">{s.by_category.map(c => (
              <div key={c.category}><div className="flex justify-between text-sm"><span className="capitalize">{c.category}</span><span className="tabular-nums">{fmt.money(c.amount, cur)} <span className="text-gray-500">· {c.pct}%</span></span></div>
                <div className="h-1.5 bg-gray-100 rounded mt-1"><div className="h-1.5 bg-brand-600 rounded" style={{ width: `${c.pct}%` }} /></div></div>))}</div></Card>
          <Card><div className="p-4 pb-0"><h2 className="font-medium">By field</h2></div>
            <Table head={['Field', { label: 'ha', right: true }, { label: 'Cost', right: true }, { label: 'Cost/ha', right: true }]} empty="No field costs yet.">
              {s.by_field.map(f => <tr key={f.field_no}><Td className="font-medium"><RecLink kind="field" code={f.field_no} /></Td><Td right>{fmt.num(f.area_ha, 2)}</Td><Td right>{fmt.money(f.cost, cur)}</Td><Td right>{fmt.money(f.cost_per_ha, cur)}</Td></tr>)}</Table></Card>
        </div></>}
    </>
  )
}
