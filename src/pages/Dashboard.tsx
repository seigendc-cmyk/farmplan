import { type ReactNode, useState } from 'react'
import { Link } from 'react-router-dom'
import { dashboard } from '../services/reports'
import { attention } from '../services/attention'
import { loadCloudConfig } from '../lib/cloud'
import { deviceTag } from '../services/device'
import { useCan, useCtx, useData, fmt } from '../ui/hooks'
import { Badge, Button, Card, Grid, PageHeader, Stat } from '../ui/kit'

/** A tile that opens its module, when the reader may open it. */
function Tile({ to, perm, children }: { to: string; perm?: string; children: ReactNode }) {
  const can = useCan()
  return perm && !can(perm) ? <>{children}</> : <Link to={to} className="block rounded-lg hover:ring-2 hover:ring-brand-200 focus-visible:ring-2 focus-visible:ring-brand-600">{children}</Link>
}

const SHOWN = 8

export default function Dashboard() {
  const ctx = useCtx(); const d = useData(c => dashboard(c)); const alerts = useData(c => attention(c)) ?? []
  const [all, setAll] = useState(false)
  if (!d) return null
  const cur = ctx.db.get<{ currency: string }>(`SELECT currency FROM farms WHERE id=?`, [ctx.farmId])?.currency
  const farm = ctx.db.get<{ name: string }>(`SELECT name FROM farms WHERE id=?`, [ctx.farmId])?.name
  const shown = all ? alerts : alerts.slice(0, SHOWN); const cloud = !!loadCloudConfig().url || deviceTag(ctx.db) !== ''
  return (
    <>
      <PageHeader title={farm ?? 'Dashboard'} sub={d.season ? `Active season ${d.season.label}` : 'No active season'} />
      {!d.season && <Card className="p-4 mb-4 border-amber-300 bg-amber-50 text-amber-900">No season is active. Create or activate one under <Link className="underline" to="/seasons">Settings → Seasons</Link>; every production record belongs to a season.</Card>}
      <Grid cols={4}>
        <Tile to="/fields" perm="production.field.view"><Stat label="Fields" value={fmt.num(d.fields)} sub={`${fmt.num(d.total_area_ha, 1)} ha total`} /></Tile>
        <Tile to="/seedbeds" perm="production.seedbed.view"><Stat label="Seedbeds this season" value={fmt.num(d.seedbeds)} /></Tile>
        <Tile to="/operations" perm="production.operation.view"><Stat label="Operations (30 days)" value={fmt.num(d.operations_30d)} /></Tile>
        <Tile to="/costs" perm="finance.cost.view"><Stat label="Season cost to date" value={d.season_cost == null ? '—' : fmt.money(d.season_cost, cur)} sub={d.stock_value != null ? `Stock on hand ${fmt.money(d.stock_value, cur)}` : undefined} /></Tile>
      </Grid>
      <div className="mt-3 grid grid-cols-2 sm:grid-cols-3 gap-3">
        <Tile to="/harvest" perm="production.harvest.view"><Stat label="Green leaf harvested" value={d.green_kg_season == null ? '—' : `${fmt.num(d.green_kg_season)} kg`} /></Tile>
        <Tile to="/curing" perm="curing.cycle.view"><Stat label="Barns curing" value={fmt.num(d.curing_active)} /></Tile>
        <Tile to="/starking" perm="curing.storage.view"><Stat label="Storage ready to open" value={fmt.num(d.storage_ready)} sub={d.storage_ready ? 'See Starking' : undefined} /></Tile>
        <Tile to="/grading" perm="quality.grading.view"><Stat label="Awaiting grading" value={fmt.num(d.ungraded_units)} /></Tile>
        <Tile to="/bales" perm="quality.bale.view"><Stat label="Unsold bales" value={fmt.num(d.bales_unsold)} /></Tile>
        <Tile to="/contracts" perm="contracts.contract.view"><Stat label="Active contracts" value={fmt.num(d.contracts_active)} /></Tile>
        <Tile to="/sales" perm="marketing.sale.view"><Stat label="Net revenue" value={d.net_revenue == null ? '—' : fmt.money(d.net_revenue, cur)} /></Tile>
      </div>
      <div className="grid md:grid-cols-3 gap-4 mt-4">
        <Card className="p-4 md:col-span-2"><h2 className="font-medium mb-2 flex items-center gap-2">Needs attention {alerts.length > 0 && <Badge tone={alerts[0].tone}>{alerts.length}</Badge>}</h2>
          {!alerts.length && <p className="text-gray-500">Nothing flagged. Overdue payments and obligations, leaf waiting at any step of the chain, budgets, services and stock show up here.</p>}
          <ul className="divide-y divide-gray-100" aria-label="Needs attention">
            {shown.map(a => <li key={a.key}><Link to={a.to} className="flex items-start gap-2 py-1.5 px-1 -mx-1 rounded hover:bg-gray-50">
              <span className="w-24 shrink-0"><Badge tone={a.tone}>{a.area}</Badge></span><span className="text-gray-800">{a.text}</span></Link></li>)}
          </ul>
          {alerts.length > SHOWN && <Button small variant="ghost" className="mt-2" onClick={() => setAll(!all)}>{all ? 'Show fewer' : `Show all ${alerts.length}`}</Button>}</Card>
        <Card className="p-4"><h2 className="font-medium mb-2">Data sync</h2>
          <p className="text-gray-600">{!d.pending_sync ? 'Everything is up to date.' : cloud ? `${d.pending_sync} local change${d.pending_sync > 1 ? 's' : ''} not yet sent to the cloud.`
            : `${d.pending_sync} change${d.pending_sync > 1 ? 's are' : ' is'} saved on this device. Cloud sync is not set up yet; set it up to keep a copy off this computer.`}</p>
          <Link className="text-brand-700 underline text-sm" to="/sync">Sync & backup</Link></Card>
      </div>
    </>
  )
}
