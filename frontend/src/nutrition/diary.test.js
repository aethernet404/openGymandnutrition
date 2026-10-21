import { describe, expect, it } from 'vitest'
import {
  shiftISO, validISO, relativeDay, mealForHour, fraction, remaining, macroSplit, kcalFromMacros,
  scaleFood, parseAmount, quickBody, foodBody, goalsBody, macroLine, kgToUnit, weightText, workoutLine, weightTrend, sparkPath, entryBase, scaleEntry, gramsForQty, qtyForGramsOf, amountPatch, findDuplicate, foodFromEntry, savedFoodBody, savedFields, savedOverrides
} from './diary.js'

describe('dates', () => {
  it('shifts across month, year and leap-day boundaries', () => {
    expect(shiftISO('2026-10-31', 1)).toBe('2026-11-01')
    expect(shiftISO('2026-01-01', -1)).toBe('2025-12-31')
    expect(shiftISO('2028-02-28', 1)).toBe('2028-02-29')
    expect(shiftISO('2027-02-28', 1)).toBe('2027-03-01')
  })
  it('does not skip or repeat a day over a DST change', () => {
    let d = '2026-03-20'
    const seen = new Set()
    for (let i = 0; i < 20; i++) { seen.add(d); d = shiftISO(d, 1) }
    expect(seen.size).toBe(20)
    expect(shiftISO('2026-03-29', 1)).toBe('2026-03-30')
    expect(shiftISO('2026-10-25', 1)).toBe('2026-10-26')
  })
  it('validates real calendar days only', () => {
    expect(validISO('2026-02-29')).toBe(false)
    expect(validISO('2028-02-29')).toBe(true)
    expect(validISO('26-1-1')).toBe(false)
    expect(validISO(null)).toBe(false)
  })
  it('names today, yesterday and tomorrow', () => {
    expect(relativeDay('2026-10-12', '2026-10-12')).toBe('today')
    expect(relativeDay('2026-10-11', '2026-10-12')).toBe('yesterday')
    expect(relativeDay('2026-10-13', '2026-10-12')).toBe('tomorrow')
    expect(relativeDay('2026-10-01', '2026-10-12')).toBe(null)
  })
  it('suggests a meal by the hour', () => {
    expect([7, 12, 18, 23].map(mealForHour)).toEqual(['breakfast', 'lunch', 'dinner', 'snack'])
  })
})

describe('progress', () => {
  it('fraction is null without a goal and not clamped over it', () => {
    expect(fraction(500, null)).toBe(null)
    expect(fraction(500, 0)).toBe(null)
    expect(fraction(1200, 1000)).toBe(1.2)
    expect(fraction(undefined, 1000)).toBe(0)
  })
  it('remaining goes negative once over', () => {
    expect(remaining(1800, 2400)).toBe(600)
    expect(remaining(2500.5, 2400)).toBe(-100.5)
    expect(remaining(10, null)).toBe(null)
  })
  it('splits calories by macro at 4/4/9 and always sums to 100', () => {
    expect(macroSplit({})).toEqual({ protein_g: 0, carbs_g: 0, fat_g: 0 })
    const s = macroSplit({ protein_g: 30, carbs_g: 50, fat_g: 20 })
    expect(s.protein_g + s.carbs_g + s.fat_g).toBe(100)
    expect(s.carbs_g).toBe(Math.round(200 / 500 * 100))
    expect(kcalFromMacros({ protein_g: 30, carbs_g: 50, fat_g: 20 })).toBe(500)
  })
})

describe('foods', () => {
  const shake = { serving: { label: '1 scoop', grams: 30 }, per: { calories: 120, protein_g: 24, carbs_g: 3, fat_g: 1.5 } }
  it('scales like the server', () => {
    expect(scaleFood(shake, 2)).toEqual({ calories: 240, protein_g: 48, carbs_g: 6, fat_g: 3, grams: 60 })
    expect(scaleFood(shake, 0.5)).toEqual({ calories: 60, protein_g: 12, carbs_g: 1.5, fat_g: 0.8, grams: 15 })
    expect(scaleFood(shake, NaN).calories).toBe(120)
    expect(scaleFood({ per: shake.per }, 1).grams).toBe(null)
  })
})

