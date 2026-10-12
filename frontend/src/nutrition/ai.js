// Pure helpers behind AI logging: the editable draft, what may be saved, how a failure is
// explained. The model's answer is only ever a DRAFT; draftToEntries is the gate between what it
// said and what the diary stores, and it applies the same rules the server will.

export const CONFIDENCE_LABEL = { low: 'Low confidence', medium: 'Medium confidence', high: 'High confidence' }

/** Server draft → editable rows (numbers stay numbers; the form edits these). */
export function draftRows(draft) {
  return (draft.items || []).map((it, i) => ({
    key: i, name: it.name, portion: it.portion || '', grams: it.grams ?? null,
    calories: it.calories, protein_g: it.protein_g, carbs_g: it.carbs_g, fat_g: it.fat_g
  }))
}

export const blankRow = key => ({ key, name: '', portion: '', grams: null, calories: null, protein_g: null, carbs_g: null, fat_g: null })

const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
export function rowsTotals(rows) {
  const t = { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 }
  for (const r of rows) for (const k of Object.keys(t)) t[k] += num(r[k])
  t.calories = Math.round(t.calories)
  for (const k of ['protein_g', 'carbs_g', 'fat_g']) t[k] = Math.round(t[k] * 10) / 10
  return t
}

/**
 * Edited rows → the POST /entries body, or the first problem in words. Nothing is sent from
 * here: the caller sends it only when the person presses Save.
 */
export function draftToEntries(rows, { date, meal, confidence }) {
  if (!rows.length) return { ok: false, error: 'There is nothing to save.' }
  const entries = []
  for (const [i, r] of rows.entries()) {
    const label = r.name?.trim() || `Item ${i + 1}`
    if (!r.name?.trim()) return { ok: false, error: `Item ${i + 1} needs a name.` }
    if (!(Number.isFinite(r.calories) && r.calories >= 0)) return { ok: false, error: `${label} needs calories (0 is fine).` }
    for (const k of ['protein_g', 'carbs_g', 'fat_g']) if (r[k] != null && !(Number.isFinite(r[k]) && r[k] >= 0)) return { ok: false, error: `${label}: check the ${k.replace('_g', '')}.` }
    if (r.grams != null && !(Number.isFinite(r.grams) && r.grams >= 0)) return { ok: false, error: `${label}: check the weight.` }
    entries.push({
      name: r.name.trim(), serving: (r.portion || '').trim(), grams: r.grams || null, qty: 1, source: 'ai',
      ...(confidence ? { confidence } : {}),
      calories: r.calories, protein_g: r.protein_g ?? 0, carbs_g: r.carbs_g ?? 0, fat_g: r.fat_g ?? 0
    })
  }
  return { ok: true, body: { date, meal, entries } }
}

/** True when the person changed anything the model said. */
export function edited(draft, rows) {
  const base = draftRows(draft)
  if (base.length !== rows.length) return true
  return base.some((b, i) => ['name', 'portion', 'grams', 'calories', 'protein_g', 'carbs_g', 'fat_g'].some(k => (b[k] ?? null) !== (rows[i][k] ?? null)))
}

/** What the screen offers after a failure, by the server's code. */
export function failureAdvice(code) {
  switch (code) {
    case 'cap': return { retry: false, describe: false, manual: true }
    case 'ai-off': case 'unavailable': case 'unprivileged': case 'shared': case 'missing': return { retry: false, describe: false, manual: true }
    case 'auth': return { retry: false, describe: false, manual: true }
    case 'busy': return { retry: true, describe: false, manual: true }
    case 'timeout': case 'provider': case 'unusable': case 'client-timeout': return { retry: true, describe: true, manual: true }
    default: return { retry: true, describe: false, manual: true }
  }
}

/** Why the AI buttons are off, in a sentence (from /config's ai.reason). */
export function unavailableText(reason) {
  return {
    off: 'AI logging is switched off by an admin.',
    unavailable: 'AI logging needs the Coach switched on and connected to Claude (Admin → Coach).',
    shared: 'The Claude account on this server belongs to another profile.',
    unprivileged: 'AI logging is switched off on this server for safety reasons.'
  }[reason] || 'AI logging is not available right now.'
}

export const allowanceText = ai => (ai ? `${ai.remaining} of ${ai.limit} AI analyses left today` : '')
