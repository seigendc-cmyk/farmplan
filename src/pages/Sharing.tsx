import { useCallback, useEffect, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { useCloudSession } from '../store/cloudSession'
import { connectCloud, loadCloudConfig, saveCloudConfig } from '../lib/cloud'
import { SHARE_MENUS, SHARE_PRESETS, createInvitation, invitationState, labelFor, listGrants, listInvitations, revokeGrant, revokeInvitation, validateShare, type Grant, type Invitation, type SharePurpose } from '../services/sharing'
import { can } from '../services/context'
import { useCtx, useRun, fmt } from '../ui/hooks'
import { Badge, Button, Card, Denied, Grid, Input, Label, Modal, NumberInput, Select, Table, Td } from '../ui/kit'

export function CloudSignIn({ onConnected, allowCreate, intro }: { onConnected: (sb: SupabaseClient, email: string) => void; allowCreate?: boolean; intro?: string }) {
  const run = useRun()
  const [cfg, setCfg] = useState(loadCloudConfig()); const [pw, setPw] = useState(''); const [create, setCreate] = useState(false)
  async function go() {
    let sb: SupabaseClient | null = null
    if (await run(async () => { sb = await connectCloud(cfg, pw, create); saveCloudConfig({ url: cfg.url, key: cfg.key, email: cfg.email }) }, 'Connected to the cloud') && sb) onConnected(sb, cfg.email!)
  }
  return (
    <Card className="p-4 max-w-xl">
      {intro && <p className="text-gray-600 mb-3">{intro}</p>}
      <form className="space-y-3" onSubmit={e => { e.preventDefault(); void go() }}>
        <Label text="Supabase project URL"><Input value={cfg.url ?? ''} onChange={e => setCfg({ ...cfg, url: e.target.value })} placeholder="https://xxxx.supabase.co" required /></Label>
        <Label text="Publishable key"><Input value={cfg.key ?? ''} onChange={e => setCfg({ ...cfg, key: e.target.value })} required /></Label>
        <Grid>
          <Label text="Email"><Input type="email" value={cfg.email ?? ''} onChange={e => setCfg({ ...cfg, email: e.target.value })} required /></Label>
          <Label text="Password" hint="Never stored on this device"><Input type="password" value={pw} onChange={e => setPw(e.target.value)} required /></Label>
        </Grid>
        {allowCreate && <label className="flex items-center gap-2"><input type="checkbox" checked={create} onChange={e => setCreate(e.target.checked)} />Create a new account with this email</label>}
        <Button variant="primary" type="submit">Connect</Button>
      </form>
    </Card>
  )
}

const STATE_TONE = { pending: 'blue', accepted: 'green', revoked: 'gray', expired: 'amber' } as const

export default function Sharing() {
  const ctx = useCtx(); const run = useRun()
  const sb = useCloudSession(s => s.sb); const setSession = useCloudSession(s => s.set)
  const [inv, setInv] = useState<Invitation[]>([]); const [grants, setGrants] = useState<Grant[]>([])
  const [draft, setDraft] = useState<{ email: string; purpose: SharePurpose; perms: Set<string>; days?: number } | null>(null)
  const [code, setCode] = useState<{ email: string; code: string } | null>(null)

  const reload = useCallback(async (c: SupabaseClient | null = sb) => {
    if (!c) return
    try { setInv(await listInvitations(c, ctx.tenantId)); setGrants(await listGrants(c, ctx.tenantId)) } catch { /* shown via run on actions */ }
  }, [sb, ctx.tenantId])
  useEffect(() => { void reload() }, [reload])

  if (!can(ctx, 'settings.access.manage')) return <Denied what="sharing with contractors and extension officers" />
  if (!sb) return <CloudSignIn intro="Sharing runs through the cloud. Sign in with the cloud account that owns this farm (you must be online and have synced at least once)." onConnected={(c, e) => { setSession(c, e); void reload(c) }} />

  const preset = (p: SharePurpose) => setDraft(d => d && { ...d, purpose: p, perms: new Set(p === 'other' ? [] : SHARE_PRESETS[p]) })
  const toggle = (k: string) => setDraft(d => { if (!d) return d; const n = new Set(d.perms); n.has(k) ? n.delete(k) : n.add(k); return { ...d, perms: n } })
  async function send() {
    const d = draft!; const err = validateShare(d.email, [...d.perms])
    let made: { code: string } | null = null
    if (await run(async () => { if (err) throw new Error(err); made = await createInvitation(sb!, ctx.tenantId, { email: d.email, purpose: d.purpose, permissions: [...d.perms], access_days: d.days ?? null }) }, 'Invitation created') && made) {
      setCode({ email: d.email, code: (made as { code: string }).code }); setDraft(null); void reload()
    }
  }
  const active = grants.filter(g => !g.revoked_at)
  return (
    <>
      <div className="flex items-center justify-between mb-3">
        <p className="text-gray-600 max-w-2xl">Invite a contractor or extension officer and choose exactly what they can see. Access is view-only, tied to their email, and you can withdraw it at any time. Costs, sales and contract terms are never shared unless you tick them.</p>
        <Button variant="primary" onClick={() => setDraft({ email: '', purpose: 'contractor', perms: new Set(SHARE_PRESETS.contractor) })}>Invite someone</Button>
      </div>

      <h3 className="font-medium mb-1">People with access</h3>
      <Card className="mb-5"><Table head={['Role', 'Can see', 'Expires', '']} empty="Nobody has access yet.">
        {active.map(g => (
          <tr key={g.id}><Td className="font-medium capitalize">{g.purpose}</Td><Td>{g.permissions.map(labelFor).join(', ')}</Td><Td>{g.expires_at ? fmt.date(g.expires_at.slice(0, 10)) : 'No expiry'}</Td>
            <Td className="text-right"><Button small variant="danger" onClick={() => { if (window.confirm('Withdraw this person’s access now?')) void run(async () => { await revokeGrant(sb, g.id); await reload() }, 'Access withdrawn') }}>Withdraw</Button></Td></tr>))}
      </Table></Card>

      <h3 className="font-medium mb-1">Invitations</h3>
      <Card><Table head={['Email', 'For', 'Status', 'Sent', '']} empty="No invitations sent.">
        {inv.map(i => { const st = invitationState(i); return (
          <tr key={i.id}><Td className="font-medium">{i.invitee_email}</Td><Td className="capitalize">{i.purpose}</Td><Td><Badge tone={STATE_TONE[st]}>{st}</Badge></Td><Td>{fmt.date(i.created_at.slice(0, 10))}</Td>
            <Td className="text-right">{st === 'pending' && <Button small variant="danger" onClick={() => void run(async () => { await revokeInvitation(sb, i.id); await reload() }, 'Invitation cancelled')}>Cancel</Button>}</Td></tr>) })}
      </Table></Card>

      {draft && <Modal title="Invite someone" onClose={() => setDraft(null)} wide>
        <form className="space-y-4" onSubmit={e => { e.preventDefault(); void send() }}>
          <Grid>
            <Label text="Their email" hint="They must sign in with this exact email to accept"><Input type="email" value={draft.email} onChange={e => setDraft({ ...draft, email: e.target.value })} required autoFocus /></Label>
            <Label text="They are a"><Select value={draft.purpose} onChange={e => preset(e.target.value as SharePurpose)}>
              <option value="contractor">Contractor (company field staff)</option><option value="extension">Extension officer</option><option value="other">Other</option></Select></Label>
          </Grid>
          <div>
            <div className="text-xs font-medium text-gray-600 mb-1">What can they see?</div>
            <div className="grid sm:grid-cols-2 gap-x-6">{SHARE_MENUS.map(m => (
              <label key={m.key} className="flex items-center gap-2 py-0.5"><input type="checkbox" checked={draft.perms.has(m.key)} onChange={() => toggle(m.key)} />{m.label}{m.sensitive && <Badge tone="amber">sensitive</Badge>}</label>))}</div>
          </div>
          <Label text="Access duration (days)" hint="Leave blank for no expiry. Counted from when they accept."><NumberInput min={1} value={draft.days} onChange={n => setDraft({ ...draft, days: n })} className="w-40" /></Label>
          <div className="flex justify-end gap-2"><Button type="button" onClick={() => setDraft(null)}>Cancel</Button><Button variant="primary" type="submit">Create invitation</Button></div>
        </form></Modal>}

      {code && <Modal title="Invitation created" onClose={() => setCode(null)}>
        <p className="mb-2">Send this code to <b>{code.email}</b> by WhatsApp or email. <b>It is shown only once</b> and works only for that email address.</p>
        <textarea readOnly aria-label="Invitation code" className="w-full border border-gray-300 rounded-md p-2 font-mono text-xs bg-gray-50" rows={3} value={code.code} onFocus={e => e.currentTarget.select()} />
        <p className="text-gray-500 text-xs mt-2">They open farmPLAN → “Contractor / extension portal”, sign in with the same email, and paste the code.</p>
        <div className="flex justify-end gap-2 mt-3"><Button onClick={() => { void navigator.clipboard?.writeText(code.code) }}>Copy</Button><Button variant="primary" onClick={() => setCode(null)}>Done</Button></div></Modal>}
    </>
  )
}
