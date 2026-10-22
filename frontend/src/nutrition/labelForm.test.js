import { describe, expect, it, vi } from 'vitest'
import { MAX_PHOTOS, TOTAL_MAX_BYTES, addPhotos, isHeic, removePhoto, totalBytes } from './labelPhotos.js'
import { conflicts, defaultColumn, entryMicros, formOf, formOfHit, logBody, savedBody } from './labelForm.js'

const file = (name, type = 'image/jpeg') => ({ name, type })
const shrinkTo = sizes => vi.fn(async (f, o) => ({ base64: 'x', bytes: typeof sizes === 'function' ? sizes(f, o) : sizes, width: o.maxEdge, height: o.maxEdge, previewUrl: 'blob:' + f.name + o.maxEdge }))

describe('label photos', () => {
  it('several files at once are shrunk and added (camera and library use the same path); thumbnails can be removed', async () => {
    const shrink = shrinkTo(300000)
    const r = await addPhotos([], [file('a.jpg'), file('b.jpg'), file('c.jpg')], { shrink })
    expect(r.photos.map(p => p.name)).toEqual(['a.jpg', 'b.jpg', 'c.jpg'])
    expect(r.problems).toEqual([]); expect(r.tooBig).toBe(false)
    expect(shrink).toHaveBeenCalledWith(expect.anything(), { maxEdge: 1280, quality: 0.82, maxBytes: expect.any(Number) })
    const more = await addPhotos(r.photos, [file('d.jpg')], { shrink })
    expect(more.photos).toHaveLength(4)
    const revoke = vi.fn()
    const left = removePhoto(more.photos, 1, revoke)
    expect(left.map(p => p.name)).toEqual(['a.jpg', 'c.jpg', 'd.jpg']); expect(revoke).toHaveBeenCalledWith('blob:b.jpg1280')
  })

  it('at most 4 photos; the extra ones are left out and it says so', async () => {
    const r = await addPhotos([], Array.from({ length: 6 }, (_, i) => file(i + '.jpg')), { shrink: shrinkTo(100000) })
    expect(r.photos).toHaveLength(MAX_PHOTOS)
    expect(r.problems[0]).toMatch(/Only 4 photos can be read at once; 2 left out/)
    const full = await addPhotos(r.photos, [file('x.jpg')], { shrink: shrinkTo(1) })
    expect(full.photos).toHaveLength(4); expect(full.problems[0]).toMatch(/Remove one first/)
  })

  it('the total cap: too big together → every photo is shrunk harder from its original; if it still does not fit it says so and flags it', async () => {
    const calls = []
    const shrink = vi.fn(async (f, o) => { calls.push(o.maxEdge); return { base64: 'x', bytes: o.maxEdge >= 1280 ? 1000000 : o.maxEdge >= 1100 ? 800000 : 600000, previewUrl: 'u' + o.maxEdge } })
    const r = await addPhotos([], [file('a.jpg'), file('b.jpg'), file('c.jpg'), file('d.jpg')], { shrink, revoke: () => {} })
    expect(totalBytes(r.photos)).toBeLessThanOrEqual(TOTAL_MAX_BYTES)           // 4 × 800 000 = 3.2 MB after one harder pass
    expect(r.tooBig).toBe(false); expect(calls).toContain(1100)
    const huge = await addPhotos([], [file('a.jpg'), file('b.jpg'), file('c.jpg'), file('d.jpg')], { shrink: shrinkTo(1400000), revoke: () => {} })
    expect(huge.tooBig).toBe(true); expect(huge.problems.at(-1)).toMatch(/too large to send together/)
  })

  it('HEIC that the browser cannot open gets a plain message and the rest still load; other failures name the file', async () => {
    const shrink = vi.fn(async f => { if (/heic|heif/i.test(f.name + f.type)) throw new Error('decode'); if (f.name === 'bad.png') throw new Error('Could not read this photo. Try a JPEG or PNG.'); return { base64: 'x', bytes: 1000, previewUrl: 'u' } })
    const r = await addPhotos([], [file('IMG_1.HEIC', 'image/heic'), file('ok.jpg'), file('bad.png', 'image/png'), file('noext', 'image/heif')], { shrink })
    expect(r.photos.map(p => p.name)).toEqual(['ok.jpg'])
    expect(r.problems[0]).toMatch(/IMG_1\.HEIC.*HEIC photo.*Most Compatible/)
    expect(r.problems[1]).toMatch(/bad\.png.*Could not read this photo/)
    expect(r.problems[2]).toMatch(/noext.*HEIC/)
    expect(isHeic(file('a.heif'))).toBe(true); expect(isHeic(file('a.jpg', 'image/jpeg'))).toBe(false)
  })
})

