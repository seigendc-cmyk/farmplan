import { useRef, useState } from 'react'
import { createClient } from '@supabase/supabase-js'
import { Db, IndexedDbPersistence, MemoryPersistence } from '../db/database'
import { dismissSyncConflict, listSyncConflicts, retrySyncConflict, supabaseCloud, syncNow } from '../services/sync'
import { useCtx, useData, useRun, fmt, plural } from '../ui/hooks'
import { useApp, useToasts } from '../store/app'
import { Button, Card, Grid, Table, Td, Input, Label, PageHeader } from '../ui/kit'
import { can } from '../services/context'

const CFG = 'farmplan.cloud'
const load = () => { try { return JSON.parse(localStorage.getItem(CFG) ?? '{}') as { url?: string; key?: string; email?: string } } catch { return {} } }

export default function SyncPage() {
  const ctx = useCtx(); const run = useRun(); const push = useToasts(s => s.push); const bump = useApp(s => s.bump)
  const [cfg, setCfg] = useState(load()); const [pw, setPw] = useState(''); const [busy, setBusy] = useState(false); const [report, setReport] = useState('')
  const file = useRef<HTMLInputElement>(null)
  const last = ctx.db.get<{ value: string }>(`SELECT value FROM meta WHERE key='last_sync'`)?.value
  const owner = can(ctx, 'settings.farm.manage')
  const conflicts = useData(c => listSyncConflicts(c.db)) ?? []

  async function sync() {
    setBusy(true); setReport('')
    try {
      if (!cfg.url || !cfg.key || !cfg.email) throw new Error('Enter the Supabase URL, publishable key and your account email.')
      localStorage.setItem(CFG, JSON.stringify(cfg))
      const sb = createClient(cfg.url, cfg.key)
      const { error } = await sb.auth.signInWithPassword({ email: cfg.email, password: pw })
      if (error) throw new Error(`Cloud sign-in failed: ${error.message}`)
      const name = ctx.db.get<{ name: string }>(`SELECT name FROM tenants WHERE id=?`, [ctx.tenantId])!.name
      const r = await syncNow(ctx.db, supabaseCloud(sb), ctx.tenantId, name)
      setReport(r.errors.length ? `Failed: ${r.errors.join('; ')}` : `Sent ${plural(r.pushed, 'record')}, received ${r.pulled}${r.conflictsKept ? `, kept ${r.conflictsKept} newer local edits` : ''}${r.quarantined ? `; ${r.quarantined} record(s) were refused by the cloud — see below` : ''}.`)
      if (!r.errors.length) push('ok', 'Sync complete')
      bump(); await sb.auth.signOut()
    } catch (e) { setReport(e instanceof Error ? e.message : String(e)) } finally { setBusy(false); setPw('') }
  }

  function download() {
    const blob = new Blob([ctx.db.exportBytes() as BlobPart], { type: 'application/x-sqlite3' })
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob)
    a.download = `farmplan-backup-${new Date().toISOString().slice(0, 10)}.sqlite`; a.click(); URL.revokeObjectURL(a.href)
  }
  async function restore(f: File) {
    if (!confirm('Restoring replaces ALL data on this computer with the backup. Continue?')) return
    await run(async () => {
      const bytes = new Uint8Array(await f.arrayBuffer())
      const mem = new MemoryPersistence(); mem.data = bytes
      const test = await Db.open(mem, x => `${import.meta.env.BASE_URL}${x}`)
      if (!test.get(`SELECT 1 FROM tenants LIMIT 1`)) throw new Error('That file is not a farmPLAN backup.')
      await new IndexedDbPersistence().save(bytes); location.reload()
    })
  }

  return (
    <>
      <PageHeader title="Sync & backup" sub="Works fully offline. Connect to the cloud whenever Internet is available." />
      <div className="grid md:grid-cols-2 gap-4">
        <Card className="p-4 space-y-3"><h2 className="font-medium">Cloud sync (Supabase)</h2>
          <p className="text-gray-500 text-sm">{ctx.db.pendingSync()} local changes waiting · last sync {last ? fmt.date(last) : 'never'}</p>
          <Label text="Project URL"><Input value={cfg.url ?? ''} onChange={e => setCfg({ ...cfg, url: e.target.value })} placeholder="https://xxxx.supabase.co" /></Label>
          <Label text="Publishable key"><Input value={cfg.key ?? ''} onChange={e => setCfg({ ...cfg, key: e.target.value })} /></Label>
          <Grid><Label text="Account email"><Input type="email" value={cfg.email ?? ''} onChange={e => setCfg({ ...cfg, email: e.target.value })} /></Label>
            <Label text="Password"><Input type="password" value={pw} onChange={e => setPw(e.target.value)} autoComplete="current-password" /></Label></Grid>
          <Button variant="primary" disabled={busy || !owner} onClick={sync}>{busy ? 'Syncing…' : 'Sync now'}</Button>
          {!owner && <p className="text-xs text-gray-500">Only users who can manage the farm can sync.</p>}
          {report && <p className="text-sm text-gray-700 bg-gray-50 border border-gray-200 rounded p-2">{report}</p>}
        </Card>
        <Card className="p-4 space-y-3"><h2 className="font-medium">Backup & restore</h2>
          <p className="text-gray-500 text-sm">A backup is a single file containing the whole farm database. Keep copies off this computer.</p>
          <div className="flex gap-2"><Button onClick={download}>Download backup</Button>
            {owner && <Button variant="danger" onClick={() => file.current?.click()}>Restore from file…</Button>}</div>
          <input ref={file} type="file" accept=".sqlite,.db" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) void restore(f); e.target.value = '' }} />
        </Card>
      </div>
      {conflicts.length > 0 && <Card className="mt-4"><div className="px-4 pt-3"><h2 className="font-medium">Records the cloud refused</h2>
        <p className="text-sm text-gray-500">These stay on this computer and everything else synced. A common cause is stock or capacity that another device had not yet uploaded — sync again, then Retry.</p></div>
        <Table head={['Table', 'Record', 'Reason', 'When', '']}>
          {conflicts.map(c => <tr key={c.id}><Td>{c.table_name}</Td><Td className="font-mono text-xs">{c.row_id.slice(0, 8)}</Td><Td>{c.reason}</Td><Td>{c.created_at}</Td>
            <Td className="text-right space-x-1">{owner && <><Button small onClick={() => void run(() => retrySyncConflict(ctx.db, c.id), 'Queued for the next sync')}>Retry</Button>
              <Button small variant="ghost" onClick={() => void run(() => dismissSyncConflict(ctx.db, c.id), 'Dismissed')}>Dismiss</Button></>}</Td></tr>)}</Table></Card>}
    </>
  )
}
