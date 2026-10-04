import { adoptBuyerNames } from '../db/buyerlink'
import { type Ctx, can, need, require, round2 } from './context'
import { listSales, buyerOutstanding, type SaleRow } from './marketing'
import { assertSeasonOpen, daysBetween, nonNeg } from './util'

export const BUYER_KINDS = ['auction_floor', 'merchant', 'contractor', 'private', 'other'] as const
export type BuyerKind = (typeof BUYER_KINDS)[number]
export const KIND_LABEL: Record<BuyerKind, string> = { auction_floor: 'Auction floor', merchant: 'Merchant', contractor: 'Contractor company', private: 'Private buyer', other: 'Other' }

export interface BuyerDeduction { label: string; kind: 'percent' | 'fixed'; value: number }
export interface BuyerInput {
  name: string; kind?: BuyerKind; contact_person?: string; phone?: string; email?: string; address?: string
  payment_terms_days?: number | null; credit_limit?: number | null
  bank_name?: string; account_name?: string; account_no?: string; settlement_notes?: string; notes?: string; active?: boolean
  deductions?: BuyerDeduction[]
}
export interface Buyer extends Required<Omit<BuyerInput, 'deductions' | 'active' | 'payment_terms_days' | 'credit_limit' | 'kind'>> {
  id: string; kind: BuyerKind; payment_terms_days: number | null; credit_limit: number | null; active: boolean; deductions: BuyerDeduction[]; sales: number; outstanding: number
}

const clean = (v: string | undefined | null) => (v ?? '').trim()
function validate(i: Partial<BuyerInput>) {
  if (i.kind !== undefined) need(BUYER_KINDS.includes(i.kind), 'Choose a buyer type')
  if (i.email !== undefined && clean(i.email)) need(/^\S+@\S+\.\S+$/.test(clean(i.email)), 'Enter a valid email address')
  if (i.payment_terms_days != null) need(Number.isInteger(i.payment_terms_days) && i.payment_terms_days >= 0, 'Payment terms must be a whole number of days')
  nonNeg(i.credit_limit, 'Credit limit')
  for (const d of i.deductions ?? []) {
    need(clean(d.label), 'Name each default deduction'); need(d.kind === 'percent' || d.kind === 'fixed', 'Deduction must be a percentage or a fixed amount'); nonNeg(d.value, 'Deduction')
    need(d.kind !== 'percent' || d.value <= 100, 'A percentage deduction cannot exceed 100')
  }
}
const COLS = ['contact_person', 'phone', 'email', 'address', 'bank_name', 'account_name', 'account_no', 'settlement_notes', 'notes'] as const

function writeDeductions(ctx: Ctx, buyerId: string, list: BuyerDeduction[]) {
  for (const d of ctx.db.all<{ id: string }>(`SELECT id FROM buyer_deductions WHERE buyer_id=? AND deleted_at IS NULL`, [buyerId])) ctx.db.softDelete('buyer_deductions', d.id)
  for (const d of list) ctx.db.insert('buyer_deductions', { tenant_id: ctx.tenantId, buyer_id: buyerId, label: clean(d.label), kind: d.kind, value: d.value })
}
const nameTaken = (ctx: Ctx, name: string, exceptId?: string) => !!ctx.db.get(`SELECT 1 FROM buyers WHERE farm_id=? AND lower(name)=lower(?) AND deleted_at IS NULL AND id<>?`, [ctx.farmId, name, exceptId ?? ''])

export function createBuyer(ctx: Ctx, i: BuyerInput): string {
  require(ctx, 'marketing.buyer.manage'); const name = clean(i.name); need(name, 'Buyer name is required'); validate(i); need(!nameTaken(ctx, name), `A buyer called "${name}" already exists`)
  return ctx.db.tx(() => {
    const row: Record<string, string | number | null> = { tenant_id: ctx.tenantId, farm_id: ctx.farmId, name, kind: i.kind ?? 'merchant', payment_terms_days: i.payment_terms_days ?? null, credit_limit: i.credit_limit ?? null, active: i.active === false ? 0 : 1 }
    for (const c of COLS) row[c] = clean(i[c]) || null
    const id = ctx.db.insert('buyers', row); writeDeductions(ctx, id, i.deductions ?? [])
    ctx.db.audit(ctx.actor?.id ?? null, 'buyer.create', 'buyers', id, { name }); return id
  })
}

