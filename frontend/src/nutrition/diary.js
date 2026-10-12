// Pure helpers behind the diary screens: dates, progress, form parsing. No React, no network —
// so they can be unit-tested, like everything else in lib/ that decides what a number means.

export const MEALS = ['breakfast', 'lunch', 'dinner', 'snack']
export const MEAL_LABEL = { breakfast: 'Breakfast', lunch: 'Lunch', dinner: 'Dinner', snack: 'Snacks' }
export const MACRO_KEYS = ['protein_g', 'carbs_g', 'fat_g']
export const MACRO_LABEL = { calories: 'Calories', protein_g: 'Protein', carbs_g: 'Carbs', fat_g: 'Fat' }
export const EMPTY_TOTALS = Object.freeze({ calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 })

const pad = n => String(n).padStart(2, '0')
export const isoOfDate = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())

/** The day `n` days from `iso`, as YYYY-MM-DD. Calendar arithmetic at noon, so DST never moves it. */
export function shiftISO(iso, n) {
  const d = new Date(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10), 12)
  d.setDate(d.getDate() + n)
  return isoOfDate(d)
}

export const validISO = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && isoOfDate(new Date(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10), 12)) === s

/** 'today' | 'yesterday' | 'tomorrow' | null — the day relative to `today`. */
export function relativeDay(iso, today) {
  if (iso === today) return 'today'
  if (iso === shiftISO(today, -1)) return 'yesterday'
  if (iso === shiftISO(today, 1)) return 'tomorrow'
  return null
}

/** The meal a new entry probably belongs to at this hour of the day. */
export function mealForHour(h) {
  return h < 10 ? 'breakfast' : h < 15 ? 'lunch' : h < 21 ? 'dinner' : 'snack'
}

/** value / goal as a fraction, or null when there is no goal. Not clamped: 1.2 means 20% over. */
export function fraction(value, goal) {
  return goal > 0 ? (value || 0) / goal : null
}

/** What is left of a goal; negative once over it. null when there is no goal. */
export const remaining = (value, goal) => (goal > 0 ? Math.round(((goal - (value || 0)) + Number.EPSILON) * 10) / 10 : null)

/** Share of calories from each macro (4/4/9 kcal per gram), as whole percent. Zeros when empty. */
export function macroSplit(t) {
  const p = (t.protein_g || 0) * 4, c = (t.carbs_g || 0) * 4, f = (t.fat_g || 0) * 9
  const sum = p + c + f
  if (!sum) return { protein_g: 0, carbs_g: 0, fat_g: 0 }
  return { protein_g: Math.round(p / sum * 100), carbs_g: Math.round(c / sum * 100), fat_g: Math.max(0, 100 - Math.round(p / sum * 100) - Math.round(c / sum * 100)) }
}

/** Calories the macros alone add up to. */
export const kcalFromMacros = t => Math.round(4 * (t.protein_g || 0) + 4 * (t.carbs_g || 0) + 9 * (t.fat_g || 0))

/** A food × servings, rounded the way the server rounds it. */
export function scaleFood(food, qty) {
  const q = Number.isFinite(qty) && qty > 0 ? qty : 1
  const r = (v, d) => { const k = 10 ** d; return Math.round(v * k) / k }
  return {
    calories: Math.round(food.per.calories * q),
    protein_g: r(food.per.protein_g * q, 1), carbs_g: r(food.per.carbs_g * q, 1), fat_g: r(food.per.fat_g * q, 1),
    grams: food.serving?.grams ? r(food.serving.grams * q, 1) : null
  }
}

/** A text box → number | null. Accepts "1,5"; anything that is not a finite number ≥ 0 is NaN. */
export function parseAmount(s) {
  if (s == null || String(s).trim() === '') return null
  const n = Number(String(s).trim().replace(',', '.'))
  return Number.isFinite(n) && n >= 0 ? n : NaN
}

/** Compact "P 24 · C 3 · F 1.5" line for a list row. */
export const macroLine = e => `P ${trim(e.protein_g)} · C ${trim(e.carbs_g)} · F ${trim(e.fat_g)}`
export const trim = n => (Math.round((n || 0) * 10) / 10).toString()

/**
 * Quick-add form → request body. calories required (a quick add is the number you know);
 * the macros default to 0. Returns { ok, body } or { ok:false, error } in plain words.
 */
export function quickBody({ name, meal, calories, protein_g, carbs_g, fat_g }, date) {
  const nums = { calories, protein_g, carbs_g, fat_g }
  for (const [k, v] of Object.entries(nums)) if (v != null && !(Number.isFinite(v) && v >= 0)) return { ok: false, error: `${MACRO_LABEL[k]} must be a number from 0 up` }
  if (calories == null) return { ok: false, error: 'Enter the calories' }
  return {
    ok: true,
    body: { date, meal, name: String(name || '').trim() || 'Quick add', source: 'quick', calories, protein_g: protein_g ?? 0, carbs_g: carbs_g ?? 0, fat_g: fat_g ?? 0 }
  }
}

/** Custom-food form → request body. */
export function foodBody({ name, brand, serving, grams, calories, protein_g, carbs_g, fat_g, ext }) {
  if (!String(name || '').trim()) return { ok: false, error: 'A food needs a name' }
  const nums = { calories, protein_g, carbs_g, fat_g }
  for (const [k, v] of Object.entries(nums)) if (v != null && !(Number.isFinite(v) && v >= 0)) return { ok: false, error: `${MACRO_LABEL[k]} must be a number from 0 up` }
  if (calories == null) return { ok: false, error: 'Enter the calories per serving' }
  if (grams != null && !(Number.isFinite(grams) && grams >= 0)) return { ok: false, error: 'Serving size must be a number' }
  return {
    ok: true,
    body: {
      name: String(name).trim(), brand: String(brand || '').trim(), serving: String(serving || '').trim() || '1 serving',
      grams: grams || null, ext: String(ext || '').trim() || null,
      per: { calories, protein_g: protein_g ?? 0, carbs_g: carbs_g ?? 0, fat_g: fat_g ?? 0 }
    }
  }
}

/** Goals form → request body (empty / 0 = no target). */
export function goalsBody(g) {
  for (const k of ['calories', ...MACRO_KEYS]) if (g[k] != null && !(Number.isFinite(g[k]) && g[k] >= 0)) return { ok: false, error: `${MACRO_LABEL[k]} must be a number from 0 up` }
  return { ok: true, body: { calories: g.calories || null, protein_g: g.protein_g || null, carbs_g: g.carbs_g || null, fat_g: g.fat_g || null } }
}
