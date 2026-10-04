import { Fragment, useEffect, useState } from 'react'
import { activateContract, addAdvance, addObligation, cancelContract, contractStatement, createContract, deleteAdvance, deleteObligation, listContractors, listContracts, reopenContract,
  setObligationDone, settleContract, updateContract, type ContractInput } from '../services/contracts'
import { listFields } from '../services/fields'
import { listInputs } from '../services/inventory'
import { useCan, useCtx, useData, useRun, fmt, today } from '../ui/hooks'
import { useSeasonPicker } from '../ui/season'
import { RecLink, useFocus } from '../ui/links'
import { Badge, Button, Card, Denied, Grid, Input, Label, Modal, NumberInput, PageHeader, Select, Stat, Table, Td, Textarea } from '../ui/kit'

const tone = (s: string) => (s === 'active' ? 'green' : s === 'settled' ? 'blue' : s === 'cancelled' ? 'gray' : 'amber') as 'green' | 'blue' | 'gray' | 'amber'

export default function Contracts() {
  const ctx = useCtx(); const can = useCan(); const run = useRun()
  const focus = useFocus('contract'); const { sid, picker } = useSeasonPicker(focus.seasonId)
  const rows = useData(c => listContracts(c, sid || undefined), [sid]); const contractors = useData(c => listContractors(c).filter(x => x.active)) ?? []
  const fields = useData(c => listFields(c)) ?? []
  const [edit, setEdit] = useState<(Partial<ContractInput> & { id?: string }) | null>(null); const [open, setOpen] = useState<string | null>(null)
  useEffect(() => { if (focus.id) setOpen(focus.id) }, [focus.id])
  if (!rows) return <Denied what="contracts" />
  const manage = can('contracts.contract.edit')
  const toggleField = (id: string) => setEdit(e => e && ({ ...e, field_ids: e.field_ids?.includes(id) ? e.field_ids.filter(x => x !== id) : [...(e.field_ids ?? []), id] }))

  return (
    <>
      <PageHeader title="Contract programmes" sub="Contractor agreements: targets, advances, obligations, deliveries and settlement" actions={<>{picker}
        {manage && <Button variant="primary" disabled={!sid || !contractors.length} reason={!contractors.length ? 'Register a contractor first' : undefined} onClick={() => setEdit({ season_id: sid, contractor_id: contractors[0].id, field_ids: [] })}>New contract</Button>}</>} />
      {!contractors.length && <Card className="p-4 mb-4 border-amber-300 bg-amber-50 text-amber-900">Register a contractor first (Contracts → Contractors).</Card>}
      <Card><Table head={['Contract', 'Contractor', 'Ref', 'Status', 'Variety', { label: 'Area ha', right: true }, { label: 'Target kg', right: true }, { label: 'Delivered', right: true }, { label: 'Advances', right: true }, { label: 'Balance', right: true }, 'Deadline', '']} empty="No contracts this season.">
        {rows.map(c => <tr key={c.id} {...focus.row(c.code)}><Td className="font-medium">{c.code}</Td><Td>{c.contractor}</Td><Td>{c.contract_no ?? '—'}</Td><Td><Badge tone={tone(c.status)}>{c.status}</Badge></Td><Td>{c.variety ?? '—'}</Td>
          <Td right>{fmt.num(c.area_ha, 1)}</Td><Td right>{fmt.num(c.target_kg)}</Td><Td right>{fmt.num(c.delivered_kg, 1)}{c.delivered_pct != null && <span className="text-gray-500"> · {c.delivered_pct}%</span>}</Td>
          <Td right>{fmt.money(c.advances_total)}</Td><Td right className={c.balance < 0 ? 'text-red-700' : ''}>{fmt.money(c.balance)}</Td><Td>{fmt.date(c.delivery_deadline)}</Td>
          <Td className="text-right"><Button small onClick={() => setOpen(c.id)}>Open</Button></Td></tr>)}</Table></Card>

      {edit && <Modal title={edit.id ? 'Edit contract' : 'New contract'} onClose={() => setEdit(null)} wide>
        <form className="space-y-3" onSubmit={e => { e.preventDefault(); const d = { ...edit, season_id: edit.season_id!, contractor_id: edit.contractor_id! }
          void run(() => edit.id ? updateContract(ctx, edit.id, d) : createContract(ctx, d), edit.id ? 'Contract updated' : 'Contract created').then(ok => ok && setEdit(null)) }}>
          <Grid cols={3}>
            <Label text="Contractor"><Select value={edit.contractor_id} onChange={e => setEdit({ ...edit, contractor_id: e.target.value })}>{contractors.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></Label>
            <Label text="Contractor's contract number"><Input value={edit.contract_no ?? ''} onChange={e => setEdit({ ...edit, contract_no: e.target.value })} /></Label>
            <Label text="Variety"><Input value={edit.variety ?? ''} onChange={e => setEdit({ ...edit, variety: e.target.value })} /></Label>
            <Label text="Contracted area (ha)"><NumberInput step="0.1" min={0} value={edit.area_ha} onChange={n => setEdit({ ...edit, area_ha: n })} /></Label>
            <Label text="Target production (kg)"><NumberInput min={0} value={edit.target_kg} onChange={n => setEdit({ ...edit, target_kg: n })} /></Label>
            <span />
            <Label text="Date signed"><Input type="date" value={edit.signed_on ?? ''} onChange={e => setEdit({ ...edit, signed_on: e.target.value || undefined })} /></Label>
            <Label text="Delivery deadline"><Input type="date" value={edit.delivery_deadline ?? ''} onChange={e => setEdit({ ...edit, delivery_deadline: e.target.value || undefined })} /></Label>
          </Grid>
          <div><div className="text-xs font-medium text-gray-600 mb-1">Fields under contract</div><div className="flex flex-wrap gap-3">{fields.map(f => <label key={f.id} className="flex items-center gap-1.5"><input type="checkbox" checked={!!edit.field_ids?.includes(f.id)} onChange={() => toggleField(f.id)} />{f.field_no} ({fmt.num(f.area_ha, 1)} ha)</label>)}</div></div>
          <Label text="Extension services provided"><Textarea value={edit.extension_services ?? ''} onChange={e => setEdit({ ...edit, extension_services: e.target.value })} /></Label>
          <Label text="Production obligations"><Textarea value={edit.production_obligations ?? ''} onChange={e => setEdit({ ...edit, production_obligations: e.target.value })} /></Label>
          <Label text="Delivery requirements"><Textarea value={edit.delivery_requirements ?? ''} onChange={e => setEdit({ ...edit, delivery_requirements: e.target.value })} /></Label>
          <div className="flex justify-end gap-2"><Button type="button" onClick={() => setEdit(null)}>Cancel</Button><Button variant="primary" type="submit">Save contract</Button></div>
        </form></Modal>}
      {open && <Statement id={open} onClose={() => { setOpen(null); focus.clear() }} onEdit={d => { setOpen(null); focus.clear(); setEdit(d) }} />}
    </>
  )
}

function Statement({ id, onClose, onEdit }: { id: string; onClose: () => void; onEdit: (d: Partial<ContractInput> & { id: string }) => void }) {
  const ctx = useCtx(); const can = useCan(); const run = useRun()
  const st = useData(c => contractStatement(c, id), [id]); const inputs = useData(c => listInputs(c)) ?? []
  const [adv, setAdv] = useState<{ kind: 'input' | 'cash' | 'service'; description?: string; input_id?: string; qty?: number; value?: number; advanced_on: string } | null>(null)
  const [ob, setOb] = useState<{ kind: 'production' | 'delivery' | 'extension' | 'other'; description: string; due_on?: string } | null>(null)
  const [settle, setSettle] = useState<{ settled_on: string; advances_recovered?: number; other_deductions?: number; notes?: string } | null>(null)
  if (!st) return null
  const s = st.summary; const edit = can('contracts.contract.edit'); const canSettle = can('contracts.contract.settle'); const live = s.status === 'draft' || s.status === 'active'
  const fullEdit = () => run(() => { const k = ctx.db.get<Record<string, string | null>>(`SELECT contract_no, variety, area_ha, target_kg, signed_on, delivery_deadline, extension_services, production_obligations, delivery_requirements FROM contracts WHERE id=?`, [id])!
    onEdit({ id, season_id: s.season_id, contractor_id: s.contractor_id, contract_no: k.contract_no ?? undefined, variety: k.variety ?? undefined, area_ha: (k.area_ha as unknown as number) ?? undefined, target_kg: (k.target_kg as unknown as number) ?? undefined,
      signed_on: k.signed_on ?? undefined, delivery_deadline: k.delivery_deadline ?? undefined, extension_services: k.extension_services ?? undefined, production_obligations: k.production_obligations ?? undefined,
      delivery_requirements: k.delivery_requirements ?? undefined, field_ids: st.fields.map(f => f.field_id) }) })
  const proceeds = s.delivered_net

  return (
    <Modal title={`${s.code} — ${s.contractor}`} onClose={onClose} wide>
      <div className="flex items-center gap-2 mb-3"><Badge tone={tone(s.status)}>{s.status}</Badge>{s.contract_no && <span className="text-gray-500">Ref {s.contract_no}</span>}
        {st.deadline_days != null && live && <span className={st.deadline_days < 0 ? 'text-red-700' : 'text-gray-500'}>{st.deadline_days < 0 ? `${-st.deadline_days} days past deadline` : `${st.deadline_days} days to delivery deadline`}</span>}
        <span className="ml-auto flex gap-2">{edit && live && <Button small onClick={() => void fullEdit()}>Edit</Button>}
          {edit && s.status === 'draft' && <Button small variant="primary" onClick={() => void run(() => activateContract(ctx, id), 'Contract activated')}>Activate</Button>}
          {edit && live && <Button small variant="danger" onClick={() => { if (window.confirm('Cancel this contract?')) void run(() => cancelContract(ctx, id), 'Contract cancelled') }}>Cancel</Button>}</span></div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3">
        <Stat label="Delivered" value={`${fmt.num(s.delivered_kg, 1)} kg`} sub={s.target_kg ? `${s.delivered_pct}% of ${fmt.num(s.target_kg)} kg` : undefined} />
        <Stat label="Delivered value (net)" value={fmt.money(proceeds)} sub={st.kg_per_contracted_ha != null ? `${fmt.num(st.kg_per_contracted_ha)} kg per contracted ha` : undefined} />
        <Stat label="Advances" value={fmt.money(s.advances_total)} sub={st.advances_by_kind.filter(k => k.value).map(k => `${k.kind} ${fmt.money(k.value)}`).join(' · ') || undefined} />
        <Stat label="Balance" value={fmt.money(s.balance)} sub={s.balance < 0 ? 'advances exceed deliveries' : 'due to farmer before settlement'} />
      </div>
      {st.fields.length > 0 && <p className="text-sm text-gray-600 mb-3">Fields: {st.fields.map((f, i) => <Fragment key={f.field_id}>{i > 0 && ', '}<RecLink kind="field" code={f.field_no} /> ({fmt.num(f.area_ha, 1)} ha)</Fragment>)} · {fmt.num(st.linked_ha, 1)} ha linked{s.area_ha ? ` of ${fmt.num(s.area_ha, 1)} ha contracted` : ''}</p>}
      {(st.extension_services || st.production_obligations || st.delivery_requirements) && <div className="text-sm text-gray-600 mb-3 space-y-1">
        {st.extension_services && <p><b>Extension:</b> {st.extension_services}</p>}{st.production_obligations && <p><b>Production:</b> {st.production_obligations}</p>}{st.delivery_requirements && <p><b>Delivery:</b> {st.delivery_requirements}</p>}</div>}

      <div className="flex items-center justify-between mb-1"><h3 className="font-medium">Advances & inputs supplied</h3>
        {edit && live && <Button small onClick={() => setAdv({ kind: 'input', advanced_on: today() })}>Add advance</Button>}</div>
      <Table head={['Date', 'Type', 'Description', { label: 'Value', right: true }, '']} empty="No advances recorded.">{st.advances.map(a => <tr key={a.id}><Td>{fmt.date(a.advanced_on)}</Td><Td>{a.kind}</Td><Td>{a.description}</Td><Td right>{fmt.money(a.value)}</Td>
        <Td className="text-right">{edit && live && <Button small variant="ghost" onClick={() => void run(() => deleteAdvance(ctx, a.id), 'Advance removed')}>Remove</Button>}</Td></tr>)}</Table>

      <div className="flex items-center justify-between mt-4 mb-1"><h3 className="font-medium">Obligations <span className="text-gray-500 font-normal">({st.obligations_open} open{st.obligations_overdue ? `, ${st.obligations_overdue} overdue` : ''})</span></h3>
        {edit && live && <Button small onClick={() => setOb({ kind: 'production', description: '' })}>Add obligation</Button>}</div>
      <Table head={['', 'Type', 'Obligation', 'Due', '']} empty="No obligations recorded.">{st.obligations.map(o => <tr key={o.id}>
        <Td><input type="checkbox" aria-label={`Done: ${o.description}`} disabled={!edit || !live} checked={!!o.done} onChange={e => void run(() => setObligationDone(ctx, o.id, e.target.checked, today()))} /></Td>
        <Td>{o.kind}</Td><Td className={o.done ? 'line-through text-gray-500' : ''}>{o.description}</Td><Td>{o.due_on && !o.done && o.due_on < today() ? <Badge tone="red">{fmt.date(o.due_on)}</Badge> : fmt.date(o.due_on)}</Td>
        <Td className="text-right">{edit && live && <Button small variant="ghost" onClick={() => void run(() => deleteObligation(ctx, o.id))}>Remove</Button>}</Td></tr>)}</Table>

      <h3 className="font-medium mt-4 mb-1">Deliveries</h3>
      <Table head={['Sale', 'Date', { label: 'kg', right: true }, { label: 'Gross', right: true }]} empty="Nothing delivered yet. Record a sale and choose this contract.">{st.deliveries.map(d => <tr key={d.code}><Td><RecLink kind="sale" code={d.code} /></Td><Td>{fmt.date(d.sold_on)}</Td><Td right>{fmt.num(d.kg, 1)}</Td><Td right>{fmt.money(d.gross)}</Td></tr>)}</Table>

      {st.settlement && <Card className="p-3 mt-4 bg-blue-50 border-blue-200"><div className="font-medium mb-1">Settled {fmt.date(st.settlement.settled_on)}</div>
        <div className="text-sm grid grid-cols-2 gap-x-6">
          <span>Delivered gross</span><span className="text-right">{fmt.money(st.settlement.delivered_gross)}</span><span>Sale deductions</span><span className="text-right">−{fmt.money(st.settlement.sale_deductions)}</span>
          <span>Advances recovered (of {fmt.money(st.settlement.advances_total)})</span><span className="text-right">−{fmt.money(st.settlement.advances_recovered)}</span><span>Other deductions</span><span className="text-right">−{fmt.money(st.settlement.other_deductions)}</span>
          <span className="font-medium">Net payable to farmer</span><span className="text-right font-medium">{fmt.money(st.settlement.net_payable)}</span>
          {st.settlement.shortfall > 0 && <><span className="text-red-700">Advance shortfall carried over</span><span className="text-right text-red-700">{fmt.money(st.settlement.shortfall)}</span></>}</div>
        {st.settlement.notes && <p className="text-sm text-gray-600 mt-1">{st.settlement.notes}</p>}
        {canSettle && <Button small className="mt-2" onClick={() => { if (window.confirm('Reopen this contract? The settlement is removed.')) void run(() => reopenContract(ctx, id), 'Contract reopened') }}>Reopen</Button>}</Card>}
      {canSettle && s.status === 'active' && <div className="mt-4 text-right"><Button variant="primary" onClick={() => setSettle({ settled_on: today(), advances_recovered: Math.min(s.advances_total, Math.max(0, proceeds)) })}>Settle contract</Button></div>}

      {adv && <Modal title="Add advance" onClose={() => setAdv(null)}>
        <form className="space-y-3" onSubmit={e => { e.preventDefault(); void run(() => addAdvance(ctx, { contract_id: id, ...adv, value: adv.value ?? 0 }), 'Advance recorded').then(ok => ok && setAdv(null)) }}>
          <Grid cols={2}>
            <Label text="Type"><Select value={adv.kind} onChange={e => setAdv({ ...adv, kind: e.target.value as typeof adv.kind })}><option value="input">Inputs supplied</option><option value="cash">Cash</option><option value="service">Service</option></Select></Label>
            <Label text="Date"><Input type="date" value={adv.advanced_on} onChange={e => setAdv({ ...adv, advanced_on: e.target.value })} required /></Label>
            {adv.kind === 'input' ? <>
              <Label text="Input"><Select value={adv.input_id ?? ''} onChange={e => setAdv({ ...adv, input_id: e.target.value })} required><option value="">Select…</option>{inputs.map(i => <option key={i.id} value={i.id}>{i.name} ({i.unit})</option>)}</Select></Label>
              <Label text="Quantity" hint="Received into stock"><NumberInput step="0.01" min={0} value={adv.qty} onChange={n => setAdv({ ...adv, qty: n })} required /></Label></>
              : <Label text="Description" className="col-span-2"><Input value={adv.description ?? ''} onChange={e => setAdv({ ...adv, description: e.target.value })} required /></Label>}
            <Label text="Value advanced"><NumberInput step="0.01" min={0} value={adv.value} onChange={n => setAdv({ ...adv, value: n })} required /></Label>
          </Grid>
          <div className="flex justify-end gap-2"><Button type="button" onClick={() => setAdv(null)}>Cancel</Button><Button variant="primary" type="submit">Save advance</Button></div></form></Modal>}
      {ob && <Modal title="Add obligation" onClose={() => setOb(null)}>
        <form className="space-y-3" onSubmit={e => { e.preventDefault(); void run(() => addObligation(ctx, { contract_id: id, ...ob }), 'Obligation added').then(ok => ok && setOb(null)) }}>
          <Grid cols={2}><Label text="Type"><Select value={ob.kind} onChange={e => setOb({ ...ob, kind: e.target.value as typeof ob.kind })}>{['production', 'delivery', 'extension', 'other'].map(k => <option key={k}>{k}</option>)}</Select></Label>
            <Label text="Due date"><Input type="date" value={ob.due_on ?? ''} onChange={e => setOb({ ...ob, due_on: e.target.value || undefined })} /></Label></Grid>
          <Label text="Obligation"><Input value={ob.description} onChange={e => setOb({ ...ob, description: e.target.value })} required /></Label>
          <div className="flex justify-end gap-2"><Button type="button" onClick={() => setOb(null)}>Cancel</Button><Button variant="primary" type="submit">Add</Button></div></form></Modal>}
      {settle && <Modal title="Settle contract" onClose={() => setSettle(null)}>
        <form className="space-y-3" onSubmit={e => { e.preventDefault(); void run(() => settleContract(ctx, id, { ...settle, advances_recovered: settle.advances_recovered ?? 0 }), 'Contract settled').then(ok => ok && setSettle(null)) }}>
          <p className="text-sm text-gray-600">Delivered net {fmt.money(proceeds)} · advances {fmt.money(s.advances_total)}. Enter what the contractor actually recovered; any difference is recorded as a shortfall.</p>
          <Grid cols={2}><Label text="Settlement date"><Input type="date" value={settle.settled_on} onChange={e => setSettle({ ...settle, settled_on: e.target.value })} required /></Label>
            <Label text="Advances recovered"><NumberInput step="0.01" min={0} value={settle.advances_recovered} onChange={n => setSettle({ ...settle, advances_recovered: n })} required /></Label>
            <Label text="Other deductions"><NumberInput step="0.01" min={0} value={settle.other_deductions} onChange={n => setSettle({ ...settle, other_deductions: n })} /></Label></Grid>
          <Label text="Notes"><Textarea value={settle.notes ?? ''} onChange={e => setSettle({ ...settle, notes: e.target.value })} /></Label>
          <div className="flex justify-end gap-2"><Button type="button" onClick={() => setSettle(null)}>Cancel</Button><Button variant="primary" type="submit">Settle</Button></div></form></Modal>}
    </Modal>
  )
}
