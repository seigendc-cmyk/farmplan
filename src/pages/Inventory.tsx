import { useState } from 'react'
import { INPUT_CATEGORIES, createInput, listInputs, listTransactions, recordAdjustment, recordPurchase, updateInput, type InputInput, type InputRow } from '../services/inventory'
import { useCan, useCtx, useData, useRun, fmt, today } from '../ui/hooks'
import { Badge, Button, Card, Denied, Grid, Input, Label, Modal, NumberInput, PageHeader, Select, Table, Td, Textarea } from '../ui/kit'
import { useFocus } from '../ui/links'

export default function Inventory() {
  const ctx = useCtx(); const can = useCan(); const run = useRun()
  const focus = useFocus('input'); const inputs = useData(c => listInputs(c)); const [tab, setTab] = useState<'stock' | 'ledger'>('stock')
  const txns = useData(c => tab === 'ledger' ? listTransactions(c) : [], [tab])
  const [edit, setEdit] = useState<(InputInput & { id?: string; active?: boolean }) | null>(null)
  const [buy, setBuy] = useState<{ input: InputRow; qty?: number; unit_cost?: number; occurred_on: string; batch_ref?: string; expiry_date?: string; note?: string } | null>(null)
  const [adj, setAdj] = useState<{ input: InputRow; qty_delta?: number; occurred_on: string; note: string } | null>(null)
  if (!inputs) return <Denied what="inventory" />
  const manage = can('resources.inventory.manage'); const money = can('finance.cost.view')
  const soon = new Date(Date.now() + 90 * 864e5).toISOString().slice(0, 10)

  return (
    <>
      <PageHeader title="Inventory" sub="Input catalogue and stock ledger. Purchases add stock; operations consume it."
        actions={<>{manage && <Button variant="primary" onClick={() => setEdit({ name: '', category: 'fertilizer', unit: 'kg', default_unit_cost: 0 })}>New product</Button>}</>} />
      <div className="flex gap-1 mb-3">{(['stock', 'ledger'] as const).map(t => <Button key={t} variant={tab === t ? 'primary' : 'secondary'} small onClick={() => setTab(t)}>{t === 'stock' ? 'Stock' : 'Transactions'}</Button>)}</div>

      {tab === 'stock' && <Card><Table head={['Product', 'Category', 'Supplier', { label: 'On hand', right: true }, 'Unit', { label: 'Reorder at', right: true }, ...(money ? [{ label: 'Avg cost', right: true }, { label: 'Value', right: true }] : []), 'Expiry', '']} empty="No products. Add your first input to the catalogue.">
        {inputs.map(r => (
          <tr key={r.id} {...focus.row(r.name, `hover:bg-gray-50 ${r.active ? '' : 'opacity-50'}`)}>
            <Td className="font-medium">{r.name}{!r.active && <span className="ml-2 text-xs text-gray-500">inactive</span>}</Td><Td className="capitalize">{r.category}</Td><Td>{r.supplier ?? '—'}</Td>
            <Td right><span className={r.on_hand <= 0 ? 'text-red-700' : ''}>{fmt.num(r.on_hand, 2)}</span>{r.reorder_level != null && r.on_hand > 0 && r.on_hand <= r.reorder_level && <> <Badge tone="amber">low</Badge></>}</Td><Td>{r.unit}</Td>
            <Td right>{r.reorder_level == null ? '—' : fmt.num(r.reorder_level, 2)}</Td>
            {money && <><Td right>{fmt.money(r.avg_cost)}</Td><Td right>{fmt.money(Math.max(0, r.on_hand) * r.avg_cost)}</Td></>}
            <Td>{r.next_expiry ? <Badge tone={r.next_expiry <= soon ? 'amber' : 'gray'}>{fmt.date(r.next_expiry)}</Badge> : '—'}</Td>
            <Td className="text-right space-x-1 whitespace-nowrap">{manage && <>
              <Button small onClick={() => setBuy({ input: r, unit_cost: r.avg_cost || r.default_unit_cost, occurred_on: today() })}>Purchase</Button>
              <Button small onClick={() => setAdj({ input: r, occurred_on: today(), note: '' })}>Adjust</Button>
              <Button small variant="ghost" onClick={() => setEdit({ ...r, category: r.category, supplier: r.supplier ?? undefined, application_notes: r.application_notes ?? undefined, safety_notes: r.safety_notes ?? undefined, active: !!r.active })}>Edit</Button></>}</Td></tr>))}
      </Table></Card>}

      {tab === 'ledger' && <Card><Table head={['Date', 'Product', 'Type', { label: 'Quantity', right: true }, ...(money ? [{ label: 'Unit cost', right: true }] : []), 'Batch', 'Note']} empty="No transactions yet.">
        {txns?.map(t => <tr key={t.id}><Td>{fmt.date(t.occurred_on)}</Td><Td>{t.input_name}</Td><Td className="capitalize">{t.kind}</Td>
          <Td right><span className={t.qty_delta < 0 ? 'text-red-700' : 'text-brand-700'}>{t.qty_delta > 0 ? '+' : ''}{fmt.num(t.qty_delta, 2)} {t.unit}</span></Td>
          {money && <Td right>{fmt.money(t.unit_cost)}</Td>}<Td>{t.batch_ref ?? '—'}</Td><Td>{t.note ?? ''}</Td></tr>)}</Table></Card>}

      {edit && <Modal title={edit.id ? `Edit ${edit.name}` : 'New product'} onClose={() => setEdit(null)}>
        <form className="space-y-3" onSubmit={async e => { e.preventDefault(); if (await run(() => edit.id ? updateInput(ctx, edit.id, edit) : createInput(ctx, edit), 'Product saved')) setEdit(null) }}>
          <Label text="Product name"><Input value={edit.name} onChange={e => setEdit({ ...edit, name: e.target.value })} required autoFocus /></Label>
          <Grid cols={3}>
            <Label text="Category"><Select value={edit.category} onChange={e => setEdit({ ...edit, category: e.target.value as InputInput['category'] })}>{INPUT_CATEGORIES.map(c => <option key={c}>{c}</option>)}</Select></Label>
            <Label text="Unit"><Input value={edit.unit} onChange={e => setEdit({ ...edit, unit: e.target.value })} placeholder="kg, L, bag" required /></Label>
            <Label text="Default price / unit"><NumberInput step="0.01" value={edit.default_unit_cost} onChange={n => setEdit({ ...edit, default_unit_cost: n ?? 0 })} /></Label></Grid>
          <Label text={`Reorder level (${edit.unit || 'units'})`} hint="The Dashboard flags this product as low when stock falls to this level. Leave empty to not track it.">
            <NumberInput step="0.01" min={0} value={edit.reorder_level ?? undefined} onChange={n => setEdit({ ...edit, reorder_level: n ?? null })} /></Label>
          <Label text="Supplier"><Input value={edit.supplier ?? ''} onChange={e => setEdit({ ...edit, supplier: e.target.value })} /></Label>
          <Label text="Application instructions" hint="Copy from the product label / approved protocol"><Textarea value={edit.application_notes ?? ''} onChange={e => setEdit({ ...edit, application_notes: e.target.value })} /></Label>
          <Label text="Safety information"><Textarea value={edit.safety_notes ?? ''} onChange={e => setEdit({ ...edit, safety_notes: e.target.value })} /></Label>
          {edit.id && <label className="flex items-center gap-2"><input type="checkbox" checked={edit.active !== false} onChange={e => setEdit({ ...edit, active: e.target.checked })} /> Active</label>}
          <div className="flex justify-end gap-2"><Button type="button" onClick={() => setEdit(null)}>Cancel</Button><Button variant="primary" type="submit">Save</Button></div>
        </form></Modal>}

      {buy && <Modal title={`Purchase — ${buy.input.name}`} onClose={() => setBuy(null)}>
        <form className="space-y-3" onSubmit={async e => { e.preventDefault(); if (await run(() => recordPurchase(ctx, { input_id: buy.input.id, qty: buy.qty ?? 0, unit_cost: buy.unit_cost ?? 0, occurred_on: buy.occurred_on, batch_ref: buy.batch_ref, expiry_date: buy.expiry_date || undefined, note: buy.note }), 'Stock received')) setBuy(null) }}>
          <Grid><Label text={`Quantity (${buy.input.unit})`}><NumberInput step="0.01" value={buy.qty} onChange={n => setBuy({ ...buy, qty: n })} required autoFocus /></Label>
            <Label text="Unit cost"><NumberInput step="0.0001" value={buy.unit_cost} onChange={n => setBuy({ ...buy, unit_cost: n })} required /></Label>
            <Label text="Date"><Input type="date" value={buy.occurred_on} onChange={e => setBuy({ ...buy, occurred_on: e.target.value })} required /></Label>
            <Label text="Batch / lot"><Input value={buy.batch_ref ?? ''} onChange={e => setBuy({ ...buy, batch_ref: e.target.value })} /></Label>
            <Label text="Expiry"><Input type="date" value={buy.expiry_date ?? ''} onChange={e => setBuy({ ...buy, expiry_date: e.target.value })} /></Label></Grid>
          <Label text="Note"><Input value={buy.note ?? ''} onChange={e => setBuy({ ...buy, note: e.target.value })} /></Label>
          <div className="flex justify-end gap-2"><Button type="button" onClick={() => setBuy(null)}>Cancel</Button><Button variant="primary" type="submit">Receive stock</Button></div>
        </form></Modal>}

      {adj && <Modal title={`Stock adjustment — ${adj.input.name}`} onClose={() => setAdj(null)}>
        <p className="text-gray-500 mb-3">On hand: {fmt.num(adj.input.on_hand, 2)} {adj.input.unit}. Use a negative number for losses.</p>
        <form className="space-y-3" onSubmit={async e => { e.preventDefault(); if (await run(() => recordAdjustment(ctx, { input_id: adj.input.id, qty_delta: adj.qty_delta ?? 0, occurred_on: adj.occurred_on, note: adj.note }), 'Adjustment recorded')) setAdj(null) }}>
          <Grid><Label text="Change"><NumberInput step="0.01" value={adj.qty_delta} onChange={n => setAdj({ ...adj, qty_delta: n })} required autoFocus /></Label>
            <Label text="Date"><Input type="date" value={adj.occurred_on} onChange={e => setAdj({ ...adj, occurred_on: e.target.value })} required /></Label></Grid>
          <Label text="Reason (required)"><Input value={adj.note} onChange={e => setAdj({ ...adj, note: e.target.value })} required /></Label>
          <div className="flex justify-end gap-2"><Button type="button" onClick={() => setAdj(null)}>Cancel</Button><Button variant="primary" type="submit">Record</Button></div>
        </form></Modal>}
    </>
  )
}
