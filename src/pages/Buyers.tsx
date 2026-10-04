import { useEffect, useState } from 'react'
import { listSales } from '../services/marketing'
import { BUYER_KINDS, KIND_LABEL, adoptUnlinkedBuyers, buyerAgeing, buyerComparison, buyerPriceHistory, buyerSummary, createBuyer, deleteBuyer, listBuyers, unlinkedBuyerNames, updateBuyer, type Buyer, type BuyerDeduction, type BuyerInput, type BuyerKind } from '../services/buyers'
import { useCan, useCtx, useData, useRun, fmt, today } from '../ui/hooks'
import { useSeasonPicker } from '../ui/season'
import { RecLink, useFocus } from '../ui/links'
import { Badge, Button, Card, Denied, Grid, Input, Label, Modal, NumberInput, PageHeader, Select, Stat, Table, Td, Textarea } from '../ui/kit'

type Tab = 'register' | 'sales' | 'balances' | 'compare'
interface Draft { id?: string; name: string; kind: BuyerKind; contact_person: string; phone: string; email: string; address: string; payment_terms_days?: number; credit_limit?: number
  bank_name: string; account_name: string; account_no: string; settlement_notes: string; notes: string; active: boolean; deductions: { label: string; kind: 'percent' | 'fixed'; value?: number }[] }
const blank = (): Draft => ({ name: '', kind: 'merchant', contact_person: '', phone: '', email: '', address: '', bank_name: '', account_name: '', account_no: '', settlement_notes: '', notes: '', active: true, deductions: [] })
const fromBuyer = (b: Buyer): Draft => ({ ...b, payment_terms_days: b.payment_terms_days ?? undefined, credit_limit: b.credit_limit ?? undefined })

