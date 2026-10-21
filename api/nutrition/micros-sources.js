/* Reading micronutrients out of what each source sends. Every function returns a `micros` object of the nutrients the
 * source actually gave (canonical units, see micros.js) and NOTHING for the rest: a nutrient a source leaves out is
 * unknown, never 0. What each source really carries is listed in docs/NUTRITION_MICRONUTRIENTS.md.
 */
import { BY_KEY, convert, microsFrom } from './micros.js';

const num = v => { const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v; return typeof n === 'number' && Number.isFinite(n) ? n : null; };

/* ------------------------------ Open Food Facts ------------------------------ */

// nutriments key (per 100 g, always grams in `_100g`) → [our key, grams → our unit]
const OFF = {
  fiber: ['fiber_g', g => g], sugars: ['sugar_g', g => g], sodium: ['sodium_mg', convert.gToMg], 'saturated-fat': ['satfat_g', g => g],
  cholesterol: ['cholesterol_mg', convert.gToMg], potassium: ['potassium_mg', convert.gToMg], calcium: ['calcium_mg', convert.gToMg], iron: ['iron_mg', convert.gToMg],
  magnesium: ['magnesium_mg', convert.gToMg], zinc: ['zinc_mg', convert.gToMg], phosphorus: ['phosphorus_mg', convert.gToMg], selenium: ['selenium_mcg', convert.gToMcg],
  copper: ['copper_mg', convert.gToMg], manganese: ['manganese_mg', convert.gToMg], iodine: ['iodine_mcg', convert.gToMcg],
  'vitamin-a': ['vit_a_mcg', convert.gToMcg], 'vitamin-c': ['vit_c_mg', convert.gToMg], 'vitamin-d': ['vit_d_mcg', convert.gToMcg], 'vitamin-e': ['vit_e_mg', convert.gToMg],
  'vitamin-k': ['vit_k_mcg', convert.gToMcg], 'vitamin-b1': ['b1_mg', convert.gToMg], 'vitamin-b2': ['b2_mg', convert.gToMg], 'vitamin-pp': ['b3_mg', convert.gToMg],
  'pantothenic-acid': ['b5_mg', convert.gToMg], 'vitamin-b6': ['b6_mg', convert.gToMg], biotin: ['biotin_mcg', convert.gToMcg], 'vitamin-b9': ['folate_mcg', convert.gToMcg],
  'vitamin-b12': ['b12_mcg', convert.gToMcg], choline: ['choline_mg', convert.gToMg]
};

/**
 * Open Food Facts `nutriments` → micros per 100 g. OFF normalises every nutrient to GRAMS per 100 g in `<name>_100g`, so
 * minerals and vitamins are converted g → mg / mcg. Assumed, not verifiable per product: vitamin A, D and E arrive already
 * converted from IU by OFF (A as mcg RAE, D as mcg, E as mg alpha-tocopherol). Salt stands in for sodium when sodium is
 * absent (÷ 2.5). A nutrient a product does not list is absent here.
 */
export function microsFromOff(n) {
  if (!n || typeof n !== 'object') return {};
  const out = {};
  for (const [name, [key, conv]] of Object.entries(OFF)) {
    const v = num(n[name + '_100g']);
    if (v != null && v >= 0) out[key] = conv(v);
  }
  if (out.sodium_mg === undefined) { const salt = num(n.salt_100g); if (salt != null && salt >= 0) out.sodium_mg = convert.saltGToSodiumMg(salt); }
  return microsFrom(out);
}

/* ------------------------------ USDA FoodData Central ------------------------------ */

// nutrient id → [our key, the unit USDA reports it in]. Several ids for one key are tried in order (first one present wins).
const USDA = [
  [1079, 'fiber_g', 'G'], [2000, 'sugar_g', 'G'], [1063, 'sugar_g', 'G'], [1093, 'sodium_mg', 'MG'], [1258, 'satfat_g', 'G'], [1253, 'cholesterol_mg', 'MG'],
  [1092, 'potassium_mg', 'MG'], [1087, 'calcium_mg', 'MG'], [1089, 'iron_mg', 'MG'], [1090, 'magnesium_mg', 'MG'], [1095, 'zinc_mg', 'MG'], [1091, 'phosphorus_mg', 'MG'],
  [1103, 'selenium_mcg', 'UG'], [1098, 'copper_mg', 'MG'], [1101, 'manganese_mg', 'MG'], [1100, 'iodine_mcg', 'UG'],
  [1106, 'vit_a_mcg', 'UG'], [1104, 'vit_a_mcg', 'IU'], [1162, 'vit_c_mg', 'MG'], [1114, 'vit_d_mcg', 'UG'], [1110, 'vit_d_mcg', 'IU'], [1109, 'vit_e_mg', 'MG'], [1185, 'vit_k_mcg', 'UG'],
  [1165, 'b1_mg', 'MG'], [1166, 'b2_mg', 'MG'], [1167, 'b3_mg', 'MG'], [1170, 'b5_mg', 'MG'], [1175, 'b6_mg', 'MG'], [1176, 'biotin_mcg', 'UG'],
  [1190, 'folate_mcg', 'UG'], [1177, 'folate_mcg', 'UG'], [1178, 'b12_mcg', 'UG'], [1180, 'choline_mg', 'MG']
];

