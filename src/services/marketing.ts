import { type Ctx, require, need, isDate, round2 } from './context'
import { addDays, assertSeasonOpen, nextCode, nonNeg } from './util'

export const CHANNELS = ['auction', 'contract', 'private'] as const

export interface SaleInput {
  season_id: string; sold_on: string; channel: typeof CHANNELS[number]; buyer?: string; buyer_id?: string; sale_ref?: string; notes?: string; contract_id?: string
  lines: { bale_id: string; price_per_kg: number; weight_kg?: number }[]; deductions?: { label: string; amount: number }[]
}

/** Marketing lot → sale: selected bales are sold together; each line carries its own price, deductions are itemised, payments tracked separately. */
/** Net value still owed to the farm by one registered buyer across all open sales. */
export function buyerOutstanding(ctx: Ctx, buyerId: string): number {
  const r = ctx.db.get<{ o: number }>(`SELECT COALESCE(SUM(
      COALESCE((SELECT SUM(gross) FROM sale_lines l WHERE l.sale_id=s.id AND l.deleted_at IS NULL),0)
      - COALESCE((SELECT SUM(amount) FROM sale_deductions d WHERE d.sale_id=s.id AND d.deleted_at IS NULL),0)
      - COALESCE((SELECT SUM(amount) FROM sale_payments p WHERE p.sale_id=s.id AND p.deleted_at IS NULL),0)),0) o
    FROM sales s WHERE s.farm_id=? AND s.buyer_id=? AND s.deleted_at IS NULL`, [ctx.farmId, buyerId])!
  return round2(r.o)
}

export function createSale(ctx: Ctx, i: SaleInput): { id: string; code: string; gross: number; net: number; warnings: string[] } {
  require(ctx, 'marketing.sale.record')
  need(isDate(i.sold_on), 'Valid sale date required'); need(CHANNELS.includes(i.channel), 'Choose a marketing channel'); need(i.lines.length > 0, 'Select at least one bale')
  need(new Set(i.lines.map(l => l.bale_id)).size === i.lines.length, 'A bale was selected twice'); assertSeasonOpen(ctx, i.season_id)
  if (i.sale_ref?.trim()) need(!ctx.db.get(`SELECT 1 FROM sales WHERE farm_id=? AND sale_ref=? AND deleted_at IS NULL`, [ctx.farmId, i.sale_ref.trim()]), `Sale reference ${i.sale_ref} is already recorded`)
  if (i.contract_id) {
    const c = ctx.db.get<{ code: string; status: string; season_id: string }>(`SELECT code, status, season_id FROM contracts WHERE id=? AND farm_id=? AND deleted_at IS NULL`, [i.contract_id, ctx.farmId])
    need(c, 'Contract not found'); need(c.status === 'active', `Contract ${c.code} is ${c.status}; only active contracts can receive deliveries`); need(c.season_id === i.season_id, `Contract ${c.code} belongs to a different season`)
  }
  const buyer = i.buyer_id ? ctx.db.get<{ id: string; name: string; active: number; credit_limit: number | null }>(`SELECT id, name, active, credit_limit FROM buyers WHERE id=? AND farm_id=? AND deleted_at IS NULL`, [i.buyer_id, ctx.farmId]) : undefined
  if (i.buyer_id) { need(buyer, 'Buyer not found'); need(buyer.active, `${buyer.name} is marked inactive; reactivate the buyer or choose another`) }
  const lines = i.lines.map(l => {
    const b = ctx.db.get<{ id: string; code: string; status: string; season_id: string; weight_kg: number; baled_on: string }>(`SELECT id, code, status, season_id, weight_kg, baled_on FROM bales WHERE id=? AND farm_id=? AND deleted_at IS NULL`, [l.bale_id, ctx.farmId])
    need(b, 'Bale not found'); need(b.status === 'baled', `${b.code} is already sold`); need(b.season_id === i.season_id, `${b.code} belongs to a different season`); need(i.sold_on >= b.baled_on, `${b.code} was baled after the sale date`)
    need(Number.isFinite(l.price_per_kg) && l.price_per_kg >= 0, `Enter a price for ${b.code}`)
    const w = l.weight_kg ?? b.weight_kg; need(w > 0, 'Weight must be above zero')
    return { bale: b, weight_kg: w, price: l.price_per_kg, gross: round2(w * l.price_per_kg) }
  })
  const deductions = (i.deductions ?? []).filter(d => d.label.trim() || d.amount); for (const d of deductions) { need(d.label.trim(), 'Name each deduction'); nonNeg(d.amount, 'Deduction') }
  const gross = round2(lines.reduce((s, l) => s + l.gross, 0)); const ded = round2(deductions.reduce((s, d) => s + d.amount, 0))
  need(ded <= gross + 0.001, 'Deductions exceed the gross value')
  const warnings: string[] = []
  if (buyer?.credit_limit != null) { const after = round2(buyerOutstanding(ctx, buyer.id) + gross - ded); if (after > buyer.credit_limit + 0.005) warnings.push(`${buyer.name} would owe ${after} against a credit limit of ${buyer.credit_limit}`) }
  return ctx.db.tx(() => {
    const code = nextCode(ctx, 'sales', 'ML')
    const id = ctx.db.insert('sales', { tenant_id: ctx.tenantId, farm_id: ctx.farmId, season_id: i.season_id, code, sale_ref: i.sale_ref?.trim() || null, sold_on: i.sold_on, channel: i.contract_id ? 'contract' : i.channel, buyer: buyer ? buyer.name : i.buyer?.trim() || null, buyer_id: buyer?.id ?? null, notes: i.notes ?? null, contract_id: i.contract_id ?? null })
    for (const l of lines) { ctx.db.insert('sale_lines', { tenant_id: ctx.tenantId, sale_id: id, bale_id: l.bale.id, weight_kg: l.weight_kg, price_per_kg: l.price, gross: l.gross }); ctx.db.update('bales', l.bale.id, { status: 'sold' }) }
    for (const d of deductions) ctx.db.insert('sale_deductions', { tenant_id: ctx.tenantId, sale_id: id, label: d.label.trim(), amount: round2(d.amount) })
    ctx.db.audit(ctx.actor?.id ?? null, 'sale.create', 'sales', id, { code, gross, deductions: ded }); return { id, code, gross, net: round2(gross - ded), warnings }
  })
}