export function updateBuyer(ctx: Ctx, id: string, i: Partial<BuyerInput>) {
  require(ctx, 'marketing.buyer.manage'); validate(i)
  const cur = ctx.db.get<{ name: string }>(`SELECT name FROM buyers WHERE id=? AND farm_id=? AND deleted_at IS NULL`, [id, ctx.farmId]); need(cur, 'Buyer not found')
  const patch: Record<string, string | number | null> = {}
  if (i.name !== undefined) { const n = clean(i.name); need(n, 'Buyer name is required'); need(!nameTaken(ctx, n, id), `A buyer called "${n}" already exists`); patch.name = n }
  if (i.kind !== undefined) patch.kind = i.kind
  if ('payment_terms_days' in i) patch.payment_terms_days = i.payment_terms_days ?? null
  if ('credit_limit' in i) patch.credit_limit = i.credit_limit ?? null
  if (i.active !== undefined) patch.active = i.active ? 1 : 0
  for (const c of COLS) if (i[c] !== undefined) patch[c] = clean(i[c]) || null
  ctx.db.tx(() => {
    if (Object.keys(patch).length) ctx.db.update('buyers', id, patch)
    if (i.deductions) writeDeductions(ctx, id, i.deductions)
    // Sales keep a copy of the name for history and the portal; keep it in step when the buyer is renamed.
    if (patch.name) for (const s of ctx.db.all<{ id: string }>(`SELECT id FROM sales WHERE buyer_id=? AND deleted_at IS NULL`, [id])) ctx.db.update('sales', s.id, { buyer: patch.name as string })
    ctx.db.audit(ctx.actor?.id ?? null, 'buyer.update', 'buyers', id, { fields: Object.keys(patch) })
  })
}

export function deleteBuyer(ctx: Ctx, id: string) {
  require(ctx, 'marketing.buyer.manage')
  const b = ctx.db.get<{ name: string }>(`SELECT name FROM buyers WHERE id=? AND farm_id=? AND deleted_at IS NULL`, [id, ctx.farmId]); need(b, 'Buyer not found')
  need(!ctx.db.get(`SELECT 1 FROM sales WHERE buyer_id=? AND deleted_at IS NULL`, [id]), `${b.name} has sales recorded. Mark the buyer inactive instead.`)
  ctx.db.tx(() => { writeDeductions(ctx, id, []); ctx.db.softDelete('buyers', id); ctx.db.audit(ctx.actor?.id ?? null, 'buyer.delete', 'buyers', id) })
}

export function listBuyers(ctx: Ctx, o: { activeOnly?: boolean } = {}): Buyer[] {
  require(ctx, 'marketing.buyer.view'); const banking = can(ctx, 'marketing.buyer.manage')
  const ded = ctx.db.all<{ buyer_id: string; label: string; kind: 'percent' | 'fixed'; value: number }>(`SELECT buyer_id, label, kind, value FROM buyer_deductions WHERE deleted_at IS NULL ORDER BY label`)
  const rows = ctx.db.all<Omit<Buyer, 'deductions' | 'outstanding' | 'active'> & { active: number }>(`SELECT b.id, b.name, b.kind, COALESCE(b.contact_person,'') contact_person, COALESCE(b.phone,'') phone, COALESCE(b.email,'') email, COALESCE(b.address,'') address,
      b.payment_terms_days, b.credit_limit, COALESCE(b.bank_name,'') bank_name, COALESCE(b.account_name,'') account_name, COALESCE(b.account_no,'') account_no, COALESCE(b.settlement_notes,'') settlement_notes, COALESCE(b.notes,'') notes, b.active,
      (SELECT COUNT(*) FROM sales s WHERE s.buyer_id=b.id AND s.deleted_at IS NULL) sales
    FROM buyers b WHERE b.farm_id=? AND b.deleted_at IS NULL ${o.activeOnly ? 'AND b.active=1' : ''} ORDER BY b.name`, [ctx.farmId])
  const canSee = can(ctx, 'marketing.sale.view')
  return rows.map(r => ({ ...r, active: !!r.active, deductions: ded.filter(d => d.buyer_id === r.id).map(({ label, kind, value }) => ({ label, kind, value })),
    // Bank details are only shown to people who may manage buyers; balances only to people who may see sales.
    ...(banking ? {} : { bank_name: '', account_name: '', account_no: '', settlement_notes: '' }), outstanding: canSee ? buyerOutstanding(ctx, r.id) : 0 }))
}

/** The buyer's default deductions turned into amounts for a given gross sale value (percentages rounded to cents). */
export function suggestDeductions(ctx: Ctx, buyerId: string, gross: number): { label: string; amount: number }[] {
  require(ctx, 'marketing.buyer.view')
  return ctx.db.all<{ label: string; kind: string; value: number }>(`SELECT label, kind, value FROM buyer_deductions WHERE buyer_id=? AND deleted_at IS NULL ORDER BY label`, [buyerId])
    .map(d => ({ label: d.label, amount: round2(d.kind === 'percent' ? (gross * d.value) / 100 : d.value) }))
}