describe('forms', () => {
  it('parseAmount accepts comma decimals, blanks, and refuses junk', () => {
    expect(parseAmount('1,5')).toBe(1.5)
    expect(parseAmount(' 12 ')).toBe(12)
    expect(parseAmount('')).toBe(null)
    expect(parseAmount('abc')).toBeNaN()
    expect(parseAmount('-3')).toBeNaN()
  })
  it('quick add needs calories, defaults the rest, names itself', () => {
    expect(quickBody({ meal: 'lunch' }, '2026-10-12').ok).toBe(false)
    const r = quickBody({ meal: 'lunch', calories: 300, protein_g: 20 }, '2026-10-12')
    expect(r.body).toEqual({ date: '2026-10-12', meal: 'lunch', name: 'Quick add', source: 'quick', calories: 300, protein_g: 20, carbs_g: 0, fat_g: 0 })
    expect(quickBody({ meal: 'lunch', calories: -1 }, 'd').ok).toBe(false)
    expect(quickBody({ meal: 'lunch', calories: 100, fat_g: NaN }, 'd').ok).toBe(false)
  })
  it('custom food needs a name and calories', () => {
    expect(foodBody({ name: '  ', calories: 1 }).ok).toBe(false)
    expect(foodBody({ name: 'x' }).ok).toBe(false)
    const r = foodBody({ name: ' Oats ', serving: '', grams: 40, calories: 150, protein_g: 5 })
    expect(r.body).toEqual({ name: 'Oats', brand: '', serving: '1 serving', grams: 40, ext: null, per: { calories: 150, protein_g: 5, carbs_g: 0, fat_g: 0 } })
  })
  it('goals: empty or 0 clears a target, junk is refused', () => {
    expect(goalsBody({ calories: 2400, protein_g: 0, carbs_g: null, fat_g: 70 }).body).toEqual({ calories: 2400, protein_g: null, carbs_g: null, fat_g: 70 })
    expect(goalsBody({ calories: NaN }).ok).toBe(false)
  })
  it('macro line trims float noise', () => {
    expect(macroLine({ protein_g: 24.000001, carbs_g: 3, fat_g: 1.54 })).toBe('P 24 · C 3 · F 1.5')
  })
})

import { burnedOf, netOf, goalWithEatBack, signed, updatedText, hasMacros, macroShares, mealBreakdown, splitToTotal } from './diary.js'

describe('Apple Health numbers', () => {
  const h = { active_kcal: 640.4, resting_kcal: 1670, steps: 8000, updatedAt: 1 }
  it('burned is active + resting; none without numbers', () => {
    expect(burnedOf(h)).toBe(2310)
    expect(burnedOf(null)).toBe(null)
    expect(burnedOf({ active_kcal: 'x', resting_kcal: 1 })).toBe(null)
    expect(burnedOf({ active_kcal: 0, resting_kcal: 1500 })).toBe(1500)
  })
  it('net is eaten minus burned, and absent when there is nothing to subtract', () => {
    expect(netOf(1420, h)).toBe(-890)
    expect(netOf(2500, h)).toBe(190)
    expect(netOf(2310, h)).toBe(0)
    expect(netOf(0, h)).toBe(-2310)
    expect(netOf(1420, null)).toBe(null)
    expect(netOf(undefined, h)).toBe(-2310)
  })
  it('eat-back adds a share of ACTIVE calories to the goal only when switched on', () => {
    expect(goalWithEatBack(2400, h, { enabled: false, percent: 50 })).toEqual({ goal: 2400, extra: 0, applied: false })
    expect(goalWithEatBack(2400, h, { enabled: true, percent: 50 })).toEqual({ goal: 2720, extra: 320, applied: true })
    expect(goalWithEatBack(2400, h, { enabled: true, percent: 100 }).goal).toBe(3040)
    expect(goalWithEatBack(2400, h, { enabled: true, percent: 0 })).toEqual({ goal: 2400, extra: 0, applied: false })
    expect(goalWithEatBack(2400, null, { enabled: true, percent: 50 })).toEqual({ goal: 2400, extra: 0, applied: false })
    expect(goalWithEatBack(null, h, { enabled: true, percent: 50 })).toEqual({ goal: null, extra: 0, applied: false })
    expect(goalWithEatBack(2400, h, undefined).goal).toBe(2400)
  })
  it('resting calories never feed the goal', () => {
    expect(goalWithEatBack(2000, { active_kcal: 0, resting_kcal: 1800 }, { enabled: true, percent: 100 }).goal).toBe(2000)
  })
  it('signed shows a real minus and always a sign', () => {
    expect(signed(-890)).toBe('−890')
    expect(signed(190)).toBe('+190')
    expect(signed(0)).toBe('0')
    expect(signed(-1234)).toBe('−' + (1234).toLocaleString())
  })
  it('updatedText: a time today, a date and time otherwise', () => {
    const now = new Date(2026, 9, 13, 18, 0).getTime()
    expect(updatedText(new Date(2026, 9, 13, 14, 5).getTime(), now, 'en-GB')).toBe('14:05')
    expect(updatedText(new Date(2026, 9, 12, 23, 30).getTime(), now, 'en-GB')).toBe('12 Oct, 23:30')
    expect(updatedText(NaN, now)).toBe('')
    expect(updatedText(undefined, now)).toBe('')
  })
})

