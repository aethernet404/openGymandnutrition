/* Micronutrients: which ones are tracked, in what unit, how they are read from each source, and how they add up.
 *
 * THE RULE THAT SHAPES EVERYTHING HERE: "no data" is not "zero". A food, portion or entry carries a `micros`
 * object holding only the nutrients that are KNOWN for it; a missing key means unknown and is never stored, summed
 * or shown as 0. A label that says 0 mg is a real 0 and is kept. Quick add and AI estimates have no micronutrient data
 * and nothing here ever invents any.
 *
 * Canonical units are fixed per nutrient (g, mg, mcg) and encoded in the key's suffix. Conversions (all one-way, into
 * these units) are in `convert`; each assumption that cannot be checked from a source is named where it is used.
 *
 * DAILY VALUES (`dv`): the FDA's adult Daily Values (21 CFR 101.9(c), the 2016 label rule in force since 2020-2021;
 * the same figures are on every US Nutrition Facts label). A general reference for labelling, not anyone's personal
 * need. Total sugars have no Daily Value.
 * UPPER LIMITS (`ul`): the Tolerable Upper Intake Levels for adults 19+ that the NIH Office of Dietary Supplements
 * lists in its fact sheets (from the National Academies' DRI reports). `scope: 'supplement'` means the limit applies
 * to the amount from supplements/fortified foods only (magnesium, niacin, folate as folic acid, vitamin E), not to the
 * nutrient eaten in ordinary food. Sources checked: see docs/NUTRITION_MICRONUTRIENTS.md (as of 2026-10).
 * The same table is copied into frontend/src/nutrition/micros.js; a test keeps the two identical.
 */

export const GROUPS = ['vitamins', 'minerals', 'other'];

// key: [label, unit, group, dv, max, ul?]   max = the largest value accepted for ONE entry (catches unit mix-ups)
const T = [
  ['vit_a_mcg', 'Vitamin A (RAE)', 'mcg', 'vitamins', 900, 1e6, { value: 3000, scope: 'supplement', what: 'preformed vitamin A (retinol)' }],
  ['vit_c_mg', 'Vitamin C', 'mg', 'vitamins', 90, 1e5, { value: 2000, scope: 'total' }],
  ['vit_d_mcg', 'Vitamin D', 'mcg', 'vitamins', 20, 1e5, { value: 100, scope: 'total' }],
  ['vit_e_mg', 'Vitamin E', 'mg', 'vitamins', 15, 1e4, { value: 1000, scope: 'supplement', what: 'vitamin E from supplements' }],
  ['vit_k_mcg', 'Vitamin K', 'mcg', 'vitamins', 120, 1e6],
  ['b1_mg', 'Thiamin (B1)', 'mg', 'vitamins', 1.2, 1e4],
  ['b2_mg', 'Riboflavin (B2)', 'mg', 'vitamins', 1.3, 1e4],
  ['b3_mg', 'Niacin (B3)', 'mg', 'vitamins', 16, 1e5, { value: 35, scope: 'supplement', what: 'niacin from supplements and fortified foods' }],
  ['b5_mg', 'Pantothenic acid (B5)', 'mg', 'vitamins', 5, 1e4],
  ['b6_mg', 'Vitamin B6', 'mg', 'vitamins', 1.7, 1e4, { value: 100, scope: 'total' }],
  ['biotin_mcg', 'Biotin (B7)', 'mcg', 'vitamins', 30, 1e6],
  ['folate_mcg', 'Folate (DFE)', 'mcg', 'vitamins', 400, 1e6, { value: 1000, scope: 'supplement', what: 'folic acid from supplements and fortified foods' }],
  ['b12_mcg', 'Vitamin B12', 'mcg', 'vitamins', 2.4, 1e6],
  ['choline_mg', 'Choline', 'mg', 'vitamins', 550, 1e5, { value: 3500, scope: 'total' }],
  ['calcium_mg', 'Calcium', 'mg', 'minerals', 1300, 1e5, { value: 2500, scope: 'total', note: '2,000 mg from age 51' }],
  ['iron_mg', 'Iron', 'mg', 'minerals', 18, 1e4, { value: 45, scope: 'total' }],
  ['magnesium_mg', 'Magnesium', 'mg', 'minerals', 420, 1e5, { value: 350, scope: 'supplement', what: 'magnesium from supplements' }],
  ['zinc_mg', 'Zinc', 'mg', 'minerals', 11, 1e4, { value: 40, scope: 'total' }],
  ['potassium_mg', 'Potassium', 'mg', 'minerals', 4700, 1e5],
  ['phosphorus_mg', 'Phosphorus', 'mg', 'minerals', 1250, 1e5, { value: 4000, scope: 'total' }],
  ['selenium_mcg', 'Selenium', 'mcg', 'minerals', 55, 1e6, { value: 400, scope: 'total' }],
  ['copper_mg', 'Copper', 'mg', 'minerals', 0.9, 1e3, { value: 10, scope: 'total' }],
  ['manganese_mg', 'Manganese', 'mg', 'minerals', 2.3, 1e3, { value: 11, scope: 'total' }],
  ['iodine_mcg', 'Iodine', 'mcg', 'minerals', 150, 1e5, { value: 1100, scope: 'total' }],
  ['fiber_g', 'Fiber', 'g', 'other', 28, 500],
  ['sugar_g', 'Sugars (total)', 'g', 'other', null, 2000],
  ['sodium_mg', 'Sodium', 'mg', 'other', 2300, 1e5],
  ['satfat_g', 'Saturated fat', 'g', 'other', 20, 1000],
  ['cholesterol_mg', 'Cholesterol', 'mg', 'other', 300, 1e5]
];
export const NUTRIENTS = T.map(([key, label, unit, group, dv, max, ul]) => ({ key, label, unit, group, dv, max, ...(ul ? { ul } : {}) }));
export const KEYS = NUTRIENTS.map(n => n.key);
export const BY_KEY = Object.fromEntries(NUTRIENTS.map(n => [n.key, n]));

