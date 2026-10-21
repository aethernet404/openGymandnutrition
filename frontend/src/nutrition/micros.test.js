// @vitest-environment node
import { describe, expect, it } from 'vitest'
import * as api from '../../../api/nutrition/micros.js'
import { BY_KEY, KEYS, NUTRIENTS, amountText, canFill, cleanMicros, coverage, coverageGroups, diffText, groupedRows, hasMicros, microsForSend, pctDv, pick, scaleMicros, upperLimitNotes } from './micros.js'

describe('the table is the server’s table', () => {
  it('same nutrients, units, groups, Daily Values, bounds and upper limits, in the same order', () => {
    expect(NUTRIENTS).toEqual(api.NUTRIENTS)
    expect(KEYS).toEqual(api.KEYS)
  })
})

describe('cleaning and sending', () => {
  it('cleanMicros keeps known, non-negative numbers only: 0 is real, null / text / junk are unknown', () => {
    expect(cleanMicros({ iron_mg: 0, zinc_mg: null, calcium_mg: '5', vit_c_mg: -1, nope: 4, vit_d_mcg: 2.5, b12_mcg: NaN })).toEqual({ iron_mg: 0, vit_d_mcg: 2.5 })
    expect(cleanMicros(null)).toEqual({}); expect(hasMicros({})).toBe(false); expect(hasMicros({ iron_mg: 0 })).toBe(true)
  })
  it('microsForSend drops empty boxes (never sends them as 0) and refuses nonsense in words', () => {
    expect(microsForSend({ iron_mg: 5, zinc_mg: null, calcium_mg: '' })).toEqual({ ok: true, micros: { iron_mg: 5 } })
    expect(microsForSend({ iron_mg: 0 }).micros).toEqual({ iron_mg: 0 })
    expect(microsForSend({ iron_mg: -2 })).toEqual({ ok: false, error: 'Iron cannot be negative' })
    expect(microsForSend({ iron_mg: 1e9 }).error).toMatch(/not plausible.*check the unit/)
    expect(microsForSend({ iron_mg: 'x' }).error).toBe('Iron must be a number')
    expect(microsForSend(undefined)).toEqual({ ok: true, micros: {} })
  })
  it('scaleMicros scales what is known and nothing else', () => {
    expect(scaleMicros({ iron_mg: 2, zinc_mg: 0 }, 1.5)).toEqual({ iron_mg: 3, zinc_mg: 0 })
    expect(scaleMicros({}, 2)).toEqual({}); expect(scaleMicros({ iron_mg: 1 }, -1)).toEqual({})
  })
})

describe('Daily Value and text', () => {
  it('percent of the Daily Value, none for total sugars, none for junk', () => {
    expect(pctDv('vit_d_mcg', 10)).toBe(50); expect(pctDv('iron_mg', 18)).toBe(100); expect(pctDv('calcium_mg', 2600)).toBe(200)
    expect(pctDv('sugar_g', 30)).toBeNull(); expect(pctDv('iron_mg', null)).toBeNull(); expect(pctDv('nope', 1)).toBeNull()
  })
  it('amounts with a sensible number of digits and the unit', () => {
    expect(amountText('calcium_mg', 1234.5, 'en-US')).toBe('1,235 mg')
    expect(amountText('iron_mg', 12.34, 'en-US')).toBe('12.3 mg')
    expect(amountText('copper_mg', 0.456, 'en-US')).toBe('0.456 mg')
    expect(amountText('vit_d_mcg', 2.5, 'en-US')).toBe('2.5 mcg')
    expect(amountText('nope', 1)).toBe(''); expect(amountText('iron_mg', null)).toBe('')
  })
})