describe('Health Auto Export extras', () => {
  it('weights are shown in the profile’s unit, one decimal', () => {
    expect(kgToUnit(80, 'kg')).toBe(80)
    expect(kgToUnit(80, 'lb')).toBe(176.4)
    expect(weightText(79.8, 'kg')).toBe('79.8 kg')
    expect(weightText(80, 'lb')).toBe('176.4 lb')
    expect(weightText(NaN, 'kg')).toBe('')
  })
  it('a workout reads as name, minutes, calories (and distance when there is one)', () => {
    expect(workoutLine({ name: 'Strength Training', duration_min: 45, kcal: 320, km: null })).toBe('Strength Training, 45 min, 320 kcal')
    expect(workoutLine({ name: 'Running', duration_min: 30, kcal: 250, km: 5.2 })).toBe('Running, 30 min, 250 kcal, 5.2 km')
    expect(workoutLine({ name: 'Running', duration_min: 30, kcal: 250, km: 5 }, 'lb')).toBe('Running, 30 min, 250 kcal, 3.1 mi')
    expect(workoutLine({ name: 'Yoga', duration_min: 20, kcal: null, km: null })).toBe('Yoga, 20 min')
  })
  it('workout calories do not feed Burned: burnedOf only knows active + resting', () => {
    expect(burnedOf({ active_kcal: 600, resting_kcal: 1700, workouts: [{ kcal: 900 }] })).toBe(2300)
  })
  it('the trend is in order, in the unit, with the change; one reading has no change', () => {
    const t = weightTrend([{ date: '2026-10-12', kg: 80 }, { date: '2026-10-01', kg: 81 }], 'kg')
    expect(t.points.map(p => p.v)).toEqual([81, 80])
    expect(t.change).toBe(-1)
    expect(weightTrend([{ date: '2026-10-12', kg: 80 }], 'lb').change).toBeNull()
    expect(weightTrend(null).points).toEqual([])
    expect(weightTrend([{ date: 'x', kg: 'no' }]).points).toEqual([])
  })
  it('the line is a path for two or more values, none otherwise, and stays inside its box', () => {
    expect(sparkPath([1])).toBeNull()
    expect(sparkPath([])).toBeNull()
    const d = sparkPath([80, 81, 79], 120, 32, 3)
    expect(d).toMatch(/^M3\.0 .* L117\.0 /)
    const ys = [...d.matchAll(/ ([\d.]+)/g)].map(m => +m[1])
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(3)
    expect(Math.max(...ys)).toBeLessThanOrEqual(29)
    expect(sparkPath([5, 5])).toMatch(/^M/)
  })
})

