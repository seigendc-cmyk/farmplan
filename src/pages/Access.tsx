import { useState } from 'react'
import { BRAIN_KEYS, BRAIN_LEVELS, PERMISSION_GROUPS, brainLevelOf } from '../lib/permissions'
import { auditTrail, createRole, listRoles, listUsers, setRolePermissions, setUserActive } from '../services/roles'
import { createUser } from '../services/setup'
import { useCtx, useData, useRun, fmt } from '../ui/hooks'
import { Badge, Button, Card, Denied, Input, Label, Modal, PageHeader, Select, Table, Td, Grid } from '../ui/kit'
import { can } from '../services/context'
import Sharing from './Sharing'
import FieldStaff from './FieldStaff'
import HubAdmin from './HubAdmin'

export default function Access() {
  const ctx = useCtx(); const run = useRun()
  const [tab, setTab] = useState<'users' | 'roles' | 'audit' | 'sharing' | 'field' | 'hub'>('users')
  const users = useData(c => listUsers(c)); const roles = useData(c => listRoles(c))
  const audit = useData(c => tab === 'audit' ? auditTrail(c) : [], [tab])
  const [nu, setNu] = useState<{ name: string; pin: string; role_id: string } | null>(null)
  const [sel, setSel] = useState<string>(''); const [draft, setDraft] = useState<Set<string> | null>(null); const [newRole, setNewRole] = useState<string | null>(null)
  if (!users && !roles && !can(ctx, 'settings.audit.view')) return <Denied what="user and access management" />
  const role = roles?.find(r => r.id === sel) ?? roles?.[0]
  const perms = draft ?? new Set(role?.permissions ?? [])
  const isOwner = role?.name === 'Owner'
  const toggle = (k: string) => { const n = new Set(perms); n.has(k) ? n.delete(k) : n.add(k); setDraft(n) }

  return (
    <>
      <PageHeader title="Users & access" sub="Menu-driven permissions: choose exactly which screens and actions each role can use." />
      <div className="flex gap-1 mb-3">{([['users', 'Users'], ['roles', 'Roles & permissions'], ['audit', 'Audit trail'], ['field', 'Field staff & devices'], ['hub', 'Wi-Fi hub'], ['sharing', 'Contractor & extension access']] as const).map(([k, l]) => <Button key={k} small variant={tab === k ? 'primary' : 'secondary'} onClick={() => setTab(k)}>{l}</Button>)}</div>

      {tab === 'users' && (users ? <>
        <div className="mb-3"><Button variant="primary" onClick={() => setNu({ name: '', pin: '', role_id: roles?.find(r => r.name === 'Field Recorder')?.id ?? roles?.[0]?.id ?? '' })}>Add user</Button></div>
        <Card><Table head={['Name', 'Role', 'Status', '']}>{users.map(u => (
          <tr key={u.id}><Td className="font-medium">{u.name}</Td><Td>{u.role_name}</Td><Td>{u.active ? <Badge tone="green">active</Badge> : <Badge>inactive</Badge>}</Td>
            <Td className="text-right">{u.id !== ctx.actor?.id && <Button small variant={u.active ? 'danger' : 'secondary'} onClick={() => run(() => setUserActive(ctx, u.id, !u.active), u.active ? 'User deactivated' : 'User reactivated')}>{u.active ? 'Deactivate' : 'Reactivate'}</Button>}</Td></tr>))}</Table></Card></> : <Denied what="user management" />)}

      {tab === 'roles' && (roles ? <div className="grid md:grid-cols-[220px_1fr] gap-4">
        <Card className="p-2 h-fit">{roles.map(r => <button key={r.id} onClick={() => { setSel(r.id); setDraft(null) }} className={`w-full text-left px-3 py-2 rounded ${r.id === role?.id ? 'bg-brand-50 text-brand-800 font-medium' : 'hover:bg-gray-50'}`}>{r.name}<span className="block text-xs text-gray-500 font-normal">{r.users} user{r.users === 1 ? '' : 's'}{r.is_system ? ' · built-in' : ''}</span></button>)}
          <Button small className="w-full mt-2" onClick={() => setNewRole('')}>New role</Button></Card>
        <Card className="p-4">{role && <>
          <div className="flex items-center justify-between mb-3"><h2 className="font-medium">{role.name}</h2>
            {!isOwner && <Button variant="primary" small disabled={!draft} onClick={async () => { if (await run(() => setRolePermissions(ctx, role.id, [...perms]), 'Permissions saved')) setDraft(null) }}>Save changes</Button>}</div>
          {isOwner && <p className="text-gray-500 mb-3">The Owner role always has full access so the farm cannot be locked out.</p>}
          <div className="mb-4 p-3 rounded border border-gray-200 bg-gray-50"><div className="text-sm font-medium mb-1">Business brain access</div>
            <p className="text-xs text-gray-500 mb-2">How much of the farm's activity log this role can read. {isOwner ? 'Owners always see everything.' : brainLevelOf(perms) ? '' : 'Currently a custom mix.'}</p>
            <div className="flex flex-wrap gap-1">{BRAIN_LEVELS.map(l => { const cur = isOwner ? l.id === 'full' : brainLevelOf(perms) === l.id
              return <Button key={l.id} small disabled={isOwner} variant={cur ? 'primary' : 'secondary'} title={l.help} aria-pressed={cur} onClick={() => { const n = new Set([...perms].filter(p => !BRAIN_KEYS.includes(p))); l.perms.forEach(p => n.add(p)); setDraft(n) }}>{l.label}</Button> })}</div>
            <p className="text-xs text-gray-500 mt-1">{BRAIN_LEVELS.find(l => l.id === (isOwner ? 'full' : brainLevelOf(perms)))?.help}</p></div>
          <div className="grid sm:grid-cols-2 gap-5">{PERMISSION_GROUPS.map(g => (
            <div key={g.menu}><div className="text-xs uppercase tracking-wide text-gray-500 mb-1">{g.menu}</div>
              {g.items.map(i => <label key={i.key} className="flex items-center gap-2 py-0.5"><input type="checkbox" disabled={isOwner} checked={isOwner || perms.has(i.key)} onChange={() => toggle(i.key)} />{i.label}</label>)}</div>))}</div></>}</Card>
      </div> : <Denied what="role management" />)}

      {tab === 'audit' && (audit ? <Card><Table head={['When', 'User', 'Action', 'Record']} empty="No activity yet.">
        {audit.map(a => <tr key={a.seq}><Td className="whitespace-nowrap">{fmt.date(a.at.slice(0, 10))} {a.at.slice(11, 16)}</Td><Td>{a.actor_name ?? 'system'}</Td><Td>{a.action}</Td><Td className="text-gray-500">{a.table_name ?? ''}</Td></tr>)}</Table></Card> : <Denied what="the audit trail" />)}

      {tab === 'field' && <FieldStaff />}
      {tab === 'hub' && <HubAdmin />}
      {tab === 'sharing' && <Sharing />}

      {nu && <Modal title="Add user" onClose={() => setNu(null)}>
        <form className="space-y-3" onSubmit={async e => { e.preventDefault(); if (await run(() => createUser(ctx, nu.name, nu.pin, nu.role_id), 'User created')) setNu(null) }}>
          <Label text="Name"><Input value={nu.name} onChange={e => setNu({ ...nu, name: e.target.value })} required autoFocus /></Label>
          <Grid><Label text="PIN (4–8 digits)"><Input type="password" inputMode="numeric" value={nu.pin} onChange={e => setNu({ ...nu, pin: e.target.value })} required /></Label>
            <Label text="Role"><Select value={nu.role_id} onChange={e => setNu({ ...nu, role_id: e.target.value })}>{roles?.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}</Select></Label></Grid>
          <div className="flex justify-end gap-2"><Button type="button" onClick={() => setNu(null)}>Cancel</Button><Button variant="primary" type="submit">Create user</Button></div>
        </form></Modal>}
      {newRole !== null && <Modal title="New role" onClose={() => setNewRole(null)}>
        <form className="space-y-3" onSubmit={async e => { e.preventDefault(); if (await run(() => { const id = createRole(ctx, newRole, []); setSel(id); setDraft(null) }, 'Role created — now choose its permissions')) setNewRole(null) }}>
          <Label text="Role name"><Input value={newRole} onChange={e => setNewRole(e.target.value)} required autoFocus /></Label>
          <div className="flex justify-end gap-2"><Button type="button" onClick={() => setNewRole(null)}>Cancel</Button><Button variant="primary" type="submit">Create</Button></div>
        </form></Modal>}
    </>
  )
}