describe('the day summary', () => {
  const S = { food: { totals: { iron_mg: 6, calcium_mg: 500 }, withData: 2, entries: 3 }, supplements: { totals: { iron_mg: 18, vit_d_mcg: 25 }, withData: 1, entries: 2 } }
  it('food only is the food bucket; food + supplements adds the known amounts and the counts', () => {
    expect(pick(S, 'food')).toMatchObject({ totals: { iron_mg: 6, calcium_mg: 500 }, withData: 2, entries: 3, supplements: 0, marked: [] })
    expect(pick(S, 'all')).toMatchObject({ totals: { iron_mg: 24, calcium_mg: 500, vit_d_mcg: 25 }, withData: 3, entries: 5, supplements: 2 })
    expect(pick(undefined, 'all')).toMatchObject({ totals: {}, withData: 0, entries: 0, supplements: 0 })
  })
  it('coverage says how much of the day the numbers are based on', () => {
    expect(coverage({ withData: 6, entries: 9 })).toEqual({ withData: 6, entries: 9, none: false, partial: true })
    expect(coverage({ withData: 0, entries: 4 }).none).toBe(true)
    expect(coverage({ withData: 3, entries: 3 })).toMatchObject({ none: false, partial: false })
    expect(coverage({ withData: 0, entries: 0 })).toBeNull()
  })
  it('rows are grouped, only known nutrients are rows (unknown ones are listed apart, never as 0)', () => {
    const g = groupedRows({ iron_mg: 6, vit_d_mcg: 0, fiber_g: 5 })
    expect(g.map(x => x.id)).toEqual(['vitamins', 'minerals', 'other'])
    expect(g[0].rows).toEqual([expect.objectContaining({ key: 'vit_d_mcg', value: 0, pct: 0 })])
    expect(g[1].rows.map(r => r.key)).toEqual(['iron_mg'])
    expect(g[1].unknown).toContain('Calcium'); expect(g[1].unknown).not.toContain('Iron')
    expect(g[2].rows[0]).toMatchObject({ key: 'fiber_g', pct: 18 })
    expect(groupedRows({}).every(x => x.rows.length === 0)).toBe(true)
  })
})

describe('upper limit notes', () => {
  it('a total-scope limit compares food + supplements; a supplement-scope limit compares the supplement total only', () => {
    const over = upperLimitNotes({ food: { totals: { zinc_mg: 15, magnesium_mg: 400, b6_mg: 3 } }, supplements: { totals: { zinc_mg: 30, magnesium_mg: 100, b6_mg: 99 } } }, 'en-US')
    expect(over.map(n => n.key)).toEqual(['b6_mg', 'zinc_mg'])           // 102 > 100 and 45 > 40; magnesium: supplements 100 ≤ 350 although food is 400
    expect(over[1]).toMatchObject({ total: 45, ul: 40, amount: '45 mg', limit: '40 mg', scope: 'total' })
    const sup = upperLimitNotes({ food: { totals: {} }, supplements: { totals: { magnesium_mg: 400, vit_e_mg: 1100, b3_mg: 36, folate_mcg: 1001, vit_a_mcg: 3001 } } })
    expect(sup.map(n => n.key).sort()).toEqual(['b3_mg', 'folate_mcg', 'magnesium_mg', 'vit_a_mcg', 'vit_e_mg'])
    expect(sup.every(n => n.scope === 'supplement' && n.what)).toBe(true)
  })
  it('at or below the limit, with no limit established, or with nothing known: no note', () => {
    expect(upperLimitNotes({ food: { totals: { vit_d_mcg: 100, iron_mg: 45, vit_k_mcg: 9999, potassium_mg: 99999 } }, supplements: { totals: {} } })).toEqual([])
    expect(upperLimitNotes(undefined)).toEqual([]); expect(upperLimitNotes({})).toEqual([])
  })
  it('food alone can push a total-scope nutrient over (calcium), and the age note rides along', () => {
    const n = upperLimitNotes({ food: { totals: { calcium_mg: 2600 } }, supplements: { totals: {} } })
    expect(n[0]).toMatchObject({ key: 'calcium_mg', note: '2,000 mg from age 51' })
  })
  it('the table has no upper limit for vitamin K, potassium, sodium, B1, B2, B12, B5, biotin, fibre', () => {
    for (const k of ['vit_k_mcg', 'potassium_mg', 'sodium_mg', 'b1_mg', 'b2_mg', 'b12_mcg', 'b5_mg', 'biotin_mcg', 'fiber_g']) expect(BY_KEY[k].ul).toBeUndefined()
  })
})

