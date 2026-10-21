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
  it('the Apple Health tiles and chart bars shrink to fit, so nothing is cut off at 375 px', () => {
    expect(rule('.nut-tile')).toMatch(/min-width:0/)
    expect(rule('.nut-bar-col')).toMatch(/min-width:0/)
    expect(rule('.nut-bar-col')).toMatch(/flex:1 1 0/)
    expect(rule('.nut-chart .row')).toMatch(/flex-wrap:wrap/)
    expect(rule('.nut-ah-sync .row')).toMatch(/flex-wrap:wrap/)
  })
  it('the save-as-food box, the duplicate question and the prompt wrap and shrink; the question’s buttons wrap', () => {
    expect(rule('.nut-savebox')).toMatch(/min-width:0/)
    expect(rule('.nut-dup')).toMatch(/flex-wrap:wrap/)
    expect(rule('.nut-dup-actions')).toMatch(/flex-wrap:wrap/)
    expect(rule('.nut-saveprompt')).toMatch(/flex-wrap:wrap/)
    expect(rule('.nut-saveprompt>span')).toMatch(/min-width:0/)
  })
  it('the micronutrient fill-in sheet, its option, the edit box and the estimate switch shrink, wrap and break long names', () => {
    for (const sel of ['.nut-fill-opt', '.nut-fill-head', '.nut-fill-card', '.nut-fill-amounts', '.nut-fill-amounts li', '.nut-fill-cands', '.nut-fill-cand', '.nut-fill-actions', '.nut-fill-box', '.nut-fill-bar', '.nut-est-switch']) expect(rule(sel), sel).toMatch(/min-width:0/)
    for (const sel of ['.nut-fill-card', '.nut-fill-name', '.nut-fill-using', '.nut-fill-reason', '.nut-fill-list', '.nut-fill-box', '.nut-fill-cand>span', '.nut-fill-amounts li>span', '.nut-fill-opt label>span', '.nut-fill-head h3']) expect(rule(sel), sel).toMatch(/overflow-wrap:anywhere/)
    for (const sel of ['.nut-fill-actions', '.nut-fill-amounts li', '.nut-fill-cand', '.nut-fill-boxbtns', '.nut-est-switch']) expect(rule(sel), sel).toMatch(/flex-wrap:wrap/)
    expect(rule('.nut-fill-amounts')).toMatch(/minmax\(0,\s*1fr\)/)
  })
  it('the per-meal Macros button is a 44 px target; its panel and grid shrink and wrap; no animation, no global classes', () => {
    expect(rule('.nut-mm-btn')).toMatch(/min-height:44px/)
    expect(rule('.nut-mm-btn')).toMatch(/min-width:44px/)
    expect(rule('.nut-meal-sub')).toMatch(/flex-wrap:wrap/)
    for (const sel of ['.nut-meal-t', '.nut-meal-sub', '.nut-mm', '.nut-mm-grid', '.nut-mm-cell', '.nut-mm-bar']) expect(rule(sel), sel).toMatch(/min-width:0/)
    for (const sel of ['.nut-mm-cell', '.nut-mm-note']) expect(rule(sel), sel).toMatch(/overflow-wrap:anywhere/)
    expect(rule('.nut-mm-grid')).toMatch(/minmax\(0,\s*1fr\)/)
    for (const sel of ['.nut-mm-btn', '.nut-mm', '.nut-mm-bar', '.nut-mm-bar>i']) expect(rule(sel), sel).not.toMatch(/transition|animation/)
    expect(rule('.nut-mm-bar')).not.toMatch(/(^|;)\s*width:/)
  })
  it('the source-code note wraps and shrinks', () => {
    expect(rule('.nut-source')).toMatch(/min-width:0/)
    expect(rule('.nut-source')).toMatch(/overflow-wrap:anywhere/)
  })
  it('the Micronutrients card and the More nutrients form section shrink and wrap; the bar never sets a width in CSS', () => {
    for (const sel of ['.nut-micros', '.nut-micros-b', '.nut-mgroup', '.nut-mrow', '.nut-more', '.nut-more-b']) expect(rule(sel), sel).toMatch(/min-width:0/)
    for (const sel of ['.nut-micros-h>span', '.nut-mrow-t>span', '.nut-cov', '.nut-munk', '.nut-mnote', '.nut-ul-notes', '.nut-more-note']) expect(rule(sel), sel).toMatch(/overflow-wrap:anywhere/)
    expect(rule('.nut-mrow-t')).toMatch(/flex-wrap:wrap/)
    expect(rule('.nut-mbar')).not.toMatch(/(^|;)\s*width:/)
  })
  it('the supplements sheet: the stack bar, nutrient chips and stack rows wrap and shrink', () => {
    for (const sel of ['.nut-stackbar', '.nut-chips']) expect(rule(sel), sel).toMatch(/flex-wrap:wrap/)
    expect(rule('.nut-stack-row')).toMatch(/flex-wrap:wrap/)
    for (const sel of ['.nut-stackbar>*', '.nut-qn', '.nut-stack-row', '.nut-stack-pick']) expect(rule(sel), sel).toMatch(/min-width:0/)
    expect(rule('.nut-chip')).toMatch(/overflow-wrap:anywhere/)
  })
  it('long names and messages wrap instead of widening the page', () => {
    expect(rule('.nut')).toMatch(/min-width:0/)
    expect(css).toMatch(/\.nut-banner[^{]*\{[^}]*overflow-wrap:anywhere/)
  })
})
