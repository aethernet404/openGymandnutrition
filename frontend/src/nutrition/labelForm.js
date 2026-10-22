// What the server read from a label, turned into form values and request bodies. Pure. The server has already validated and mapped
// the label (api/nutrition/label.js); everything here is still shown to the person to check before anything is saved.
import { KEYS, cleanMicros, hasMicros, scaleMicros } from './micros.js'
import { foodBody } from './diary.js'

const r1 = v => Math.round(v * 10) / 10
export const LABEL_NOTE = 'Read from your photo of the label, please check.'

/** The column to start with: the first one that has any macros or micronutrients. */
export const defaultColumn = label => Math.max(0, (label?.columns || []).findIndex(c => Object.keys(c.per || {}).length || Object.keys(c.micros || {}).length))

/**
 * Form values for one column of a read label. Numbers the label did not print are null (unknown), never 0.
 * @returns {{ name, brand, serving, grams, servingsPerContainer, calories, protein_g, carbs_g, fat_g, micros, others, upc, flagged, rows, perServing, note }}
 */
export function formOf(label, columnId = defaultColumn(label)) {
  const c = label.columns?.[columnId] || { per: {}, micros: {}, others: [], rows: [], flags: [] }
  const flagged = new Set()
  for (const r of c.rows || []) if (r.flag && r.key) flagged.add(r.key)
  const kind = label.kind || null
  return {
    name: label.name || '', brand: label.brand || '', serving: label.servingText || '', grams: c.grams ?? label.servingGrams ?? null,
    servingsPerContainer: label.servingsPerContainer ?? null,
    calories: c.per.calories ?? null, protein_g: c.per.protein_g ?? null, carbs_g: c.per.carbs_g ?? null, fat_g: c.per.fat_g ?? null,
    micros: { ...(c.micros || {}) }, others: (c.others || []).map(o => ({ ...o })), upc: label.upc || '', kind,
    flagged, rows: (c.rows || []).filter(r => r.flag), flags: [...(label.flags || []), ...(c.flags || [])], perServing: c.perServing !== false, note: c.note || '',
    otherIngredientsText: label.otherIngredientsText || ''
  }
}

/** Rows the reader could not read well, or that did not fit, for the "check these" list. */
export const rowsToCheck = form => form.rows.map(r => ({ name: r.name, flag: r.flag, key: r.key, amount: r.amount, unit: r.unit }))

/**
 * The body for POST /foods (a saved food or supplement from this label): origin 'label', the barcode, the other ingredients.
 * `supplement`: calories default to 0 (a supplement label often prints none) and the type is 'supplement'.
 */
export function savedBody(form, { supplement = false, choice = null } = {}) {
  const r = foodBody({
    name: form.name, brand: form.brand, serving: form.serving, grams: form.grams, calories: form.calories ?? (supplement ? 0 : null),
    protein_g: form.protein_g, carbs_g: form.carbs_g, fat_g: form.fat_g, micros: cleanMicros(form.micros)
  })
  if (!r.ok) return r
  const { ext: _e, ...body } = r.body
  if (!hasMicros(body.micros)) delete body.micros
  const upc = String(form.upc || '').replace(/\D/g, '')
  return { ok: true, body: {
    ...body, origin: 'label', ...(supplement ? { type: 'supplement' } : {}), ...(upc.length >= 8 && upc.length <= 14 ? { upc } : {}),
    ...(form.others?.length ? { otherIngredients: form.others.map(o => ({ name: o.name, amount: o.amount ?? null, unit: o.unit || '' })) } : {}),
    checkDuplicate: true, ...(choice ? { onDuplicate: choice } : {})
  } }
}

/** The body to LOG this label without saving it as a food: whole-entry numbers for `qty` servings, marked as label data. */
export function logBody(form, { date, meal, qty, supplement = false }) {
  const per = { calories: form.calories ?? 0, protein_g: form.protein_g ?? 0, carbs_g: form.carbs_g ?? 0, fat_g: form.fat_g ?? 0 }
  const micros = cleanMicros(form.micros)
  const name = String(form.name || '').trim()
  if (!name) return { ok: false, error: 'A food needs a name' }
  return { ok: true, body: {
    date, meal, name, brand: form.brand || '', serving: form.serving || '', qty, source: supplement ? 'supplement' : 'manual',
    grams: form.grams ? r1(form.grams * qty) : null,
    calories: Math.round(per.calories * qty), protein_g: r1(per.protein_g * qty), carbs_g: r1(per.carbs_g * qty), fat_g: r1(per.fat_g * qty),
    ...(hasMicros(micros) ? { micros: scaleMicros(micros, qty), microsSource: 'label' } : {}),
    base: { ...per, grams: form.grams || null, ...(hasMicros(micros) ? { micros } : {}) }
  } }
}

/** Whole-entry micronutrients for `qty` servings of this label (what POST /micros/label takes). */
export const entryMicros = (form, qty) => scaleMicros(cleanMicros(form.micros), qty)

/** The nutrients an entry has already that this label also gives a DIFFERENT number for: each one needs the person's yes to be replaced. */
export function conflicts(existing, incoming) {
  return KEYS.filter(k => existing?.[k] != null && incoming?.[k] != null && Math.abs(existing[k] - incoming[k]) > 1e-9)
}

/** A DSLD / saved-supplement / database hit as form values (so a barcode hit goes through the same review). */
export function formOfHit(hit) {
  const b = hit.bases?.[0] || { per: {}, micros: {} }
  return {
    name: hit.name || '', brand: hit.brand || '', serving: b.label || '', grams: b.grams ?? null, servingsPerContainer: hit.servingsPerContainer ?? null,
    calories: b.per?.calories ?? null, protein_g: b.per?.protein_g ?? null, carbs_g: b.per?.carbs_g ?? null, fat_g: b.per?.fat_g ?? null,
    micros: { ...(b.micros || {}) }, others: (hit.otherIngredients || []).map(o => ({ ...o })), upc: hit.upc || '', kind: hit.kind || null,
    flagged: new Set(), rows: [], flags: [], perServing: true, note: '', otherIngredientsText: hit.otherIngredientsText || ''
  }
}
