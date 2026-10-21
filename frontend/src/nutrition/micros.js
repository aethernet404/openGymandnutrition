// Micronutrients on the phone: the same table as api/nutrition/micros.js (a test keeps the two identical), and the pure
// helpers the diary card and the forms use. "No data" is never zero: a nutrient nobody knows is absent from every total
// and is shown as unknown, not as 0.
//
// Daily Values: the FDA's adult Daily Values (21 CFR 101.9(c), the 2016 Nutrition Facts rule, in force 2020-2021). A
// general reference printed on US food labels, not a personal need and not medical advice. Total sugars have none.
// Upper limits: the adult Tolerable Upper Intake Levels in the NIH Office of Dietary Supplements fact sheets.
// scope 'supplement' = the limit applies to the amount from supplements and fortified foods only.

export const GROUPS = [
  { id: 'vitamins', label: 'Vitamins' },
  { id: 'minerals', label: 'Minerals' },
  { id: 'other', label: 'Other' }
]

export const NUTRIENTS = [
  { key: 'vit_a_mcg', label: 'Vitamin A (RAE)', unit: 'mcg', group: 'vitamins', dv: 900, max: 1000000, ul: { value: 3000, scope: 'supplement', what: 'preformed vitamin A (retinol)' } },
  { key: 'vit_c_mg', label: 'Vitamin C', unit: 'mg', group: 'vitamins', dv: 90, max: 100000, ul: { value: 2000, scope: 'total' } },
  { key: 'vit_d_mcg', label: 'Vitamin D', unit: 'mcg', group: 'vitamins', dv: 20, max: 100000, ul: { value: 100, scope: 'total' } },
  { key: 'vit_e_mg', label: 'Vitamin E', unit: 'mg', group: 'vitamins', dv: 15, max: 10000, ul: { value: 1000, scope: 'supplement', what: 'vitamin E from supplements' } },
  { key: 'vit_k_mcg', label: 'Vitamin K', unit: 'mcg', group: 'vitamins', dv: 120, max: 1000000 },
  { key: 'b1_mg', label: 'Thiamin (B1)', unit: 'mg', group: 'vitamins', dv: 1.2, max: 10000 },
  { key: 'b2_mg', label: 'Riboflavin (B2)', unit: 'mg', group: 'vitamins', dv: 1.3, max: 10000 },
  { key: 'b3_mg', label: 'Niacin (B3)', unit: 'mg', group: 'vitamins', dv: 16, max: 100000, ul: { value: 35, scope: 'supplement', what: 'niacin from supplements and fortified foods' } },
  { key: 'b5_mg', label: 'Pantothenic acid (B5)', unit: 'mg', group: 'vitamins', dv: 5, max: 10000 },
  { key: 'b6_mg', label: 'Vitamin B6', unit: 'mg', group: 'vitamins', dv: 1.7, max: 10000, ul: { value: 100, scope: 'total' } },
  { key: 'biotin_mcg', label: 'Biotin (B7)', unit: 'mcg', group: 'vitamins', dv: 30, max: 1000000 },
  { key: 'folate_mcg', label: 'Folate (DFE)', unit: 'mcg', group: 'vitamins', dv: 400, max: 1000000, ul: { value: 1000, scope: 'supplement', what: 'folic acid from supplements and fortified foods' } },
  { key: 'b12_mcg', label: 'Vitamin B12', unit: 'mcg', group: 'vitamins', dv: 2.4, max: 1000000 },
  { key: 'choline_mg', label: 'Choline', unit: 'mg', group: 'vitamins', dv: 550, max: 100000, ul: { value: 3500, scope: 'total' } },
  { key: 'calcium_mg', label: 'Calcium', unit: 'mg', group: 'minerals', dv: 1300, max: 100000, ul: { value: 2500, scope: 'total', note: '2,000 mg from age 51' } },
  { key: 'iron_mg', label: 'Iron', unit: 'mg', group: 'minerals', dv: 18, max: 10000, ul: { value: 45, scope: 'total' } },
  { key: 'magnesium_mg', label: 'Magnesium', unit: 'mg', group: 'minerals', dv: 420, max: 100000, ul: { value: 350, scope: 'supplement', what: 'magnesium from supplements' } },
  { key: 'zinc_mg', label: 'Zinc', unit: 'mg', group: 'minerals', dv: 11, max: 10000, ul: { value: 40, scope: 'total' } },
  { key: 'potassium_mg', label: 'Potassium', unit: 'mg', group: 'minerals', dv: 4700, max: 100000 },
  { key: 'phosphorus_mg', label: 'Phosphorus', unit: 'mg', group: 'minerals', dv: 1250, max: 100000, ul: { value: 4000, scope: 'total' } },
  { key: 'selenium_mcg', label: 'Selenium', unit: 'mcg', group: 'minerals', dv: 55, max: 1000000, ul: { value: 400, scope: 'total' } },
  { key: 'copper_mg', label: 'Copper', unit: 'mg', group: 'minerals', dv: 0.9, max: 1000, ul: { value: 10, scope: 'total' } },
  { key: 'manganese_mg', label: 'Manganese', unit: 'mg', group: 'minerals', dv: 2.3, max: 1000, ul: { value: 11, scope: 'total' } },
  { key: 'iodine_mcg', label: 'Iodine', unit: 'mcg', group: 'minerals', dv: 150, max: 100000, ul: { value: 1100, scope: 'total' } },
  { key: 'fiber_g', label: 'Fiber', unit: 'g', group: 'other', dv: 28, max: 500 },
  { key: 'sugar_g', label: 'Sugars (total)', unit: 'g', group: 'other', dv: null, max: 2000 },
  { key: 'sodium_mg', label: 'Sodium', unit: 'mg', group: 'other', dv: 2300, max: 100000 },
  { key: 'satfat_g', label: 'Saturated fat', unit: 'g', group: 'other', dv: 20, max: 1000 },
  { key: 'cholesterol_mg', label: 'Cholesterol', unit: 'mg', group: 'other', dv: 300, max: 100000 }
]
export const KEYS = NUTRIENTS.map(n => n.key)
export const BY_KEY = Object.fromEntries(NUTRIENTS.map(n => [n.key, n]))