const isNum = v => typeof v === 'number' && Number.isFinite(v);
const r4 = v => Math.round(v * 1e4) / 1e4;

/**
 * A `micros` object from a client or a source → { ok:true, value } with only known keys that hold a number from 0 up
 * to the nutrient's bound (null / undefined = unknown, dropped), or { ok:false, error }. Strings, NaN, negatives and
 * absurd values are refused; unknown keys are refused too (a typo must not silently vanish). An empty result is fine.
 */
export function microsOf(obj) {
  if (obj === undefined || obj === null) return { ok: true, value: {} };
  if (typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, error: 'micros must be an object' };
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const n = BY_KEY[k];
    if (!n) return { ok: false, error: `unknown nutrient "${String(k).slice(0, 30)}"` };
    if (v === null || v === undefined) continue;
    if (!isNum(v)) return { ok: false, error: `${n.label} must be a number` };
    if (v < 0) return { ok: false, error: `${n.label} cannot be negative` };
    if (v > n.max) return { ok: false, error: `${n.label} is not plausible (over ${n.max} ${n.unit}); check the unit` };
    out[k] = r4(v);
  }
  return { ok: true, value: out };
}

/** Lenient version for data read from a source: whatever is a sensible number is kept, the rest is unknown. */
export function microsFrom(candidate) {
  const out = {};
  for (const [k, v] of Object.entries(candidate || {})) {
    const n = BY_KEY[k];
    if (!n || !isNum(v) || v < 0) continue;
    out[k] = r4(Math.min(v, n.max));
  }
  return out;
}

export const hasMicros = m => !!m && typeof m === 'object' && Object.keys(m).length > 0;

/** × k, keeping only what is known. */
export function scaleMicros(m, k) {
  if (!hasMicros(m) || !isNum(k) || k < 0) return undefined;
  const out = {};
  for (const key of KEYS) if (isNum(m[key])) out[key] = r4(m[key] * k);
  return hasMicros(out) ? out : undefined;
}

/**
 * Add up the known amounts of a list of entries (or foods). A nutrient is in the answer only if at least one entry knows it.
 * @returns {{ totals: Record<string, number>, withData: number, entries: number }}
 */
export function sumMicros(entries) {
  const totals = {};
  let withData = 0;
  for (const e of entries) {
    if (!hasMicros(e.micros)) continue;
    withData++;
    for (const key of KEYS) if (isNum(e.micros[key])) totals[key] = r4((totals[key] || 0) + e.micros[key]);
  }
  return { totals, withData, entries: entries.length };
}

/* ------------------------------ conversions ------------------------------ */

export const convert = {
  gToMg: g => g * 1000,
  gToMcg: g => g * 1e6,
  mgToMcg: mg => mg * 1000,
  mcgToMg: mcg => mcg / 1000,
  // Vitamin D: 1 mcg = 40 IU (FDA/NIH).
  vitDIuToMcg: iu => iu / 40,
  // Vitamin A: 1 mcg RAE = 1 mcg retinol = 12 mcg dietary beta-carotene; on a supplement label 1 IU retinol = 0.3 mcg RAE
  // (the old label unit; whether an IU on a food is retinol or beta-carotene cannot be told, so retinol is assumed).
  vitAIuToMcgRae: iu => iu * 0.3,
  // Vitamin E: 1 IU = 0.67 mg alpha-tocopherol for the natural form (d-alpha), 0.45 mg for synthetic (dl-alpha); natural assumed.
  vitEIuToMg: iu => iu * 0.67,
  // Salt (sodium chloride) → sodium: sodium is 39.3 % of salt by weight (÷ 2.5).
  saltGToSodiumMg: g => g * 400
};
