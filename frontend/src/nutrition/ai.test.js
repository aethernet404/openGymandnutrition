import { describe, expect, it } from 'vitest'
import { draftRows, rowsTotals, draftToEntries, edited, failureAdvice, unavailableText, allowanceText, blankRow } from './ai.js'

const draft = { name: 'Eggs on toast', confidence: 'medium', notFood: false, notes: 'oil is a guess', warnings: [], items: [
  { name: 'Fried egg', portion: '2 large', grams: 100, calories: 180, protein_g: 12.5, carbs_g: 1, fat_g: 14 },
  { name: 'Toast', portion: '1 slice', grams: null, calories: 80, protein_g: 3, carbs_g: 14, fat_g: 1 }
] }

describe('AI draft', () => {
  it('turns the model’s items into editable rows and sums them live', () => {
    const rows = draftRows(draft)
    expect(rows).toHaveLength(2)
    expect(rows[1].grams).toBe(null)
    expect(rowsTotals(rows)).toEqual({ calories: 260, protein_g: 15.5, carbs_g: 15, fat_g: 15 })
    rows[0].calories = 200
    expect(rowsTotals(rows).calories).toBe(280)
    expect(rowsTotals([blankRow(0)])).toEqual({ calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 })
  })

  it('saves one AI entry per item, carrying the confidence and the edits', () => {
    const rows = draftRows(draft)
    rows[0].calories = 200; rows[0].name = '  Scrambled egg '
    const r = draftToEntries(rows, { date: '2026-10-12', meal: 'breakfast', confidence: 'medium' })
    expect(r.ok).toBe(true)
    expect(r.body.date).toBe('2026-10-12'); expect(r.body.meal).toBe('breakfast')
    expect(r.body.entries).toEqual([
      { name: 'Scrambled egg', serving: '2 large', grams: 100, qty: 1, source: 'ai', confidence: 'medium', calories: 200, protein_g: 12.5, carbs_g: 1, fat_g: 14 },
      { name: 'Toast', serving: '1 slice', grams: null, qty: 1, source: 'ai', confidence: 'medium', calories: 80, protein_g: 3, carbs_g: 14, fat_g: 1 }
    ])
  })

  it('refuses to save an empty, unnamed or number-less draft, saying what to fix', () => {
    expect(draftToEntries([], { date: 'd', meal: 'lunch' }).ok).toBe(false)
    const rows = draftRows(draft)
    expect(draftToEntries([{ ...rows[0], name: ' ' }], { date: 'd', meal: 'lunch' }).error).toMatch(/Item 1 needs a name/)
    expect(draftToEntries([{ ...rows[0], calories: null }], { date: 'd', meal: 'lunch' }).error).toMatch(/needs calories/)
    expect(draftToEntries([{ ...rows[0], calories: NaN }], { date: 'd', meal: 'lunch' }).ok).toBe(false)
    expect(draftToEntries([{ ...rows[0], protein_g: -1 }], { date: 'd', meal: 'lunch' }).ok).toBe(false)
    expect(draftToEntries([{ ...rows[0], grams: -5 }], { date: 'd', meal: 'lunch' }).ok).toBe(false)
    expect(draftToEntries([{ ...blankRow(0), name: 'Water', calories: 0 }], { date: 'd', meal: 'lunch' }).ok).toBe(true)
  })

  it('knows when the person changed the estimate', () => {
    const rows = draftRows(draft)
    expect(edited(draft, rows)).toBe(false)
    expect(edited(draft, [{ ...rows[0], calories: 181 }, rows[1]])).toBe(true)
    expect(edited(draft, [rows[0]])).toBe(true)
  })

  it('every failure leaves a way forward, and manual entry is always one of them', () => {
    for (const code of ['cap', 'ai-off', 'unavailable', 'unprivileged', 'shared', 'missing', 'auth', 'busy', 'timeout', 'provider', 'unusable', 'client-timeout', 'something-new']) {
      expect(failureAdvice(code).manual, code).toBe(true)
    }
    expect(failureAdvice('cap').retry).toBe(false)
    expect(failureAdvice('auth').retry).toBe(false)
    expect(failureAdvice('timeout')).toEqual({ retry: true, describe: true, manual: true })
  })

  it('words the allowance and the reasons', () => {
    expect(allowanceText({ remaining: 27, limit: 30 })).toBe('27 of 30 AI analyses left today')
    expect(allowanceText(null)).toBe('')
    expect(unavailableText('off')).toMatch(/switched off by an admin/)
    expect(unavailableText('unavailable')).toMatch(/Coach/)
    expect(unavailableText('???')).toMatch(/not available/)
  })
})