export default function Buyers() {
  const ctx = useCtx(); const can = useCan(); const run = useRun(); const focus = useFocus('buyer'); const { sid, picker } = useSeasonPicker()
  const [tab, setTab] = useState<Tab>('register'); const [draft, setDraft] = useState<Draft | null>(null); const [open, setOpen] = useState<string | null>(null); const [all, setAll] = useState(false)
  useEffect(() => { if (focus.id) { setTab('register'); setOpen(focus.id) } }, [focus.id])
  const canSales = can('marketing.sale.view'); const manage = can('marketing.buyer.manage')
  const buyers = useData(c => listBuyers(c))
  const unlinked = useData(c => can('marketing.buyer.view') ? unlinkedBuyerNames(c) : []) ?? []
  const stats = useData(c => tab === 'sales' && canSales ? buyerSummary(c, { seasonId: all ? undefined : sid || undefined }) : [], [tab, sid, all]) ?? []
  const ageing = useData(c => tab === 'balances' && canSales ? buyerAgeing(c) : [], [tab]) ?? []
  const cmp = useData(c => tab === 'compare' && canSales ? buyerComparison(c, { seasonId: all ? undefined : sid || undefined }) : [], [tab, sid, all]) ?? []
  if (!buyers) return <Denied what="buyers" />
  const shown = buyers.filter(b => b.active || all)

  async function save() {
    const d = draft!
    const input: BuyerInput = { name: d.name, kind: d.kind, contact_person: d.contact_person, phone: d.phone, email: d.email, address: d.address, payment_terms_days: d.payment_terms_days ?? null, credit_limit: d.credit_limit ?? null,
      bank_name: d.bank_name, account_name: d.account_name, account_no: d.account_no, settlement_notes: d.settlement_notes, notes: d.notes, active: d.active,
      deductions: d.deductions.filter(x => x.label.trim()).map(x => ({ label: x.label, kind: x.kind, value: x.value ?? 0 }) as BuyerDeduction) }
    // People who can't manage bank details never receive them, so don't overwrite them with blanks on edit.
    if (!manage) for (const k of ['bank_name', 'account_name', 'account_no', 'settlement_notes'] as const) delete input[k]
    if (await run(() => { if (d.id) updateBuyer(ctx, d.id, input); else createBuyer(ctx, input) }, d.id ? 'Buyer updated' : 'Buyer added')) setDraft(null)
  }
  const opened = open ? buyers.find(b => b.id === open) : undefined
  return (
    <>
      <PageHeader title="Buyers" sub="Who you sell to: terms, credit, default deductions, prices and what they owe" actions={<>{tab !== 'register' && tab !== 'balances' && picker}
        {manage && <Button variant="primary" onClick={() => setDraft(blank())}>Add buyer</Button>}</>} />
      <div className="flex gap-1 mb-3">{([['register', 'Register'], ['sales', 'Sales & prices'], ['balances', 'Balances owed'], ['compare', 'Compare']] as const).filter(([k]) => k === 'register' || canSales).map(([k, l]) => <Button key={k} small variant={tab === k ? 'primary' : 'secondary'} onClick={() => setTab(k)}>{l}</Button>)}
        <label className="ml-auto text-sm text-gray-600 flex items-center gap-1.5"><input type="checkbox" checked={all} onChange={e => setAll(e.target.checked)} />{tab === 'register' ? 'Show inactive' : 'All seasons'}</label></div>

      {tab === 'register' && <>
        {unlinked.length > 0 && manage && can('marketing.sale.record') && <Card className="p-3 mb-3 bg-amber-50 border-amber-200 flex flex-wrap items-center justify-between gap-2">
          <div className="text-sm text-amber-900">{unlinked.reduce((s, u) => s + u.sales, 0)} sale(s) only have a typed buyer name ({unlinked.map(u => u.name).join(', ')}). Add them to the register to get balances and price history.</div>
          <Button small variant="primary" onClick={() => void run(() => { const r = adoptUnlinkedBuyers(ctx); return Promise.resolve(r) }, 'Buyers created from existing sales')}>Create buyers from these names</Button></Card>}
        <Card><Table head={['Buyer', 'Type', 'Contact', 'Terms', { label: 'Credit limit', right: true }, { label: 'Owes', right: true }, { label: 'Sales', right: true }, 'Status', '']} empty="No buyers yet. Add the auction floors, merchants and contractor companies you sell to.">
          {shown.map(b => <tr key={b.id} {...focus.row(b.name)}><Td className="font-medium">{b.name}</Td><Td>{KIND_LABEL[b.kind]}</Td><Td>{[b.contact_person, b.phone].filter(Boolean).join(' · ') || '—'}</Td>
            <Td>{b.payment_terms_days != null ? `${b.payment_terms_days} days` : '—'}</Td><Td right>{b.credit_limit != null ? fmt.money(b.credit_limit) : '—'}</Td>
            <Td right className={b.credit_limit != null && b.outstanding > b.credit_limit ? 'text-red-700 font-medium' : ''}>{canSales ? fmt.money(b.outstanding) : '—'}</Td><Td right>{b.sales}</Td>
            <Td>{b.active ? <Badge tone="green">active</Badge> : <Badge>inactive</Badge>}</Td>
            <Td className="text-right whitespace-nowrap"><Button small onClick={() => setOpen(b.id)}>Open</Button>{manage && <> <Button small onClick={() => setDraft(fromBuyer(b))}>Edit</Button></>}</Td></tr>)}</Table></Card></>}

      {tab === 'sales' && <>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3"><Stat label="Buyers who bought" value={String(stats.length)} /><Stat label="Net sales" value={fmt.money(stats.reduce((s, x) => s + x.net, 0))} />
          <Stat label="Kg sold" value={fmt.num(stats.reduce((s, x) => s + x.kg, 0), 1)} /><Stat label="Outstanding" value={fmt.money(stats.reduce((s, x) => s + x.outstanding, 0))} /></div>
        <Card><Table head={['Buyer', { label: 'Sales', right: true }, { label: 'kg', right: true }, { label: 'Gross', right: true }, { label: 'Net', right: true }, { label: 'Avg price/kg', right: true }, { label: 'Paid', right: true }, { label: 'Owes', right: true }, { label: 'Days to pay', right: true }]} empty="No sales in this period.">
          {stats.map(s => <tr key={s.buyer_id ?? s.name}><Td className="font-medium">{s.name}{!s.buyer_id && <span className="text-xs text-gray-500"> · not in register</span>}</Td><Td right>{s.sales}</Td><Td right>{fmt.num(s.kg, 1)}</Td><Td right>{fmt.money(s.gross)}</Td><Td right>{fmt.money(s.net)}</Td>
            <Td right>{fmt.money(s.avg_price)}</Td><Td right>{fmt.money(s.paid)}</Td><Td right>{fmt.money(s.outstanding)}</Td><Td right>{s.avg_days_to_pay == null ? '—' : fmt.num(s.avg_days_to_pay, 0)}</Td></tr>)}</Table></Card></>}

      {tab === 'balances' && <Card><div className="p-4 pb-0"><h2 className="font-medium">Money owed to you</h2><p className="text-xs text-gray-500">Aged from the sale date, as of {fmt.date(today())}. “Overdue” uses each buyer's own payment terms (none set → never overdue).</p></div>
        <Table head={['Buyer', { label: '0–30 days', right: true }, { label: '31–60', right: true }, { label: '61+', right: true }, { label: 'Total', right: true }, { label: 'Overdue', right: true }, { label: 'Oldest (days)', right: true }]} empty="Nobody owes you anything.">
          {[...ageing.map(a => <tr key={a.buyer_id ?? a.name}><Td className="font-medium">{a.name}</Td><Td right>{fmt.money(a.current)}</Td><Td right>{fmt.money(a.d31_60)}</Td><Td right className={a.d61_plus ? 'text-red-700' : ''}>{fmt.money(a.d61_plus)}</Td>
            <Td right className="font-medium">{fmt.money(a.total)}</Td><Td right className={a.overdue ? 'text-red-700 font-medium' : ''}>{fmt.money(a.overdue)}</Td><Td right>{a.oldest_days ?? '—'}</Td></tr>), ...(ageing.length > 1 ? [<tr key="total" className="font-medium bg-gray-50"><Td>Total</Td><Td right>{fmt.money(ageing.reduce((s, a) => s + a.current, 0))}</Td><Td right>{fmt.money(ageing.reduce((s, a) => s + a.d31_60, 0))}</Td><Td right>{fmt.money(ageing.reduce((s, a) => s + a.d61_plus, 0))}</Td><Td right>{fmt.money(ageing.reduce((s, a) => s + a.total, 0))}</Td><Td right>{fmt.money(ageing.reduce((s, a) => s + a.overdue, 0))}</Td><Td></Td></tr>] : [])]}</Table></Card>}

      {tab === 'compare' && <Card><div className="p-4 pb-0"><h2 className="font-medium">Which buyers pay best?</h2><p className="text-xs text-gray-500">“Grade-adjusted” compares each buyer's prices with the farm-wide average for the same grades, so a buyer who only took your best leaf is not flattered. Positive = paid above average.</p></div>
        <Table head={['#', 'Buyer', { label: 'kg', right: true }, { label: 'Avg price/kg', right: true }, { label: 'Grade-adjusted', right: true }, { label: 'Days to pay', right: true }, { label: 'Owes', right: true }]} empty="No sales in this period.">
          {cmp.map(c => <tr key={c.buyer_id ?? c.name}><Td>{c.rank}</Td><Td className="font-medium">{c.name}</Td><Td right>{fmt.num(c.kg, 1)}</Td><Td right>{fmt.money(c.avg_price)}</Td>
            <Td right className={c.grade_adjusted_pct == null ? '' : c.grade_adjusted_pct < 0 ? 'text-red-700' : 'text-brand-700'}>{c.grade_adjusted_pct == null ? '—' : `${c.grade_adjusted_pct > 0 ? '+' : ''}${c.grade_adjusted_pct}%`}</Td><Td right>{c.avg_days_to_pay == null ? '—' : fmt.num(c.avg_days_to_pay, 0)}</Td><Td right>{fmt.money(c.outstanding)}</Td></tr>)}</Table></Card>}

      {opened && <BuyerDetail buyer={opened} canSales={canSales} onClose={() => { setOpen(null); focus.clear() }} />}
      {draft && <Modal title={draft.id ? 'Edit buyer' : 'Add buyer'} onClose={() => setDraft(null)} wide>
        <form className="space-y-3" onSubmit={e => { e.preventDefault(); void save() }}>
          <Grid cols={3}><Label text="Name"><Input value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} required autoFocus /></Label>
            <Label text="Type"><Select value={draft.kind} onChange={e => setDraft({ ...draft, kind: e.target.value as BuyerKind })}>{BUYER_KINDS.map(k => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}</Select></Label>
            <Label text="Status"><Select value={draft.active ? 'a' : 'i'} onChange={e => setDraft({ ...draft, active: e.target.value === 'a' })}><option value="a">Active</option><option value="i">Inactive (hidden from new sales)</option></Select></Label></Grid>
          <Grid cols={3}><Label text="Contact person"><Input value={draft.contact_person} onChange={e => setDraft({ ...draft, contact_person: e.target.value })} /></Label>
            <Label text="Phone / WhatsApp"><Input value={draft.phone} onChange={e => setDraft({ ...draft, phone: e.target.value })} /></Label>
            <Label text="Email"><Input type="email" value={draft.email} onChange={e => setDraft({ ...draft, email: e.target.value })} /></Label></Grid>
          <Label text="Address"><Input value={draft.address} onChange={e => setDraft({ ...draft, address: e.target.value })} /></Label>
          <Grid cols={3}><Label text="Payment terms (days)" hint="Blank = none"><NumberInput min={0} step="1" value={draft.payment_terms_days} onChange={n => setDraft({ ...draft, payment_terms_days: n })} /></Label>
            <Label text="Credit limit" hint="Warns when a sale would pass it"><NumberInput min={0} step="0.01" value={draft.credit_limit} onChange={n => setDraft({ ...draft, credit_limit: n })} /></Label></Grid>
          <div className="font-medium">Default deductions <span className="text-gray-500 font-normal">— pre-filled on sales to this buyer</span></div>
          {draft.deductions.map((d, i) => <div key={i} className="grid grid-cols-[1fr_9rem_7rem_auto] gap-2 items-center">
            <Input aria-label="Deduction name" placeholder="Levy, commission…" value={d.label} onChange={e => setDraft({ ...draft, deductions: draft.deductions.map((x, j) => j === i ? { ...x, label: e.target.value } : x) })} />
            <Select aria-label="Deduction type" value={d.kind} onChange={e => setDraft({ ...draft, deductions: draft.deductions.map((x, j) => j === i ? { ...x, kind: e.target.value as 'percent' | 'fixed' } : x) })}><option value="percent">% of gross</option><option value="fixed">Fixed amount</option></Select>
            <NumberInput aria-label="Deduction value" step="0.01" min={0} value={d.value} onChange={n => setDraft({ ...draft, deductions: draft.deductions.map((x, j) => j === i ? { ...x, value: n } : x) })} />
            <Button type="button" small variant="ghost" onClick={() => setDraft({ ...draft, deductions: draft.deductions.filter((_, j) => j !== i) })}>Remove</Button></div>)}
          <Button type="button" small onClick={() => setDraft({ ...draft, deductions: [...draft.deductions, { label: '', kind: 'percent' }] })}>+ Add default deduction</Button>
          {manage && <><div className="font-medium">Settlement details</div>
            <Grid cols={3}><Label text="Bank"><Input value={draft.bank_name} onChange={e => setDraft({ ...draft, bank_name: e.target.value })} /></Label>
              <Label text="Account name"><Input value={draft.account_name} onChange={e => setDraft({ ...draft, account_name: e.target.value })} /></Label>
              <Label text="Account / reference"><Input value={draft.account_no} onChange={e => setDraft({ ...draft, account_no: e.target.value })} /></Label></Grid>
            <Label text="Settlement notes"><Textarea value={draft.settlement_notes} onChange={e => setDraft({ ...draft, settlement_notes: e.target.value })} /></Label></>}
          <Label text="Notes"><Textarea value={draft.notes} onChange={e => setDraft({ ...draft, notes: e.target.value })} /></Label>
          <div className="flex justify-between gap-2">
            <div>{draft.id && <Button type="button" variant="danger" onClick={() => { if (window.confirm(`Delete ${draft.name}? This only works if they have no sales.`)) void run(() => deleteBuyer(ctx, draft.id!), 'Buyer deleted').then(ok => ok && setDraft(null)) }}>Delete</Button>}</div>
            <div className="flex gap-2"><Button type="button" onClick={() => setDraft(null)}>Cancel</Button><Button variant="primary" type="submit">{draft.id ? 'Save changes' : 'Add buyer'}</Button></div></div>
        </form></Modal>}
    </>
  )
}

