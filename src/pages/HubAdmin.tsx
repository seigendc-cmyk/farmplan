import { useState } from 'react'
import { createPairing, isHubEnabled, listHubDevices, revokeHubDevice } from '../services/hub'
import { DEFAULT_HUB_PORT, hubStatus, hubSupported, startHub, stopHub, type HubStatus } from '../lib/hubBridge'
import { can } from '../services/context'
import { useCtx, useData, useRun, fmt } from '../ui/hooks'
import { Badge, Button, Card, Denied, Input, Label, Select, Table, Td } from '../ui/kit'

const ROLES = ['Field Recorder', 'Farm Manager', 'Store Clerk']

/** Office-side control of the Wi-Fi hub: switch on, show the address, pair phones, remove them. */
export default function HubAdmin() {
  const ctx = useCtx(); const run = useRun()
  const [status, setStatus] = useState<HubStatus | null>(hubStatus()); const [label, setLabel] = useState(''); const [role, setRole] = useState('Field Recorder')
  const [pair, setPair] = useState<{ code: string; expires_at: string; label: string } | null>(null)
  const devices = useData(c => can(c, 'settings.users.manage') ? listHubDevices(c) : null)
  if (!can(ctx, 'settings.users.manage')) return <Denied what="the Wi-Fi hub" />
  const on = isHubEnabled(ctx.db) && !!status; const desktop = hubSupported()
  const address = status?.addresses[0] ? `${status.addresses[0]}:${status.port}` : null
  return (
    <>
      <p className="text-gray-600 max-w-2xl mb-3">Phones on the farm Wi-Fi can sync straight with this computer, with no internet. This computer stays the master copy and sends everything on to the cloud whenever it is online. Keep this app open while phones sync.</p>
      <Card className="p-4 mb-4 max-w-2xl">
        <div className="flex items-center justify-between gap-3">
          <div><div className="font-medium">Farm hub {on ? <Badge tone="green">on</Badge> : <Badge>off</Badge>}</div>
            {address && on && <div className="text-sm text-gray-600 mt-1">Phones connect to <span className="font-mono font-semibold">{address}</span></div>}
            {!desktop && <div className="text-sm text-amber-700 mt-1">The hub can only run in the desktop app on the office computer.</div>}</div>
          {on ? <Button variant="danger" onClick={() => void run(async () => { await stopHub(ctx.db); setStatus(null) }, 'Hub switched off')}>Switch off</Button>
            : <Button variant="primary" disabled={!desktop} onClick={() => void run(async () => setStatus(await startHub(ctx.db, DEFAULT_HUB_PORT)), 'Hub is on')}>Switch on</Button>}
        </div>
        {on && !address && <p className="text-xs text-gray-500 mt-2">The hub is on. This computer’s Wi-Fi address (for example 192.168.1.20) is in your network settings; use it with port {DEFAULT_HUB_PORT}.</p>}
        <p className="text-xs text-gray-500 mt-2">Windows may ask to allow this app through the firewall on private networks: choose Allow. Use a farm Wi-Fi you trust; the hub is not encrypted (it is an ordinary local web address), but every phone needs a pairing code and its own secret key.</p>
      </Card>

      <Card className="p-4 mb-4 max-w-2xl">
        <h2 className="font-medium mb-2">Pair a phone</h2>
        <form className="flex flex-wrap gap-2 items-end" onSubmit={e => { e.preventDefault(); void run(async () => { const r = await createPairing(ctx, label, role); setPair({ ...r, label }); setLabel('') }) }}>
          <Label text="Name this phone" className="flex-1 min-w-48"><Input value={label} onChange={e => setLabel(e.target.value)} placeholder="Supervisor phone" required /></Label>
          <Label text="Role"><Select value={role} onChange={e => setRole(e.target.value)}>{ROLES.map(r => <option key={r}>{r}</option>)}</Select></Label>
          <Button variant="primary" type="submit" disabled={!on}>Create code</Button>
        </form>
        {!on && <p className="text-xs text-gray-500 mt-2">Switch the hub on first.</p>}
        {pair && <div className="mt-3 rounded-lg bg-brand-50 p-3"><div className="text-sm text-gray-600">Code for “{pair.label}” — type it on the phone under <em>Join a farm → Farm Wi-Fi hub</em>. Works once, expires {fmt.date(pair.expires_at.slice(0, 10))} {pair.expires_at.slice(11, 16)} UTC.</div>
          <div className="text-3xl font-mono font-semibold tracking-widest mt-1">{pair.code}</div></div>}
      </Card>

      <Card><Table head={['Tag', 'Phone', 'Role', 'Last seen', 'Status', '']} empty="No phones paired yet.">
        {(devices ?? []).map(d => <tr key={d.id}><Td className="font-mono">{d.tag}</Td><Td className="font-medium">{d.label}</Td><Td>{d.role_name}</Td><Td>{d.last_seen ? `${d.last_seen.slice(0, 16)} UTC` : 'never'}</Td>
          <Td>{d.revoked ? <Badge>removed</Badge> : <Badge tone="green">active</Badge>}</Td>
          <Td className="text-right">{!d.revoked && <Button small variant="danger" onClick={() => void run(() => revokeHubDevice(ctx, d.id), 'Phone removed from the hub')}>Remove</Button>}</Td></tr>)}</Table></Card>
      <p className="text-xs text-gray-500 mt-2">Removing a phone stops it syncing with the hub at once. Records it already sent stay on the farm.</p>
    </>
  )
}