describe('changing the amount of an entry', () => {
  const old = { calories: 33, protein_g: 1.1, carbs_g: 3.3, fat_g: 0.7, qty: 0.3, grams: 30 }
  it('the base is the saved base, or else totals ÷ qty (qty 1 when absent)', () => {
    expect(entryBase({ ...old, base: { calories: 110, protein_g: 3.667, carbs_g: 11, fat_g: 2.333, grams: 100 } }).per.calories).toBe(110)
    const b = entryBase(old)
    expect(b.qty).toBe(0.3); expect(b.per.calories).toBe(110); expect(b.gramsPer).toBe(100)
    const ai = entryBase({ calories: 600, protein_g: 20, carbs_g: 90, fat_g: 15 })
    expect(ai.qty).toBe(1); expect(ai.per).toEqual({ calories: 600, protein_g: 20, carbs_g: 90, fat_g: 15 }); expect(ai.gramsPer).toBeNull()
  })
  it('junk in an old entry cannot make NaN or negative numbers', () => {
    const b = entryBase({ calories: 'x', qty: -2, protein_g: NaN, grams: -5 })
    expect(Object.values(b.per).every(v => v === 0)).toBe(true)
    expect(b.qty).toBe(1); expect(b.gramsPer).toBeNull()
    expect(entryBase({ calories: 10, qty: 0 }).per.calories).toBe(10)
  })
  it('amount × base, rounded like the server (kcal whole, macros one decimal)', () => {
    const b = entryBase({ calories: 200, protein_g: 10, carbs_g: 20, fat_g: 5, qty: 1, grams: 100 })
    expect(scaleEntry(b, 1.5)).toEqual({ calories: 300, protein_g: 15, carbs_g: 30, fat_g: 7.5 })
    expect(scaleEntry(b, 0.33)).toEqual({ calories: 66, protein_g: 3.3, carbs_g: 6.6, fat_g: 1.7 })
  })
  it('many edits in a row come back to the start exactly', () => {
    const b = entryBase(old)
    let cur = { calories: 33, protein_g: 1.1, carbs_g: 3.3, fat_g: 0.7 }
    for (const q of [1.7, 0.45, 9.99, 0.77, 3, 0.3]) cur = scaleEntry(b, q, cur)
    expect(cur).toEqual({ calories: 33, protein_g: 1.1, carbs_g: 3.3, fat_g: 0.7 })
  })
  it('numbers set by hand are kept, the rest follow', () => {
    const b = entryBase({ calories: 200, protein_g: 10, carbs_g: 20, fat_g: 5, qty: 1 })
    expect(scaleEntry(b, 2, { calories: 400, protein_g: 99, carbs_g: 40, fat_g: 10 }, { protein_g: true })).toEqual({ calories: 400, protein_g: 99, carbs_g: 40, fat_g: 10 })
    expect(scaleEntry(b, 3, { calories: 400, protein_g: 99, carbs_g: 40, fat_g: 10 }, { protein_g: true })).toEqual({ calories: 600, protein_g: 99, carbs_g: 60, fat_g: 15 })
  })
  it('grams and servings stay in step; no weight, no conversion', () => {
    const b = entryBase({ calories: 200, qty: 2, grams: 200 })
    expect(gramsForQty(b, 1.5)).toBe(150); expect(qtyForGramsOf(b, 150)).toBe(1.5)
    expect(qtyForGramsOf(b, 0)).toBeNull(); expect(qtyForGramsOf(b, NaN)).toBeNull()
    expect(gramsForQty(entryBase({ calories: 5 }), 2)).toBeNull(); expect(qtyForGramsOf(entryBase({ calories: 5 }), 50)).toBeNull()
  })
  it('the patch carries amount, weight and the unchanging base', () => {
    const b = entryBase({ calories: 200, protein_g: 10, carbs_g: 20, fat_g: 5, qty: 1, grams: 100 })
    expect(amountPatch(b, 2)).toEqual({ qty: 2, grams: 200, base: { calories: 200, protein_g: 10, carbs_g: 20, fat_g: 5, grams: 100 } })
    expect(amountPatch(entryBase({ calories: 5 }), 2).grams).toBeUndefined()
  })
})

