import { useEffect, useState } from 'react'
import { CHANNELS, createSale, deletePayment, deleteSale, listSales, recordPayment, revenueSummary, saleDetail, type SaleInput } from '../services/marketing'
import { listBales } from '../services/quality'
import { listBuyers, suggestDeductions } from '../services/buyers'
import { useToasts } from '../store/app'
import { listContracts } from '../services/contracts'
import { useCan, useCtx, useData, useRun, fmt, today } from '../ui/hooks'
import { useSeasonPicker } from '../ui/season'
import { RecLink, useFocus } from '../ui/links'
import { Badge, Button, Card, Denied, Grid, Input, Label, Modal, NumberInput, PageHeader, Select, Stat, Table, Td } from '../ui/kit'

interface Draft { contract_id?: string; sold_on: string; channel: SaleInput['channel']; buyer: string; buyer_id: string; sale_ref: string; prices: Record<string, number | undefined>; deductions: { label: string; amount?: number }[] }

export default function Sales() {
  const ctx = useCtx(); const can = useCan(); const run = useRun()
  const focus = useFocus('sale'); const { sid, picker } = useSeasonPicker(focus.seasonId)
  const sales = useData(c => listSales(c, sid || undefined), [sid]); const rev = useData(c => sid ? revenueSummary(c, sid) : null, [sid])
  const stock = useData(c => listBales(c, { seasonId: sid || undefined, status: 'baled' }), [sid]) ?? []
  const contracts = useData(c => can('contracts.contract.view') ? listContracts(c, sid || undefined).filter(k => k.status === 'active') : [], [sid]) ?? []
  const buyers = useData(c => can('marketing.buyer.view') ? listBuyers(c, { activeOnly: true }) : [], []) ?? []; const push = useToasts(x => x.push)
  const [draft, setDraft] = useState<Draft | null>(null); const [view, setView] = useState<string | null>(null)
  useEffect(() => { if (focus.id) setView(focus.id) }, [focus.id])
  if (!sales) return <Denied what="sales" />
  const record = can('marketing.sale.record')
  const picked = draft ? stock.filter(b => draft.prices[b.id] != null) : []
  const chosen = draft?.buyer_id ? buyers.find(b => b.id === draft.buyer_id) : undefined
  const gross = picked.reduce((s, b) => s + b.weight_kg * (draft!.prices[b.id] ?? 0), 0); const ded = draft?.deductions.reduce((s, d) => s + (d.amount ?? 0), 0) ?? 0
  const credit = { after: (chosen?.outstanding ?? 0) + gross - ded, over: chosen?.credit_limit != null && (chosen.outstanding + gross - ded) > chosen.credit_limit + 0.005 }

  async function save() {
    const d = draft!
    let warnings: string[] = []
    if (await run(() => { warnings = createSale(ctx, { season_id: sid, sold_on: d.sold_on, channel: d.channel, contract_id: d.contract_id || undefined, buyer: d.buyer, buyer_id: d.buyer_id || undefined, sale_ref: d.sale_ref,
      lines: picked.map(b => ({ bale_id: b.id, price_per_kg: d.prices[b.id]! })), deductions: d.deductions.filter(x => x.label.trim()).map(x => ({ label: x.label, amount: x.amount ?? 0 })) }).warnings }, 'Sale recorded')) { setDraft(null); for (const w of warnings) push('err', `Credit limit: ${w}`) }
  }
  return (
    <>
      <PageHeader title="Sales" sub="Bales → marketing lot → sale, with deductions and payments" actions={<>{picker}
        {record && <Button variant="primary" disabled={!stock.length} reason={!stock.length ? 'No unsold bales this season' : undefined} onClick={() => setDraft({ sold_on: today(), channel: 'auction', buyer: '', buyer_id: '', sale_ref: '', prices: {}, deductions: [{ label: '' }] })}>Record sale</Button>}</>} />
      {rev && rev.kg > 0 && <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4"><Stat label="Net revenue" value={fmt.money(rev.net)} sub={`gross ${fmt.money(rev.gross)}`} /><Stat label="Average price / kg" value={fmt.money(rev.avg_price_per_kg)} sub={`${fmt.num(rev.kg, 1)} kg sold`} />
        <Stat label="Net / kg" value={fmt.money(rev.net_per_kg)} /><Stat label="Net / ha" value={fmt.money(rev.net_per_ha)} sub={`${fmt.num(rev.harvested_ha, 1)} ha harvested`} /></div>}
      <Card className="mb-4"><Table head={['Lot', 'Date', 'Channel', 'Buyer', 'Reference', { label: 'Bales', right: true }, { label: 'kg', right: true }, { label: 'Gross', right: true }, { label: 'Deductions', right: true }, { label: 'Net', right: true }, 'Payment', '']} empty="No sales this season.">
        {sales.map(s => <tr key={s.id} {...focus.row(s.code)}><Td className="font-medium">{s.code}</Td><Td>{fmt.date(s.sold_on)}</Td><Td>{s.channel}</Td><Td>{s.buyer_id ? <RecLink kind="buyer" code={s.buyer} /> : s.buyer ?? '—'}{s.contract_code && <div className="text-xs text-gray-500">contract <RecLink kind="contract" code={s.contract_code} /></div>}</Td><Td>{s.sale_ref ?? '—'}</Td><Td right>{s.bales}</Td><Td right>{fmt.num(s.weight_kg, 1)}</Td>
          <Td right>{fmt.money(s.gross)}</Td><Td right>{fmt.money(s.deductions)}</Td><Td right>{fmt.money(s.net)}</Td><Td><Badge tone={s.status === 'paid' ? 'green' : s.status === 'unpaid' ? 'red' : 'amber'}>{s.status}</Badge></Td>
          <Td className="text-right"><Button small onClick={() => setView(s.id)}>Open</Button></Td></tr>)}</Table></Card>
      {rev && rev.kg > 0 && <div className="grid md:grid-cols-3 gap-4">
        {([['Revenue by grade', rev.by_grade], ['Revenue by field', rev.by_field], ['Revenue by variety', rev.by_variety]] as const).map(([title, data]) =>
          <Card key={title}><div className="px-4 pt-3 font-medium">{title}</div><Table head={['', { label: 'kg', right: true }, { label: '$/kg', right: true }, { label: 'Net', right: true }]}>
            {data.map(r => <tr key={r.key}><Td className="font-medium">{title === 'Revenue by field' && r.key !== '—' ? <RecLink kind="field" code={r.key} /> : r.key}</Td><Td right>{fmt.num(r.kg, 1)}</Td><Td right>{fmt.money(r.avg_price)}</Td><Td right>{fmt.money(r.net)}</Td></tr>)}</Table></Card>)}</div>}

      {draft && <Modal title="Record sale" onClose={() => setDraft(null)} wide>
        <form className="space-y-3" onSubmit={e => { e.preventDefault(); void save() }}>
          <Grid cols={4}>
            <Label text="Sale date"><Input type="date" value={draft.sold_on} onChange={e => setDraft({ ...draft, sold_on: e.target.value })} required /></Label>
            <Label text="Channel"><Select value={draft.channel} onChange={e => setDraft({ ...draft, channel: e.target.value as Draft['channel'] })}>{CHANNELS.map(c => <option key={c}>{c}</option>)}</Select></Label>
            {contracts.length > 0 && <Label text="Delivery under contract"><Select value={draft.contract_id ?? ''} onChange={e => { const k = contracts.find(x => x.id === e.target.value); setDraft({ ...draft, contract_id: e.target.value || undefined, buyer: k ? k.contractor : draft.buyer }) }}><option value="">None (open market)</option>{contracts.map(k => <option key={k.id} value={k.id}>{k.code} · {k.contractor}</option>)}</Select></Label>}
            {buyers.length > 0 && <Label text="Buyer"><Select value={draft.buyer_id} onChange={e => { const b = buyers.find(x => x.id === e.target.value); setDraft({ ...draft, buyer_id: e.target.value, buyer: b ? b.name : draft.buyer }) }}><option value="">Not in the register…</option>{buyers.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}</Select></Label>}
            {!draft.buyer_id && <Label text="Buyer / market"><Input value={draft.buyer} onChange={e => setDraft({ ...draft, buyer: e.target.value })} /></Label>}
            <Label text="Sale reference"><Input value={draft.sale_ref} onChange={e => setDraft({ ...draft, sale_ref: e.target.value })} /></Label>
          </Grid>
          <div className="font-medium">Bales sold <span className="text-gray-500 font-normal">— enter a price per kg to include a bale</span></div>
          <div className="max-h-56 overflow-y-auto border border-gray-200 rounded-md"><Table head={['Bale', 'Grade', { label: 'kg', right: true }, { label: 'Price / kg', right: true }]} empty="No unsold bales.">
            {stock.map(b => <tr key={b.id}><Td className="font-mono text-xs">{b.code}</Td><Td>{b.grade}</Td><Td right>{fmt.num(b.weight_kg, 1)}</Td>
              <Td right><NumberInput aria-label={`Price for ${b.code}`} step="0.01" min={0} className="w-28 text-right" value={draft.prices[b.id]} onChange={n => setDraft({ ...draft, prices: { ...draft.prices, [b.id]: n } })} /></Td></tr>)}</Table></div>
          <div className="font-medium">Deductions</div>
          {draft.deductions.map((d, i) => <div key={i} className="grid grid-cols-[1fr_8rem] gap-2"><Input aria-label="Deduction label" placeholder="Levy, commission…" value={d.label} onChange={e => setDraft({ ...draft, deductions: draft.deductions.map((x, j) => j === i ? { ...x, label: e.target.value } : x) })} />
            <NumberInput aria-label="Deduction amount" step="0.01" min={0} value={d.amount} onChange={n => setDraft({ ...draft, deductions: draft.deductions.map((x, j) => j === i ? { ...x, amount: n } : x) })} /></div>)}
          <div className="flex gap-2"><Button type="button" small onClick={() => setDraft({ ...draft, deductions: [...draft.deductions, { label: '' }] })}>+ Add deduction</Button>
            {chosen && chosen.deductions.length > 0 && <Button type="button" small disabled={!gross} onClick={() => setDraft({ ...draft, deductions: suggestDeductions(ctx, chosen.id, gross).map(x => ({ label: x.label, amount: x.amount })) })}>Use {chosen.name}'s default deductions</Button>}</div>
          {chosen && <div className={`text-sm rounded px-3 py-2 border ${credit.over ? 'bg-amber-50 border-amber-300 text-amber-900' : 'bg-gray-50 border-gray-200 text-gray-600'}`}>{chosen.name}: {chosen.payment_terms_days != null ? `pays within ${chosen.payment_terms_days} days · ` : ''}currently owes {fmt.money(chosen.outstanding)}{chosen.credit_limit != null ? ` of ${fmt.money(chosen.credit_limit)} limit · after this sale ${fmt.money(credit.after)}${credit.over ? ' — over the limit (you can still save)' : ''}` : ''}</div>}
          <div className="text-sm bg-gray-50 border border-gray-200 rounded px-3 py-2">{picked.length} bale(s) · gross <b>{fmt.money(gross)}</b> · deductions {fmt.money(ded)} · net <b>{fmt.money(gross - ded)}</b></div>
          <div className="flex justify-end gap-2"><Button type="button" onClick={() => setDraft(null)}>Cancel</Button><Button variant="primary" type="submit" disabled={!picked.length}>Save sale</Button></div>
        </form></Modal>}
      {view && <SaleModal id={view} onClose={() => { setView(null); focus.clear() }} canRecord={record} />}
    </>
  )
}

function SaleModal({ id, onClose, canRecord }: { id: string; onClose: () => void; canRecord: boolean }) {
  const ctx = useCtx(); const run = useRun(); const d = useData(c => { try { return saleDetail(c, id) } catch { return null } }, [id])
  const [pay, setPay] = useState<{ paid_on: string; amount?: number; method?: string; reference?: string } | null>(null)
  if (!d) return null
  const s = d.sale
  return (
    <Modal title={`${s.code}${s.sale_ref ? ` · ${s.sale_ref}` : ''}`} onClose={onClose} wide>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3"><Stat label="Gross" value={fmt.money(s.gross)} /><Stat label="Deductions" value={fmt.money(s.deductions)} /><Stat label="Net" value={fmt.money(s.net)} /><Stat label="Outstanding" value={fmt.money(s.outstanding)} sub={s.status} /></div>
      <p className="text-sm text-gray-600 mb-3">Sold {fmt.date(s.sold_on)} · {s.channel}{s.buyer && <> · to {s.buyer_id ? <RecLink kind="buyer" code={s.buyer} /> : s.buyer}</>}{s.contract_code && <> · under contract <RecLink kind="contract" code={s.contract_code} /></>}</p>
      <Table head={['Bale', 'Grade', { label: 'kg', right: true }, { label: 'Price', right: true }, { label: 'Gross', right: true }]}>{d.lines.map(l => <tr key={l.bale_code}><Td className="font-mono text-xs"><RecLink kind="bale" code={l.bale_code} /></Td><Td>{l.grade}</Td><Td right>{fmt.num(l.weight_kg, 1)}</Td><Td right>{fmt.money(l.price_per_kg)}</Td><Td right>{fmt.money(l.gross)}</Td></tr>)}</Table>
      {d.deductions.length > 0 && <p className="text-sm text-gray-600 mt-2">Deductions: {d.deductions.map(x => `${x.label} ${fmt.money(x.amount)}`).join(' · ')}</p>}
      <div className="flex items-center justify-between mt-4 mb-1"><h3 className="font-medium">Payments</h3>
        {canRecord && s.outstanding > 0 && <Button small variant="primary" onClick={() => setPay({ paid_on: today(), amount: s.outstanding })}>Record payment</Button>}</div>
      <Table head={['Date', { label: 'Amount', right: true }, 'Method', 'Reference', '']} empty="No payments yet.">{d.payments.map(p => <tr key={p.id}><Td>{fmt.date(p.paid_on)}</Td><Td right>{fmt.money(p.amount)}</Td><Td>{p.method ?? '—'}</Td><Td>{p.reference ?? '—'}</Td>
        <Td className="text-right">{canRecord && <Button small variant="ghost" onClick={() => void run(() => deletePayment(ctx, p.id), 'Payment removed')}>Remove</Button>}</Td></tr>)}</Table>
      {pay && <form className="grid grid-cols-2 sm:grid-cols-5 gap-2 items-end mt-3" onSubmit={e => { e.preventDefault(); void run(() => recordPayment(ctx, id, { ...pay, amount: pay.amount ?? 0 }), 'Payment recorded').then(ok => ok && setPay(null)) }}>
        <Label text="Date"><Input type="date" value={pay.paid_on} onChange={e => setPay({ ...pay, paid_on: e.target.value })} required /></Label>
        <Label text="Amount"><NumberInput step="0.01" min={0} value={pay.amount} onChange={n => setPay({ ...pay, amount: n })} required /></Label>
        <Label text="Method"><Input value={pay.method ?? ''} onChange={e => setPay({ ...pay, method: e.target.value })} /></Label>
        <Label text="Reference"><Input value={pay.reference ?? ''} onChange={e => setPay({ ...pay, reference: e.target.value })} /></Label>
        <Button variant="primary" type="submit">Save</Button></form>}
      {canRecord && <div className="mt-4 text-right"><Button variant="danger" onClick={() => { if (window.confirm(`Reverse sale ${s.code}? Bales return to stock.`)) void run(() => deleteSale(ctx, id), 'Sale reversed').then(ok => ok && onClose()) }}>Reverse sale</Button></div>}
    </Modal>
  )
}
