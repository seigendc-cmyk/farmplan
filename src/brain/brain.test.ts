import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Db, MemoryPersistence } from '../db/database'
import { initialiseFarm, login, createUser } from '../services/setup'
import { type Ctx, PermissionError } from '../services/context'
import { createSeason } from '../services/seasons'
import { createField } from '../services/fields'
import { recordHarvest } from '../services/harvest'
import { recordWeather } from '../services/weather'
import { recordLabour } from '../services/labour'
import { addCost } from '../services/util'
import { createRole } from '../services/roles'
import { recordNote } from '../services/activity'
import { setBiTransport } from '../services/bi'
import { askBrain, askCloudOpen, DEFAULT_BRAIN, type BrainSettings } from './ask'
import { availableQuestions, CATALOGUE, resolveParams } from './catalogue'
import { claudeEngine, extractParams, localEngine, numbersGrounded, parseDecision, rulesEngine, testLocal, DEFAULT_LOCAL, type LocalTransport } from './engine'

let db: Db; let o: Ctx; let season: string; let f4: string
beforeEach(async () => {
  db = await Db.open(new MemoryPersistence())
  await initialiseFarm(db, { tenantName: 'T', farmName: 'F', ownerName: 'Lovemore', ownerPin: '1234' })
  const r = await login(db, 'Lovemore', '1234'); o = { db, ...r.ctx! }
  season = createSeason(o, { label: '2026/27', starts_on: '2026-09-01', ends_on: '2027-08-31', activate: true })
  f4 = createField(o, { field_no: 'F-04', area_ha: 4 }); const f5 = createField(o, { field_no: 'F-05', area_ha: 2 })
  recordHarvest(o, { field_id: f4, season_id: season, harvested_on: '2027-01-20', green_weight_kg: 2000 }); recordHarvest(o, { field_id: f5, season_id: season, harvested_on: '2027-01-21', green_weight_kg: 500 })
  recordWeather(o, { season_id: season, recorded_on: '2027-01-10', rainfall_mm: 12 }); recordWeather(o, { season_id: season, recorded_on: '2027-02-03', rainfall_mm: 30 })
  addCost(o, { seasonId: season, category: 'fertilizer', amount: 800, on: '2027-01-05', sourceType: 'manual', sourceId: 'x1', fieldId: f4 })
  recordLabour(o, { season_id: season, worked_on: '2027-01-12', worker_name: 'Rudo', task: 'weeding', hours: 8, field_id: f4 } as never)
})
afterEach(() => setBiTransport(null))
const withRole = async (name: string, perms: string[]) => { const rid = createRole(o, name, perms); await createUser(o, name, '9999', rid); const r = await login(db, name, '9999'); const c = { db, ...r.ctx! } as Ctx; await login(db, 'Lovemore', '1234'); return c }
const rules: BrainSettings = { ...DEFAULT_BRAIN, engine: 'rules' }

