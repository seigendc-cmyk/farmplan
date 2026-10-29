import { describe, it, expect, beforeEach } from 'vitest'
import { Db, MemoryPersistence } from '../db/database'
import { initialiseFarm, login } from './setup'
import { type Ctx } from './context'
import { createSeason } from './seasons'
import { createSeedbed } from './seedbeds'
import { createField } from './fields'
import { recordTransplant } from './transplants'
import { getProject, projectOfSeason } from './projects'

let db: Db; let o: Ctx; let crop: string; let sbs: string; let bed: string; let field: string
const unmet = (season: string) => getProject(o, projectOfSeason(o, season)!.id).unmet
const at = (season: string, stage: string) => db.run(`UPDATE projects SET stage=? WHERE season_id=?`, [stage, season])
beforeEach(async () => {
  db = await Db.open(new MemoryPersistence())
  await initialiseFarm(db, { tenantName: 'T', farmName: 'F', ownerName: 'Lovemore', ownerPin: '1234' })
  o = { db, ...(await login(db, 'Lovemore', '1234')).ctx! }
  db.run(`UPDATE farms SET modules=? WHERE id=?`, ['tobacco,seedbed', o.farmId])
  crop = createSeason(o, { label: '2026/27', starts_on: '2026-09-01', ends_on: '2027-08-31', activate: true })
  sbs = createSeason(o, { label: 'SB 2026', starts_on: '2026-08-01', ends_on: '2026-11-30', enterprise: 'seedbed' })
  bed = createSeedbed(o, { season_id: sbs, code: 'OB1', bed_length_m: 10, bed_width_m: 1, bed_count: 1, actual_seedlings: 100 })
  field = createField(o, { field_no: 'F1', area_ha: 1 } as never)
  at(crop, 'growing'); at(sbs, 'dispatched')
})

describe('transplant stage gates', () => {
  it('no transplants: both gates are blocked', () => {
    expect(unmet(crop)).toEqual(['Record transplanting']); expect(unmet(sbs)).toEqual(["Record at least one transplant from this season's seedbeds"])
  })
  it('a cross-season transplant opens the crop season growing gate and the seedbed dispatched gate', () => {
    recordTransplant(o, { seedbed_id: bed, field_id: field, occurred_on: '2026-10-02', qty: 10, crop_season_id: crop })
    expect(unmet(crop)).toEqual([]); expect(unmet(sbs)).toEqual([])
  })
  it('legacy tobacco is unchanged: its own bed opens growing; another crop season stays blocked', () => {
    const other = createSeason(o, { label: '2027/28', starts_on: '2027-09-01', ends_on: '2028-08-31' }); at(other, 'growing')
    const lb = createSeedbed(o, { season_id: crop, code: 'LB', bed_length_m: 10, bed_width_m: 1, bed_count: 1, actual_seedlings: 50 })
    recordTransplant(o, { seedbed_id: lb, field_id: field, occurred_on: '2026-10-02', qty: 10 })
    expect(unmet(crop)).toEqual([]); expect(unmet(other)).toEqual(['Record transplanting'])
  })
  it('a cross-season transplant into one crop season does not open another crop season', () => {
    const other = createSeason(o, { label: '2027/28', starts_on: '2027-09-01', ends_on: '2028-08-31' }); at(other, 'growing')
    recordTransplant(o, { seedbed_id: bed, field_id: field, occurred_on: '2026-10-02', qty: 10, crop_season_id: crop })
    expect(unmet(other)).toEqual(['Record transplanting'])
  })
})
