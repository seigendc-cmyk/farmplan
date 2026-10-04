import { useState } from 'react'
import { createSeason, listSeasons, setSeasonStatus } from '../services/seasons'
import { useCan, useCtx, useData, useRun, fmt } from '../ui/hooks'
import { Badge, Button, Card, Denied, Input, Label, Modal, PageHeader, Table, Td, Grid } from '../ui/kit'

export default function Seasons() {
  const ctx = useCtx(); const can = useCan(); const run = useRun()
  const seasons = useData(c => listSeasons(c)); const [open, setOpen] = useState(false)
  const [f, setF] = useState({ label: '', starts_on: '', ends_on: '', activate: true })
  if (!seasons) return <Denied what="seasons" />
  const manage = can('settings.season.manage')
  const tone = { active: 'green', planned: 'blue', closed: 'gray' } as const
  return (
    <>
      <PageHeader title="Seasons" sub="Every production record belongs to a season, so seasons can be compared." actions={manage && <Button variant="primary" onClick={() => setOpen(true)}>New season</Button>} />
      <Card><Table head={['Season', 'Enterprise', 'Starts', 'Ends', 'Status', '']} empty="No seasons yet.">
        {seasons.map(s => (
          <tr key={s.id}><Td className="font-medium">{s.label}</Td><Td className="capitalize">{s.enterprise}</Td><Td>{fmt.date(s.starts_on)}</Td><Td>{fmt.date(s.ends_on)}</Td>
            <Td><Badge tone={tone[s.status as keyof typeof tone]}>{s.status}</Badge></Td>
            <Td className="text-right space-x-1">{manage && (<>
              {s.status !== 'active' && s.status !== 'closed' && <Button small onClick={() => run(() => setSeasonStatus(ctx, s.id, 'active'), `${s.label} is now active`)}>Activate</Button>}
              {s.status === 'active' && <Button small variant="danger" onClick={() => confirm(`Close season ${s.label}? No further activity can be recorded.`) && run(() => setSeasonStatus(ctx, s.id, 'closed'), 'Season closed')}>Close</Button>}
              {s.status === 'closed' && <Button small onClick={() => run(() => setSeasonStatus(ctx, s.id, 'planned'), 'Season reopened')}>Reopen</Button>}</>)}</Td></tr>))}
      </Table></Card>
      {open && <Modal title="New season" onClose={() => setOpen(false)}>
        <form className="space-y-3" onSubmit={async e => { e.preventDefault(); if (await run(() => createSeason(ctx, f), 'Season created')) setOpen(false) }}>
          <Label text="Label" hint="e.g. 2026/27"><Input value={f.label} onChange={e => setF({ ...f, label: e.target.value })} required autoFocus /></Label>
          <Grid><Label text="Starts"><Input type="date" value={f.starts_on} onChange={e => setF({ ...f, starts_on: e.target.value })} required /></Label>
            <Label text="Ends"><Input type="date" value={f.ends_on} onChange={e => setF({ ...f, ends_on: e.target.value })} required /></Label></Grid>
          <label className="flex items-center gap-2"><input type="checkbox" checked={f.activate} onChange={e => setF({ ...f, activate: e.target.checked })} /> Make this the active season</label>
          <div className="flex justify-end gap-2 pt-2"><Button type="button" onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" type="submit">Create</Button></div>
        </form></Modal>}
    </>
  )
}