describe('estimated micronutrients (USDA stand-ins)', () => {
  const S = {
    food: { totals: { iron_mg: 5 }, withData: 2, entries: 7, est: { totals: { iron_mg: 2, calcium_mg: 90 } }, groups: { labels: 2, estimated: 3, none: 2 } },
    supplements: { totals: { vit_d_mcg: 25 }, withData: 1, entries: 1, est: { totals: {} }, groups: { labels: 1, estimated: 0, none: 0 } }
  }
  it('estimates are added only while included, and the nutrients they touched are marked', () => {
    expect(pick(S, 'food', true)).toMatchObject({ totals: { iron_mg: 7, calcium_mg: 90 }, labelTotals: { iron_mg: 5 }, marked: ['iron_mg', 'calcium_mg'] })
    expect(pick(S, 'food', false)).toMatchObject({ totals: { iron_mg: 5 }, marked: [] })
    expect(pick(S, 'all', true).groups).toEqual({ labels: 3, estimated: 3, none: 2 })
    expect(groupedRows({ iron_mg: 7 }, ['iron_mg'])[1].rows[0]).toMatchObject({ key: 'iron_mg', estimated: true })
  })
  it('three groups; the counted ones depend on the switch; an answer without groups is read as labels and none', () => {
    expect(coverageGroups(pick(S, 'food', true))).toEqual({ entries: 7, labels: 2, estimated: 3, none: 2, counted: 5, nothing: false, left: false })
    expect(coverageGroups(pick(S, 'food', false))).toMatchObject({ counted: 2, left: true })
    expect(coverageGroups(pick({ food: { totals: {}, withData: 1, entries: 4 } }, 'food'))).toMatchObject({ labels: 1, estimated: 0, none: 3 })
    expect(coverageGroups(pick(undefined, 'food'))).toBeNull()
  })
  it('the upper-limit note flags estimated values only when they are in the total it states', () => {
    const z = { food: { totals: { zinc_mg: 38 }, est: { totals: { zinc_mg: 4 } } }, supplements: { totals: {} } }
    expect(upperLimitNotes(z, 'en-US', true)).toMatchObject([{ key: 'zinc_mg', total: 42, estimated: true }])
    expect(upperLimitNotes(z, 'en-US', false)).toEqual([])
  })
  it('canFill follows the server rule: vitamins or minerals of its own, an estimate already, supplements and nameless entries are left alone', () => {
    expect(canFill({ name: 'x', meal: 'snack' })).toBe(true)
    expect(canFill({ name: 'x', meal: 'snack', micros: { sodium_mg: 5, fiber_g: 1 } })).toBe(true)
    expect(canFill({ name: 'x', meal: 'snack', micros: { calcium_mg: 5 } })).toBe(false)
    expect(canFill({ name: 'x', meal: 'snack', microsEst: { micros: { iron_mg: 1 } } })).toBe(false)
    expect(canFill({ name: 'x', meal: 'supplements' })).toBe(false)
    expect(canFill({ name: ' ', meal: 'snack' })).toBe(false)
  })
  it('differences are worded: twice, half, more, less', () => {
    expect(diffText({ key: 'fat_g', entry: 9, standin: 19, ratio: 2.11 })).toEqual({ how: 'about twice the', what: 'fat', numbers: '19 g', logged: '9 g' })
    expect(diffText({ key: 'calories', entry: 200, standin: 90, ratio: 0.45 }).how).toBe('about half the')
    expect(diffText({ key: 'carbs_g', entry: 10, standin: 40, ratio: 4 }).how).toBe('about 4 times the')
    expect(diffText({ key: 'protein_g', entry: 0, standin: 8, ratio: null }).how).toBe('some')
  })
})
