// @vitest-environment node
// The weight trend once floated over the diary as a dark box with no close button: the card's inner div was
// given className="center", which is the app's global dialog class (position:absolute, a background, a shadow).
// These tests keep that kind of collision from coming back, for every class the nutrition module uses.
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const NUT = join(process.cwd(), 'src/nutrition')
const SRC = readdirSync(NUT).filter(n => /\.jsx$/.test(n) && !/\.test\./.test(n)).map(n => [n, readFileSync(join(NUT, n), 'utf8')])
const indexCss = readFileSync(join(process.cwd(), 'src/index.css'), 'utf8')
const nutCss = readFileSync(join(NUT, 'nutrition.css'), 'utf8')

const classesIn = src => {
  const out = new Set()
  for (const m of src.matchAll(/className=(?:"([^"]*)"|\{([^}]*)\})/g)) {
    for (const s of (m[1] ?? '').split(/\s+/)) if (s) out.add(s)
    for (const q of (m[2] ?? '').matchAll(/['"`]([^'"`$]*)['"`]/g)) for (const s of q[1].split(/\s+/)) if (s) out.add(s)
  }
  return out
}
const overlayRules = css => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(m => ({ sel: m[1].trim(), body: m[2] })).filter(r => /position:\s*(absolute|fixed)/.test(r.body))

describe('nothing in the nutrition module can float over the page', () => {
  it('no class it uses is a bare, global overlay class (position:absolute/fixed) in the app stylesheet', () => {
    const used = new Set(SRC.flatMap(([, s]) => [...classesIn(s)]))
    const hits = []
    for (const { sel } of overlayRules(indexCss)) {
      for (const part of sel.split(',')) {
        const m = /^\.([\w-]+)$/.exec(part.trim().replace(/^[\s\S]*\*\/\s*/, ''))          // a bare ".name" selector: applies wherever the class is used
        if (m && used.has(m[1])) hits.push(m[1])
      }
    }
    expect(hits).toEqual([])
  })

  it('the old collision is gone: no nutrition component uses className "center"', () => {
    for (const [name, src] of SRC) expect(classesIn(src).has('center'), name).toBe(false)
  })

  it('the stylesheet’s own rules put nothing out of flow, except the camera frame and its aim line', () => {
    const offenders = overlayRules(nutCss).map(r => r.sel).filter(s => !/nut-cam|nut-datepick|nut-photo|nut-cam-line/.test(s))
    expect(offenders).toEqual([])
    expect(nutCss).not.toMatch(/position:\s*fixed/)
    expect(nutCss).not.toMatch(/z-index/)
  })

  it('there is no popup, tooltip or popover in the weight and chart code: no sheet is opened from them at all', () => {
    for (const name of ['AppleHealth.jsx', 'HealthHomeCard.jsx']) {
      const src = SRC.find(([n]) => n === name)[1]
      expect(src, name).not.toMatch(/openSheet|confirmSheet|createPortal|role="dialog"|tooltip|popover/i)
    }
    const diary = SRC.find(([n]) => n === 'Diary.jsx')[1]
    const weightCard = diary.slice(diary.indexOf('function WeightCard'), diary.indexOf('function MealCard'))
    expect(weightCard).not.toMatch(/openSheet|createPortal|role="dialog"|tooltip|popover|useEffect/i)
  })
})
