import { useCallback, useEffect, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { acceptInvitation, fetchLookups, fetchPortal, myAccess, viewsFor, type Access, type PortalRow, type PortalView } from '../services/sharing'
import { useApp, useToasts } from '../store/app'
import { fmt } from '../ui/hooks'
import { Button, Card, Input, Label, Table, Td } from '../ui/kit'
import { CloudSignIn } from './Sharing'

function cell(v: PortalView['cols'][number], row: PortalRow, lookups: Record<string, string>): string {
  const x = row[v.k]; if (x == null || x === '') return '—'
  switch (v.fmt) {
    case 'date': return fmt.date(String(x).slice(0, 10))
    case 'num': return fmt.num(Number(x), 1)
    case 'money': return fmt.money(Number(x))
    case 'bool': return x === true || x === 1 ? 'Yes' : 'No'
    case 'lookup': return lookups[String(x)] ?? '—'
    default: return String(x)
  }
}

export default function Portal() {
  const push = useToasts(s => s.push)
  const [sb, setSb] = useState<SupabaseClient | null>(null)
  const [access, setAccess] = useState<Access[]>([])
  const [sel, setSel] = useState<Access | null>(null)
  const [code, setCode] = useState('')
  const [tab, setTab] = useState<PortalView | null>(null)
  const [rows, setRows] = useState<PortalRow[] | null>(null)
  const [lookups, setLookups] = useState<Record<string, string>>({})
  const err = (e: unknown) => push('err', e instanceof Error ? e.message : String(e))

  const load = useCallback(async (c: SupabaseClient) => { try { const a = await myAccess(c); setAccess(a); setSel(s => a.find(x => x.grant_id === s?.grant_id) ?? (a.length === 1 ? a[0] : null)) } catch (e) { err(e) } }, [])  // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!sb || !sel) return
    setTab(null); setRows(null)
    void fetchLookups(sb, sel.tenant_id, sel.permissions).then(setLookups)
    setTab(viewsFor(sel.permissions)[0] ?? null)
  }, [sb, sel])
  useEffect(() => {
    if (!sb || !sel || !tab) return
    let live = true; setRows(null)
    fetchPortal(sb, tab, sel.tenant_id).then(r => live && setRows(r)).catch(e => { if (live) { err(e); setRows([]) } })
    return () => { live = false }
  }, [sb, sel, tab])  // eslint-disable-line react-hooks/exhaustive-deps

  async function accept() {
    try { await acceptInvitation(sb!, code); setCode(''); push('ok', 'Invitation accepted'); await load(sb!) } catch (e) { err(e) }
  }
  const views = sel ? viewsFor(sel.permissions) : []
  const groups = [...new Set(views.map(v => v.group))]

  return (
    <div className="min-h-full bg-gray-50"><div className="max-w-6xl mx-auto p-6">
      <div className="flex items-center justify-between mb-5">
        <div><h1 className="text-xl font-semibold text-gray-900">Contractor / extension portal</h1><p className="text-gray-500">Read-only view of the farms that have shared records with you.</p></div>
        <Button onClick={() => useApp.getState().leavePortal()}>Back to farm login</Button>
      </div>

      {!sb && <CloudSignIn allowCreate intro="Sign in with the email address the farmer invited. New here? Tick “Create a new account”. Some projects ask you to confirm your email first." onConnected={(c) => { setSb(c); void load(c) }} />}

      {sb && <>
        <Card className="p-4 mb-4 max-w-xl">
          <form className="flex gap-2 items-end" onSubmit={e => { e.preventDefault(); void accept() }}>
            <Label text="Have an invitation code?" className="flex-1"><Input value={code} onChange={e => setCode(e.target.value)} placeholder="Paste the code from the farmer" /></Label>
            <Button variant="primary" type="submit" disabled={!code.trim()}>Accept</Button>
          </form>
        </Card>

        <h2 className="font-medium mb-1">Shared with me</h2>
        {!access.length && <Card className="p-6 text-center text-gray-500 mb-4">Nothing has been shared with you yet.</Card>}
        <div className="flex flex-wrap gap-2 mb-4">{access.map(a => (
          <button key={a.grant_id} onClick={() => setSel(a)} className={`text-left border rounded-lg px-3 py-2 bg-white ${sel?.grant_id === a.grant_id ? 'border-brand-600 ring-1 ring-brand-600' : 'border-gray-200 hover:bg-gray-50'}`}>
            <div className="font-medium">{a.farm_name ?? a.tenant_name}</div><div className="text-xs text-gray-500 capitalize">{a.purpose}{a.expires_at ? ` · until ${fmt.date(a.expires_at.slice(0, 10))}` : ''}</div></button>))}</div>

        {sel && <>
          <Card className="px-3 py-2 mb-3 bg-amber-50 border-amber-200 text-amber-900 text-sm">You have view-only access. You can’t change any records, and you only see what the farmer chose to share.</Card>
          <div className="flex flex-wrap gap-x-5 gap-y-1 mb-3 border-b border-gray-200">{groups.map(g => (
            <div key={g} className="flex items-center gap-1 pb-1"><span className="text-[11px] uppercase tracking-wider text-gray-500 mr-1">{g}</span>
              {views.filter(v => v.group === g).map(v => <Button key={v.key} small variant={tab?.key === v.key ? 'primary' : 'ghost'} onClick={() => setTab(v)}>{v.label}</Button>)}</div>))}</div>
          {tab && <Card><Table head={tab.cols.map(c => c.label)} empty={rows ? 'No records.' : 'Loading…'}>
            {rows?.map((r, i) => <tr key={String(r.id ?? i)}>{tab.cols.map(c => <Td key={c.k} right={c.fmt === 'num' || c.fmt === 'money'}>{cell(c, r, lookups)}</Td>)}</tr>)}</Table></Card>}
        </>}
      </>}
    </div></div>
  )
}
