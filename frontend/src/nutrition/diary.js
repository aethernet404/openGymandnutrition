// Pure helpers behind the diary screens: dates, progress, form parsing. No React, no network —
// so they can be unit-tested, like everything else in lib/ that decides what a number means.

import { cleanMicros, hasMicros, scaleMicros } from './micros.js'

export const MEALS = ['breakfast', 'lunch', 'dinner', 'snack']
export const MEAL_LABEL = { breakfast: 'Breakfast', lunch: 'Lunch', dinner: 'Dinner', snack: 'Snacks', supplements: 'Vitamins & supplements' }
// The supplements section is a meal of its own for entries, but not one you can pick for food (MEALS stays food only).
export const SUPPLEMENTS = 'supplements'
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
export function foodBody({ name, brand, serving, grams, calories, protein_g, carbs_g, fat_g, ext, micros }) {
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
      per: { calories, protein_g: protein_g ?? 0, carbs_g: carbs_g ?? 0, fat_g: fat_g ?? 0 },
      // Micronutrients for one serving: only the ones filled in (given as `micros`; an empty object clears them on an edit).
      ...(micros !== undefined ? { micros: cleanMicros(micros) } : {})
    }
  }
}

/** Goals form → request body (empty / 0 = no target). */
export function goalsBody(g) {
  for (const k of ['calories', ...MACRO_KEYS]) if (g[k] != null && !(Number.isFinite(g[k]) && g[k] >= 0)) return { ok: false, error: `${MACRO_LABEL[k]} must be a number from 0 up` }
  return { ok: true, body: { calories: g.calories || null, protein_g: g.protein_g || null, carbs_g: g.carbs_g || null, fat_g: g.fat_g || null } }
}

/* ---------- Apple Health: burned, net, and the optional "eat back" ---------- */

/** Active + resting energy for a day (kcal, whole), or null when no numbers came in. */
export const burnedOf = h => (h && Number.isFinite(h.active_kcal) && Number.isFinite(h.resting_kcal) ? Math.round(h.active_kcal + h.resting_kcal) : null)

/** Eaten minus burned. Negative means more went out than came in. null without Health numbers. */
export function netOf(eaten, h) {
  const burned = burnedOf(h)
  return burned == null ? null : Math.round(eaten || 0) - burned
}

/**
 * The calorie goal for a day, with "eat back" applied when the person turned it on: their goal plus
 * a percentage of the day's ACTIVE calories (not resting). Off, or no Health numbers for the day,
 * leaves the goal exactly as set.
 * @returns {{ goal:number|null, extra:number, applied:boolean }}
 */
export function goalWithEatBack(goal, h, eatBack) {
  if (!(goal > 0)) return { goal: null, extra: 0, applied: false }
  if (!eatBack?.enabled || !h || !Number.isFinite(h.active_kcal)) return { goal, extra: 0, applied: false }
  const extra = Math.round(h.active_kcal * (eatBack.percent ?? 0) / 100)
  return { goal: goal + extra, extra, applied: extra > 0 }
}

/** "+120" / "−890" / "0": the sign is always shown, with a real minus. */
export const signed = n => (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n).toLocaleString()

/** When the numbers last arrived: a time for today, a date and time otherwise. */
export function updatedText(ts, now = Date.now(), locale) {
  if (!Number.isFinite(ts)) return ''
  const t = new Date(ts)
  const same = new Date(now).toDateString() === t.toDateString()
  const time = t.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
  return same ? time : t.toLocaleDateString(locale, { day: 'numeric', month: 'short' }) + ', ' + time
}

/* ---------- Health Auto Export extras: workouts, exercise minutes, body weight (display only) ---------- */

const KG_PER_LB = 0.45359237
const KM_PER_MI = 1.609344
const dec1 = n => (Math.round(n * 10) / 10).toString()

/** A kilogram figure in the profile's weight unit ('kg' or 'lb'), one decimal, as a number. */
export const kgToUnit = (kg, unit) => Math.round((unit === 'lb' ? kg / KG_PER_LB : kg) * 10) / 10
export const weightText = (kg, unit) => (Number.isFinite(kg) ? `${dec1(kgToUnit(kg, unit))} ${unit === 'lb' ? 'lb' : 'kg'}` : '')

