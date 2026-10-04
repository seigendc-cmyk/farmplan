import { type Ctx, can, need } from './context'

/** The only objects a natural-language question may read. Each is a read-only SQL view defined in the local schema. */
export interface BiView { name: string; perm: string; about: string; columns: string[] }
export const BI_VIEWS: BiView[] = [
  { name: 'bi_seasons', perm: 'settings.season.view', about: 'Seasons', columns: ['season', 'starts_on', 'ends_on', 'status'] },
  { name: 'bi_fields', perm: 'production.field.view', about: 'Fields', columns: ['field_no', 'area_ha', 'variety', 'soil_type', 'previous_crop', 'current_crop', 'irrigated', 'tenure'] },
  { name: 'bi_operations', perm: 'production.operation.view', about: 'Field and seedbed operations', columns: ['season', 'occurred_on', 'op_type', 'field_no', 'seedbed', 'operator', 'area_ha'] },
  { name: 'bi_weather', perm: 'production.weather.view', about: 'Rainfall, temperature and observations', columns: ['recorded_on', 'field_no', 'rainfall_mm', 'temp_min_c', 'temp_max_c', 'event', 'observation'] },
  { name: 'bi_harvests', perm: 'production.harvest.view', about: 'Harvest batches (green leaf)', columns: ['season', 'code', 'field_no', 'harvested_on', 'variety', 'priming', 'leaf_position', 'green_weight_kg'] },
  { name: 'bi_curing', perm: 'curing.cycle.view', about: 'Curing cycles', columns: ['season', 'code', 'barn', 'status', 'loaded_at', 'green_weight_kg', 'offloaded_at', 'cured_weight_kg'] },
  { name: 'bi_bales', perm: 'quality.bale.view', about: 'Graded bales', columns: ['season', 'code', 'grade', 'weight_kg', 'baled_on', 'field_no', 'variety', 'status'] },
  { name: 'bi_sales', perm: 'marketing.sale.view', about: 'Sale lines (one row per bale sold)', columns: ['season', 'sale_code', 'sold_on', 'channel', 'buyer', 'grade', 'weight_kg', 'price_per_kg', 'gross', 'field_no', 'variety'] },
  { name: 'bi_costs', perm: 'finance.cost.view', about: 'Every cost entry', columns: ['season', 'category', 'amount', 'occurred_on', 'field_no', 'note'] },
  { name: 'bi_budgets', perm: 'finance.budget.view', about: 'Planned cost per season and category', columns: ['season', 'category', 'budget'] },
  { name: 'bi_buyers', perm: 'marketing.buyer.view', about: 'Registered buyers with payment terms and credit limits (no bank details)', columns: ['name', 'kind', 'payment_terms_days', 'credit_limit', 'active'] },
  { name: 'bi_machine_logs', perm: 'resources.machinery.view', about: 'Machine use, fuel, service and repair logs (cost needs finance access)', columns: ['season', 'machine', 'machine_kind', 'log_kind', 'logged_on', 'field_no', 'hours', 'fuel_l', 'cost', 'description', 'operator'] },
  { name: 'bi_labour', perm: 'resources.labour.view', about: 'Labour entries (pay_amount needs finance access)', columns: ['season', 'worked_on', 'worker_name', 'task', 'field_no', 'hours', 'pay_amount'] },
]

export const allowedViews = (ctx: Ctx) => BI_VIEWS.filter(v => can(ctx, v.perm) && ((v.name !== 'bi_labour' && v.name !== 'bi_machine_logs') || can(ctx, 'finance.cost.view')))

const FORBIDDEN = /\b(insert|update|delete|drop|alter|create|attach|detach|pragma|replace|vacuum|reindex|begin|commit|rollback|savepoint|release|load_extension|analyze|explain|trigger|virtual|truncate)\b/i
export const BI_ROW_LIMIT = 500

/**
 * Accepts exactly one SELECT (optionally with CTEs) that reads only whitelisted views, and wraps it in a row limit.
 * Defence in depth: execution also runs with query_only on, and base-table names are rejected anywhere in the text.
 */