export function recordPayment(ctx: Ctx, saleId: string, p: { paid_on: string; amount: number; method?: string; reference?: string }): string {
  require(ctx, 'marketing.sale.record'); need(isDate(p.paid_on), 'Valid payment date required'); need(p.amount > 0, 'Amount must be above zero')
  const s = listSales(ctx).find(x => x.id === saleId); need(s, 'Sale not found'); need(p.paid_on >= s.sold_on, 'Payment cannot precede the sale')
  need(p.amount <= s.outstanding + 0.005, `Only ${s.outstanding} is outstanding on ${s.code}`)
  return ctx.db.tx(() => {
    const id = ctx.db.insert('sale_payments', { tenant_id: ctx.tenantId, sale_id: saleId, paid_on: p.paid_on, amount: round2(p.amount), method: p.method ?? null, reference: p.reference ?? null })
    ctx.db.audit(ctx.actor?.id ?? null, 'sale.payment', 'sales', saleId, { amount: p.amount }); return id
  })
}
export function deletePayment(ctx: Ctx, id: string) { require(ctx, 'marketing.sale.record'); ctx.db.tx(() => ctx.db.softDelete('sale_payments', id)) }

/** Reverses a sale: bales return to stock. Payments must be removed first so money is never silently discarded. */
export function deleteSale(ctx: Ctx, id: string) {
  require(ctx, 'marketing.sale.record')
  const s = ctx.db.get<{ code: string; season_id: string }>(`SELECT code, season_id FROM sales WHERE id=? AND farm_id=? AND deleted_at IS NULL`, [id, ctx.farmId]); need(s, 'Sale not found')
  need(!ctx.db.get(`SELECT 1 FROM sale_payments WHERE sale_id=? AND deleted_at IS NULL`, [id]), `${s.code} has payments recorded; remove them first`)
  need(!ctx.db.get(`SELECT 1 FROM sales x JOIN contracts c ON c.id=x.contract_id WHERE x.id=? AND c.status='settled'`, [id]), `${s.code} belongs to a settled contract`); assertSeasonOpen(ctx, s.season_id)
  ctx.db.tx(() => {
    for (const l of ctx.db.all<{ id: string; bale_id: string }>(`SELECT id, bale_id FROM sale_lines WHERE sale_id=? AND deleted_at IS NULL`, [id])) { ctx.db.softDelete('sale_lines', l.id); ctx.db.update('bales', l.bale_id, { status: 'baled' }) }
    for (const d of ctx.db.all<{ id: string }>(`SELECT id FROM sale_deductions WHERE sale_id=? AND deleted_at IS NULL`, [id])) ctx.db.softDelete('sale_deductions', d.id)
    ctx.db.softDelete('sales', id); ctx.db.audit(ctx.actor?.id ?? null, 'sale.delete', 'sales', id)
  })
}

