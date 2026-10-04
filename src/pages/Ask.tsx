import { useState } from 'react'
import { askBrain, askCloudOpen, loadBrainSettings, saveBrainSettings, type BrainAnswer, type BrainSettings } from '../brain/ask'
import { availableQuestions } from '../brain/catalogue'
import { DEFAULT_LOCAL, testLocal } from '../brain/engine'
import { BI_ROW_LIMIT, DEFAULT_MODEL, clearBiSettings, loadBiSettings, saveBiSettings, type BiSettings } from '../services/bi'
import { can } from '../services/context'
import { useToasts } from '../store/app'
import { useCtx, useData } from '../ui/hooks'
import { Badge, Button, Card, Denied, Input, Label, Modal, PageHeader, Select, Table, Td } from '../ui/kit'

const cell = (v: unknown) => v == null ? '—' : typeof v === 'number' ? new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(v) : String(v)
const ENGINE_LABEL = { rules: 'Keyword matching', local: 'Local model', claude: 'Claude' } as const
const PRIVACY = 'Sends your question and the names of tables and columns only, never farm records. The query Claude writes runs here, on the data your role may see.'
type Answer = BrainAnswer & { sql?: string | null; truncated?: boolean }

/**
 * One place to ask. The business brain answers first, from fixed checked lookups on this device (`brain.chat.ask`).
 * Claude is the fallback, for people allowed to send a question off the device (`brain.chat.cloud`); its answers are
 * read-only queries over the `bi_*` views the role may see, run locally. Replaces "Ask your data" and "Ask the brain".
 */