/**
 * One workout as a line: "Strength Training, 45 min, 320 kcal" (+ ", 5.2 km" when there is a distance; miles
 * when the profile counts in pounds). A workout without calories simply has no calories part. These calories
 * are display only: they are already inside Active Energy and are never added to Burned or Net.
 */
export function workoutLine(w, unit = 'kg') {
  const parts = [w.name, `${w.duration_min} min`]
  if (Number.isFinite(w.kcal)) parts.push(`${Math.round(w.kcal)} kcal`)
  if (Number.isFinite(w.km) && w.km > 0) parts.push(unit === 'lb' ? `${dec1(w.km / KM_PER_MI)} mi` : `${dec1(w.km)} km`)
  return parts.join(', ')
}

/** Readings (kg, any order) → the points to draw, in the profile's unit, and the change over them. */
export function weightTrend(readings, unit = 'kg') {
  const pts = (readings || []).filter(r => r && Number.isFinite(r.kg)).sort((a, b) => (a.date < b.date ? -1 : 1)).map(r => ({ date: r.date, v: kgToUnit(r.kg, unit) }))
  const change = pts.length >= 2 ? Math.round((pts.at(-1).v - pts[0].v) * 10) / 10 : null
  return { points: pts, change }
}

/** An SVG path for a small line chart of `values` in a w × h box (null for fewer than two values). */
export function sparkPath(values, w = 120, h = 32, pad = 3) {
  if (!values || values.length < 2) return null
  const lo = Math.min(...values), hi = Math.max(...values), span = hi - lo || 1
  return values.map((v, i) => `${i ? 'L' : 'M'}${(pad + (w - 2 * pad) * i / (values.length - 1)).toFixed(1)} ${(h - pad - (h - 2 * pad) * (v - lo) / span).toFixed(1)}`).join(' ')
}

/* ---------- changing the amount of an entry already in the diary ---------- */

const MACRO_ROUND = { calories: 0, protein_g: 1, carbs_g: 1, fat_g: 1 }
const cleanNum = v => (Number.isFinite(v) && v >= 0 ? v : 0)

/**
 * What one unit of an entry (one serving, or for an entry with no food behind it, the portion as logged) is
 * worth. A saved entry carries it as `base`; an older one, or one from AI logging or Quick add, has none, so it
 * is worked out from the totals ÷ qty (qty 1 when absent). From here on the base never changes, so any number
 * of amount edits is always base × amount and rounding cannot build up.
 * @returns {{ per:{calories,protein_g,carbs_g,fat_g}, gramsPer:number|null, qty:number }}
 */
export function entryBase(e) {
  const qty = Number.isFinite(e.qty) && e.qty > 0 ? e.qty : 1
  const b = e.base
  if (b && Number.isFinite(b.calories)) {
    return { per: { calories: cleanNum(b.calories), protein_g: cleanNum(b.protein_g), carbs_g: cleanNum(b.carbs_g), fat_g: cleanNum(b.fat_g) }, gramsPer: b.grams > 0 ? b.grams : null, qty, micros: cleanMicros(b.micros) }
  }
  const per = {}
  for (const k of MACRO_KEYS_ALL) per[k] = Math.round(cleanNum(e[k]) / qty * 1000) / 1000
  // Micronutrients per unit, only the ones the entry knows (no micros → none; never zeros).
  return { per, gramsPer: e.grams > 0 ? Math.round(e.grams / qty * 100) / 100 : null, qty, micros: scaleMicros(cleanMicros(e.micros), 1 / qty) }
}
const MACRO_KEYS_ALL = ['calories', 'protein_g', 'carbs_g', 'fat_g']

/**
 * The numbers for `qty` units of a base. Keys in `manual` (a value the person typed) are left exactly as they
 * are in `current`; the others follow the amount.
 */
export function scaleEntry(base, qty, current = {}, manual = {}) {
  const out = {}
  for (const k of MACRO_KEYS_ALL) {
    if (manual[k] && current[k] !== undefined) { out[k] = current[k]; continue }
    const k10 = 10 ** MACRO_ROUND[k]
    out[k] = Math.round(base.per[k] * qty * k10) / k10
  }
  return out
}

