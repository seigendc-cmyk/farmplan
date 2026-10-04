import { useState } from 'react'
import { DEFAULT_MATURITY_DAYS, createStorageUnit, listStorage, openStorageUnit, unstoredByCycle, type StorageInput } from '../services/storage'
import { useCan, useCtx, useData, useRun, fmt, today } from '../ui/hooks'
import { useSeasonPicker } from '../ui/season'
import { RecLink, useFocus } from '../ui/links'
import { Badge, Button, Card, Denied, Grid, Input, Label, Modal, NumberInput, PageHeader, Select, Stat, Table, Td, Textarea } from '../ui/kit'

export default function Starking() {
  const ctx = useCtx(); const can = useCan(); const run = useRun()
  const focus = useFocus('storage'); const { sid, picker } = useSeasonPicker(focus.seasonId)
  const rows = useData(c => listStorage(c, { seasonId: sid || undefined }), [sid])
  const unstored = useData(c => unstoredByCycle(c)) ?? []
  const [edit, setEdit] = useState<Partial<StorageInput> | null>(null)
  if (!rows) return <Denied what="starking and storage" />
  const manage = can('curing.storage.edit')
  const ready = rows.filter(r => r.stage === 'READY TO OPEN')
  const tone = (s: string) => (s === 'READY TO OPEN' ? 'green' : s === 'OPENED' ? 'gray' : 'amber') as 'green' | 'gray' | 'amber'
  const cyc = unstored.find(u => u.id === edit?.cycle_id)

  async function open(id: string, code: string, expected: string) {
    const early = today() < expected
    if (early && !window.confirm(`${code} is not due until ${fmt.date(expected)}. Open early?`)) return
    await run(() => openStorageUnit(ctx, id, today(), early), `${code} opened for grading`)
  }
  return (
    <>
      <PageHeader title="Starking & storage" sub="Slate packs and piles maturing before grading" actions={<>{picker}
        {manage && <Button variant="primary" disabled={!unstored.length} reason={!unstored.length ? 'No cured leaf waiting to be stored' : undefined} onClick={() => setEdit({ cycle_id: unstored[0].id, kind: 'slate_pack', created_on: today(), maturity_days: DEFAULT_MATURITY_DAYS })}>Store cured leaf</Button>}</>} />
      {unstored.length > 0 && <Card className="p-3 mb-4 border-amber-300 bg-amber-50 text-amber-900"><div className="font-medium">Cured leaf not yet stored</div>
        <ul className="text-sm mt-1">{unstored.map(u => <li key={u.id}><RecLink kind="cycle" code={u.code} /> ({u.barn_code}): {fmt.num(u.unstored_kg, 1)} kg of {fmt.num(u.cured_weight_kg, 1)} kg still unrecorded</li>)}</ul></Card>}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-4">
        <Stat label="Units" value={rows.length} /><Stat label="Ready to open" value={ready.length} />
        <Stat label="Maturing" value={`${fmt.num(rows.filter(r => r.stage === 'MATURING').reduce((s, r) => s + r.weight_kg, 0), 1)} kg`} />
      </div>
      <Card><Table head={['Unit', 'Type', 'Cycle', { label: 'Weight kg', right: true }, 'Location', 'Stored', 'Opens', { label: 'Age d', right: true }, 'Stage', 'Next action', '']} empty="Nothing in storage for this season.">
        {rows.map(r => <tr key={r.id} {...focus.row(r.code)}><Td className="font-medium">{r.code}</Td><Td>{r.kind === 'slate_pack' ? 'Slate pack' : 'Pile'}</Td><Td><RecLink kind="cycle" code={r.cycle_code} /></Td><Td right>{fmt.num(r.weight_kg, 1)}</Td><Td>{r.location ?? '—'}</Td>
          <Td>{fmt.date(r.created_on)}</Td><Td>{fmt.date(r.expected_open_on)}</Td><Td right>{r.age_days}</Td><Td><Badge tone={tone(r.stage)}>{r.stage}</Badge></Td><Td>{r.next_action}</Td>
          <Td className="text-right">{manage && r.status === 'maturing' && <Button small onClick={() => void open(r.id, r.code, r.expected_open_on)}>Open for grading</Button>}</Td></tr>)}</Table></Card>

      {edit && <Modal title="Store cured leaf" onClose={() => setEdit(null)}>
        <form className="space-y-3" onSubmit={e => { e.preventDefault(); void run(() => createStorageUnit(ctx, { ...edit, weight_kg: edit.weight_kg ?? 0 } as StorageInput), 'Stored — maturing started').then(ok => ok && setEdit(null)) }}>
          <Grid cols={2}>
            <Label text="Curing cycle"><Select value={edit.cycle_id} onChange={e => setEdit({ ...edit, cycle_id: e.target.value })}>{unstored.map(u => <option key={u.id} value={u.id}>{u.code} ({fmt.num(u.unstored_kg, 1)} kg left)</option>)}</Select></Label>
            <Label text="Type"><Select value={edit.kind} onChange={e => setEdit({ ...edit, kind: e.target.value as 'slate_pack' | 'pile' })}><option value="slate_pack">Slate pack</option><option value="pile">Pile</option></Select></Label>
            <Label text="Weight (kg)" hint={cyc ? `Up to ${fmt.num(cyc.unstored_kg, 1)} kg` : undefined}><NumberInput step="0.1" min={0} value={edit.weight_kg} onChange={n => setEdit({ ...edit, weight_kg: n })} required /></Label>
            <Label text="Date stored"><Input type="date" value={edit.created_on ?? ''} onChange={e => setEdit({ ...edit, created_on: e.target.value })} required /></Label>
            <Label text="Maturity period (days)"><NumberInput min={1} max={365} value={edit.maturity_days} onChange={n => setEdit({ ...edit, maturity_days: n })} /></Label>
            <Label text="Location"><Input value={edit.location ?? ''} onChange={e => setEdit({ ...edit, location: e.target.value })} /></Label>
            <Label text="Condition"><Input value={edit.condition ?? ''} onChange={e => setEdit({ ...edit, condition: e.target.value })} /></Label>
          </Grid>
          <Label text="Remarks"><Textarea value={edit.remarks ?? ''} onChange={e => setEdit({ ...edit, remarks: e.target.value })} /></Label>
          <div className="flex justify-end gap-2"><Button type="button" onClick={() => setEdit(null)}>Cancel</Button><Button variant="primary" type="submit">Save</Button></div>
        </form></Modal>}
    </>
  )
}