describe('saving an estimate or an entry as a food', () => {
  it('foodFromEntry: one serving from the base, not the entry’s total; the entry’s own label and weight; AI entries are marked', () => {
    const f = foodFromEntry({ name: ' Pliny the Elder ', brand: '', source: 'ai', serving: '1 can (12 oz)', qty: 1.5, grams: 532.5, calories: 315, protein_g: 3, carbs_g: 19.5, fat_g: 0, base: { calories: 210, protein_g: 2, carbs_g: 13, fat_g: 0, grams: 355 } })
    expect(f).toEqual({ name: 'Pliny the Elder', brand: '', serving: '1 can (12 oz)', grams: 355, calories: 210, protein_g: 2, carbs_g: 13, fat_g: 0, origin: 'ai' })
  })
  it('foodFromEntry: an older entry with no base derives it from totals ÷ amount, rounded like a food; Quick add is not marked AI; a food entry keeps its brand', () => {
    expect(foodFromEntry({ name: 'IPA', source: 'quick', calories: 400, protein_g: 4, carbs_g: 30, fat_g: 0, qty: 2 })).toEqual({ name: 'IPA', brand: '', serving: '', grams: null, calories: 200, protein_g: 2, carbs_g: 15, fat_g: 0, origin: null })
    const odd = foodFromEntry({ name: 'X', brand: 'Brand', source: 'food', serving: '1 pint', calories: 100, protein_g: 1, carbs_g: 7, fat_g: 0.3, qty: 0.3, grams: 142 })
    expect([odd.calories, odd.carbs_g, odd.fat_g, odd.grams, odd.brand]).toEqual([333, 23.3, 1, 473.3, 'Brand'])
  })
  it('foodFromEntry copes with junk: no qty, NaN, negative numbers', () => {
    const f = foodFromEntry({ name: 'Old', calories: 'x', protein_g: NaN, carbs_g: -4, qty: -1 })
    expect([f.calories, f.protein_g, f.carbs_g, f.fat_g]).toEqual([0, 0, 0, 0])
  })
  it('findDuplicate: same name and brand, any case, extra spaces; another brand or a looked-up food is not one', () => {
    const foods = [{ id: 1, source: 'custom', name: 'Pliny  the Elder', brand: 'Russian River' }, { id: 2, source: 'off', name: 'Nutella', brand: '' }, { id: 3, name: 'Legacy', brand: '' }]
    expect(findDuplicate(foods, ' pliny THE elder ', 'russian river').id).toBe(1)
    expect(findDuplicate(foods, 'Pliny the Elder', 'Other')).toBeNull()
    expect(findDuplicate(foods, 'Nutella', '')).toBeNull()
    expect(findDuplicate(foods, 'legacy').id).toBe(3)
    expect(findDuplicate(null, 'x')).toBeNull()
  })
  it('savedFoodBody: the confirmed name and numbers, the origin, the duplicate check; nothing else; the usual validation in words', () => {
    const ok = savedFoodBody({ name: ' Beer ', brand: ' B ', serving: '1 can', grams: 355, calories: 210, protein_g: 2, carbs_g: 13, fat_g: null, origin: 'ai', image: 'x', photo: 'y' })
    expect(ok.body).toEqual({ name: 'Beer', brand: 'B', serving: '1 can', grams: 355, per: { calories: 210, protein_g: 2, carbs_g: 13, fat_g: 0 }, origin: 'ai', checkDuplicate: true })
    expect(savedFoodBody({ name: 'B', calories: 1 }, { choice: 'update' }).body.onDuplicate).toBe('update')
    expect(savedFoodBody({ name: 'B', calories: 1 }).body.origin).toBeUndefined()
    expect(savedFoodBody({ name: '  ', calories: 1 }).error).toBe('A food needs a name')
    expect(savedFoodBody({ name: 'B', calories: null }).error).toMatch(/calories/)
    expect(savedFoodBody({ name: 'B', calories: -5 }).ok).toBe(false)
    expect(savedFoodBody({ name: 'B', calories: 1, protein_g: NaN }).ok).toBe(false)
    expect(savedFoodBody({ name: 'B', calories: 1, grams: -1 }).ok).toBe(false)
  })
  it('savedFields / savedOverrides: the saved copy follows the row until it is edited, and only edits are kept', () => {
    const row = { name: 'Fried egg', portion: '2 large', grams: 100, calories: 180, protein_g: 12.5, carbs_g: 1, fat_g: 14 }
    const eff = savedFields(row, {})
    expect(eff).toEqual({ name: 'Fried egg', brand: '', serving: '2 large', grams: 100, calories: 180, protein_g: 12.5, carbs_g: 1, fat_g: 14, origin: 'ai' })
    const over = savedOverrides({}, eff, { ...eff, name: 'Pliny', calories: 210 })
    expect(over).toEqual({ name: 'Pliny', calories: 210 })
    expect(savedFields({ ...row, calories: 999, name: 'Changed' }, over)).toMatchObject({ name: 'Pliny', calories: 210, serving: '2 large', protein_g: 12.5 })
    expect(savedFields({ ...row, grams: 120 }, savedOverrides({}, eff, { ...eff, grams: null })).grams).toBeNull()      // clearing the weight is an edit too
  })
})