describe('keyword router + catalogue', () => {
  it('answers a harvest question from the fixed lookup, with the sources', async () => {
    const a = await askBrain(o, 'How much did we harvest from each field this season?', { settings: rules })
    expect(a.engine).toBe('rules'); expect(a.id).toBe('harvest_by_field'); expect(a.rows).toEqual([{ field: 'F-04', green_kg: 2000, batches: 1 }, { field: 'F-05', green_kg: 500, batches: 1 }])
    expect(a.params.season).toBe('2026/27'); expect(a.sources[0].ref).toBe('bi_harvests'); expect(a.sentence).toMatch(/F-04 leads with 2,000/)
  })
  it('handles rain by month, costs per hectare and who-owes without any model', async () => {
    expect((await askBrain(o, 'how much rain fell each month in 2026/27', { settings: rules })).rows).toEqual([{ month: '2027-01', rain_mm: 12, rain_days: 1 }, { month: '2027-02', rain_mm: 30, rain_days: 1 }])
    const c = await askBrain(o, 'Which field had the highest cost per hectare?', { settings: rules }); expect(c.id).toBe('cost_per_ha'); expect(c.rows[0]).toMatchObject({ field: 'F-04', cost_per_ha: 200 })
    expect((await askBrain(o, 'who owes us money?', { settings: rules })).id).toBe('buyers_owing')
    expect((await askBrain(o, 'What is the total spend by category', { settings: rules })).id).toBe('cost_by_category')
  })
  it('extracts season, field, person, days and quoted text', () => {
    const i = { question: 'What did Tendai record on F-04 in the last 3 days?', spec: [], seasons: ['2026/27'], fields: ['F-04'], people: ['Tendai'], today: '2027-01-30' }
    expect(extractParams(i)).toMatchObject({ field: 'F-04', actor: 'Tendai', days: 3 }); expect(extractParams({ ...i, question: 'notes that mention "hail damage"' }).text).toBe('hail damage')
    expect(extractParams({ ...i, question: 'costs for 2026-27' }).season).toBe('2026/27')
  })
  it('says so (with suggestions) when nothing matches, and refuses a season that does not exist', async () => {
    const n = await askBrain(o, 'What is the meaning of life?', { settings: rules }); expect(n.id).toBeNull(); expect(n.suggestions.length).toBeGreaterThan(0); expect(n.canTryCloud).toBe(true)
    const bad = await askBrain(o, 'harvest per field', { settings: rules, localTransport: undefined }); expect(bad.id).toBe('harvest_by_field')
    expect(() => resolveParams(o, CATALOGUE.find(q => q.id === 'harvest_by_field')!, { season: '1999/00' })).toThrow(/No season/)
    expect(() => resolveParams(o, CATALOGUE.find(q => q.id === 'recent_activity')!, { days: 9999 })).toThrow(/between 1 and 365/)
  })
})

describe('access: the chat can only answer what the person could already open', () => {
  it('needs brain.chat.ask', async () => {
    const rec = await withRole('Plain', ['production.harvest.view']); await expect(askBrain(rec, 'harvest per field', { settings: rules })).rejects.toThrow(PermissionError)
  })
  it('hides catalogue entries the role lacks data permission for', async () => {
    const c = await withRole('Weatherman', ['brain.chat.ask', 'production.weather.view'])
    expect(availableQuestions(c).map(q => q.id)).toEqual(['rain_by_month'])
    expect((await askBrain(c, 'rain by month', { settings: rules })).rows).toHaveLength(2)
    const h = await askBrain(c, 'harvest per field', { settings: rules }); expect(h.id).toBeNull(); expect(h.rows).toEqual([])
    const m = await askBrain(c, 'what did we spend on fertilizer', { settings: rules }); expect(m.id).toBeNull()
  })
  it('activity questions follow the activity access level', async () => {
    recordNote(o, { text: 'Hail damage on the north edge' })
    const own = await withRole('Scout', ['brain.chat.ask', 'brain.log.view_own', 'brain.note.record'])
    recordNote(own, { text: 'Saw hail on F-05' })
    const mine = await askBrain(own, 'find notes that mention "hail"', { settings: rules }); expect(mine.id).toBe('find_notes'); expect(mine.rows).toHaveLength(1); expect(String(mine.rows[0].what)).toMatch(/F-05/)
    const all = await askBrain(o, 'find notes that mention "hail"', { settings: rules }); expect(all.rows).toHaveLength(2)
    const noLog = await withRole('NoLog', ['brain.chat.ask', 'production.weather.view']); expect(availableQuestions(noLog).some(q => q.id === 'recent_activity')).toBe(false)
  })
})

