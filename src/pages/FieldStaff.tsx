import { useCallback, useEffect, useState } from 'react'
import { useCloudSession } from '../store/cloudSession'
import { addMember, listMembers, setMemberActive, type Member } from '../services/devices'
import { can } from '../services/context'
import { useCtx, useRun } from '../ui/hooks'
import { Badge, Button, Card, Denied, Input, Label, Select, Table, Td } from '../ui/kit'
import { CloudSignIn } from './Sharing'

const ROLES = ['Field Recorder', 'Farm Manager', 'Store Clerk']

export default function FieldStaff() {
  const ctx = useCtx(); const run = useRun()
  const sb = useCloudSession(s => s.sb); const setSession = useCloudSession(s => s.set); const me = useCloudSession(s => s.email)
  const [members, setMembers] = useState<Member[]>([]); const [email, setEmail] = useState(''); const [role, setRole] = useState('Field Recorder')
  const reload = useCallback(async () => { if (sb) try { setMembers(await listMembers(sb, ctx.tenantId)) } catch { /* surfaced by actions */ } }, [sb, ctx.tenantId])
  useEffect(() => { void reload() }, [reload])

  if (!can(ctx, 'settings.users.manage')) return <Denied what="field staff and devices" />
  if (!sb) return <CloudSignIn intro="Field phones join through the cloud. Sign in with the farm owner's cloud account (you must be online and have synced this farm at least once)." onConnected={(c, e) => setSession(c, e)} />
  return (
    <>
      <p className="text-gray-600 max-w-2xl mb-3">Staff use their own phone as a field terminal. Each person first creates a cloud account (the join screen on their phone has a “Create account” option), then you enrol their email here and choose their role. Every phone that joins gets a device tag, so codes it creates offline (for example H-B-00007) never clash with other devices.</p>
      <Card className="p-4 mb-4 max-w-2xl">
        <form className="flex flex-wrap gap-2 items-end" onSubmit={e => { e.preventDefault(); void run(async () => { await addMember(sb, ctx.tenantId, email, role); setEmail(''); await reload() }, 'Staff member enrolled') }}>
          <Label text="Their cloud account email" className="flex-1 min-w-48"><Input type="email" value={email} onChange={e => setEmail(e.target.value)} required /></Label>
          <Label text="Role"><Select value={role} onChange={e => setRole(e.target.value)}>{ROLES.map(r => <option key={r}>{r}</option>)}</Select></Label>
          <Button variant="primary" type="submit">Enrol</Button>
        </form>
      </Card>
      <Card><Table head={['Email', 'Role', 'Devices', 'Status', '']} empty="No staff yet.">
        {members.map(m => <tr key={m.user_id}><Td className="font-medium">{m.email}</Td><Td>{m.role_name}</Td><Td>{m.devices || '—'}</Td>
          <Td>{m.active ? <Badge tone="green">active</Badge> : <Badge>inactive</Badge>}</Td>
          <Td className="text-right">{m.email.toLowerCase() !== me.toLowerCase() && <Button small variant={m.active ? 'danger' : 'secondary'} onClick={() => void run(async () => { await setMemberActive(sb, ctx.tenantId, m.user_id, !m.active); await reload() }, m.active ? 'Access removed' : 'Access restored')}>{m.active ? 'Remove access' : 'Restore'}</Button>}</Td></tr>)}</Table></Card>
      <p className="text-xs text-gray-500 mt-2">Removing access stops a phone syncing immediately. Data already recorded stays on the farm.</p>
    </>
  )
}