/** The nutrients people usually take as supplements, for a quick way to add them (key order = chip order). */
export const COMMON_SUPPLEMENT_KEYS = ['vit_d_mcg', 'vit_c_mg', 'b12_mcg', 'magnesium_mg', 'zinc_mg', 'iron_mg', 'calcium_mg', 'folate_mcg', 'vit_k_mcg', 'b6_mg']

const isNum = v => typeof v === 'number' && Number.isFinite(v)
const r4 = v => Math.round(v * 1e4) / 1e4
export const hasMicros = m => !!m && typeof m === 'object' && Object.keys(m).length > 0

/** The known amounts of a micros object only (anything that is not a sensible number is unknown). */
export function cleanMicros(m) {
  const out = {}
  for (const k of KEYS) if (m && isNum(m[k]) && m[k] >= 0) out[k] = m[k]
  return out
}

/** × k, known amounts only. */
export function scaleMicros(m, k) {
  const out = {}
  if (!isNum(k) || k < 0) return out
  for (const key of KEYS) if (m && isNum(m[key])) out[key] = r4(m[key] * k)
  return out
}

/**
 * A form's micros (number | null | '' per nutrient) → the object to send: only numbers, an empty box is unknown and
 * is left out, never sent as 0. Returns { ok, micros } or { ok:false, error }.
 */
export function microsForSend(form) {
  const out = {}
  for (const k of KEYS) {
    const v = form?.[k]
    if (v === null || v === undefined || v === '') continue
    if (!isNum(v)) return { ok: false, error: `${BY_KEY[k].label} must be a number` }
    if (v < 0) return { ok: false, error: `${BY_KEY[k].label} cannot be negative` }
    if (v > BY_KEY[k].max) return { ok: false, error: `${BY_KEY[k].label} is not plausible (over ${BY_KEY[k].max} ${BY_KEY[k].unit}); check the unit` }
    out[k] = v
  }
  return { ok: true, micros: out }
}

/** Percent of the Daily Value (whole number), or null when the nutrient has none. */
export const pctDv = (key, value) => (BY_KEY[key]?.dv && isNum(value) ? Math.round(value / BY_KEY[key].dv * 100) : null)

/** "1,200 mg" / "0.9 mg" / "2.5 mcg": a sensible number of digits for the size, with the unit. */
export function amountText(key, value, locale) {
  const n = BY_KEY[key]
  if (!n || !isNum(value)) return ''
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : value >= 1 ? 2 : 3
  const x = Number(value.toFixed(digits))
  return `${x.toLocaleString(locale)} ${n.unit}`
}

/**
 * The day's micros summary from the server ({ food, supplements }, each { totals, withData, entries, est, groups }) for a
 * mode: 'food' or 'all' (food + supplements). `totals` add the known label / database amounts; the amounts that come from
 * accepted USDA stand-ins (`est.totals`, only for nutrients the entry does not know itself) are added when `includeEst`,
 * and the nutrients they contributed to are listed in `marked` so the card can mark them. Older answers have no est or groups.
 */
export function pick(summary, mode, includeEst = true) {
  const empty = { totals: {}, withData: 0, entries: 0, est: { totals: {} } }
  const parts = mode === 'all' ? [summary?.food || empty, summary?.supplements || empty] : [summary?.food || empty]
  const totals = {}
  const est = {}
  const groups = { labels: 0, estimated: 0, none: 0 }
  let withData = 0
  let entries = 0
  for (const b of parts) {
    for (const [k, v] of Object.entries(b.totals || {})) totals[k] = r4((totals[k] || 0) + v)
    for (const [k, v] of Object.entries(b.est?.totals || {})) est[k] = r4((est[k] || 0) + v)
    withData += b.withData || 0
    entries += b.entries || 0
    const g = b.groups || { labels: b.withData || 0, estimated: 0, none: (b.entries || 0) - (b.withData || 0) }
    groups.labels += g.labels; groups.estimated += g.estimated; groups.none += g.none
  }
  const all = { ...totals }
  if (includeEst) for (const [k, v] of Object.entries(est)) all[k] = r4((all[k] || 0) + v)
  return { totals: all, labelTotals: totals, estTotals: est, marked: includeEst ? Object.keys(est) : [], includeEst, withData, entries, groups, supplements: mode === 'all' ? (summary?.supplements?.entries || 0) : 0 }
}