describe('local model engine', () => {
  const settings: BrainSettings = { engine: 'auto', localEnabled: true, local: { ...DEFAULT_LOCAL, url: 'http://127.0.0.1:8080/', phrase: true } }
  const reply = (content: string): LocalTransport => async () => ({ choices: [{ message: { content } }] })
  it('sends a JSON schema limited to the questions this person may ask, and never any rows when routing', async () => {
    const c = await withRole('Weatherman', ['brain.chat.ask', 'production.weather.view']); const calls: { url: string; body: any }[] = []
    const tr: LocalTransport = async (url, body) => { calls.push({ url, body }); return { choices: [{ message: { content: calls.length === 1 ? '{"id":"rain_by_month","params":{"season":"2026/27"}}' : 'Rain fell in two months, with 12 mm in 2027-01 and 30 mm in 2027-02.' } }] } }
    const a = await askBrain(c, 'how wet was it', { settings, localTransport: tr })
    expect(calls[0].url).toBe('http://127.0.0.1:8080/v1/chat/completions'); expect(calls[0].body.response_format.json_schema.schema.properties.id.enum).toEqual(['rain_by_month', null])
    expect(calls[0].body.temperature).toBe(0); expect(JSON.stringify(calls[0].body)).not.toMatch(/2000|Rudo|fertilizer/)
    expect(a.engine).toBe('local'); expect(a.id).toBe('rain_by_month'); expect(a.sentence).toMatch(/12 mm/); expect(calls).toHaveLength(2)
  })
  it('throws away a sentence containing a number that is not in the table', async () => {
    let n = 0; const tr: LocalTransport = async () => ({ choices: [{ message: { content: n++ === 0 ? '{"id":"harvest_by_field","params":{}}' : 'F-04 produced 9,999 kg, a record.' } }] })
    const a = await askBrain(o, 'harvest please', { settings, localTransport: tr }); expect(a.sentence).not.toMatch(/9,999/); expect(a.sentence).toMatch(/F-04 leads with 2,000/)
  })
  it('falls back to keywords when the model is down, returns nonsense, or picks an unknown item', async () => {
    const down: LocalTransport = async () => { throw new Error('The local model is not reachable') }
    const a = await askBrain(o, 'harvest per field', { settings, localTransport: down }); expect(a.engine).toBe('rules'); expect(a.id).toBe('harvest_by_field'); expect(a.notes.join(' ')).toMatch(/not reachable.*keyword/)
    const junk = await askBrain(o, 'harvest per field', { settings, localTransport: reply('sure thing!') }); expect(junk.id).toBe('harvest_by_field'); expect(junk.notes.length).toBe(1)
    const wrong = await askBrain(o, 'harvest per field', { settings, localTransport: reply('{"id":"drop_table","params":{}}') }); expect(wrong.id).toBe('harvest_by_field')   // unknown id → null → keyword second chance
    expect(parseDecision('{"id":"x","params":{"a":{"b":1},"c":"ok"}}', ['y'])).toEqual({ id: null, params: { c: 'ok' } })
  })
  it('refuses parameters that do not exist rather than guessing', async () => {
    const a = await askBrain(o, 'harvest in an odd season', { settings, localTransport: reply('{"id":"harvest_by_field","params":{"season":"2031/32"}}') }); expect(a.id).toBeNull(); expect(a.sentence).toMatch(/No season called 2031\/32/)
  })
  it('number guard accepts formatting differences and rejects invented figures', () => {
    const rows = [{ field: 'F-04', kg: 2000.5, n: 3 }]
    expect(numbersGrounded('F-04 had 2,000.5 kg across 1 row', rows)).toBe(true); expect(numbersGrounded('about 2,001 kg', rows)).toBe(true); expect(numbersGrounded('about 2,100 kg', rows)).toBe(false)
  })
  it('test-connection lists models', async () => { expect(await testLocal(DEFAULT_LOCAL, async () => ({ data: [{ id: 'qwen2.5:3b-instruct' }] }))).toEqual(['qwen2.5:3b-instruct']) })
  it('is only used when enabled', async () => { let called = false; const a = await askBrain(o, 'harvest per field', { settings: { ...settings, localEnabled: false }, localTransport: async () => { called = true; return {} } }); expect(called).toBe(false); expect(a.engine).toBe('rules') })
})

