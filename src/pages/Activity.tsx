import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { activityActors, canSeeAnyActivity, listActivity, recordNote, visibleDomains } from '../services/activity'
import { listFields } from '../services/fields'
import { can } from '../services/context'
import { useCtx, useData, useRun, fmt } from '../ui/hooks'
import { Badge, Button, Card, Denied, Input, Label, Modal, PageHeader, Select, Textarea } from '../ui/kit'
import { RecLink } from '../ui/links'
import type { Domain, EventKind } from '../db/activity'

const KINDS: { id: EventKind; label: string }[] = [{ id: 'action', label: 'Actions' }, { id: 'note', label: 'Notes' }, { id: 'voice', label: 'Voice' }, { id: 'photo', label: 'Photos' }, { id: 'system', label: 'System' }]
const DOMAIN_LABEL: Record<Domain, string> = { ops: 'Operations', finance: 'Finance', admin: 'Admin' }
const TONE: Record<Domain, 'green' | 'amber' | 'gray'> = { ops: 'green', finance: 'amber', admin: 'gray' }

export default function Activity() {
  const ctx = useCtx(); const run = useRun(); const [params] = useSearchParams()
  const [q, setQ] = useState(''); const [kind, setKind] = useState(''); const [domain, setDomain] = useState(''); const [actor, setActor] = useState(''); const [fieldId, setFieldId] = useState(params.get('field') ?? ''); const [from, setFrom] = useState(''); const [to, setTo] = useState('')
  const [limit, setLimit] = useState(100); const [note, setNote] = useState<{ text: string; field_id: string; visibility: Domain } | null>(null)
  const rows = useData(c => listActivity(c, { q, kind: (kind || undefined) as EventKind | undefined, domain: (domain || undefined) as Domain | undefined, actor: actor || undefined, fieldId: fieldId || undefined, from: from || undefined, to: to || undefined, limit }), [q, kind, domain, actor, fieldId, from, to, limit])
  const actors = useData(c => activityActors(c), [rows?.length]) ?? []
  const fields = useData(c => can(c, 'production.field.view') ? listFields(c) : []) ?? []
  const doms = visibleDomains(ctx)
  if (!canSeeAnyActivity(ctx)) return <Denied what="the activity log" />
  const canNote = can(ctx, 'brain.note.record')
  const day = (iso: string) => iso.slice(0, 10)
  let last = ''
  return (
    <>
      <PageHeader title="Activity" sub="Everything that happens on the farm, in order. You see what your access level allows." actions={canNote && <Button variant="primary" onClick={() => setNote({ text: '', field_id: fieldId, visibility: 'ops' })}>Add note</Button>} />
      <Card className="p-3 mb-3"><div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <Input placeholder="Search…" aria-label="Search activity" value={q} onChange={e => { setQ(e.target.value); setLimit(100) }} className="col-span-2" />
        <Select aria-label="Kind" value={kind} onChange={e => setKind(e.target.value)}><option value="">All kinds</option>{KINDS.map(k => <option key={k.id} value={k.id}>{k.label}</option>)}</Select>
        {doms.length > 1 && <Select aria-label="Area" value={domain} onChange={e => setDomain(e.target.value)}><option value="">All areas</option>{doms.map(d => <option key={d} value={d}>{DOMAIN_LABEL[d]}</option>)}</Select>}
        <Select aria-label="Person" value={actor} onChange={e => setActor(e.target.value)}><option value="">Everyone</option>{actors.map(a => <option key={a} value={a}>{a}</option>)}</Select>
        {fields.length > 0 && <Select aria-label="Field" value={fieldId} onChange={e => setFieldId(e.target.value)}><option value="">All fields</option>{fields.map(f => <option key={f.id} value={f.id}>{f.field_no}</option>)}</Select>}
        <Input type="date" aria-label="From date" value={from} onChange={e => setFrom(e.target.value)} /><Input type="date" aria-label="To date" value={to} onChange={e => setTo(e.target.value)} />
      </div></Card>
      {!rows ? <Denied what="the activity log" /> : rows.length === 0 ? <Card className="p-6 text-gray-500">No activity matches.</Card> : <Card className="divide-y divide-gray-100">
        {rows.map(r => { const d = day(r.occurred_at); const head = d !== last; last = d
          return <div key={r.id}>{head && <div className="px-4 py-1.5 bg-gray-50 text-xs uppercase tracking-wide text-gray-500">{fmt.date(d)}</div>}
            <div className="px-4 py-2 flex items-start gap-3"><div className="text-xs text-gray-500 w-12 pt-0.5">{new Date(r.occurred_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
              <div className="flex-1 min-w-0"><div>{r.summary}</div>
                <div className="text-xs text-gray-500 flex flex-wrap gap-x-2">{r.actor_name && <span>{r.actor_name}</span>}{r.device_tag && <span>· phone {r.device_tag}</span>}{r.field_no && <span>· field <RecLink kind="field" code={r.field_no} /></span>}</div>
                {r.body && <p className="text-sm text-gray-600 mt-1 whitespace-pre-wrap">{r.body}</p>}</div>
              <div className="flex gap-1">{r.kind === 'note' && <Badge>note</Badge>}<Badge tone={TONE[r.domain]}>{DOMAIN_LABEL[r.domain]}</Badge></div></div></div> })}</Card>}
      {rows && rows.length >= limit && <div className="text-center mt-3"><Button onClick={() => setLimit(limit + 100)}>Show more</Button></div>}
      {note && <Modal title="Add a note" onClose={() => setNote(null)}>
        <form className="space-y-3" onSubmit={async e => { e.preventDefault(); if (await run(() => recordNote(ctx, { text: note.text, field_id: note.field_id || null, visibility: note.visibility }), 'Note added')) setNote(null) }}>
          <Label text="Note"><Textarea rows={4} autoFocus value={note.text} onChange={e => setNote({ ...note, text: e.target.value })} /></Label>
          {fields.length > 0 && <Label text="About field (optional)"><Select value={note.field_id} onChange={e => setNote({ ...note, field_id: e.target.value })}><option value="">Whole farm</option>{fields.map(f => <option key={f.id} value={f.id}>{f.field_no}</option>)}</Select></Label>}
          {doms.length > 1 && <Label text="Who can read it" hint="Only people with this level of access"><Select value={note.visibility} onChange={e => setNote({ ...note, visibility: e.target.value as Domain })}>{(['ops', ...doms.filter(d => d !== 'ops')] as Domain[]).map(d => <option key={d} value={d}>{DOMAIN_LABEL[d]}</option>)}</Select></Label>}
          <div className="flex justify-end gap-2"><Button type="button" onClick={() => setNote(null)}>Cancel</Button><Button variant="primary" type="submit">Save note</Button></div></form></Modal>}
    </>
  )
}
