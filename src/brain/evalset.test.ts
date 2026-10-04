import { describe, it, expect } from 'vitest'
import { Db, MemoryPersistence } from '../db/database'
import { initialiseFarm, login } from '../services/setup'
import { createSeason } from '../services/seasons'
import { createField } from '../services/fields'
import { evaluate, summarise, EVAL_SET, HOLDOUT_SET } from './evalset'
import { rulesEngine } from './engine'
import { availableQuestions } from './catalogue'

describe('keyword router quality (the floor the local model must beat)', () => {
  it('routes the everyday questions and refuses the off-topic ones', async () => {
    const db = await Db.open(new MemoryPersistence()); await initialiseFarm(db, { tenantName: 'T', farmName: 'F', ownerName: 'Lovemore', ownerPin: '1234' })
    const o = { db, ...(await login(db, 'Lovemore', '1234')).ctx! }; createSeason(o, { label: '2025/26', starts_on: '2025-09-01', ends_on: '2026-08-31' }); createSeason(o, { label: '2026/27', starts_on: '2026-09-01', ends_on: '2027-08-31', activate: true })
    createField(o, { field_no: 'F-04', area_ha: 4 }); createField(o, { field_no: 'F-05', area_ha: 2 })
    const spec = availableQuestions(o).map(({ id, title, about, keywords, params }) => ({ id, title, about, keywords, params }))
    const route = (q: string) => rulesEngine.route({ question: q, spec, seasons: ['2025/26', '2026/27'], fields: ['F-04', 'F-05'], people: ['Tendai', 'Rudo'], today: '2027-01-30' })
    const h = await evaluate(route, HOLDOUT_SET); console.log('HOLDOUT', JSON.stringify(summarise(h)), '\n' + h.filter(x => !x.ok || !x.paramsOk).map(x => `  ${x.q} → ${x.got} (wanted ${x.expected})`).join('\n'))
    const r = await evaluate(route)
    const s = summarise(r); console.log(JSON.stringify(s), '\nMISSES:\n' + r.filter(x => !x.ok || !x.paramsOk).map(x => `  ${x.hard ? '[hard] ' : ''}${x.q}  → ${x.got} (wanted ${x.expected})${x.ok && !x.paramsOk ? ' params wrong' : ''}`).join('\n'))
    expect(EVAL_SET.length).toBeGreaterThan(50); expect(s.easy_pct).toBeGreaterThanOrEqual(90); expect(s.p95_ms).toBeLessThan(50)
  })
})