/** Grams for an amount, one decimal; null when the entry has no weight. */
export const gramsForQty = (base, qty) => (base.gramsPer ? Math.round(base.gramsPer * qty * 10) / 10 : null)
/** Amount for a weight, two decimals (what the server keeps); null when there is no weight or the weight is not a positive number. */
export const qtyForGramsOf = (base, g) => (base.gramsPer && Number.isFinite(g) && g > 0 ? Math.round(g / base.gramsPer * 100) / 100 || null : null)

/** The fields to send when the amount changed: the amount, the weight, and the unchanging base (stored with the entry). */
export function amountPatch(base, qty) {
  const g = gramsForQty(base, qty)
  const mi = scaleMicros(base.micros, qty)
  return { qty, ...(g != null ? { grams: g } : {}), ...(hasMicros(mi) ? { micros: mi } : {}), base: { ...base.per, grams: base.gramsPer, ...(hasMicros(base.micros) ? { micros: base.micros } : {}) } }
}

/* ---------- saving an estimate or an entry as a reusable food ---------- */

const normName = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim()

/** Is there already a saved food with this name and brand (ignoring case and extra spaces)? Returns it or null. */
export const findDuplicate = (foods, name, brand = '') => (foods || []).find(f => (f.source ?? 'custom') === 'custom' && normName(f.name) === normName(name) && normName(f.brand) === normName(brand)) || null

/**
 * The saved food an existing entry stands for, per ONE serving: the entry's stored base (or totals ÷ amount for an
 * older entry or one from AI / Quick add), never its totals — an entry logged as 2 × a can is a can's numbers, not
 * two cans'. The serving label and weight are the entry's own; origin is 'ai' for an AI estimate.
 */
export function foodFromEntry(entry) {
  const base = entryBase(entry)
  const r1 = n => Math.round(n * 10) / 10
  return {
    name: String(entry.name || '').trim(), brand: String(entry.brand || '').trim(),
    serving: String(entry.serving || '').trim(), grams: base.gramsPer != null ? r1(base.gramsPer) : null,
    calories: Math.round(base.per.calories), protein_g: r1(base.per.protein_g), carbs_g: r1(base.per.carbs_g), fat_g: r1(base.per.fat_g),
    ...(hasMicros(base.micros) ? { micros: base.micros } : {}),
    ...(entry.meal === SUPPLEMENTS ? { type: 'supplement' } : {}),
    origin: entry.source === 'ai' ? 'ai' : null
  }
}

/**
 * The form of a food to save → the POST /foods body, or the first problem in words. Only the name and numbers the
 * person confirmed go anywhere: no photo, no note, no model text.
 */
export function savedFoodBody(f, { origin = f.origin, choice = null } = {}) {
  const r = foodBody(f)
  if (!r.ok) return r
  const { ext: _e, ...body } = r.body
  return { ok: true, body: { ...body, ...(f.type ? { type: f.type } : {}), ...(origin ? { origin } : {}), checkDuplicate: true, ...(choice ? { onDuplicate: choice } : {}) } }   // micros ride along inside body when the form had any
}

/**
 * What an AI review row would be saved as: the row's own values until the person edits the saved copy, so the saved
 * name, serving and numbers can differ from what is logged without ever changing what is logged.
 */
export function savedFields(row, over = {}) {
  const pick = (k, fallback) => (over[k] !== undefined ? over[k] : fallback)
  return {
    name: pick('name', row.name || ''), brand: pick('brand', ''), serving: pick('serving', row.portion || ''), grams: pick('grams', row.grams ?? null),
    calories: pick('calories', row.calories), protein_g: pick('protein_g', row.protein_g), carbs_g: pick('carbs_g', row.carbs_g), fat_g: pick('fat_g', row.fat_g),
    origin: 'ai'
  }
}
/** The overrides after the form changed from `eff` to `next`: only what actually differs from the row. */
export function savedOverrides(over, eff, next) {
  const out = { ...over }
  for (const k of ['name', 'brand', 'serving', 'grams', 'calories', 'protein_g', 'carbs_g', 'fat_g']) if (next[k] !== eff[k]) out[k] = next[k]
  return out
}