/** Attach (or detach with null) a buyer on an existing sale, e.g. to tidy a free-text name. */
export function linkSaleBuyer(ctx: Ctx, saleId: string, buyerId: string | null) {
  require(ctx, 'marketing.sale.record'); require(ctx, 'marketing.buyer.view')
  const s = ctx.db.get<{ season_id: string; code: string }>(`SELECT season_id, code FROM sales WHERE id=? AND farm_id=? AND deleted_at IS NULL`, [saleId, ctx.farmId]); need(s, 'Sale not found'); assertSeasonOpen(ctx, s.season_id)
  const b = buyerId ? ctx.db.get<{ name: string }>(`SELECT name FROM buyers WHERE id=? AND farm_id=? AND deleted_at IS NULL`, [buyerId, ctx.farmId]) : undefined
  if (buyerId) need(b, 'Buyer not found')
  ctx.db.tx(() => { ctx.db.update('sales', saleId, buyerId ? { buyer_id: buyerId, buyer: b!.name } : { buyer_id: null }); ctx.db.audit(ctx.actor?.id ?? null, 'sale.buyer', 'sales', saleId, { buyerId }) })
}

/** Sales whose buyer is only a typed name, grouped, so the owner can turn them into registered buyers in one step. */
export function unlinkedBuyerNames(ctx: Ctx): { name: string; sales: number }[] {
  require(ctx, 'marketing.buyer.view')
  return ctx.db.all<{ name: string; sales: number }>(`SELECT trim(buyer) name, COUNT(*) sales FROM sales WHERE farm_id=? AND deleted_at IS NULL AND buyer_id IS NULL AND trim(COALESCE(buyer,'')) <> '' GROUP BY lower(trim(buyer)) ORDER BY name`, [ctx.farmId])
}
export function adoptUnlinkedBuyers(ctx: Ctx) { require(ctx, 'marketing.buyer.manage'); require(ctx, 'marketing.sale.record'); return adoptBuyerNames(ctx.db, ctx.farmId) }

// ------------------------------------------------------------------ analysis
export interface BuyerStat { buyer_id: string | null; name: string; sales: number; kg: number; gross: number; net: number; avg_price: number | null; paid: number; outstanding: number; avg_days_to_pay: number | null; overdue: number }
export interface Ageing { buyer_id: string | null; name: string; current: number; d31_60: number; d61_plus: number; total: number; overdue: number; oldest_days: number | null }

/** Name used for grouping: the registered buyer, else the typed name (case-insensitive), else "(no buyer)". */
const keyOf = (s: SaleRow) => s.buyer_id ?? `t:${(s.buyer ?? '').trim().toLowerCase()}`
const nameOf = (s: SaleRow) => (s.buyer ?? '').trim() || '(no buyer)'
const today = () => new Date().toISOString().slice(0, 10)

function salesWithPayments(ctx: Ctx, seasonId?: string) {
  require(ctx, 'marketing.buyer.view'); require(ctx, 'marketing.sale.view')
  const sales = listSales(ctx, seasonId); const pays = new Map<string, { paid_on: string; amount: number }[]>()
  for (const p of ctx.db.all<{ sale_id: string; paid_on: string; amount: number }>(`SELECT sale_id, paid_on, amount FROM sale_payments WHERE deleted_at IS NULL`)) pays.set(p.sale_id, [...(pays.get(p.sale_id) ?? []), p])
  return { sales, pays }
}

export function buyerSummary(ctx: Ctx, o: { seasonId?: string; asOf?: string } = {}): BuyerStat[] {
  const { sales, pays } = salesWithPayments(ctx, o.seasonId); const asOf = o.asOf ?? today(); const m = new Map<string, BuyerStat & { w: number; wd: number }>()
  for (const s of sales) {
    const k = keyOf(s); const e = m.get(k) ?? { buyer_id: s.buyer_id, name: nameOf(s), sales: 0, kg: 0, gross: 0, net: 0, avg_price: null, paid: 0, outstanding: 0, avg_days_to_pay: null, overdue: 0, w: 0, wd: 0 }
    e.sales++; e.kg += s.weight_kg; e.gross += s.gross; e.net += s.net; e.paid += s.paid; e.outstanding += s.outstanding
    if (s.outstanding > 0.005 && s.due_on && s.due_on < asOf) e.overdue += s.outstanding
    for (const p of pays.get(s.id) ?? []) { e.w += p.amount; e.wd += p.amount * daysBetween(s.sold_on, p.paid_on) }
    m.set(k, e)
  }
  return [...m.values()].map(({ w, wd, ...e }) => ({ ...e, kg: round2(e.kg), gross: round2(e.gross), net: round2(e.net), paid: round2(e.paid), outstanding: round2(e.outstanding), overdue: round2(e.overdue),
    avg_price: e.kg ? round2(e.gross / e.kg) : null, avg_days_to_pay: w ? round2(wd / w) : null })).sort((a, b) => b.net - a.net || a.name.localeCompare(b.name))
}