const LABEL = {
  isLabel: true, name: 'Daily Multi', brand: 'Brightwell', servingText: '2 capsules', servingGrams: null, servingsPerContainer: 30, upc: '012345678905', kind: 'supplement', flags: [{ code: 'columns', text: 'x' }], otherIngredientsText: 'Gelatin',
  columns: [
    { id: 0, heading: 'Per serving', perServing: true, grams: null, per: { calories: 5 }, micros: { vit_c_mg: 90, vit_d_mcg: 25 }, others: [{ name: 'Creatine', amount: 3, unit: 'g' }], rows: [{ name: 'Zinc', key: 'zinc_mg', flag: 'unreadable', amount: null, unit: 'mg' }, { name: 'Vitamin C', key: 'vit_c_mg', flag: null }], flags: [] },
    { id: 1, heading: 'As prepared', perServing: true, grams: 50, per: {}, micros: {}, others: [], rows: [], flags: [] }]
}

describe('from a read label to form values and bodies', () => {
  it('form values: unknown stays null (never 0), unreadable rows are flagged, the other column is available', () => {
    const f = formOf(LABEL)
    expect([f.name, f.brand, f.serving, f.calories, f.protein_g, f.upc, f.servingsPerContainer]).toEqual(['Daily Multi', 'Brightwell', '2 capsules', 5, null, '012345678905', 30])
    expect([...f.flagged]).toEqual(['zinc_mg']); expect(f.rows.map(r => r.name)).toEqual(['Zinc'])
    expect(f.micros).toEqual({ vit_c_mg: 90, vit_d_mcg: 25 }); expect(f.others[0].name).toBe('Creatine')
    expect(formOf(LABEL, 1).grams).toBe(50); expect(defaultColumn(LABEL)).toBe(0)
  })

  it('a saved supplement: origin label, type supplement, barcode and other ingredients ride along, calories default to 0; a food needs calories', () => {
    const s = savedBody({ ...formOf(LABEL), calories: null }, { supplement: true })
    expect(s.ok).toBe(true)
    expect(s.body).toMatchObject({ name: 'Daily Multi', brand: 'Brightwell', serving: '2 capsules', origin: 'label', type: 'supplement', upc: '012345678905', checkDuplicate: true, per: { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 }, micros: { vit_c_mg: 90, vit_d_mcg: 25 }, otherIngredients: [{ name: 'Creatine', amount: 3, unit: 'g' }] })
    expect(savedBody({ ...formOf(LABEL), calories: null }).ok).toBe(false)
    expect('type' in savedBody(formOf(LABEL)).body).toBe(false)
    expect(savedBody({ ...formOf(LABEL), upc: '12' }, { supplement: true }).body.upc).toBeUndefined()
    expect(savedBody(formOf(LABEL), { supplement: true, choice: 'update' }).body.onDuplicate).toBe('update')
  })

  it('logging without saving: whole-entry numbers for the servings, label data marked, base kept', () => {
    const r = logBody({ ...formOf(LABEL), calories: 200, protein_g: 4, carbs_g: 30, fat_g: 7, grams: 40 }, { date: '2026-10-12', meal: 'snack', qty: 2 })
    expect(r.body).toMatchObject({ name: 'Daily Multi', qty: 2, source: 'manual', calories: 400, protein_g: 8, carbs_g: 60, fat_g: 14, grams: 80, microsSource: 'label', micros: { vit_c_mg: 180, vit_d_mcg: 50 }, base: { calories: 200, grams: 40 } })
    expect(logBody(formOf(LABEL), { date: 'd', meal: 'supplements', qty: 1, supplement: true }).body.source).toBe('supplement')
    expect(logBody({ ...formOf(LABEL), name: ' ' }, { date: 'd', meal: 'm', qty: 1 }).ok).toBe(false)
    expect(entryMicros(formOf(LABEL), 1.5)).toEqual({ vit_c_mg: 135, vit_d_mcg: 37.5 })
  })

  it('nutrients an entry already has that the label gives a different number for need a yes; equal ones do not', () => {
    expect(conflicts({ iron_mg: 1, zinc_mg: 5, sodium_mg: 100 }, { iron_mg: 2, zinc_mg: 5, calcium_mg: 9 })).toEqual(['iron_mg'])
    expect(conflicts({}, { iron_mg: 2 })).toEqual([])
  })

  it('a database hit (DSLD, a saved supplement) goes through the same form', () => {
    const f = formOfHit({ name: 'X', brand: 'Y', upc: '012345678905', kind: 'supplement', otherIngredients: [{ name: 'C', amount: 1, unit: 'g' }], bases: [{ label: '1 tablet', grams: null, per: { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 }, micros: { iron_mg: 18 } }] })
    expect([f.name, f.serving, f.micros, f.others.length, f.upc]).toEqual(['X', '1 tablet', { iron_mg: 18 }, 1, '012345678905'])
  })
})
