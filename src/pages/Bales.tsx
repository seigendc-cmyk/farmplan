import { type ReactNode, useState } from 'react'
import { baleLineage, createBales, deleteBale, listBales, listGrades, unbaledOutputs } from '../services/quality'
import { useCan, useCtx, useData, useRun, fmt, today } from '../ui/hooks'
import { useSeasonPicker } from '../ui/season'
import { RecLink, useFocus } from '../ui/links'
import { Qr } from '../ui/Qr'
import { Badge, Button, Card, Denied, Grid, Input, Label, Modal, NumberInput, PageHeader, Select, Stat, Table, Td } from '../ui/kit'

export default function Bales() {
  const ctx = useCtx(); const can = useCan(); const run = useRun()
  const focus = useFocus('bale'); const { sid, picker } = useSeasonPicker(focus.seasonId)
  const [status, setStatus] = useState(''); const [gradeId, setGradeId] = useState('')
  const rows = useData(c => listBales(c, { seasonId: sid || undefined, status: status || undefined, gradeId: gradeId || undefined }), [sid, status, gradeId])
  const grades = useData(c => listGrades(c)) ?? []; const open = useData(c => unbaledOutputs(c)) ?? []
  const [make, setMake] = useState<{ output_id: string; baled_on: string; count?: number; each?: number } | null>(null)
  const [label, setLabel] = useState<string | null>(null); const [scan, setScan] = useState(''); const [traceCode, setTraceCode] = useState<string | null>(null)
  if (!rows) return <Denied what="bales" />
  const record = can('quality.bale.record'); const out = open.find(o => o.output_id === make?.output_id)
  const kg = rows.reduce((s, b) => s + b.weight_kg, 0)

  return (
    <>
      <PageHeader title="Bales" sub="Every bale carries a QR code that traces back to field, barn and storage" actions={<>{picker}
        {record && <Button variant="primary" disabled={!open.length} reason={!open.length ? 'No graded leaf is waiting to be baled' : undefined} onClick={() => setMake({ output_id: open[0].output_id, baled_on: today() })}>Create bales</Button>}</>} />
      <Card className="p-3 mb-4 flex gap-2 items-end">
        <Label text="Scan or type a bale code" className="flex-1"><Input value={scan} onChange={e => setScan(e.target.value)} placeholder="TB26-F04-B000123" /></Label>
        <Button disabled={!scan.trim()} onClick={() => setTraceCode(scan.trim())}>Trace</Button></Card>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-4"><Stat label="Bales" value={rows.length} /><Stat label="Weight" value={`${fmt.num(kg, 1)} kg`} /><Stat label="Unsold" value={rows.filter(b => b.status === 'baled').length} /></div>
      <div className="flex gap-2 mb-3"><Select aria-label="Status filter" className="w-40" value={status} onChange={e => setStatus(e.target.value)}><option value="">All statuses</option><option value="baled">In stock</option><option value="sold">Sold</option></Select>
        <Select aria-label="Grade filter" className="w-40" value={gradeId} onChange={e => setGradeId(e.target.value)}><option value="">All grades</option>{grades.map(g => <option key={g.id} value={g.id}>{g.code}</option>)}</Select></div>
      <Card><Table head={['Bale', 'Grade', { label: 'kg', right: true }, 'Baled', 'Field', 'Variety', 'Lot', 'Status', '']} empty="No bales yet.">
        {rows.map(b => <tr key={b.id} {...focus.row(b.code)}><Td className="font-mono text-xs font-medium">{b.code}</Td><Td>{b.grade}</Td><Td right>{fmt.num(b.weight_kg, 1)}</Td><Td>{fmt.date(b.baled_on)}</Td><Td><RecLink kind="field" code={b.field_no} /></Td><Td>{b.variety ?? '—'}</Td><Td><RecLink kind="lot" code={b.lot_code} /></Td>
          <Td>{b.status === 'sold' ? <><Badge>sold</Badge> <RecLink kind="sale" code={b.sale_code} /></> : <Badge tone="green">in stock</Badge>}</Td>
          <Td className="text-right space-x-1 whitespace-nowrap"><Button small onClick={() => setLabel(b.code)}>Label</Button><Button small variant="ghost" onClick={() => setTraceCode(b.code)}>Trace</Button>
            {record && b.status === 'baled' && <Button small variant="danger" onClick={() => { if (window.confirm(`Delete ${b.code}?`)) void run(() => deleteBale(ctx, b.id), 'Bale deleted') }}>Delete</Button>}</Td></tr>)}</Table></Card>

      {make && <Modal title="Create bales" onClose={() => setMake(null)}>
        <form className="space-y-3" onSubmit={e => { e.preventDefault(); const n = make.count ?? 0, w = make.each ?? 0
          void run(() => createBales(ctx, { output_id: make.output_id, baled_on: make.baled_on, weights: Array.from({ length: n }, () => w) }), `${n} bale${n === 1 ? '' : 's'} created`).then(ok => ok && setMake(null)) }}>
          <Label text="Graded leaf"><Select value={make.output_id} onChange={e => setMake({ ...make, output_id: e.target.value })}>{open.map(o => <option key={o.output_id} value={o.output_id}>{o.lot_code} · grade {o.grade} · {fmt.num(o.remaining_kg, 1)} kg left</option>)}</Select></Label>
          <Grid cols={3}>
            <Label text="Baling date"><Input type="date" value={make.baled_on} onChange={e => setMake({ ...make, baled_on: e.target.value })} required /></Label>
            <Label text="Number of bales"><NumberInput min={1} max={500} value={make.count} onChange={n => setMake({ ...make, count: n })} required /></Label>
            <Label text="Weight each (kg)" hint={out ? `Up to ${fmt.num(out.remaining_kg, 1)} kg in total` : undefined}><NumberInput step="0.1" min={0} value={make.each} onChange={n => setMake({ ...make, each: n })} required /></Label>
          </Grid>
          <p className="text-xs text-gray-500">For bales of different weights, create them in separate batches.</p>
          <div className="flex justify-end gap-2"><Button type="button" onClick={() => setMake(null)}>Cancel</Button><Button variant="primary" type="submit">Create</Button></div>
        </form></Modal>}

      {label && <Modal title="Bale label" onClose={() => setLabel(null)}>
        <div className="flex flex-col items-center gap-2 print:p-0"><Qr value={label} size={200} /><div className="font-mono text-lg">{label}</div>
          <Button onClick={() => window.print()}>Print</Button></div></Modal>}
      {traceCode && <Trace code={traceCode} onClose={() => setTraceCode(null)} />}
    </>
  )
}

