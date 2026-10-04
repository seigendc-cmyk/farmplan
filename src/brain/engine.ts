import type { Question, RawParams } from './catalogue'
import { callBiModel, DEFAULT_MODEL } from '../services/bi'

/** What a router is told about the world. Names only — never farm records. */
export interface RouteInput { question: string; spec: Pick<Question, 'id' | 'title' | 'about' | 'keywords' | 'params'>[]; seasons: string[]; fields: string[]; people: string[]; today: string }
export interface Decision { id: string | null; params: RawParams }
export type EngineName = 'rules' | 'local' | 'claude'
export interface Engine { name: EngineName; route(i: RouteInput): Promise<Decision>; /** Optional: turn result rows into a sentence. Must not invent numbers (the caller verifies). */ phrase?(question: string, title: string, rows: Record<string, unknown>[]): Promise<string | null> }

// ------------------------------------------------------------------ 1. rules: works with no model at all
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** Questions that ask for an action, a forecast or something outside the farm data. The catalogue is read-only history, so these get no match. */
const REFUSE = /^\s*(delete|remove|erase|wipe|drop|update|edit|insert|create|reset|set|add)\b|ignore .{0,20}instructions|\bpins?\b|password|forecast|tomorrow|predict|\bpoem\b/i
const STOP = new Set(['a', 'an', 'the', 'at', 'in', 'on', 'of', 'that', 'any', 'was', 'were', 'there', 'is', 'are', 'about', 'for', 'to'])
const has = (q: string, k: string) => k.includes(' ') ? q.includes(k) : new RegExp(`\\b${esc(k)}\\b`).test(q)
const weight = (k: string) => k.startsWith('+') ? 3 : k.includes(' ') ? 2 : 1

export function extractParams(i: RouteInput): RawParams {
  const q = i.question; const lower = q.toLowerCase(); const p: RawParams = {}
  const sm = q.match(/\b(20\d\d)\s*[/-]\s*(\d{4}|\d{2})\b/); if (sm) { const label = `${sm[1]}/${sm[2].slice(-2)}`; if (i.seasons.includes(label)) p.season = label }
  const fm = lower.match(/\bf[-\s]?0*(\d+)\b|\bfield\s+0*(\d+)\b/); if (fm) { const n = fm[1] ?? fm[2]; const hit = i.fields.find(f => f.replace(/\D/g, '').replace(/^0+/, '') === n); if (hit) p.field = hit }
  const person = i.people.filter(n => n.length > 1).find(n => new RegExp(`\\b${esc(n.toLowerCase())}\\b`).test(lower)); if (person) p.actor = person
  const dm = lower.match(/last\s+(\d{1,3})\s+days?/); if (dm) p.days = Number(dm[1]); else if (/\byesterday\b|\btoday\b/.test(lower)) p.days = 1; else if (/\bweek\b/.test(lower)) p.days = 7; else if (/\bmonth\b/.test(lower)) p.days = 30
  const quoted = q.match(/["“']([^"”']{2,80})["”']/); if (quoted) p.text = quoted[1]
  return p
}

export const rulesEngine: Engine = {
  name: 'rules',
  async route(i) {
    const lower = i.question.toLowerCase(); if (REFUSE.test(lower)) return { id: null, params: {} }; const params = extractParams(i)
    let best: { id: string; score: number } | null = null
    for (const q of i.spec) {
      let score = 0; for (const k of q.keywords) if (has(lower, k.replace(/^\+/, ''))) score += weight(k)
      if (q.id === 'recent_activity' && params.actor && score === 0) score = 1   // a person's name alone leans towards activity, but any topic word beats it
      if (score > 0 && (!best || score > best.score)) best = { id: q.id, score }
    }
    if (!best) return { id: null, params: {} }
    // A quoted phrase means "search for this", unless something more specific matched strongly.
    if (params.text && best.score < 3 && i.spec.some(s => s.id === 'find_notes')) return { id: 'find_notes', params }
    if (best.id === 'find_notes' && !params.text) { const m = lower.match(/(?:notes?d?|mention(?:ed|s)?|about|find|search(?: for)?)\s+(.{2,60})$/); if (m) { const t = m[1].replace(/[?.!]+$/, '').split(/\s+/).filter(w => !STOP.has(w)).join(' '); if (t) params.text = t } }
    return { id: best.id, params }
  },
}

// ------------------------------------------------------------------ shared prompt + parsing for model engines
export function routerPrompt(i: RouteInput): string {
  // Kept short on purpose: on a CPU the prompt is read at a few dozen tokens a second, so every line costs time on every question.
  const items = i.spec.map(q => `- ${q.id}: ${q.title}${q.params.length ? ` (${q.params.map(p => p.name + (p.optional ? '?' : '')).join(', ')})` : ''}`).join('\n')
  return `Route the farmer's question to ONE item. Do not answer it. Reply JSON only: {"id": <item or null>, "params": {}}. Use null if nothing fits.
${items}
Params: season = label like 2026/27 (omit for current); field = like F-04; actor = a person's name; days = number; text = words to find.
Seasons: ${i.seasons.join(', ') || 'none'}. Fields: ${i.fields.join(', ') || 'none'}. People: ${i.people.join(', ') || 'none'}. Today: ${i.today}.`
}
export function parseDecision(text: string, ids: string[]): Decision {
  const a = text.indexOf('{'), b = text.lastIndexOf('}'); if (a < 0 || b <= a) throw new Error('The model reply was not understood')
  const o = JSON.parse(text.slice(a, b + 1)) as { id?: unknown; params?: unknown }
  const id = typeof o.id === 'string' && ids.includes(o.id) ? o.id : null
  const params: RawParams = {}; if (o.params && typeof o.params === 'object') for (const [k, v] of Object.entries(o.params as Record<string, unknown>)) if (typeof v === 'string' || typeof v === 'number') params[k] = v
  return { id, params }
}

