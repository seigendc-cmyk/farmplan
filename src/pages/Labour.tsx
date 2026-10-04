import { useState } from 'react'
import { deleteLabour, listLabour, recordLabour, type LabourInput } from '../services/labour'
import { listFields } from '../services/fields'
import { listSeasons } from '../services/seasons'
import { useCan, useCtx, useData, useRun, fmt, today } from '../ui/hooks'
import { Button, Card, Denied, Grid, Input, Label, Modal, NumberInput, PageHeader, Select, Stat, Table, Td } from '../ui/kit'
import { RecLink } from '../ui/links'

export default function Labour() {
  const ctx = useCtx(); const can = useCan(); const run = useRun()
  const seasons = useData(c => listSeasons(c)) ?? []; const fields = useData(c => can('production.field.view') ? listFields(c) : []) ?? []
  const [sid, setSid] = useState(''); const season = sid || seasons.find(s => s.status === 'active')?.id || seasons[0]?.id || ''
  const rows = useData(c => listLabour(c, { seasonId: season || undefined }), [season])
  const [edit, setEdit] = useState<Partial<LabourInput> | null>(null)
  if (!rows) return <Denied what="labour records" />
  const showPay = can('finance.cost.view'); const record = can('resources.labour.record')
  const hours = rows.reduce((s, r) => s + (r.hours ?? 0), 0); const pay = rows.reduce((s, r) => s + (r.pay_amount ?? 0), 0)
  return (
    <>
      <PageHeader title="Labour" sub="Who worked, on what, for how long. Pay flows into costs." actions={<>
        {seasons.length > 0 && <Select value={season} onChange={e => setSid(e.target.value)} className="w-40">{seasons.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}</Select>}
        {record && <Button variant="primary" disabled={!season} onClick={() => setEdit({ season_id: season, worked_on: today() })}>Record labour</Button>}</>} />
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-4"><Stat label="Entries" value={rows.length} /><Stat label="Hours" value={fmt.num(hours, 1)} />{showPay && <Stat label="Pay" value={fmt.money(pay)} />}</div>
      <Card><Table head={['Date', 'Worker', 'Task', 'Field', { label: 'Hours', right: true }, ...(showPay ? [{ label: 'Pay', right: true }] : []), 'Notes', '']} empty="No labour recorded for this season.">
        {rows.map(r => <tr key={r.id}><Td>{fmt.date(r.worked_on)}</Td><Td className="font-medium">{r.worker_name}</Td><Td>{r.task}</Td><Td><RecLink kind="field" code={r.field_no} /></Td><Td right>{fmt.num(r.hours, 1)}</Td>
          {showPay && <Td right>{fmt.money(r.pay_amount)}</Td>}<Td>{r.remarks ?? ''}</Td>
          <Td className="text-right">{record && <Button small variant="danger" onClick={() => { if (window.confirm('Delete this entry and its cost?')) void run(() => deleteLabour(ctx, r.id), 'Entry deleted') }}>Delete</Button>}</Td></tr>)}</Table></Card>
      {edit && <Modal title="Record labour" onClose={() => setEdit(null)}>
        <form className="space-y-3" onSubmit={async e => { e.preventDefault(); if (await run(() => recordLabour(ctx, edit as LabourInput), 'Labour recorded')) setEdit(null) }}>
          <Grid>
            <Label text="Worker"><Input value={edit.worker_name ?? ''} onChange={e => setEdit({ ...edit, worker_name: e.target.value })} required autoFocus /></Label>
            <Label text="Task"><Input value={edit.task ?? ''} onChange={e => setEdit({ ...edit, task: e.target.value })} required /></Label>
            <Label text="Date"><Input type="date" value={edit.worked_on ?? ''} onChange={e => setEdit({ ...edit, worked_on: e.target.value })} required /></Label>
            <Label text="Field (optional)"><Select value={edit.field_id ?? ''} onChange={e => setEdit({ ...edit, field_id: e.target.value || null })}><option value="">—</option>{fields.map(f => <option key={f.id} value={f.id}>{f.field_no}</option>)}</Select></Label>
            <Label text="Hours"><NumberInput step="any" min={0} value={edit.hours ?? undefined} onChange={n => setEdit({ ...edit, hours: n ?? null })} /></Label>
            {can('finance.cost.view') && <Label text="Pay"><NumberInput step="any" min={0} value={edit.pay_amount} onChange={n => setEdit({ ...edit, pay_amount: n })} /></Label>}
          </Grid>
          <div className="flex justify-end gap-2"><Button type="button" onClick={() => setEdit(null)}>Cancel</Button><Button variant="primary" type="submit">Save</Button></div>
        </form></Modal>}
    </>
  )
}
