import { describe, expect, it } from 'vitest'
import {
  shiftISO, validISO, relativeDay, mealForHour, fraction, remaining, macroSplit, kcalFromMacros,
  scaleFood, parseAmount, quickBody, foodBody, goalsBody, macroLine, kgToUnit, weightText, workoutLine, weightTrend, sparkPath
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

import { burnedOf, netOf, goalWithEatBack, signed, updatedText } from './diary.js'

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
