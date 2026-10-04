/**
 * Speed and quality check for the brain's LOCAL model. Run it on the computer that will host the model:
 *   npx tsx tools/brain-bench/bench.ts --url http://127.0.0.1:11434 --model qwen2.5:3b-instruct
 * Options: --runs N (repeat lookups, default 3) · --phrase N (how many answers to word, default 8) · --mock (no model; checks the harness itself)
 */
import { Db, MemoryPersistence } from '../../src/db/database'
import { seedDemo } from '../../src/brain/demo'
import { CATALOGUE, availableQuestions, resolveParams, seasonLabels, knownPeople } from '../../src/brain/catalogue'
import { DEFAULT_LOCAL, localEngine, rulesEngine, routerPrompt, testLocal, type LocalTransport, type RouteInput } from '../../src/brain/engine'
import { EVAL_SET, HOLDOUT_SET, evaluate, summarise } from '../../src/brain/evalset'

const arg = (n: string, d?: string) => { const i = process.argv.indexOf(`--${n}`); return i < 0 ? d : (process.argv[i + 1]?.startsWith('--') || process.argv[i + 1] == null ? 'true' : process.argv[i + 1]) }
const url = arg('url', DEFAULT_LOCAL.url)!, model = arg('model', DEFAULT_LOCAL.model)!, runs = Number(arg('runs', '3')), nPhrase = Number(arg('phrase', '8')), mock = arg('mock') === 'true'
const med = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] ?? 0

async function main() {
  const db = await Db.open(new MemoryPersistence()); const t0 = performance.now(); const o = await seedDemo(db)
  console.log(`Seeded demo farm in ${Math.round(performance.now() - t0)} ms (${db.get<{ n: number }>(`SELECT COUNT(*) n FROM bi_labour`)!.n} labour rows, ${db.get<{ n: number }>(`SELECT COUNT(*) n FROM bi_costs`)!.n} cost rows, ${db.get<{ n: number }>(`SELECT COUNT(*) n FROM activity_log`)!.n} activity events)\n`)
  const spec = availableQuestions(o).map(({ id, title, about, keywords, params }) => ({ id, title, about, keywords, params }))
  const base = { spec, seasons: seasonLabels(o).map(s => s.label), fields: ['F-01', 'F-02', 'F-03', 'F-04', 'F-05', 'F-06', 'F-07', 'F-08'], people: knownPeople(o), today: new Date().toISOString().slice(0, 10) }
  const mk = (question: string): RouteInput => ({ ...base, question })

  console.log('1. Lookups on this device (the part that produces the numbers)')
  for (const q of CATALOGUE) { const p = resolveParams(o, q, q.params.some(x => x.name === 'text' && !x.optional) ? { text: 'hail' } : {}); const ts: number[] = []; let n = 0
    for (let i = 0; i < runs; i++) { const t = performance.now(); n = q.run(o, p).length; ts.push(performance.now() - t) } console.log(`   ${q.id.padEnd(20)} ${String(Math.round(med(ts))).padStart(5)} ms   ${n} rows`) }

  const prompt = routerPrompt(mk('x')); console.log(`\n2. Router prompt: ${prompt.length} characters (about ${Math.round(prompt.length / 3.6)} tokens) sent with every question`)

  let tr: LocalTransport | undefined
  if (mock) { tr = async (_u, body: any) => { await new Promise(r => setTimeout(r, 150)); const q = body.messages.at(-1).content as string; const d = body.response_format ? await rulesEngine.route(mk(q)) : null
    return { choices: [{ message: { content: d ? JSON.stringify(d) : q.includes('Rows') ? 'Done.' : '' } }] } } }
  else { try { const m = await testLocal({ ...DEFAULT_LOCAL, url, model }); console.log(`   Connected to ${url}. Models: ${m.join(', ') || '(none listed)'}`); if (m.length && !m.includes(model)) console.log(`   WARNING: ${model} is not in that list.`) }
    catch (e) { console.error(`\nCould not reach ${url}: ${e instanceof Error ? e.message : e}\nStart Ollama (or llama-server) first, or run with --mock to test the harness only.`); process.exit(1) } }
  const eng = localEngine({ ...DEFAULT_LOCAL, url, model, timeoutMs: 180_000 }, tr)

  console.log(`\n3. Routing quality and speed with ${mock ? 'a MOCK model' : model}`)
  const warm = performance.now(); await eng.route(mk('warm up')).catch(() => null); console.log(`   first call (model load + warm-up): ${Math.round(performance.now() - warm)} ms`)
  for (const [name, set] of [['main set', EVAL_SET], ['unseen set', HOLDOUT_SET]] as const) {
    const r = await evaluate(q => eng.route(mk(q)), set); const s = summarise(r)
    console.log(`   ${name}: right lookup ${s.routed_pct}% · parameters right ${s.params_pct}% · off-topic refused ${s.refused_pct}% · errors ${s.errors} · latency p50 ${s.p50_ms} ms, p95 ${s.p95_ms} ms, max ${s.max_ms} ms`)
    for (const x of r.filter(x => !x.ok || !x.paramsOk).slice(0, 12)) console.log(`      miss: "${x.q}" → ${x.error ?? x.got} (wanted ${x.expected})`)
  }
  const kw = summarise(await evaluate(q => rulesEngine.route(mk(q)), [...EVAL_SET, ...HOLDOUT_SET])); console.log(`   keyword matching on the same questions: right lookup ${kw.routed_pct}%, refused ${kw.refused_pct}% (the floor the model must beat)`)

  console.log(`\n4. Wording answers (${nPhrase} samples; a sentence with an unverified number is thrown away)`)
  let ok = 0, tot = 0; const ts: number[] = []
  for (const it of EVAL_SET.filter(x => x.id && x.id !== 'buyers_owing').slice(0, nPhrase)) { const q = CATALOGUE.find(c => c.id === it.id)!; const rows = q.run(o, resolveParams(o, q, it.params)); if (!rows.length) continue
    const t = performance.now(); const s = await eng.phrase!(it.q, q.title, rows).catch(() => null); ts.push(performance.now() - t); tot++; if (s) ok++; console.log(`   ${Math.round(performance.now() - t)} ms  ${s ? 'ok  ' : 'DROP'} ${s ?? '(sentence rejected or failed; plain summary used)'}`) }
  console.log(`   accepted ${ok}/${tot}; median ${Math.round(med(ts))} ms`)

  const route = summarise(await evaluate(q => eng.route(mk(q)), HOLDOUT_SET)); const total = route.p50_ms + med(ts)
  console.log(`\nVerdict: typical answer ≈ ${(total / 1000).toFixed(1)} s (route ${route.p50_ms} ms + wording ${Math.round(med(ts))} ms + lookup <0.1 s). ${total < 15000 ? 'Comfortable.' : total < 40000 ? 'Usable; consider turning off model wording (Engine settings) to halve it.' : 'Slow; turn off model wording, or use keyword matching only.'}`)
}
void main()