describe('Claude opt-in', () => {
  it('needs brain.chat.cloud and a key, and sends names but no records', async () => {
    const mgr = await withRole('Mgr', ['brain.chat.ask', 'production.harvest.view'])
    await expect(askBrain(mgr, 'harvest per field', { engine: 'claude', apiKey: 'sk-x' })).rejects.toThrow(PermissionError)
    await expect(askBrain(o, 'harvest per field', { engine: 'claude', apiKey: '  ' })).rejects.toThrow(/API key/)
    const seen: string[] = []; setBiTransport(async r => { seen.push(r.system + '\n' + r.messages.map(m => m.content).join('\n')); return '{"id":"harvest_by_field","params":{"season":"2026/27"}}' })
    const a = await askBrain(o, 'which field gave the most leaf?', { engine: 'claude', apiKey: 'sk-x' })
    expect(a.engine).toBe('claude'); expect(a.id).toBe('harvest_by_field'); expect(a.rows[0].field).toBe('F-04'); expect(seen.join()).not.toMatch(/2000|Rudo|800/); expect(seen.join()).toMatch(/F-04/)
    expect(claudeEngine('k').name).toBe('claude')
  })
  it('the open-ended path is gated by the same permission', async () => {
    const mgr = await withRole('Mgr2', ['brain.chat.ask', 'production.harvest.view']); await expect(askCloudOpen(mgr, 'why was F-04 so good')).rejects.toThrow(PermissionError)
    expect(rulesEngine.name).toBe('rules'); expect(localEngine(DEFAULT_LOCAL).phrase).toBeTypeOf('function')
  })
})

describe('real HTTP transport', () => {
  it('talks to an OpenAI-compatible server, reports errors plainly, and times out', async () => {
    const { createServer } = await import('node:http'); let mode: 'ok' | 'err' | 'slow' = 'ok'; let seen: any = null
    const srv = createServer((req, res) => { let b = ''; req.on('data', d => (b += d)); req.on('end', () => {
      if (req.url === '/v1/models') { res.setHeader('content-type', 'application/json'); return void res.end(JSON.stringify({ data: [{ id: 'm1' }] })) }
      if (mode === 'err') { res.statusCode = 500; return void res.end('boom') }
      if (mode === 'slow') return
      seen = JSON.parse(b); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content: '{"id":"fields_list","params":{}}' } }] })) }) })
    await new Promise<void>(r => srv.listen(0, '127.0.0.1', r)); const url = `http://127.0.0.1:${(srv.address() as { port: number }).port}`
    try {
      expect(await testLocal({ ...DEFAULT_LOCAL, url })).toEqual(['m1'])
      const s: BrainSettings = { engine: 'auto', localEnabled: true, local: { ...DEFAULT_LOCAL, url, model: 'm1', timeoutMs: 400 } }
      const a = await askBrain(o, 'show me the list', { settings: s }); expect(a.engine).toBe('local'); expect(a.id).toBe('fields_list'); expect(seen.model).toBe('m1'); expect(seen.response_format.type).toBe('json_schema')
      mode = 'err'; const e = await askBrain(o, 'list all fields', { settings: s }); expect(e.engine).toBe('rules'); expect(e.notes[0]).toMatch(/returned 500/)
      mode = 'slow'; const t = await askBrain(o, 'list all fields', { settings: s }); expect(t.engine).toBe('rules'); expect(t.notes[0]).toMatch(/too long/)
      await expect(testLocal({ ...DEFAULT_LOCAL, url: 'http://127.0.0.1:1' })).rejects.toThrow(/not reachable/)
    } finally { srv.closeAllConnections?.(); srv.close() }
  })
})
