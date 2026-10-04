import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'

/** Phone layout guard: a grid of 3+ fixed columns must say what it becomes on a small screen (sm:/md:), or it crushes its contents at 390 px. */
describe('phone-safe grids', () => {
  it('no page or kit component uses a fixed grid of 3+ columns without a breakpoint', () => {
    const files = [...readdirSync('src/pages').map(f => `src/pages/${f}`), 'src/ui/kit.tsx', 'src/App.tsx'].filter(f => f.endsWith('.tsx'))
    const bad: string[] = []
    for (const f of files) for (const cls of readFileSync(f, 'utf8').match(/className="[^"]*"/g) ?? []) {
      if (/(^|\s|")grid-cols-([3-9]|1[01])\b/.test(cls) && !/\b(sm|md|lg):grid-cols-/.test(cls)) bad.push(`${f}: ${cls}`)
    }
    expect(bad).toEqual([])
  })
})
