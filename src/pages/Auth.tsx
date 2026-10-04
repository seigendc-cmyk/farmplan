import { useState } from 'react'
import { useApp, useToasts } from '../store/app'
import { initialiseFarm, login } from '../services/setup'
import { Button, Card, Input, Label, Grid } from '../ui/kit'

function Frame({ title, sub, children }: { title: string; sub: string; children: React.ReactNode }) {
  return (
    <div className="h-full grid place-items-center p-6">
      <div className="w-full max-w-md">
        <div className="mb-5"><div className="text-brand-700 font-semibold text-lg">farmPLAN Tobacco — Zimbabwe</div><div className="text-gray-500">{sub}</div></div>
        <Card className="p-5"><h1 className="font-semibold text-gray-900 mb-4">{title}</h1>{children}</Card>
      </div>
    </div>
  )
}

export function Setup() {
  const { db, afterSetup } = useApp(); const push = useToasts(s => s.push)
  const [f, setF] = useState({ tenantName: '', farmName: '', location: '', ownerName: '', ownerPin: '', pin2: '' })
  const [busy, setBusy] = useState(false)
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value })
  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (f.ownerPin !== f.pin2) return push('err', 'PINs do not match')
    setBusy(true)
    try { await initialiseFarm(db!, { tenantName: f.tenantName || f.farmName, farmName: f.farmName, location: f.location, ownerName: f.ownerName, ownerPin: f.ownerPin }); afterSetup() }
    catch (err) { push('err', err instanceof Error ? err.message : String(err)) } finally { setBusy(false) }
  }
  return (
    <Frame title="Set up this farm" sub="First-time setup. Everything is stored on this computer and works offline.">
      <form onSubmit={submit} className="space-y-3">
        <Label text="Farm name"><Input value={f.farmName} onChange={set('farmName')} required autoFocus /></Label>
        <Grid><Label text="Business / tenant name" hint="Defaults to the farm name"><Input value={f.tenantName} onChange={set('tenantName')} /></Label>
          <Label text="Location"><Input value={f.location} onChange={set('location')} /></Label></Grid>
        <Label text="Owner name"><Input value={f.ownerName} onChange={set('ownerName')} required /></Label>
        <Grid><Label text="Owner PIN (4–8 digits)"><Input type="password" inputMode="numeric" value={f.ownerPin} onChange={set('ownerPin')} required /></Label>
          <Label text="Confirm PIN"><Input type="password" inputMode="numeric" value={f.pin2} onChange={set('pin2')} required /></Label></Grid>
        <Button variant="primary" type="submit" disabled={busy} className="w-full">{busy ? 'Setting up…' : 'Create farm'}</Button>
      </form>
      <p className="text-sm text-gray-500 mt-4 text-center">Already have a farm in the cloud? <button type="button" className="text-brand-700 underline" onClick={() => useApp.getState().openJoin()}>Join it as a field device</button></p>
    </Frame>
  )
}

export function Login() {
  const { db, signedIn } = useApp(); const push = useToasts(s => s.push)
  const [name, setName] = useState(''); const [pin, setPin] = useState(''); const [busy, setBusy] = useState(false)
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true)
    const r = await login(db!, name, pin); setBusy(false)
    if (r.ok && r.ctx) signedIn(r.ctx); else { push('err', r.reason ?? 'Sign-in failed'); setPin('') }
  }
  return (
    <Frame title="Sign in" sub="Farm management system">
      <form onSubmit={submit} className="space-y-3">
        <Label text="Name"><Input value={name} onChange={e => setName(e.target.value)} autoFocus required /></Label>
        <Label text="PIN"><Input type="password" inputMode="numeric" value={pin} onChange={e => setPin(e.target.value)} required /></Label>
        <Button variant="primary" type="submit" disabled={busy} className="w-full">Sign in</Button>
      </form>
    </Frame>
  )
}