const join = (items: ReactNode[], sep: string) => items.length ? items.map((x, i) => <span key={i}>{i > 0 && sep}{x}</span>) : '—'

function Trace({ code, onClose }: { code: string; onClose: () => void }) {
  const t = useData(c => { try { return { ok: baleLineage(c, code) } } catch (e) { return { err: e instanceof Error ? e.message : String(e) } } }, [code])
  return (
    <Modal title={`Trace ${code}`} onClose={onClose} wide>
      {!t || 'err' in t ? <p className="text-red-700">{t && 'err' in t ? t.err : 'Not available'}</p> : (() => { const l = t.ok; return (
        <div className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5">
          {([['Bale', `${l.bale.code} · grade ${l.bale.grade} · ${fmt.num(l.bale.weight_kg, 1)} kg · baled ${fmt.date(l.bale.baled_on)}`], ['Farm / season', `${l.farm} · ${l.season}`],
            ['Fields', join(l.fields.map(f => <RecLink key={f} kind="field" code={f} />), ', ')], ['Variety', l.varieties.join(', ') || '—'],
            ['Harvest batches', join(l.harvests.map(h => <span key={h.code}><RecLink kind="harvest" code={h.code} /> ({h.field_no}, {fmt.date(h.harvested_on)}, {fmt.num(h.kg)} kg)</span>), '; ')],
            ['Barn / curing cycle', <>{l.barn_code} · <RecLink kind="cycle" code={l.cycle_code} /></>],
            ['Storage', <><RecLink kind="storage" code={l.unit_code} /> ({l.unit_kind === 'slate_pack' ? 'slate pack' : 'pile'})</>], ['Grading lot', <><RecLink kind="lot" code={l.lot_code} /> · {fmt.date(l.graded_on)}</>],
            ['Sale', l.sale ? <><RecLink kind="sale" code={l.sale.code} /> · {fmt.date(l.sale.sold_on)}{l.sale.buyer && <> · {l.sale.buyer_id ? <RecLink kind="buyer" code={l.sale.buyer} /> : l.sale.buyer}</>}</> : 'Not sold']] as [string, ReactNode][])
            .map(([k, v]) => <div key={k} className="contents"><div className="text-gray-500">{k}</div><div>{v}</div></div>)}</div>) })()}
    </Modal>
  )
}