/** Money still owed, bucketed by days since the sale (0–30, 31–60, 61+). "Overdue" uses the buyer's own payment terms. */
export function buyerAgeing(ctx: Ctx, asOf = today()): Ageing[] {
  const { sales } = salesWithPayments(ctx); const m = new Map<string, Ageing>()
  for (const s of sales.filter(x => x.outstanding > 0.005)) {
    const k = keyOf(s); const e = m.get(k) ?? { buyer_id: s.buyer_id, name: nameOf(s), current: 0, d31_60: 0, d61_plus: 0, total: 0, overdue: 0, oldest_days: null }
    const age = Math.max(0, daysBetween(s.sold_on, asOf)); if (age <= 30) e.current += s.outstanding; else if (age <= 60) e.d31_60 += s.outstanding; else e.d61_plus += s.outstanding
    e.total += s.outstanding; if (s.due_on && s.due_on < asOf) e.overdue += s.outstanding; e.oldest_days = Math.max(e.oldest_days ?? 0, age); m.set(k, e)
  }
  return [...m.values()].map(e => ({ ...e, current: round2(e.current), d31_60: round2(e.d31_60), d61_plus: round2(e.d61_plus), total: round2(e.total), overdue: round2(e.overdue) })).sort((a, b) => b.total - a.total || a.name.localeCompare(b.name))
}

export interface PriceHistoryRow { season: string; grade: string; kg: number; avg_price: number }
export function buyerPriceHistory(ctx: Ctx, buyerId: string): PriceHistoryRow[] {
  require(ctx, 'marketing.buyer.view'); require(ctx, 'marketing.sale.view')
  return ctx.db.all<{ season: string; grade: string; kg: number; gross: number }>(`SELECT se.label season, g.code grade, SUM(l.weight_kg) kg, SUM(l.gross) gross
    FROM sale_lines l JOIN sales s ON s.id=l.sale_id JOIN seasons se ON se.id=s.season_id JOIN bales b ON b.id=l.bale_id JOIN grades g ON g.id=b.grade_id
    WHERE s.farm_id=? AND s.buyer_id=? AND s.deleted_at IS NULL AND l.deleted_at IS NULL GROUP BY se.label, g.code ORDER BY se.label, g.code`, [ctx.farmId, buyerId])
    .map(r => ({ season: r.season, grade: r.grade, kg: round2(r.kg), avg_price: round2(r.gross / r.kg) }))
}

export interface BuyerComparison extends BuyerStat { grade_adjusted_pct: number | null; rank: number }
/**
 * Ranks registered and typed buyers. A plain average price rewards whoever bought the best grades, so the headline figure is a
 * grade-adjusted premium: for each grade, how far the buyer's price is above or below the farm-wide average for that grade, weighted by kg.
 */
export function buyerComparison(ctx: Ctx, o: { seasonId?: string } = {}): BuyerComparison[] {
  const stats = buyerSummary(ctx, o)
  const rows = ctx.db.all<{ k: string; grade: string; kg: number; gross: number }>(`SELECT COALESCE(s.buyer_id, 't:' || lower(trim(COALESCE(s.buyer,'')))) k, g.code grade, SUM(l.weight_kg) kg, SUM(l.gross) gross
    FROM sale_lines l JOIN sales s ON s.id=l.sale_id JOIN bales b ON b.id=l.bale_id JOIN grades g ON g.id=b.grade_id
    WHERE s.farm_id=? AND s.deleted_at IS NULL AND l.deleted_at IS NULL ${o.seasonId ? 'AND s.season_id=?' : ''} GROUP BY k, g.code`, o.seasonId ? [ctx.farmId, o.seasonId] : [ctx.farmId])
  const farm = new Map<string, { kg: number; gross: number }>()
  for (const r of rows) { const f = farm.get(r.grade) ?? { kg: 0, gross: 0 }; f.kg += r.kg; f.gross += r.gross; farm.set(r.grade, f) }
  const adj = new Map<string, { num: number; den: number }>()
  for (const r of rows) { const f = farm.get(r.grade)!; const avg = f.gross / f.kg; const a = adj.get(r.k) ?? { num: 0, den: 0 }; a.num += r.gross - r.kg * avg; a.den += r.kg * avg; adj.set(r.k, a) }
  const idKey = (s: BuyerStat) => s.buyer_id ?? `t:${s.name.toLowerCase()}`
  return stats.map(s => { const a = adj.get(idKey(s)); return { ...s, grade_adjusted_pct: a && a.den ? round2((a.num / a.den) * 100) : null, rank: 0 } })
    .sort((a, b) => (b.grade_adjusted_pct ?? -Infinity) - (a.grade_adjusted_pct ?? -Infinity) || a.name.localeCompare(b.name)).map((s, i) => ({ ...s, rank: i + 1 }))
}
