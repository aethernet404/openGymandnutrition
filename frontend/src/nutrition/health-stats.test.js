import { describe, expect, it } from 'vitest'
import { barPct, cardState, rangeSeries } from './health-stats.js'

const day = (date, over = {}) => ({ date, active_kcal: null, resting_kcal: null, burned_kcal: null, steps: null, exercise_min: null, workouts: [], ...over })

describe('cardState', () => {
  it('nothing: no card; no token and no data: setup; a token without data: waiting', () => {
    expect(cardState(null).kind).toBe('none')
    expect(cardState({}).kind).toBe('none')
    expect(cardState({ days: [day('d')], token: false, hasData: false }).kind).toBe('setup')
    expect(cardState({ days: [day('d')], token: true, hasData: false }).kind).toBe('waiting')
  })
  it('data: today’s figures, null stays null, a zero stays a zero', () => {
    const c = cardState({ days: [day('d', { burned_kcal: 2100.4, steps: 0, exercise_min: null })], token: true, hasData: true, updatedAt: 5, weight: { latest: { kg: 80 } } })
    expect(c).toMatchObject({ kind: 'data', burned: 2100, steps: 0, exercise_min: null, weightKg: 80, updatedAt: 5, anyToday: true })
    expect(cardState({ days: [day('d')], token: true, hasData: true }).anyToday).toBe(false)
  })
  it('junk numbers never become figures', () => {
    const c = cardState({ days: [day('d', { burned_kcal: 'x', steps: NaN })], token: true, hasData: true, updatedAt: 'now', weight: { latest: { kg: 'y' } } })
    expect([c.burned, c.steps, c.updatedAt, c.weightKg]).toEqual([null, null, null, null])
  })
})

describe('rangeSeries', () => {
  const days = [day('a', { steps: 1000 }), day('b'), day('c', { steps: 0 }), day('d', { steps: 3000 })]
  it('keeps gaps as gaps and averages only the days with a value (a real zero counts)', () => {
    const s = rangeSeries(days, 'steps', 4)
    expect(s.points.map(p => p.v)).toEqual([1000, null, 0, 3000])
    expect(s).toMatchObject({ have: 3, avg: 1333, max: 3000, min: 0 })
  })
  it('takes the last n days; an empty range has no average', () => {
    expect(rangeSeries(days, 'steps', 2).points.map(p => p.date)).toEqual(['c', 'd'])
    expect(rangeSeries(days, 'burned_kcal', 4)).toMatchObject({ have: 0, avg: null, max: null })
    expect(rangeSeries(undefined, 'steps', 7).points).toEqual([])
  })
})

describe('barPct', () => {
  it('scales to the tallest, keeps small values visible, and draws nothing for gaps or an empty range', () => {
    expect(barPct(50, 100)).toBe(50)
    expect(barPct(1, 1000)).toBe(4)
    expect(barPct(null, 100)).toBe(0)
    expect(barPct(5, 0)).toBe(0)
    expect(barPct(0, 100)).toBe(4)
  })
})