export interface SaleRow { id: string; code: string; sale_ref: string | null; season_id: string; season_label: string; sold_on: string; channel: string; buyer: string | null; buyer_id: string | null; due_on: string | null; contract_id: string | null; contract_code: string | null; bales: number; weight_kg: number
  gross: number; deductions: number; net: number; paid: number; outstanding: number; status: 'unpaid' | 'part paid' | 'paid'; avg_price: number | null }
export function listSales(ctx: Ctx, seasonId?: string): SaleRow[] {
  require(ctx, 'marketing.sale.view')
  return ctx.db.all<Omit<SaleRow, 'net' | 'outstanding' | 'status' | 'avg_price' | 'due_on'> & { terms: number | null }>(`SELECT s.id, s.code, s.sale_ref, s.season_id, se.label season_label, s.sold_on, s.channel, s.buyer, s.buyer_id, bu.payment_terms_days terms, s.contract_id, ct.code contract_code,
      (SELECT COUNT(*) FROM sale_lines l WHERE l.sale_id=s.id AND l.deleted_at IS NULL) bales,
      COALESCE((SELECT SUM(weight_kg) FROM sale_lines l WHERE l.sale_id=s.id AND l.deleted_at IS NULL),0) weight_kg,
      COALESCE((SELECT SUM(gross) FROM sale_lines l WHERE l.sale_id=s.id AND l.deleted_at IS NULL),0) gross,
      COALESCE((SELECT SUM(amount) FROM sale_deductions d WHERE d.sale_id=s.id AND d.deleted_at IS NULL),0) deductions,
      COALESCE((SELECT SUM(amount) FROM sale_payments p WHERE p.sale_id=s.id AND p.deleted_at IS NULL),0) paid
    FROM sales s JOIN seasons se ON se.id=s.season_id LEFT JOIN buyers bu ON bu.id=s.buyer_id LEFT JOIN contracts ct ON ct.id=s.contract_id WHERE s.farm_id=? AND s.deleted_at IS NULL ${seasonId ? 'AND s.season_id=?' : ''} ORDER BY s.code DESC`, seasonId ? [ctx.farmId, seasonId] : [ctx.farmId])
    .map(({ terms, ...r }) => { const gross = round2(r.gross), ded = round2(r.deductions), net = round2(gross - ded), paid = round2(r.paid), out = round2(net - paid)
      return { ...r, due_on: terms == null ? null : addDays(r.sold_on, terms), gross, deductions: ded, net, paid, outstanding: out, weight_kg: round2(r.weight_kg), status: paid <= 0 ? 'unpaid' : out > 0.005 ? 'part paid' : 'paid', avg_price: r.weight_kg ? round2(gross / r.weight_kg) : null } })
}

