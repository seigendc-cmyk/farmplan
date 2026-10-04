import { useEffect, useState } from 'react'
import { listSeasons } from '../services/seasons'
import { useData } from './hooks'
import { Select } from './kit'

/** Season picker shared by production pages. Defaults to the active season; `jumpTo` (the season of a linked record) switches to that season when it arrives. */
export function useSeasonPicker(jumpTo?: string) {
  const seasons = useData(c => listSeasons(c)) ?? []
  const [picked, setPicked] = useState('')
  useEffect(() => { if (jumpTo) setPicked(jumpTo) }, [jumpTo])
  const active = seasons.find(s => s.status === 'active')
  const sid = picked || jumpTo || active?.id || seasons[0]?.id || ''
  const picker = seasons.length > 0
    ? <Select aria-label="Season" value={sid} onChange={e => setPicked(e.target.value)} className="w-40">{seasons.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}</Select>
    : null
  return { sid, seasons, picker, season: seasons.find(s => s.id === sid) }
}