export default function Ask() {
  const ctx = useCtx(); const push = useToasts(s => s.push)
  const brain = can(ctx, 'brain.chat.ask'); const cloud = can(ctx, 'brain.chat.cloud')
  const qs = useData(c => brain ? availableQuestions(c) : []) ?? []
  const [s, setS] = useState<BrainSettings>(loadBrainSettings()); const [bi, setBi] = useState<BiSettings>(loadBiSettings())
  const [open, setOpen] = useState(false); const [q, setQ] = useState(''); const [busy, setBusy] = useState(false); const [history, setHistory] = useState<Answer[]>([])
  const [probe, setProbe] = useState(''); const [sqlShown, setSqlShown] = useState<number | null>(null)
  if (!brain && !cloud) return <Denied what="Ask" />

  async function ask(text: string) {
    if (!brain) return askClaude(text)
    setBusy(true)
    try { const a = await askBrain(ctx, text, { settings: s }); setHistory(h => [a, ...h]); setQ('') } catch (e) { push('err', e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }
  async function askClaude(text: string) {
    if (!loadBiSettings().apiKey.trim()) { setOpen(true); push('err', 'Add your Anthropic API key under Engine settings → Claude first'); return }
    setBusy(true)
    try {
      const r = await askCloudOpen(ctx, text)
      setHistory(h => [{ question: text, engine: 'claude', id: null, title: 'Open question', params: {}, columns: r.result?.columns ?? [], rows: r.result?.rows ?? [], sentence: r.explanation,
        sources: [{ kind: 'view', ref: 'bi views' }], notes: ['Claude wrote a read-only query from table and column names only; it ran on this device.'], suggestions: [], canTryCloud: false, sql: r.sql, truncated: r.result?.truncated }, ...h])
      setQ('')
    } catch (e) { push('err', e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }
  const save = (n: BrainSettings) => { setS(n); saveBrainSettings(n) }
  const saveKey = (n: BiSettings) => { setBi(n); saveBiSettings(n) }

  return (
    <>
      <PageHeader title="Ask" sub={brain ? 'Ask about the farm in plain language. Answers come from fixed, checked lookups on this device, limited to what your role can open.' + (cloud ? ' If the brain has no answer, you can ask Claude instead.' : '')
        : 'Your role asks Claude directly. ' + PRIVACY} actions={<Button onClick={() => setOpen(true)}>Engine settings</Button>} />
      <form className="flex gap-2 mb-2" onSubmit={e => { e.preventDefault(); void ask(q) }}>
        <Input value={q} onChange={e => setQ(e.target.value)} placeholder="e.g. How much did we harvest from each field this season?" aria-label="Your question" />
        <Button variant="primary" type="submit" disabled={busy || q.trim().length < 3}>{busy ? 'Working…' : 'Ask'}</Button>
      </form>
      <div className="flex flex-wrap gap-1.5 mb-5">{qs.slice(0, 8).map(x => <button key={x.id} type="button" onClick={() => setQ(x.about)} className="text-xs border border-gray-200 bg-white rounded-full px-2.5 py-1 hover:bg-gray-50">{x.title}</button>)}</div>
      <div className="space-y-4">{history.map((a, i) => (
        <Card key={i} className="p-4">
          <div className="flex items-start justify-between gap-3"><div className="font-medium">{a.question}</div><Badge tone={a.engine === 'claude' ? 'amber' : a.engine === 'local' ? 'green' : 'gray'}>{ENGINE_LABEL[a.engine]}</Badge></div>
          <p className="my-2">{a.sentence}</p>
          {a.title && a.engine !== 'claude' && <p className="text-xs text-gray-500 mb-2">Looked up: {a.title}{Object.keys(a.params).length > 0 && ` (${Object.entries(a.params).map(([k, v]) => `${k}: ${v}`).join(', ')})`} · from {a.sources.map(x => x.ref).join(', ')}</p>}
          {a.rows.length > 0 && <Table head={a.columns.map((c, j) => ({ label: c.replace(/_/g, ' '), right: typeof a.rows[0][c] === 'number' && j > 0 }))}>{a.rows.slice(0, 50).map((r, j) => <tr key={j}>{a.columns.map((c, k) => <Td key={c} right={typeof r[c] === 'number' && k > 0}>{cell(r[c])}</Td>)}</tr>)}</Table>}
          {a.engine === 'claude' && a.rows.length === 0 && a.sql && <p className="text-sm text-gray-500">The query returned no rows.</p>}
          {a.truncated && <p className="text-xs text-amber-700 mt-1">Showing the first {BI_ROW_LIMIT} rows.</p>}
          {a.sql && <><button type="button" className="text-xs text-gray-600 underline mt-2" aria-expanded={sqlShown === i} onClick={() => setSqlShown(sqlShown === i ? null : i)}>{sqlShown === i ? 'Hide' : 'Show'} the query</button>
            {sqlShown === i && <pre className="text-xs bg-gray-50 border rounded p-2 mt-1 overflow-x-auto whitespace-pre-wrap">{a.sql}</pre>}</>}
          {a.notes.map(n => <p key={n} className="text-xs text-amber-700 mt-2">{n}</p>)}
          {a.suggestions.length > 0 && <div className="mt-2 text-sm text-gray-600">Try: {a.suggestions.map(x => <button key={x} type="button" className="mr-2 underline" onClick={() => setQ(x)}>{x}</button>)}</div>}
          {cloud && a.engine !== 'claude' && (a.canTryCloud
            ? <div className="mt-3 flex flex-wrap items-center gap-2"><Button small variant="primary" disabled={busy} onClick={() => void askClaude(a.question)}>Ask Claude instead</Button><span className="text-xs text-gray-600">{PRIVACY}</span></div>
            : <div className="mt-2 text-xs text-gray-600">Not what you meant? <button type="button" className="underline" disabled={busy} onClick={() => void askClaude(a.question)}>Ask Claude instead</button></div>)}
        </Card>))}</div>

      {open && <Modal title="Engine settings" onClose={() => setOpen(false)}>
        {brain && <><p className="text-xs text-gray-500 mb-3">The brain always picks from a fixed list of lookups, so even a small model cannot make up figures. A local model only chooses the lookup and words the answer; if it is off or unreachable, keyword matching still works.</p>
        <div className="space-y-3">
          <Label text="Engine"><Select value={s.engine} onChange={e => save({ ...s, engine: e.target.value as BrainSettings['engine'] })}><option value="auto">Local model when available, else keywords</option><option value="rules">Keyword matching only</option></Select></Label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={s.localEnabled} onChange={e => save({ ...s, localEnabled: e.target.checked })} />Use a local model on this computer</label>
          {s.localEnabled && <>
            <Label text="Local server address" hint="llama.cpp server or Ollama on this computer"><Input value={s.local.url} onChange={e => save({ ...s, local: { ...s.local, url: e.target.value } })} /></Label>
            <Label text="Model name" hint="A 3B model such as qwen2.5:3b-instruct suits 8 GB computers"><Input value={s.local.model} onChange={e => save({ ...s, local: { ...s.local, model: e.target.value } })} placeholder={DEFAULT_LOCAL.model} /></Label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={s.local.phrase} onChange={e => save({ ...s, local: { ...s.local, phrase: e.target.checked } })} />Let the model word the answer (numbers are checked against the table)</label>
            <div className="flex items-center gap-2"><Button small onClick={async () => { try { const m = await testLocal(s.local); setProbe(m.length ? `Connected. Models: ${m.slice(0, 5).join(', ')}` : 'Connected, but no models are loaded') } catch (e) { setProbe(e instanceof Error ? e.message : 'Not reachable') } }}>Test connection</Button><span className="text-xs text-gray-500">{probe}</span></div></>}
        </div></>}
        {cloud && <fieldset className={`space-y-3 ${brain ? 'mt-5 pt-4 border-t border-gray-200' : ''}`}><legend className="font-medium text-sm mb-1">Claude (fallback)</legend>
          <p className="text-xs text-gray-600">{PRIVACY} The key is kept on this device only; remove it on shared devices.</p>
          <Label text="Anthropic API key"><Input type="password" autoComplete="off" value={bi.apiKey} onChange={e => saveKey({ ...bi, apiKey: e.target.value })} placeholder="sk-ant-…" /></Label>
          <Label text="Claude model"><Input value={bi.model} onChange={e => saveKey({ ...bi, model: e.target.value })} placeholder={DEFAULT_MODEL} /></Label>
          {bi.apiKey && <Button small variant="danger" onClick={() => { clearBiSettings(); setBi({ apiKey: '', model: DEFAULT_MODEL }); push('ok', 'Key removed from this device') }}>Remove key</Button>}
        </fieldset>}
        <div className="flex justify-end mt-4"><Button variant="primary" onClick={() => setOpen(false)}>Done</Button></div></Modal>}
    </>
  )
}
