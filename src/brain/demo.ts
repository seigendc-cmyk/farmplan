import type { Db } from '../db/database'
import { initialiseFarm, login, createUser } from '../services/setup'
import type { Ctx } from '../services/context'
import { createSeason } from '../services/seasons'
import { createField } from '../services/fields'
import { recordHarvest } from '../services/harvest'
import { recordWeather } from '../services/weather'
import { recordLabour } from '../services/labour'
import { addCost } from '../services/util'
import { recordNote } from '../services/activity'

/** A busy two-season demo farm for benchmarking. Sales/bales are not seeded (they need the whole curing chain), so those lookups return empty tables. */
export async function seedDemo(db: Db, scale = 1): Promise<Ctx> {
  await initialiseFarm(db, { tenantName: 'Bench', farmName: 'Bench Farm', ownerName: 'Lovemore', ownerPin: '1234' })
  const o: Ctx = { db, ...(await login(db, 'Lovemore', '1234')).ctx! }; const owner = o
  const rid = db.get<{ id: string }>(`SELECT id FROM roles WHERE name='Field Recorder'`)!.id
  for (const n of ['Tendai', 'Rudo']) await createUser(owner, n, '1111', rid)
  const seasons = [createSeason(o, { label: '2025/26', starts_on: '2025-09-01', ends_on: '2026-08-31' }), createSeason(o, { label: '2026/27', starts_on: '2026-09-01', ends_on: '2027-08-31', activate: true })]
  const fields = Array.from({ length: 8 }, (_, i) => createField(o, { field_no: `F-0${i + 1}`, area_ha: 2 + i }))
  const day = (base: string, n: number) => new Date(Date.parse(base) + n * 864e5).toISOString().slice(0, 10)
  const workers = ['Rudo', 'Tendai', 'Chipo', 'Farai', 'Tatenda', 'Nyasha', 'Kudzai', 'Blessing']
  seasons.forEach((s, si) => {
    const start = si === 0 ? '2025-10-01' : '2026-10-01'
    for (let d = 0; d < 180 * scale; d++) if (d % 2 === 0 || d % 7 === 0) recordWeather(o, { season_id: s, recorded_on: day(start, d), rainfall_mm: (d * 7) % 23 })
    fields.forEach((f, fi) => { for (let h = 0; h < 25 * scale; h++) recordHarvest(o, { field_id: f, season_id: s, harvested_on: day(start, 90 + h * 2), green_weight_kg: 200 + ((h * 37 + fi * 11) % 300) }) })
    for (let l = 0; l < 600 * scale; l++) recordLabour(o, { season_id: s, field_id: fields[l % 8], worked_on: day(start, l % 150), worker_name: `${workers[l % 8]}${Math.floor(l / 600)}`, task: ['weeding', 'planting', 'priming', 'tying'][l % 4], hours: 4 + (l % 5) } as never)
    for (let c = 0; c < 400 * scale; c++) addCost(o, { seasonId: s, category: ['fertilizer', 'chemicals', 'fuel', 'labour', 'transport', 'curing'][c % 6], amount: 50 + (c % 90), on: day(start, c % 150), sourceType: 'manual', sourceId: `b${si}-${c}`, fieldId: c % 5 === 0 ? null : fields[c % 8] })
  })
  for (const n of ['Tendai', 'Rudo']) { const c: Ctx = { db, ...(await login(db, n, '1111')).ctx! }; recordNote(c, { text: n === 'Tendai' ? 'Hail damage on the north edge of F-04' : 'Irrigation pump leaking near barn 2' }) }
  return { db, ...(await login(db, 'Lovemore', '1234')).ctx! }
}