function BuyerDetail({ buyer, canSales, onClose }: { buyer: Buyer; canSales: boolean; onClose: () => void }) {
  const hist = useData(c => canSales ? buyerPriceHistory(c, buyer.id) : [], [buyer.id]) ?? []
  const sales = useData(c => canSales ? listSales(c).filter(s => s.buyer_id === buyer.id).slice(0, 20) : [], [buyer.id]) ?? []
  return (
    <Modal title={buyer.name} onClose={onClose} wide>
      <div className="grid sm:grid-cols-2 gap-x-6 gap-y-1 text-sm mb-3">
        <div><span className="text-gray-500">Type:</span> {KIND_LABEL[buyer.kind]}</div><div><span className="text-gray-500">Terms:</span> {buyer.payment_terms_days != null ? `${buyer.payment_terms_days} days` : 'none set'}</div>
        <div><span className="text-gray-500">Contact:</span> {[buyer.contact_person, buyer.phone, buyer.email].filter(Boolean).join(' · ') || '—'}</div><div><span className="text-gray-500">Credit limit:</span> {buyer.credit_limit != null ? fmt.money(buyer.credit_limit) : 'none'}</div>
        {buyer.address && <div className="sm:col-span-2"><span className="text-gray-500">Address:</span> {buyer.address}</div>}
        {(buyer.bank_name || buyer.account_no) && <div className="sm:col-span-2"><span className="text-gray-500">Pays into / settles via:</span> {[buyer.bank_name, buyer.account_name, buyer.account_no].filter(Boolean).join(' · ')}{buyer.settlement_notes ? ` — ${buyer.settlement_notes}` : ''}</div>}
        {buyer.deductions.length > 0 && <div className="sm:col-span-2"><span className="text-gray-500">Default deductions:</span> {buyer.deductions.map(d => `${d.label} ${d.kind === 'percent' ? `${d.value}%` : fmt.money(d.value)}`).join(' · ')}</div>}
        {buyer.notes && <div className="sm:col-span-2 text-gray-600">{buyer.notes}</div>}
      </div>
      {canSales && <><h3 className="font-medium mb-1">Price history by grade</h3>
        <Table head={['Season', 'Grade', { label: 'kg', right: true }, { label: 'Avg price/kg', right: true }]} empty="No sales to this buyer yet.">{hist.map(h => <tr key={`${h.season}${h.grade}`}><Td>{h.season}</Td><Td>{h.grade}</Td><Td right>{fmt.num(h.kg, 1)}</Td><Td right>{fmt.money(h.avg_price)}</Td></tr>)}</Table>
        <h3 className="font-medium mt-4 mb-1">Recent sales</h3>
        <Table head={['Lot', 'Date', 'Season', { label: 'kg', right: true }, { label: 'Net', right: true }, { label: 'Owes', right: true }, 'Payment']} empty="No sales to this buyer yet.">{sales.map(s => <tr key={s.id}><Td className="font-medium"><RecLink kind="sale" code={s.code} /></Td><Td>{fmt.date(s.sold_on)}</Td><Td>{s.season_label}</Td>
          <Td right>{fmt.num(s.weight_kg, 1)}</Td><Td right>{fmt.money(s.net)}</Td><Td right>{fmt.money(s.outstanding)}</Td><Td><Badge tone={s.status === 'paid' ? 'green' : s.status === 'unpaid' ? 'red' : 'amber'}>{s.status}</Badge></Td></tr>)}</Table></>}
    </Modal>
  )
}
