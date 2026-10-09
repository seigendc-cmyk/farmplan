import { useEffect, useState } from 'react'
import { MODULES } from '../modules/registry'
import { enabledModules, setFarmModules } from '../services/modules'
import { useCan, useCtx, useData, useRun } from '../ui/hooks'
import { Badge, Button, Card, Denied, PageHeader } from '../ui/kit'

export default function Modules() {
  const ctx = useCtx(); const can = useCan(); const run = useRun()
  const on = useData(c => enabledModules(c)); const [pick, setPick] = useState<string[]>([])
  useEffect(() => { if (on) setPick(on) }, [on])
  if (!can('settings.modules.manage')) return <Denied what="modules" />
  const changed = !!on && (pick.length !== on.length || pick.some(p => !on.includes(p)))
  return (
    <>
      <PageHeader title="Modules" sub="Choose which kinds of farming this farm uses. Switching a module off hides its screens; nothing is deleted." />
      <Card><ul className="divide-y divide-gray-100">
        {MODULES.map(m => (
          <li key={m.id} className="flex items-start gap-3 p-4">
            <input id={`mod-${m.id}`} type="checkbox" className="mt-1" checked={pick.includes(m.id)} disabled={!m.available}
              onChange={e => setPick(e.target.checked ? [...pick, m.id] : pick.filter(x => x !== m.id))} />
            <label htmlFor={`mod-${m.id}`} className="flex-1">
              <span className="font-medium">{m.label}</span>{!m.available && <Badge tone="gray">coming soon</Badge>}
              <span className="block text-sm text-gray-500">{m.blurb}</span>
            </label>
          </li>))}
      </ul></Card>
      <div className="mt-3"><Button variant="primary" disabled={!changed} onClick={() => run(() => setFarmModules(ctx, pick), 'Modules saved')}>Save modules</Button></div>
    </>
  )
}