/** Rows for the card, grouped: only nutrients that have a known amount today, in table order. Others are listed as unknown. `marked` = nutrients that include estimated amounts. */
export function groupedRows(totals, marked = []) {
  return GROUPS.map(g => ({
    ...g,
    rows: NUTRIENTS.filter(n => n.group === g.id && isNum(totals?.[n.key])).map(n => ({ key: n.key, label: n.label, unit: n.unit, value: totals[n.key], pct: pctDv(n.key, totals[n.key]), estimated: marked.includes(n.key) })),
    unknown: NUTRIENTS.filter(n => n.group === g.id && !isNum(totals?.[n.key])).map(n => n.label)
  }))
}

/** "Based on 6 of 9 entries that have micronutrient data" — missing data made visible. null when there are no entries. */
export function coverage(p) {
  if (!p.entries) return null
  return { withData: p.withData, entries: p.entries, none: p.withData === 0, partial: p.withData > 0 && p.withData < p.entries }
}

/**
 * The entries split in three: their own data (labels and databases), estimated from USDA stand-ins, no data. `counted` is
 * how many the totals are based on (estimated ones only while estimates are included). null when there are no entries.
 */
export function coverageGroups(p) {
  if (!p.entries) return null
  const { labels, estimated, none } = p.groups
  const counted = labels + (p.includeEst ? estimated : 0)
  return { entries: p.entries, labels, estimated, none, counted, nothing: counted === 0, left: !p.includeEst && estimated > 0 }
}

/** Can "Fill in micronutrients" be offered for this entry? (The same rule as the server's skipReason.) */
export function canFill(e) {
  if (!e || e.meal === 'supplements' || !String(e.name || '').trim() || e.microsEst) return false
  return !KEYS.some(k => isNum(e.micros?.[k]) && (BY_KEY[k].group === 'vitamins' || BY_KEY[k].group === 'minerals'))
}

const MACRO_WORD = { calories: 'calories', protein_g: 'protein', carbs_g: 'carbs', fat_g: 'fat' }
/** One difference between a stand-in and the entry in words, e.g. "about twice the fat (19 g, you logged 9 g)". Plain strings for nt(). */
export function diffText(d) {
  const what = MACRO_WORD[d.key]
  const unit = d.key === 'calories' ? ' kcal' : ' g'
  const r = d.ratio
  const how = r == null ? 'some' : r >= 2.5 ? `about ${Math.round(r)} times the` : r >= 1.8 ? 'about twice the' : r > 1 ? 'more' : r <= 0.4 ? 'less than half the' : r <= 0.6 ? 'about half the' : 'less'
  return { how, what, numbers: `${d.standin}${unit}`, logged: `${d.entry}${unit}` }
}

/**
 * Notes for nutrients above the usual adult upper limit, from what was actually eaten and taken today (food AND
 * supplements, whatever the card is showing). A limit with scope 'supplement' is compared with the supplement total
 * only, because that is what it is about (magnesium, niacin, folic acid, vitamin E, preformed vitamin A).
 * Neutral by design: it states the fact and where to take it.
 * @returns {{ key:string, label:string, total:number, ul:number, what:string|null, note:string|null, amount:string, limit:string }[]}
 */
export function upperLimitNotes(summary, locale, includeEst = true) {
  const food = { ...(summary?.food?.totals || {}) }
  const sup = summary?.supplements?.totals || {}
  const estFood = includeEst ? summary?.food?.est?.totals || {} : {}
  for (const [k, v] of Object.entries(estFood)) food[k] = r4((food[k] || 0) + v)
  const out = []
  for (const n of NUTRIENTS) {
    if (!n.ul) continue
    const total = n.ul.scope === 'supplement' ? (sup[n.key] ?? null) : (isNum(food[n.key]) || isNum(sup[n.key]) ? (food[n.key] || 0) + (sup[n.key] || 0) : null)
    if (total == null || total <= n.ul.value) continue
    out.push({ key: n.key, label: n.label, estimated: n.ul.scope !== 'supplement' && isNum(estFood[n.key]) && estFood[n.key] > 0, total, ul: n.ul.value, what: n.ul.what || null, note: n.ul.note || null, scope: n.ul.scope, amount: amountText(n.key, total, locale), limit: amountText(n.key, n.ul.value, locale) })
  }
  return out
}
