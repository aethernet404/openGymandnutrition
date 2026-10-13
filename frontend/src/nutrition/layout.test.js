// @vitest-environment node
// happy-dom has no layout, so the layout rules are pinned where they live: in the stylesheet. Each of these
// was the cause of (or guards against) a box running off the right edge of a phone: a grid column that cannot
// shrink below its content, and an input that insists on its default width.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const css = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'nutrition.css'), 'utf8')
const rule = sel => {
  const m = css.match(new RegExp('(?:^|\\n)' + sel.replace(/[.>*]/g, '\\$&') + '\\s*\\{([^}]*)\\}'))
  return m ? m[1] : ''
}

describe('nutrition layout survives narrow screens and large text', () => {
  it('every grid uses shrinkable columns (minmax(0, 1fr)), never bare 1fr', () => {
    const grids = [...css.matchAll(/grid-template-columns:([^;}]*)/g)].map(m => m[1])
    expect(grids.length).toBeGreaterThanOrEqual(3)
    for (const g of grids) {
      expect(g, g).toMatch(/minmax\(0,\s*1fr\)/)
      expect(g.replace(/minmax\(0,\s*1fr\)/g, ''), g).not.toMatch(/\b1fr\b/)
    }
  })
  it('the field grid’s children and the number inputs inside them can shrink', () => {
    expect(rule('.nut-fields>*')).toMatch(/min-width:0/)
    expect(rule('.nut-input')).toMatch(/min-width:0/)
    expect(rule('.nut-input input')).toMatch(/width:0/)
    expect(rule('.nut-input input')).toMatch(/min-width:0/)
    expect(rule('.nut-input input')).toMatch(/box-sizing:border-box/)
  })
  it('the energy block and the AI buttons shrink too, and its cells can wrap', () => {
    expect(rule('.nut-energy-grid>div')).toMatch(/min-width:0/)
    expect(rule('.nut-ai-row>*')).toMatch(/min-width:0/)
  })
  it('no fixed pixel widths on boxes that hold text; rows with a label and a field can wrap', () => {
    expect(rule('.nut-cap')).not.toMatch(/(^|;)\s*width:\d+px/)
    expect(rule('.nut-cap')).toMatch(/max-width:\d+%/)
    expect(rule('.nut-datefield')).toMatch(/flex-wrap:wrap/)
    expect(rule('.nut-usda-row')).toMatch(/flex-wrap:wrap/)
  })
  it('long names and messages wrap instead of widening the page', () => {
    expect(rule('.nut')).toMatch(/min-width:0/)
    expect(css).toMatch(/\.nut-banner[^{]*\{[^}]*overflow-wrap:anywhere/)
  })
})