/* ---------- per-meal macros that add up to the day ---------- */

/**
 * Round each part to a multiple of `step` so that the rounded parts add up to `target` exactly (largest remainder:
 * the units left over after rounding down go to the parts with the biggest fractional parts). `target` is the day's
 * total, already rounded the way the server rounds it. When the parts do not really add up to the target (a day that
 * changed under us, a mocked answer) each part is simply rounded on its own.
 */
export function splitToTotal(parts, target, step) {
  const q = 1e6
  const units = parts.map(p => Math.round((p / step) * q) / q)
  const own = units.map(u => Math.round(u))
  const goal = Math.round(target / step)
  if (Math.abs(units.reduce((a, b) => a + b, 0) - goal) > 0.5 + 1e-6) return own.map(u => Math.round(u * step * 1e6) / 1e6)
  const floors = units.map(Math.floor)
  let left = goal - floors.reduce((a, b) => a + b, 0)
  const order = units.map((u, i) => [u - floors[i], i]).sort((a, b) => b[0] - a[0] || a[1] - b[1])
  const out = [...floors]
  for (const [, i] of order) { if (left <= 0) break; out[i]++; left-- }
  return out.map(u => Math.round(u * step * 1e6) / 1e6)
}

/**
 * { breakfast, lunch, dinner, snack, supplements } → { calories, protein_g, carbs_g, fat_g }, summed from the entries and
 * rounded so that the meals add up to the day's totals (calories to whole numbers, grams to 0.1).
 */
export function mealBreakdown(entries, totals, meals = [...MEALS, 'supplements']) {
  const out = {}
  const sums = meals.map(m => { const t = { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 }; for (const e of entries.filter(x => x.meal === m)) for (const k of Object.keys(t)) t[k] += e[k] || 0; return t })
  const stray = Object.fromEntries(Object.keys(sums[0] || {}).map(k => [k, entries.filter(e => !meals.includes(e.meal)).reduce((a, e) => a + (e[k] || 0), 0)]))
  for (const k of ['calories', 'protein_g', 'carbs_g', 'fat_g']) {
    const step = k === 'calories' ? 1 : 0.1
    // An entry of an unknown meal still counts in the day; it is a part of its own so the rest adds up.
    const parts = [...sums.map(s => s[k]), stray[k] || 0]
    const split = splitToTotal(parts, totals?.[k] ?? parts.reduce((a, b) => a + b, 0), step)
    meals.forEach((m, i) => { (out[m] ||= {})[k] = split[i] })
  }
  return out
}

const KCAL_PER_G = { protein_g: 4, carbs_g: 4, fat_g: 9 }
/**
 * Each macro's share of the meal's calories (whole percent) and the proportion bar's segments. Shares are of the calories
 * the meal states; when entries have calories but not all of their macros the three do not reach 100 %, and `partial`
 * says so rather than pretending. No calories → no shares.
 */
export function macroShares(m) {
  const cal = m?.calories || 0
  const kcal = Object.fromEntries(Object.entries(KCAL_PER_G).map(([k, f]) => [k, (m?.[k] || 0) * f]))
  const used = kcal.protein_g + kcal.carbs_g + kcal.fat_g
  if (!(cal > 0)) return { pct: { protein_g: null, carbs_g: null, fat_g: null }, bar: [], partial: false }
  const whole = Math.max(cal, used)                         // a bar never overflows when macros imply more than the stated calories
  return {
    pct: Object.fromEntries(Object.keys(kcal).map(k => [k, Math.round(kcal[k] / cal * 100)])),
    bar: Object.keys(kcal).map(k => ({ key: k, width: kcal[k] / whole * 100 })),
    partial: used < cal * 0.85
  }
}

/** Is there anything to show for the supplements section's macros (calories or macros entered)? */
export const hasMacros = t => !!t && (t.calories > 0 || t.protein_g > 0 || t.carbs_g > 0 || t.fat_g > 0)