/** value in `from` ('G'|'MG'|'UG'|'IU') → the canonical unit of `key`, or null if that pair makes no sense. */
function toCanonical(value, from, key) {
  const to = BY_KEY[key].unit;
  if (from === 'IU') return key === 'vit_d_mcg' ? convert.vitDIuToMcg(value) : key === 'vit_a_mcg' ? convert.vitAIuToMcgRae(value) : null;
  const f = { G: 1, MG: 1e-3, UG: 1e-6 }[from];
  const t = { g: 1, mg: 1e-3, mcg: 1e-6 }[to];
  return f == null || t == null ? null : value * f / t;
}

/**
 * USDA `foodNutrients` (search result format) → micros per 100 g. Looked up by nutrient id; the unit USDA states for the
 * row (`unitName`, else the usual one) is converted to ours, so a row in µg or IU is not mistaken for mg. Reference foods
 * (Foundation, SR Legacy) carry nearly all of them; Branded foods carry only what is on their label (typically sodium,
 * sugar, fibre, saturated fat, cholesterol, potassium, calcium, iron, vitamin D, and sometimes A and C).
 */
export function microsFromUsda(list) {
  if (!Array.isArray(list)) return {};
  const byId = new Map();
  for (const x of list) { const id = x?.nutrientId ?? x?.nutrient?.id; if (id != null && !byId.has(id)) byId.set(id, x); }
  const out = {};
  for (const [id, key, usual] of USDA) {
    if (out[key] !== undefined) continue;
    const row = byId.get(id);
    const v = num(row?.value ?? row?.amount);
    if (v == null || v < 0) continue;
    const unit = String(row.unitName || row.nutrient?.unitName || usual).replace(/[µμ]/g, 'u').toUpperCase().replace('MCG', 'UG');   // the detail endpoint writes µg (micro sign)
    const c = toCanonical(v, unit, key);
    if (c != null) out[key] = c;
  }
  return microsFrom(out);
}

/* ------------------------------ FatSecret ------------------------------ */

/**
 * A FatSecret food.get v5 serving → micros for that serving. The docs list the amounts directly: fiber, sugar,
 * saturated_fat (g), sodium, cholesterol, potassium, calcium, iron, vitamin_c (mg), vitamin_a, vitamin_d (mcg).
 * "Where available", and a Brand food's example shows 0 for every vitamin, so for a BRAND food a 0 for vitamin A, C, D,
 * calcium or iron is read as "not provided" (unknown), not as a real 0: FatSecret does not distinguish them. A Generic food's
 * zeros are kept, and so are zeros for the fields a label always states (fibre, sugar, sodium, saturated fat, cholesterol).
 * Evidence for this reading: none beyond the docs' own Brand example; it is the cautious choice, and it errs towards
 * "no data" rather than a false 0.
 */
const FS_ONLY_IF_POSITIVE_FOR_BRAND = new Set(['vit_a_mcg', 'vit_c_mg', 'vit_d_mcg', 'calcium_mg', 'iron_mg']);
export function microsFromFatSecret(s, { brand = false } = {}) {
  if (!s || typeof s !== 'object') return {};
  const g = k => { const v = num(s[k]); return v != null && v >= 0 ? v : undefined; };
  const raw = {
    fiber_g: g('fiber'), sugar_g: g('sugar'), satfat_g: g('saturated_fat'), sodium_mg: g('sodium'), cholesterol_mg: g('cholesterol'), potassium_mg: g('potassium'),
    vit_a_mcg: g('vitamin_a'), vit_c_mg: g('vitamin_c'), vit_d_mcg: g('vitamin_d'), calcium_mg: g('calcium'), iron_mg: g('iron')
  };
  if (brand) for (const k of FS_ONLY_IF_POSITIVE_FOR_BRAND) if (raw[k] === 0) delete raw[k];
  return microsFrom(raw);
}
