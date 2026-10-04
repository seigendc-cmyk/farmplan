import { useState } from 'react'
import { SEEDBED_STATUSES, createSeedbed, listSeedbeds, nextSeedbedCode, updateSeedbed, type SeedbedInput, type SeedbedMetrics } from '../services/seedbeds'
import { listSeasons } from '../services/seasons'
import { listOperations } from '../services/operations'
import { useCan, useCtx, useData, useRun, fmt, today } from '../ui/hooks'
import { Badge, Button, Card, Denied, Grid, Input, Label, Modal, NumberInput, PageHeader, Select, Stat, Table, Td } from '../ui/kit'
import { RecordOperation } from './Operations'

type Draft = Omit<SeedbedInput, 'season_id'> & { id?: string; season_id: string }

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
  if (!rows) return <Denied what="seedbeds" />
  const manage = can('production.seedbed.edit'); const showCost = can('finance.cost.view')
  const totalSeedlings = rows.reduce((s, r) => s + (r.actual_seedlings ?? 0), 0)

  const statusTone = (s: string) => (['ready'].includes(s) ? 'green' : ['depleted', 'abandoned'].includes(s) ? 'gray' : 'blue') as 'green' | 'gray' | 'blue'
  async function save() {
    const e = edit!
    if (await run(() => e.id ? updateSeedbed(ctx, e.id, e) : createSeedbed(ctx, e), e.id ? 'Seedbed updated' : 'Seedbed created')) setEdit(null)
  }
  return (
    <>
      <PageHeader title="Seedbeds" sub="Register, diary and seedling output per bed"
        actions={<>{seasons.length > 0 && <Select value={sid} onChange={e => setSeasonId(e.target.value)} className="w-40">{seasons.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}</Select>}
          {manage && <Button variant="primary" disabled={!sid} onClick={() => setEdit({ season_id: sid, bed_count: 1, status: 'prepared', prepared_on: today(), code: nextSeedbedCode(ctx, sid) })}>New seedbed</Button>}</>} />
      {!seasons.length && <Card className="p-4 mb-4 border-amber-300 bg-amber-50 text-amber-900">Create a season first (Settings → Seasons).</Card>}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-4">
        <Stat label="Seedbeds" value={rows.length} /><Stat label="Seedlings produced" value={fmt.num(totalSeedlings)} />
        <Stat label="Total area" value={`${fmt.num(rows.reduce((s, r) => s + (r.area_m2 ?? 0), 0))} m²`} />
      </div>
      <Card><Table head={['Bed', 'Variety', 'Seed lot', { label: 'Beds', right: true }, { label: 'Area m²', right: true }, 'Sown', { label: 'Expected', right: true }, { label: 'Actual', right: true }, { label: 'Achieved', right: true }, ...(showCost ? [{ label: 'Cost', right: true }, { label: '/1000', right: true }] : []), 'Status', '']} empty="No seedbeds for this season.">
        {rows.map(r => (
          <tr key={r.id} className="hover:bg-gray-50">
            <Td className="font-medium">{r.code}</Td><Td>{r.variety ?? '—'}</Td><Td>{r.seed_lot ?? '—'}</Td><Td right>{r.bed_count}</Td><Td right>{fmt.num(r.area_m2, 1)}</Td>
            <Td>{fmt.date(r.sown_on)}</Td><Td right>{fmt.num(r.expected_seedlings)}</Td><Td right>{fmt.num(r.actual_seedlings)}</Td>
            <Td right>{r.achievement_pct == null ? '—' : `${r.achievement_pct}%`}</Td>
            {showCost && <><Td right>{fmt.money(r.total_cost)}</Td><Td right>{fmt.money(r.cost_per_1000_seedlings)}</Td></>}
            <Td><Badge tone={statusTone(r.status)}>{r.status}</Badge></Td>
            <Td className="text-right space-x-1 whitespace-nowrap">
              <Button small variant="ghost" onClick={() => setDiary(r)}>Diary</Button>
              {can('production.operation.record') && <Button small onClick={() => setRecording(r)}>Record</Button>}
              {manage && <Button small onClick={() => setEdit({ ...r })}>Edit</Button>}</Td></tr>))}
      </Table></Card>

      {edit && <Modal title={edit.id ? `Edit ${edit.code}` : 'New seedbed'} onClose={() => setEdit(null)} wide>
        <form className="space-y-3" onSubmit={e => { e.preventDefault(); void save() }}>
          <Grid cols={3}>
            <Label text="Seedbed ID"><Input value={edit.code ?? ''} onChange={e => setEdit({ ...edit, code: e.target.value })} required /></Label>
            <Label text="Variety"><Input value={edit.variety ?? ''} onChange={e => setEdit({ ...edit, variety: e.target.value })} /></Label>
            <Label text="Location"><Input value={edit.location ?? ''} onChange={e => setEdit({ ...edit, location: e.target.value })} /></Label>
            <Label text="Seed lot"><Input value={edit.seed_lot ?? ''} onChange={e => setEdit({ ...edit, seed_lot: e.target.value })} /></Label>
            <Label text="Seed supplier"><Input value={edit.seed_supplier ?? ''} onChange={e => setEdit({ ...edit, seed_supplier: e.target.value })} /></Label>
            <Label text="Number of beds"><NumberInput min={1} value={edit.bed_count} onChange={n => setEdit({ ...edit, bed_count: n ?? 1 })} /></Label>
            <Label text="Bed length (m)"><NumberInput step="0.1" value={edit.bed_length_m ?? undefined} onChange={n => setEdit({ ...edit, bed_length_m: n ?? null })} /></Label>
            <Label text="Bed width (m)"><NumberInput step="0.1" value={edit.bed_width_m ?? undefined} onChange={n => setEdit({ ...edit, bed_width_m: n ?? null })} /></Label>
            <Label text="Area m²" hint="Auto-calculated from dimensions if blank"><NumberInput step="0.1" value={edit.area_m2 ?? undefined} onChange={n => setEdit({ ...edit, area_m2: n ?? null })} /></Label>
            <Label text="Preparation date"><Input type="date" value={edit.prepared_on ?? ''} onChange={e => setEdit({ ...edit, prepared_on: e.target.value || null })} /></Label>
            <Label text="Sowing date"><Input type="date" value={edit.sown_on ?? ''} onChange={e => setEdit({ ...edit, sown_on: e.target.value || null })} /></Label>
            <Label text="Status"><Select value={edit.status} onChange={e => setEdit({ ...edit, status: e.target.value as Draft['status'] })}>{SEEDBED_STATUSES.map(s => <option key={s}>{s}</option>)}</Select></Label>
            <Label text="Expected seedlings"><NumberInput value={edit.expected_seedlings ?? undefined} onChange={n => setEdit({ ...edit, expected_seedlings: n ?? null })} /></Label>
            <Label text="Actual seedlings"><NumberInput value={edit.actual_seedlings ?? undefined} onChange={n => setEdit({ ...edit, actual_seedlings: n ?? null })} /></Label>
          </Grid>
          <div className="flex justify-end gap-2 pt-2"><Button type="button" onClick={() => setEdit(null)}>Cancel</Button><Button variant="primary" type="submit">Save seedbed</Button></div>
        </form></Modal>}

      {diary && <Modal title={`${diary.code} — operations diary`} onClose={() => setDiary(null)} wide>
        <Table head={['Date', 'Operation', 'Inputs', 'Operator', 'Weather', ...(showCost ? [{ label: 'Cost', right: true }] : []), 'Remarks']} empty="No operations recorded.">
          {ops?.map(o => <tr key={o.id}><Td>{fmt.date(o.occurred_on)}</Td><Td>{o.op_type}</Td><Td>{o.inputs || '—'}</Td><Td>{o.operator ?? '—'}</Td><Td>{o.weather ?? '—'}</Td>{showCost && <Td right>{fmt.money(o.cost)}</Td>}<Td>{o.remarks ?? ''}</Td></tr>)}</Table></Modal>}
      {recording && <RecordOperation target={{ type: 'seedbed', id: recording.id, label: recording.code }} seasonId={recording.season_id} onClose={() => setRecording(null)} />}
    </>
  )
}
