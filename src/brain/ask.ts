import { type Ctx, can, need, require, ValidationError } from '../services/context'
import { askQuestion, loadBiSettings, type BiAnswer } from '../services/bi'
import { availableQuestions, seasonLabels, knownPeople, resolveParams, templateSentence, type Resolved, type Rows, type Source } from './catalogue'
import { DEFAULT_LOCAL, claudeEngine, localEngine, rulesEngine, type Decision, type Engine, type EngineName, type LocalSettings, type LocalTransport, type RouteInput } from './engine'

export type EngineChoice = 'auto' | 'rules'
export interface BrainSettings { engine: EngineChoice; local: LocalSettings; localEnabled: boolean }
const KEY = 'farmplan.brain'
export const DEFAULT_BRAIN: BrainSettings = { engine: 'auto', local: DEFAULT_LOCAL, localEnabled: false }
export function loadBrainSettings(): BrainSettings {
  try { const o = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<BrainSettings>; return { engine: o.engine === 'rules' ? 'rules' : 'auto', localEnabled: !!o.localEnabled, local: { ...DEFAULT_LOCAL, ...(o.local ?? {}) } } } catch { return DEFAULT_BRAIN }
}
export function saveBrainSettings(s: BrainSettings) { try { localStorage.setItem(KEY, JSON.stringify(s)) } catch { /* private mode */ } }

export interface BrainAnswer {
  question: string; engine: EngineName; id: string | null; title: string | null; params: Resolved; columns: string[]; rows: Rows; sentence: string; sources: Source[]
  notes: string[]; suggestions: string[]; canTryCloud: boolean
}
export interface AskOptions { engine?: 'auto' | 'rules' | 'claude'; settings?: BrainSettings; localTransport?: LocalTransport; apiKey?: string; now?: Date }

function routeInput(ctx: Ctx, question: string, now: Date): RouteInput {
  const qs = availableQuestions(ctx)
  return { question, spec: qs.map(({ id, title, about, keywords, params }) => ({ id, title, about, keywords, params })), seasons: seasonLabels(ctx).map(s => s.label),
    fields: can(ctx, 'production.field.view') ? ctx.db.all<{ field_no: string }>(`SELECT field_no FROM fields WHERE farm_id=? AND deleted_at IS NULL ORDER BY field_no`, [ctx.farmId]).map(f => f.field_no) : [], people: knownPeople(ctx), today: now.toISOString().slice(0, 10) }
}

/**
 * Question → (engine picks a catalogue item) → fixed query runs on this device under the caller's own access → sentence.
 * The engine never sees records, never writes SQL, and a failed local model quietly falls back to the keyword router.
 */
export async function askBrain(ctx: Ctx, question: string, o: AskOptions = {}): Promise<BrainAnswer> {
  require(ctx, 'brain.chat.ask'); const text = (question ?? '').trim(); need(text.length >= 3, 'Ask a question'); need(text.length <= 500, 'Please keep the question under 500 characters')
  const qs = availableQuestions(ctx); need(qs.length > 0, 'Your role cannot query any data'); const s = o.settings ?? loadBrainSettings(); const notes: string[] = []
  const input = routeInput(ctx, text, o.now ?? new Date())
  let engine: Engine; const want = o.engine ?? 'auto'
  if (want === 'claude') { require(ctx, 'brain.chat.cloud'); const key = (o.apiKey ?? loadBiSettings().apiKey).trim(); need(key, 'Add your Anthropic API key first (Ask → Engine settings → Claude)'); engine = claudeEngine(key, loadBiSettings().model) }
  else if (want === 'auto' && s.localEnabled && s.local.url.trim()) engine = localEngine(s.local, o.localTransport)
  else engine = rulesEngine
  let d: Decision
  try { d = await engine.route(input) }
  catch (e) {
    if (engine.name === 'claude') throw e
    notes.push(`${e instanceof Error ? e.message : 'The local model failed'} — used keyword matching instead.`); engine = rulesEngine; d = await rulesEngine.route(input)
  }
  // A small model that says "none" gets one chance from the keyword router before we give up.
  if (!d.id && engine.name === 'local') { const r = await rulesEngine.route(input); if (r.id) { d = r; notes.push('The local model found no match; keyword matching did.') } }
  const q = qs.find(x => x.id === d.id)
  const none = (msg: string): BrainAnswer => ({ question: text, engine: engine.name, id: null, title: null, params: {}, columns: [], rows: [], sentence: msg, sources: [], notes,
    suggestions: qs.slice(0, 6).map(x => x.title), canTryCloud: engine.name !== 'claude' && can(ctx, 'brain.chat.cloud') })
  if (!q) return none('I can only answer questions I know how to look up safely, and this one did not match any of them.')
  let params: Resolved
  try { params = resolveParams(ctx, q, d.params) } catch (e) { if (e instanceof ValidationError) return none(e.message); throw e }
  const rows = q.run(ctx, params); let sentence: string | null = null
  if (engine.phrase) { try { sentence = await engine.phrase(text, q.title, rows) } catch { notes.push('Could not phrase the answer with the local model; showing a plain summary.') } }
  return { question: text, engine: engine.name, id: q.id, title: q.title, params, columns: rows[0] ? Object.keys(rows[0]) : [], rows, sentence: sentence ?? templateSentence(q.title, rows),
    sources: q.sources, notes, suggestions: [], canTryCloud: false }
}

/** The opt-in escape hatch for open-ended questions: the existing "Ask your data" path (Claude writes a read-only query; names only leave the device). */
export async function askCloudOpen(ctx: Ctx, question: string): Promise<BiAnswer> {
  require(ctx, 'brain.chat.cloud'); return askQuestion(ctx, question, loadBiSettings())
}
