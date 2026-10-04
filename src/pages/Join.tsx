import { useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { joinFarm, myFarms, type MyFarm } from '../services/devices'
import { useApp, useToasts } from '../store/app'
import { Button, Card, Grid, Input, Label, Select } from '../ui/kit'
import { plural } from '../ui/hooks'
import { CloudSignIn } from './Sharing'
import { joinHub } from '../services/lan'

/** Turns a blank phone/tablet into a field terminal for an existing farm. */
export default function Join() {
  const { db, leavePortal, afterSetup } = useApp(); const push = useToasts(s => s.push)
  const [sb, setSb] = useState<SupabaseClient | null>(null); const [farms, setFarms] = useState<MyFarm[]>([])
  const [f, setF] = useState({ tenantId: '', deviceLabel: '', name: '', pin: '', pin2: '' }); const [busy, setBusy] = useState(false)
  const [mode, setMode] = useState<'cloud' | 'hub'>('cloud'); const [h, setH] = useState({ hubUrl: '', code: '', name: '', pin: '', pin2: '' })
  async function joinViaHub(e: React.FormEvent) {
    e.preventDefault(); if (h.pin !== h.pin2) return push('err', 'PINs do not match')
    setBusy(true)
    try { const r = await joinHub(db!, h); push('ok', `Joined. This device is “${r.tag}”; received ${plural(r.report.pulled, 'record')}.`); afterSetup() } catch (x) { err(x) } finally { setBusy(false) }
  }
  const err = (e: unknown) => push('err', e instanceof Error ? e.message : String(e))
  async function connected(c: SupabaseClient) {
    setSb(c)
    try { const l = await myFarms(c); setFarms(l); setF(x => ({ ...x, tenantId: l[0]?.tenant_id ?? '' })); if (!l.length) push('err', 'This account is not enrolled in any farm yet. Ask the farm owner to enrol your email.') } catch (e) { err(e) }
  }
  async function join(e: React.FormEvent) {
    e.preventDefault(); if (f.pin !== f.pin2) return push('err', 'PINs do not match')
    setBusy(true)
    try { const r = await joinFarm(db!, sb!, f); push('ok', `Joined. This device is “${r.tag}”; received ${plural(r.report.pulled, 'record')}.`); afterSetup() }
    catch (x) { err(x) } finally { setBusy(false) }
  }
  return (
    <div className="min-h-full bg-gray-50"><div className="max-w-xl mx-auto p-6">
      <div className="flex items-center justify-between mb-5">
        <div><h1 className="text-xl font-semibold text-gray-900">Join a farm</h1><p className="text-gray-500">Set this device up as a field terminal.</p></div>
        <Button onClick={leavePortal}>Back</Button>
      </div>
      <div className="flex gap-1 mb-3"><Button small variant={mode === 'cloud' ? 'primary' : 'secondary'} onClick={() => setMode('cloud')}>Over the internet</Button><Button small variant={mode === 'hub' ? 'primary' : 'secondary'} onClick={() => setMode('hub')}>Farm Wi-Fi hub</Button></div>
      {mode === 'hub' && <Card className="p-4"><form className="space-y-3" onSubmit={joinViaHub}>
        <p className="text-gray-500 text-sm">Connect to the farm Wi-Fi. On the office computer open Users &amp; access → Wi-Fi hub, switch the hub on and create a pairing code for this phone.</p>
        <Label text="Hub address" hint="Shown on the office computer, e.g. 192.168.1.20:7878"><Input value={h.hubUrl} onChange={e => setH({ ...h, hubUrl: e.target.value })} required /></Label>
        <Label text="Pairing code" hint="6 digits, valid for 10 minutes, works once"><Input inputMode="numeric" value={h.code} onChange={e => setH({ ...h, code: e.target.value })} required /></Label>
        <Label text="Your name" hint="Shown on everything you record"><Input value={h.name} onChange={e => setH({ ...h, name: e.target.value })} required /></Label>
        <Grid><Label text="Choose a PIN (4–8 digits)"><Input type="password" inputMode="numeric" value={h.pin} onChange={e => setH({ ...h, pin: e.target.value })} required /></Label>
          <Label text="Confirm PIN"><Input type="password" inputMode="numeric" value={h.pin2} onChange={e => setH({ ...h, pin2: e.target.value })} required /></Label></Grid>
        <Button variant="primary" type="submit" disabled={busy} className="w-full">{busy ? 'Pairing…' : 'Pair with hub'}</Button>
      </form></Card>}
      {mode === 'cloud' && !sb && <CloudSignIn allowCreate intro="Sign in with the cloud account the farm owner enrolled. New? Tick “Create a new account”, then tell the owner your email so they can enrol you." onConnected={c => void connected(c)} />}
      {mode === 'cloud' && sb && farms.length > 0 && (
        <Card className="p-4"><form className="space-y-3" onSubmit={join}>
          <Label text="Farm"><Select value={f.tenantId} onChange={e => setF({ ...f, tenantId: e.target.value })}>{farms.map(x => <option key={x.tenant_id} value={x.tenant_id}>{x.tenant_name} — {x.role_name}</option>)}</Select></Label>
          <Label text="Name this device" hint="e.g. Supervisor phone"><Input value={f.deviceLabel} onChange={e => setF({ ...f, deviceLabel: e.target.value })} required /></Label>
          <Label text="Your name" hint="Shown on everything you record"><Input value={f.name} onChange={e => setF({ ...f, name: e.target.value })} required /></Label>
          <Grid><Label text="Choose a PIN (4–8 digits)"><Input type="password" inputMode="numeric" value={f.pin} onChange={e => setF({ ...f, pin: e.target.value })} required /></Label>
            <Label text="Confirm PIN"><Input type="password" inputMode="numeric" value={f.pin2} onChange={e => setF({ ...f, pin2: e.target.value })} required /></Label></Grid>
          <Button variant="primary" type="submit" disabled={busy} className="w-full">{busy ? 'Joining…' : 'Join farm'}</Button>
        </form></Card>)}
    </div></div>
  )
}
