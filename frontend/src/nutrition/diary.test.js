import { describe, expect, it } from 'vitest'
import {
  shiftISO, validISO, relativeDay, mealForHour, fraction, remaining, macroSplit, kcalFromMacros,
  scaleFood, parseAmount, quickBody, foodBody, goalsBody, macroLine
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