export function validateSelect(sql: string, allowed: string[], baseTables: string[]): string {
  let q = String(sql ?? '').trim().replace(/;+\s*$/, '')
  need(q, 'No query was produced')
  need(!/--|\/\*|\*\//.test(q), 'Comments are not allowed in queries')
  need(!q.includes(';'), 'Only a single statement is allowed')
  need(/^(select|with)\b/i.test(q), 'Only SELECT queries are allowed')
  const bare = q.replace(/'(?:[^']|'')*'/g, "''")          // ignore string literals when scanning
  need(!/"|`|\[|\]/.test(bare), 'Quoted identifiers are not allowed')
  need(!FORBIDDEN.test(bare), 'That query is not read-only')
  need(!/\bsqlite_|\bpragma_/i.test(bare), 'System tables are not available')
  const words = new Set(bare.toLowerCase().match(/[a-z_][a-z0-9_]*/g) ?? [])
  for (const t of baseTables) need(!words.has(t.toLowerCase()), `Table ${t} is not available; use the bi_ views`)
  const ctes = new Set([...bare.matchAll(/\b([a-z_][a-z0-9_]*)\s+as\s*\(/gi)].map(m => m[1].toLowerCase()))
  const ok = new Set(allowed.map(a => a.toLowerCase()))
  let seen = 0
  for (const m of bare.matchAll(/\b(?:from|join)\s+([a-z_][a-z0-9_]*)/gi)) {
    const n = m[1].toLowerCase(); seen++
    need(ok.has(n) || ctes.has(n), `${m[1]} is not available to you`)
  }
  for (const w of words) if (w.startsWith('bi_')) need(ok.has(w), `${w} is not available to you`)
  need(seen > 0, 'The query must read from one of the bi_ views')
  return `SELECT * FROM (${q}) LIMIT ${BI_ROW_LIMIT}`
}

export interface BiResult { columns: string[]; rows: Record<string, unknown>[]; truncated: boolean }
export function runSelect(ctx: Ctx, sql: string): BiResult {
  const tables = ctx.db.all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type='table'`).map(t => t.name)
  const safe = validateSelect(sql, allowedViews(ctx).map(v => v.name), tables)
  ctx.db.run('PRAGMA query_only = ON')
  try {
    const rows = ctx.db.all<Record<string, unknown>>(safe)
    return { columns: rows[0] ? Object.keys(rows[0]) : [], rows, truncated: rows.length >= BI_ROW_LIMIT }
  } finally { ctx.db.run('PRAGMA query_only = OFF') }
}

// ------------------------------------------------------------------ the model call
export interface BiSettings { apiKey: string; model: string }
const KEY = 'farmplan.bi'
export const DEFAULT_MODEL = 'claude-sonnet-5-5'
export function loadBiSettings(): BiSettings { try { const o = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<BiSettings>; return { apiKey: o.apiKey ?? '', model: o.model || DEFAULT_MODEL } } catch { return { apiKey: '', model: DEFAULT_MODEL } } }
export function saveBiSettings(s: BiSettings) { try { localStorage.setItem(KEY, JSON.stringify(s)) } catch { /* private mode */ } }
export function clearBiSettings() { try { localStorage.removeItem(KEY) } catch { /* ignore */ } }

export type BiTransport = (req: { apiKey: string; model: string; system: string; messages: { role: 'user' | 'assistant'; content: string }[] }) => Promise<string>
const defaultTransport: BiTransport = async ({ apiKey, model, system, messages }) => {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
    body: JSON.stringify({ model, max_tokens: 1024, system, messages }),
  })
  if (!r.ok) throw new Error(r.status === 401 ? 'The API key was rejected' : `The AI service returned ${r.status}`)
  const j = await r.json() as { content?: { type: string; text?: string }[] }
  return (j.content ?? []).filter(c => c.type === 'text').map(c => c.text ?? '').join('')
}
let transport: BiTransport = defaultTransport
/** Calls the cloud model through the same transport (so tests can stub it). Used by the brain's Claude engine; only names, never records, are sent. */
export const callBiModel: BiTransport = req => transport(req)
export function setBiTransport(t: BiTransport | null) { transport = t ?? defaultTransport }

/** Only table and column names go to the model — never any farm data. */
export function systemPrompt(ctx: Ctx, currency: string, today: string): string {
  const views = allowedViews(ctx).map(v => `- ${v.name}(${v.columns.join(', ')}) — ${v.about}`).join('\n')
  return `You translate a tobacco farmer's question into ONE read-only SQLite SELECT query.
Rules: use only these views; no other tables; no comments; one statement; never modify data.
Views:
${views}
Notes: dates are ISO text (YYYY-MM-DD, or ISO timestamps); "season" is a label such as 2026/27; weights are kg; areas are hectares; money is in ${currency}; today is ${today}.
Cost categories: seed, fertilizer, chemicals, labour, machinery, fuel, irrigation, transport, curing, storage, grading, baling, marketing, overhead.
Use SUM/AVG/GROUP BY with clear column aliases, ROUND(x, 2) for money and averages, and ORDER BY for rankings.
Reply with JSON only: {"sql": "<query>", "explanation": "<one plain-English sentence saying what the query calculates>"}.
If the question cannot be answered from these views, reply {"sql": null, "explanation": "<why, and what could be asked instead>"}.`
}

export interface BiAnswer { question: string; sql: string | null; explanation: string; result: BiResult | null }
function parse(text: string): { sql: string | null; explanation: string } {
  const a = text.indexOf('{'), b = text.lastIndexOf('}'); need(a >= 0 && b > a, 'The AI reply was not understood')
  const o = JSON.parse(text.slice(a, b + 1)) as { sql?: string | null; explanation?: string }
  return { sql: typeof o.sql === 'string' && o.sql.trim() ? o.sql : null, explanation: String(o.explanation ?? '') }
}

/** Question → SQL (from the model) → validated, run locally. One automatic repair attempt if the first query is refused or fails. */
export async function askQuestion(ctx: Ctx, question: string, s: BiSettings): Promise<BiAnswer> {
  need(allowedViews(ctx).length > 0, 'Your role cannot query any data'); need(question.trim().length >= 3, 'Ask a question'); need(s.apiKey.trim(), 'Add your Anthropic API key first')
  const cur = ctx.db.get<{ currency: string }>(`SELECT currency FROM farms WHERE id=?`, [ctx.farmId])?.currency ?? 'USD'
  const system = systemPrompt(ctx, cur, new Date().toISOString().slice(0, 10))
  const messages: { role: 'user' | 'assistant'; content: string }[] = [{ role: 'user', content: question.trim() }]
  let reply = await transport({ apiKey: s.apiKey.trim(), model: s.model, system, messages }); let p = parse(reply)
  for (let attempt = 0; ; attempt++) {
    if (!p.sql) return { question, sql: null, explanation: p.explanation || 'That cannot be answered from the farm data.', result: null }
    try { return { question, sql: p.sql, explanation: p.explanation, result: runSelect(ctx, p.sql) } }
    catch (e) {
      if (attempt >= 1) throw new Error(`The generated query could not be run: ${e instanceof Error ? e.message : String(e)}`)
      messages.push({ role: 'assistant', content: reply }, { role: 'user', content: `That query was refused or failed: ${e instanceof Error ? e.message : String(e)}. Reply with corrected JSON using only the listed views.` })
      reply = await transport({ apiKey: s.apiKey.trim(), model: s.model, system, messages }); p = parse(reply)
    }
  }
}

export const SUGGESTED_QUESTIONS = [
  'Which field had the highest cost per hectare this season?', 'What is my average selling price per kg by grade?', 'How much rain fell each month this season?',
  'Which 5 workers logged the most hours?', 'How much did we spend on fertilizer compared with budget?', 'Total green weight harvested per field, highest first',
]