describe('per-meal macros add up to the day', () => {
  const E = (meal, calories, protein_g, carbs_g, fat_g) => ({ meal, calories, protein_g, carbs_g, fat_g })
  const day = es => { const t = { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 }; for (const e of es) for (const k of Object.keys(t)) t[k] += e[k] || 0; return { calories: Math.round(t.calories), protein_g: Math.round(t.protein_g * 10) / 10, carbs_g: Math.round(t.carbs_g * 10) / 10, fat_g: Math.round(t.fat_g * 10) / 10 } }
  const sum = (b, k) => Math.round(Object.values(b).reduce((a, m) => a + m[k], 0) * 10) / 10

  it('three meals of 0.5 kcal each: independent rounding would give 2 or 0, the split gives exactly the day total', () => {
    const es = [E('breakfast', 0.5, 0.04, 0.04, 0.04), E('lunch', 0.5, 0.04, 0.04, 0.04), E('dinner', 0.5, 0.04, 0.04, 0.04)]
    const t = day(es)
    const b = mealBreakdown(es, t)
    for (const k of ['calories', 'protein_g', 'carbs_g', 'fat_g']) expect(sum(b, k), k).toBe(t[k])
  })
  it('real-looking days: every macro of the meals sums to the totals the server sends', () => {
    const es = [E('breakfast', 312.4, 10.26, 50.31, 5.55), E('breakfast', 95.5, 0.33, 22.04, 0.25), E('lunch', 650, 40.05, 60.95, 20.15), E('snack', 187.3, 7.14, 20.07, 9.02), E('dinner', 0, 0, 0, 0), E('supplements', 5, 0, 1.25, 0)]
    const t = day(es)
    const b = mealBreakdown(es, t)
    for (const k of ['calories', 'protein_g', 'carbs_g', 'fat_g']) expect(sum(b, k), k).toBe(t[k])
    expect(Math.abs(b.lunch.calories - 650)).toBeLessThanOrEqual(1)
    expect(b.dinner).toEqual({ calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 })
  })
  it('an entry of an unknown meal still counts in the day, so the others are not stretched to cover it', () => {
    const es = [E('breakfast', 100, 5, 10, 2), E('brunch', 50, 1, 5, 1)]
    const b = mealBreakdown(es, day(es))
    expect(b.breakfast).toEqual({ calories: 100, protein_g: 5, carbs_g: 10, fat_g: 2 })
  })
  it('when the parts do not match the target at all, each is rounded on its own (no invented numbers)', () => {
    expect(splitToTotal([10.4, 20.6], 99, 1)).toEqual([10, 21])
    expect(splitToTotal([1.04, 2.06], 3.1, 0.1)).toEqual([1, 2.1])
  })
  it('shares of the meal’s calories; protein and carbs 4 kcal/g, fat 9', () => {
    const s = macroShares({ calories: 400, protein_g: 25, carbs_g: 50, fat_g: 11.1 })
    expect(s.pct).toEqual({ protein_g: 25, carbs_g: 50, fat_g: 25 })
    expect(s.bar.map(b => Math.round(b.width))).toEqual([25, 50, 25])
    expect(s.partial).toBe(false)
  })
  it('calories without macros: shares are 0 and the meal is flagged as partial; no calories: no shares at all', () => {
    expect(macroShares({ calories: 300, protein_g: 0, carbs_g: 0, fat_g: 0 })).toMatchObject({ pct: { protein_g: 0, carbs_g: 0, fat_g: 0 }, partial: true })
    expect(macroShares({ calories: 300, protein_g: 10, carbs_g: 0, fat_g: 0 }).partial).toBe(true)
    expect(macroShares({ calories: 0, protein_g: 5, carbs_g: 5, fat_g: 5 })).toEqual({ pct: { protein_g: null, carbs_g: null, fat_g: null }, bar: [], partial: false })
  })
  it('the bar never overflows when the macros imply more than the stated calories', () => {
    const s = macroShares({ calories: 100, protein_g: 20, carbs_g: 20, fat_g: 20 })
    expect(s.bar.reduce((a, b) => a + b.width, 0)).toBeCloseTo(100, 5)
  })
  it('hasMacros: any calories or macro counts', () => {
    expect(hasMacros({ calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 })).toBe(false)
    expect(hasMacros({ calories: 0, protein_g: 0, carbs_g: 0.5, fat_g: 0 })).toBe(true)
    expect(hasMacros(undefined)).toBe(false)
  })
})
