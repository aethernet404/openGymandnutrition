import { describe, expect, it } from 'vitest'
import { barcodeOf, snapshotOf, defaultBase, gramsOf, qtyForGrams, sourceNotes, hitLine } from './lookup.js'

const hit = { source: 'off', ext: '301', name: 'Nutella', brand: 'Ferrero', bases: [
  { label: '15 g', grams: 15, per: { calories: 81, protein_g: 0.9, carbs_g: 8.6, fat_g: 4.6 } },
  { label: '100 g', grams: 100, per: { calories: 539, protein_g: 6.3, carbs_g: 57.5, fat_g: 30.9 } }
] }

describe('lookup helpers', () => {
  it('barcodeOf accepts 8–14 digits and ignores spaces and dashes', () => {
    expect(barcodeOf(' 3017 6204-22003 ')).toBe('3017620422003')
    for (const bad of ['', '1234567', '123456789012345', 'abc12345678', null]) expect(barcodeOf(bad)).toBe(null)
  })
  it('snapshotOf carries exactly what the server keeps as a recent', () => {
    expect(snapshotOf(hit, hit.bases[1])).toEqual({ name: 'Nutella', brand: 'Ferrero', source: 'off', ext: '301', serving: '100 g', grams: 100, per: hit.bases[1].per })
    expect(snapshotOf({ ...hit, brand: undefined }, { label: '1 pot', per: hit.bases[0].per }).grams).toBe(null)
  })
  it('defaults to the label serving, and converts servings and grams both ways', () => {
    expect(defaultBase(hit).label).toBe('15 g')
    expect(gramsOf(hit.bases[0], 2)).toBe(30)
    expect(gramsOf({ label: '1 pot', grams: null }, 2)).toBe(null)
    expect(qtyForGrams(hit.bases[1], 150)).toBe(1.5)
    expect(qtyForGrams(hit.bases[0], 20)).toBe(1.333)
    expect(qtyForGrams(hit.bases[1], 0)).toBe(null)
    expect(qtyForGrams(hit.bases[1], NaN)).toBe(null)
    expect(qtyForGrams({ label: 'x', grams: null }, 10)).toBe(null)
  })
  it('says plainly when USDA is off, with the fix only for an admin', () => {
    const s = { off: { ok: true, count: 3 }, usda: { ok: false, skipped: 'no-key' } }
    expect(sourceNotes(s)).toEqual([{ tone: 'info', text: expect.stringContaining('an admin has not added a key') }])
    expect(sourceNotes(s, { admin: true })[0].text).toContain('Goals → Admin')
  })
  it('reports a failing source in its own words and offers a retry', () => {
    const notes = sourceNotes({ off: { ok: false, kind: 'timeout', error: 'Open Food Facts did not answer in time' }, usda: { ok: true, count: 2 } })
    expect(notes).toEqual([{ tone: 'warn', text: 'Open Food Facts did not answer in time', retry: true, kind: 'timeout' }])
    expect(sourceNotes(null)).toEqual([])
    expect(sourceNotes({ off: { ok: true } })).toEqual([])
  })
  it('hitLine joins brand and portion without stray separators', () => {
    expect(hitLine(hit)).toBe('Ferrero · 15 g')
    expect(hitLine({ ...hit, brand: '' })).toBe('15 g')
  })
})
