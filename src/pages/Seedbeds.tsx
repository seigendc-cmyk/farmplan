import { useState } from 'react'
import { Link } from 'react-router-dom'
import { SEEDBED_STATUSES, createSeedbed, listSeedbeds, nextSeedbedCode, updateSeedbed, type SeedbedInput, type SeedbedMetrics } from '../services/seedbeds'
import { TRAY_STATUSES, createTray, deleteTray, listTrays, updateTray, type Tray } from '../services/trays'
import { listTrayTypes } from '../services/traytypes'
import { listSeasons } from '../services/seasons'
import { listOperations } from '../services/operations'
import { useCan, useCtx, useData, useRun, fmt, today } from '../ui/hooks'
import { Badge, Button, Card, Denied, Grid, Input, Label, Modal, NumberInput, PageHeader, Select, Stat, Table, Td } from '../ui/kit'
import { RecordOperation } from './Operations'

type Draft = Omit<SeedbedInput, 'season_id'> & { id?: string; season_id: string }
type TrayDraft = { id?: string; tray_type_id: string; code: string; variety: string; sown_on: string; status: string; expected_seedlings?: number; actual_seedlings?: number }

export default function Seedbeds() {
  const ctx = useCtx(); const can = useCan(); const run = useRun()
  const seasons = useData(c => listSeasons(c)) ?? []
  const active = seasons.find(s => s.status === 'active')
  const [seasonId, setSeasonId] = useState<string>('')
  const sid = seasonId || active?.id || seasons[0]?.id || ''
  const rows = useData(c => listSeedbeds(c, sid || undefined), [sid])
  const [edit, setEdit] = useState<Draft | null>(null)
  const [diary, setDiary] = useState<SeedbedMetrics | null>(null)
  const [recording, setRecording] = useState<SeedbedMetrics | null>(null)
  const ops = useData(c => diary ? listOperations(c, { targetType: 'seedbed', targetId: diary.id }) : [], [diary])
  const [bayId, setBayId] = useState<string | null>(null); const [tray, setTray] = useState<TrayDraft | null>(null)
  const trays = useData(c => bayId ? listTrays(c, bayId) : [], [bayId]) ?? []; const trayTypes = useData(c => listTrayTypes(c), []) ?? []
  if (!rows) return <Denied what="seedbeds" />
  const manage = can('production.seedbed.edit'); const showCost = can('finance.cost.view')
  const totalSeedlings = rows.reduce((s, r) => s + (r.actual_seedlings ?? 0), 0)

  const statusTone = (s: string) => (['ready'].includes(s) ? 'green' : ['depleted', 'abandoned'].includes(s) ? 'gray' : 'blue') as 'green' | 'gray' | 'blue'
  async function save() {
    const e = edit!
    if (await run(() => e.id ? updateSeedbed(ctx, e.id, e) : createSeedbed(ctx, e), e.id ? 'Seedbed updated' : 'Seedbed created')) setEdit(null)
  }
  const isBay = edit?.kind === 'float_bay'
  const bay = rows.find(r => r.id === bayId) ?? null
  async function saveTray() {
    const t = tray!; const v = { tray_type_id: t.tray_type_id, code: t.code, variety: t.variety, sown_on: t.sown_on || undefined, expected_seedlings: t.expected_seedlings, actual_seedlings: t.actual_seedlings }
    if (await run(() => t.id ? updateTray(ctx, t.id, { ...v, status: t.status }) : createTray(ctx, { ...v, seedbed_id: bay!.id }), t.id ? 'Tray updated' : 'Tray added')) setTray(null)
  }
  const editTray = (t: Tray) => setTray({ id: t.id, tray_type_id: t.tray_type_id, code: t.code, variety: t.variety ?? '', sown_on: t.sown_on ?? '', status: t.status, expected_seedlings: t.expected_seedlings ?? undefined, actual_seedlings: t.actual_seedlings ?? undefined })
  return (
    <>
      <PageHeader title="Seedbeds" sub="Register, diary and seedling output per bed"
        actions={<>{seasons.length > 0 && <Select value={sid} onChange={e => setSeasonId(e.target.value)} className="w-40">{seasons.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}</Select>}
          {manage && <Button variant="primary" disabled={!sid} onClick={() => setEdit({ season_id: sid, kind: 'open_bed', bed_count: 1, status: 'prepared', prepared_on: today(), code: nextSeedbedCode(ctx, sid) })}>New seedbed</Button>}</>} />
      {!seasons.length && <Card className="p-4 mb-4 border-amber-300 bg-amber-50 text-amber-900">Create a season first (Settings → Seasons).</Card>}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-4">
        <Stat label="Seedbeds" value={rows.length} /><Stat label="Seedlings produced" value={fmt.num(totalSeedlings)} />
        <Stat label="Total area" value={`${fmt.num(rows.reduce((s, r) => s + (r.area_m2 ?? 0), 0))} m²`} />
      </div>
      <Card><Table head={['Bed', 'Variety', 'Seed lot', { label: 'Beds', right: true }, { label: 'Area m²', right: true }, 'Sown', { label: 'Expected', right: true }, { label: 'Actual', right: true }, { label: 'Achieved', right: true }, ...(showCost ? [{ label: 'Cost', right: true }, { label: '/1000', right: true }] : []), 'Status', '']} empty="No seedbeds for this season.">
        {rows.map(r => (
          <tr key={r.id} className="hover:bg-gray-50">
            <Td className="font-medium">{r.code}{r.kind === 'float_bay' && <span className="ml-2 text-xs font-normal text-gray-500">Float bay</span>}</Td><Td>{r.variety ?? '—'}</Td><Td>{r.seed_lot ?? '—'}</Td><Td right>{r.kind === 'float_bay' ? '—' : r.bed_count}</Td><Td right>{fmt.num(r.area_m2, 1)}</Td>
            <Td>{fmt.date(r.sown_on)}</Td><Td right>{fmt.num(r.expected_seedlings)}</Td><Td right>{fmt.num(r.actual_seedlings)}</Td>
            <Td right>{r.achievement_pct == null ? '—' : `${r.achievement_pct}%`}</Td>
            {showCost && <><Td right>{fmt.money(r.total_cost)}</Td><Td right>{fmt.money(r.cost_per_1000_seedlings)}</Td></>}
            <Td><Badge tone={statusTone(r.status)}>{r.status}</Badge></Td>
            <Td className="text-right space-x-1 whitespace-nowrap">
              <Button small variant="ghost" onClick={() => setDiary(r)}>Diary</Button>
              {r.kind === 'float_bay' && <Button small aria-label={`Trays ${r.code}`} onClick={() => setBayId(r.id)}>Trays</Button>}
              {can('production.operation.record') && r.kind !== 'float_bay' && <Button small onClick={() => setRecording(r)}>Record</Button>}
              {manage && <Button small onClick={() => setEdit({ ...r })}>Edit</Button>}</Td></tr>))}
      </Table></Card>

      {edit && <Modal title={edit.id ? `Edit ${edit.code}` : 'New seedbed'} onClose={() => setEdit(null)} wide>
        <form className="space-y-3" onSubmit={e => { e.preventDefault(); void save() }}>
          <Grid cols={3}>
            <Label text="Seedbed ID"><Input value={edit.code ?? ''} onChange={e => setEdit({ ...edit, code: e.target.value })} required /></Label>
            {!edit.id && <Label text="Kind"><Select value={edit.kind ?? 'open_bed'} onChange={e => setEdit({ ...edit, kind: e.target.value as Draft['kind'] })}><option value="open_bed">Open bed</option><option value="float_bay">Float bay</option></Select></Label>}
            <Label text="Variety"><Input value={edit.variety ?? ''} onChange={e => setEdit({ ...edit, variety: e.target.value })} /></Label>
            <Label text="Location"><Input value={edit.location ?? ''} onChange={e => setEdit({ ...edit, location: e.target.value })} /></Label>
            <Label text="Seed lot"><Input value={edit.seed_lot ?? ''} onChange={e => setEdit({ ...edit, seed_lot: e.target.value })} /></Label>
            <Label text="Seed supplier"><Input value={edit.seed_supplier ?? ''} onChange={e => setEdit({ ...edit, seed_supplier: e.target.value })} /></Label>
            {!isBay && <>
            <Label text="Number of beds"><NumberInput min={1} value={edit.bed_count} onChange={n => setEdit({ ...edit, bed_count: n ?? 1 })} /></Label>
            <Label text="Bed length (m)"><NumberInput step="0.1" value={edit.bed_length_m ?? undefined} onChange={n => setEdit({ ...edit, bed_length_m: n ?? null })} /></Label>
            <Label text="Bed width (m)"><NumberInput step="0.1" value={edit.bed_width_m ?? undefined} onChange={n => setEdit({ ...edit, bed_width_m: n ?? null })} /></Label>
            <Label text="Area m²" hint="Auto-calculated from dimensions if blank"><NumberInput step="0.1" value={edit.area_m2 ?? undefined} onChange={n => setEdit({ ...edit, area_m2: n ?? null })} /></Label>
            </>}
            <Label text="Preparation date"><Input type="date" value={edit.prepared_on ?? ''} onChange={e => setEdit({ ...edit, prepared_on: e.target.value || null })} /></Label>
            <Label text="Sowing date"><Input type="date" value={edit.sown_on ?? ''} onChange={e => setEdit({ ...edit, sown_on: e.target.value || null })} /></Label>
            <Label text="Status"><Select value={edit.status} onChange={e => setEdit({ ...edit, status: e.target.value as Draft['status'] })}>{SEEDBED_STATUSES.map(s => <option key={s}>{s}</option>)}</Select></Label>
            {!isBay && <>
            <Label text="Expected seedlings"><NumberInput value={edit.expected_seedlings ?? undefined} onChange={n => setEdit({ ...edit, expected_seedlings: n ?? null })} /></Label>
            <Label text="Actual seedlings"><NumberInput value={edit.actual_seedlings ?? undefined} onChange={n => setEdit({ ...edit, actual_seedlings: n ?? null })} /></Label>
            </>}
          </Grid>
          <div className="flex justify-end gap-2 pt-2"><Button type="button" onClick={() => setEdit(null)}>Cancel</Button><Button variant="primary" type="submit">Save seedbed</Button></div>
        </form></Modal>}

      {bay && <Modal title={`${bay.code} — trays`} onClose={() => { setBayId(null); setTray(null) }} wide>
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2"><div className="text-sm text-gray-700">{`Seedlings in this bay: ${fmt.num(bay.actual_seedlings)} counted, ${fmt.num(bay.expected_seedlings)} expected`}</div>
            {manage && trayTypes.length > 0 && <Button variant="primary" onClick={() => setTray({ tray_type_id: trayTypes[0].id, code: '', variety: '', sown_on: '', status: 'sown' })}>Add tray</Button>}</div>
          {manage && trayTypes.length === 0 && <div className="rounded border border-amber-300 bg-amber-50 text-amber-900 p-3 text-sm">Add a tray type first in <Link to="/tray-types" className="underline font-medium">Tray types</Link>, then trays can go in this bay.</div>}
          <Table head={['Tray', 'Type', 'Variety', 'Sown', { label: 'Expected', right: true }, { label: 'Counted', right: true }, { label: 'Available', right: true }, 'Status', '']} empty="No trays in this bay yet">
            {trays.map(t => <tr key={t.id}><Td className="font-medium">{t.code}</Td><Td>{t.tray_type}</Td><Td>{t.variety ?? '—'}</Td><Td>{fmt.date(t.sown_on)}</Td>
              <Td right>{fmt.num(t.expected_seedlings)}</Td><Td right>{fmt.num(t.actual_seedlings)}</Td><Td right>{fmt.num(t.available)}</Td><Td><Badge tone={statusTone(t.status)}>{t.status}</Badge></Td>
              <Td className="text-right space-x-1 whitespace-nowrap">{manage && <><Button small aria-label={`Edit ${t.code}`} onClick={() => editTray(t)}>Edit</Button>
                <Button small variant="danger" aria-label={`Remove ${t.code}`} onClick={() => confirm(`Remove tray ${t.code}?`) && run(() => deleteTray(ctx, t.id), 'Tray removed')}>Remove</Button></>}</Td></tr>)}</Table>
        </div></Modal>}
      {bay && tray && <Modal title={tray.id ? `Edit ${tray.code}` : 'Add tray'} onClose={() => setTray(null)}>
        <form noValidate className="space-y-3" onSubmit={e => { e.preventDefault(); void saveTray() }}>
          <Grid cols={2}>
            <Label text="Tray type"><Select value={tray.tray_type_id} onChange={e => setTray({ ...tray, tray_type_id: e.target.value })}>{trayTypes.map(t => <option key={t.id} value={t.id}>{t.name} ({t.cells} cells)</option>)}</Select></Label>
            <Label text="Code" hint="Leave blank for the next number"><Input value={tray.code} placeholder="T-001" onChange={e => setTray({ ...tray, code: e.target.value })} /></Label>
            <Label text="Variety"><Input value={tray.variety} onChange={e => setTray({ ...tray, variety: e.target.value })} /></Label>
            <Label text="Sown date"><Input type="date" value={tray.sown_on} onChange={e => setTray({ ...tray, sown_on: e.target.value })} /></Label>
            <Label text="Expected seedlings" hint="Defaults to the cells in the tray"><NumberInput value={tray.expected_seedlings} onChange={n => setTray({ ...tray, expected_seedlings: n ?? undefined })} /></Label>
            <Label text="Actual seedlings"><NumberInput value={tray.actual_seedlings} onChange={n => setTray({ ...tray, actual_seedlings: n ?? undefined })} /></Label>
            {tray.id && <Label text="Status"><Select value={tray.status} onChange={e => setTray({ ...tray, status: e.target.value })}>{TRAY_STATUSES.map(s => <option key={s}>{s}</option>)}</Select></Label>}
          </Grid>
          <div className="flex justify-end gap-2 pt-2"><Button type="button" onClick={() => setTray(null)}>Cancel</Button><Button variant="primary" type="submit">Save tray</Button></div>
        </form></Modal>}

      {diary && <Modal title={`${diary.code} — operations diary`} onClose={() => setDiary(null)} wide>
        <Table head={['Date', 'Operation', 'Inputs', 'Operator', 'Weather', ...(showCost ? [{ label: 'Cost', right: true }] : []), 'Remarks']} empty="No operations recorded.">
          {ops?.map(o => <tr key={o.id}><Td>{fmt.date(o.occurred_on)}</Td><Td>{o.op_type}</Td><Td>{o.inputs || '—'}</Td><Td>{o.operator ?? '—'}</Td><Td>{o.weather ?? '—'}</Td>{showCost && <Td right>{fmt.money(o.cost)}</Td>}<Td>{o.remarks ?? ''}</Td></tr>)}</Table></Modal>}
      {recording && <RecordOperation target={{ type: 'seedbed', id: recording.id, label: recording.code }} seasonId={recording.season_id} onClose={() => setRecording(null)} />}
    </>
  )
}