export function saleDetail(ctx: Ctx, id: string) {
  require(ctx, 'marketing.sale.view'); const sale = listSales(ctx).find(s => s.id === id); need(sale, 'Sale not found')
  return { sale,
    lines: ctx.db.all<{ bale_code: string; grade: string; weight_kg: number; price_per_kg: number; gross: number }>(`SELECT b.code bale_code, g.code grade, l.weight_kg, l.price_per_kg, l.gross FROM sale_lines l JOIN bales b ON b.id=l.bale_id JOIN grades g ON g.id=b.grade_id WHERE l.sale_id=? AND l.deleted_at IS NULL ORDER BY b.code`, [id]),
    deductions: ctx.db.all<{ label: string; amount: number }>(`SELECT label, amount FROM sale_deductions WHERE sale_id=? AND deleted_at IS NULL`, [id]),
    payments: ctx.db.all<{ id: string; paid_on: string; amount: number; method: string | null; reference: string | null }>(`SELECT id, paid_on, amount, method, reference FROM sale_payments WHERE sale_id=? AND deleted_at IS NULL ORDER BY paid_on`, [id]) }
}

/** Revenue per kg / per hectare and breakdowns by grade, field and variety. Deductions are spread over each sale's lines in proportion to gross. */
export function revenueSummary(ctx: Ctx, seasonId: string) {
  require(ctx, 'marketing.sale.view')
  const lines = ctx.db.all<{ gross: number; kg: number; share: number; grade: string; field_no: string | null; variety: string | null }>(
    `SELECT l.gross, l.weight_kg kg, CASE WHEN sg.g > 0 THEN COALESCE(sd.d,0) / sg.g ELSE 0 END share, g.code grade, f.field_no, b.variety
     FROM sale_lines l JOIN sales s ON s.id=l.sale_id JOIN bales b ON b.id=l.bale_id JOIN grades g ON g.id=b.grade_id LEFT JOIN fields f ON f.id=b.field_id
     LEFT JOIN (SELECT sale_id, SUM(gross) g FROM sale_lines WHERE deleted_at IS NULL GROUP BY sale_id) sg ON sg.sale_id=s.id
     LEFT JOIN (SELECT sale_id, SUM(amount) d FROM sale_deductions WHERE deleted_at IS NULL GROUP BY sale_id) sd ON sd.sale_id=s.id
     WHERE s.season_id=? AND s.farm_id=? AND l.deleted_at IS NULL AND s.deleted_at IS NULL`, [seasonId, ctx.farmId])
  const group = (key: (l: typeof lines[number]) => string) => {
    const m = new Map<string, { key: string; kg: number; gross: number; net: number }>()
    for (const l of lines) { const k = key(l); const e = m.get(k) ?? { key: k, kg: 0, gross: 0, net: 0 }; e.kg += l.kg; e.gross += l.gross; e.net += l.gross * (1 - l.share); m.set(k, e) }
    return [...m.values()].sort((a, b) => a.key.localeCompare(b.key)).map(e => ({ key: e.key, kg: round2(e.kg), gross: round2(e.gross), net: round2(e.net), avg_price: e.kg ? round2(e.gross / e.kg) : null }))
  }
  const kg = lines.reduce((s, l) => s + l.kg, 0), gross = lines.reduce((s, l) => s + l.gross, 0), net = lines.reduce((s, l) => s + l.gross * (1 - l.share), 0)
  const ha = ctx.db.get<{ a: number }>(`SELECT COALESCE(SUM(f.area_ha),0) a FROM fields f WHERE f.id IN (SELECT field_id FROM harvest_batches WHERE season_id=? AND deleted_at IS NULL)`, [seasonId])!.a
  return { kg: round2(kg), gross: round2(gross), net: round2(net), avg_price_per_kg: kg ? round2(gross / kg) : null, net_per_kg: kg ? round2(net / kg) : null,
    harvested_ha: round2(ha), net_per_ha: ha ? round2(net / ha) : null, by_grade: group(l => l.grade), by_field: group(l => l.field_no ?? '—'), by_variety: group(l => l.variety ?? '—') }
}