// ------------------------------------------------------------------ 2. local model (llama.cpp server or Ollama, OpenAI-compatible)
export interface LocalSettings { url: string; model: string; timeoutMs: number; phrase: boolean }
export const DEFAULT_LOCAL: LocalSettings = { url: 'http://127.0.0.1:11434', model: 'qwen2.5:3b-instruct', timeoutMs: 90_000, phrase: false }   // wording is off by default: it roughly doubles the wait on a CPU-only 8 GB machine
export type LocalTransport = (url: string, body: unknown, timeoutMs: number) => Promise<{ choices?: { message?: { content?: string } }[]; data?: unknown[] }>
export const defaultLocalTransport: LocalTransport = async (url, body, timeoutMs) => {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const r = await fetch(url, { method: body == null ? 'GET' : 'POST', headers: { 'content-type': 'application/json' }, body: body == null ? undefined : JSON.stringify(body), signal: ctl.signal })
    if (!r.ok) throw new Error(`The local model returned ${r.status}`); return await r.json()
  } catch (e) { throw new Error(e instanceof DOMException && e.name === 'AbortError' ? 'The local model took too long to answer' : e instanceof Error && /returned/.test(e.message) ? e.message : 'The local model is not reachable') }
  finally { clearTimeout(t) }
}
const base = (u: string) => u.replace(/\/+$/, '')

export async function testLocal(s: LocalSettings, tr: LocalTransport = defaultLocalTransport): Promise<string[]> {
  const r = await tr(`${base(s.url)}/v1/models`, null, 5000); return ((r.data ?? []) as { id?: string }[]).map(m => String(m.id ?? '')).filter(Boolean)
}

/** Numbers in a sentence that do not appear in the result are a sign the model made something up. */
export function numbersGrounded(sentence: string, rows: Record<string, unknown>[]): boolean {
  const norm = (s: string) => s.replace(/,/g, '').replace(/^0+(?=\d)/, '').replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')
  const allowed = new Set<string>([String(rows.length)])
  const add = (n: number) => { for (const d of [0, 1, 2]) allowed.add(norm(n.toFixed(d))); allowed.add(norm(String(n))) }
  for (const r of rows) for (const v of Object.values(r)) { if (typeof v === 'number') { add(v); add(Math.abs(v)) } else if (typeof v === 'string') for (const m of v.match(/\d+(?:\.\d+)?/g) ?? []) allowed.add(norm(m)) }
  return (sentence.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).every(n => allowed.has(norm(n)))
}

export function localEngine(s: LocalSettings, tr: LocalTransport = defaultLocalTransport): Engine {
  const url = `${base(s.url)}/v1/chat/completions`
  const chat = async (messages: { role: string; content: string }[], schema: object | null, maxTokens: number) => {
    const body: Record<string, unknown> = { model: s.model, messages, temperature: 0, max_tokens: maxTokens, stream: false }
    if (schema) body.response_format = { type: 'json_schema', json_schema: { name: 'route', strict: true, schema } }
    const r = await tr(url, body, s.timeoutMs); return r.choices?.[0]?.message?.content ?? ''
  }
  return {
    name: 'local',
    async route(i) {
      const ids = i.spec.map(q => q.id)
      const schema = { type: 'object', properties: { id: { enum: [...ids, null] }, params: { type: 'object', additionalProperties: { type: ['string', 'number'] } } }, required: ['id'] }
      return parseDecision(await chat([{ role: 'system', content: routerPrompt(i) }, { role: 'user', content: i.question }], schema, 120), ids)
    },
    async phrase(question, title, rows) {
      if (!s.phrase || !rows.length) return null
      const text = await chat([{ role: 'system', content: 'Answer the question in one or two plain sentences using ONLY the rows given. Copy numbers exactly as they appear. Give no advice and no extra numbers.' },
        { role: 'user', content: `Question: ${question}\nTable: ${title}\nRows (JSON): ${JSON.stringify(rows.slice(0, 12))}${rows.length > 12 ? `\n(${rows.length} rows in total)` : ''}` }], null, 120)
      const t = text.trim().replace(/\s+/g, ' '); return t && t.length <= 400 && numbersGrounded(t, rows) ? t : null
    },
  }
}

// ------------------------------------------------------------------ 3. Claude (opt-in): routing only, so no farm record ever leaves the device
export function claudeEngine(apiKey: string, model = DEFAULT_MODEL): Engine {
  return {
    name: 'claude',
    async route(i) {
      const ids = i.spec.map(q => q.id)
      const reply = await callBiModel({ apiKey, model, system: routerPrompt({ ...i, people: [] }), messages: [{ role: 'user', content: i.question }] })
      return parseDecision(reply, ids)
    },
  }
}
