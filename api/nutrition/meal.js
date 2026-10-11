/* What a model is allowed to say about a meal, and the check that holds it to that.
 *
 * Same stance as coach/core/validate.js: the prompt asks, this decides. Every number is bounded,
 * the totals are recomputed here from the items (a model that adds up wrong is not trusted to
 * add up right the second time), and a failure comes back as a list of plain sentences the
 * repair round can quote straight back at the model.
 */

const CONFIDENCE = ['low', 'medium', 'high'];
const MAX_ITEMS = 20;
const LIMITS = { grams: 3000, calories: 5000, protein_g: 500, carbs_g: 800, fat_g: 500 };

const isNum = v => typeof v === 'number' && Number.isFinite(v);
const round = (v, d = 0) => { const k = 10 ** d; return Math.round(v * k) / k; };
const str = (v, max) => String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);

/** @returns {{ ok:true, meal:object } | { ok:false, errors:string[] }} */
export function validateMeal(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, errors: ['the answer must be a JSON object'] };
  const errors = [];

  if (value.not_food === true) {
    return { ok: true, meal: { name: '', confidence: 'low', notFood: true, items: [], totals: { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 }, notes: str(value.notes, 300), warnings: [] } };
  }
  if (!Array.isArray(value.items) || !value.items.length) errors.push('items must be a non-empty array (or set "not_food": true when the picture shows no food)');
  else if (value.items.length > MAX_ITEMS) errors.push(`items has ${value.items.length} entries; at most ${MAX_ITEMS}`);

  const items = [];
  const warnings = [];
  (Array.isArray(value.items) ? value.items.slice(0, MAX_ITEMS) : []).forEach((it, i) => {
    const at = `items[${i}]`;
    if (!it || typeof it !== 'object') { errors.push(`${at} must be an object`); return; }
    const name = str(it.name, 80);
    if (!name) errors.push(`${at}.name is missing`);
    const row = { name, portion: str(it.portion, 80), grams: null };
    if (it.grams != null) {
      if (!isNum(it.grams) || it.grams <= 0 || it.grams > LIMITS.grams) errors.push(`${at}.grams must be a number between 1 and ${LIMITS.grams}, or null`);
      else row.grams = round(it.grams);
    }
    for (const k of ['calories', 'protein_g', 'carbs_g', 'fat_g']) {
      if (!isNum(it[k]) || it[k] < 0 || it[k] > LIMITS[k]) errors.push(`${at}.${k} must be a number between 0 and ${LIMITS[k]}`);
      else row[k] = round(it[k], k === 'calories' ? 0 : 1);
    }
    // Atwater check: 4/4/9 kcal per gram should land near the stated calories. A loose
    // tolerance — fibre, alcohol and rounding all move it — and a warning, not a rejection,
    // because the person reviews every number before anything is saved.
    if (isNum(row.calories) && isNum(row.protein_g) && isNum(row.carbs_g) && isNum(row.fat_g)) {
      const implied = 4 * row.protein_g + 4 * row.carbs_g + 9 * row.fat_g;
      if (Math.abs(implied - row.calories) > Math.max(40, 0.3 * row.calories)) warnings.push(`${name || at}: macros imply about ${round(implied)} kcal, estimate says ${row.calories}`);
    }
    items.push(row);
  });

  const confidence = CONFIDENCE.includes(value.confidence) ? value.confidence : null;
  if (!confidence) errors.push(`confidence must be one of ${CONFIDENCE.join(', ')}`);

  if (errors.length) return { ok: false, errors };

  const totals = { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 };
  for (const it of items) for (const k of Object.keys(totals)) totals[k] += it[k];
  totals.calories = round(totals.calories);
  for (const k of ['protein_g', 'carbs_g', 'fat_g']) totals[k] = round(totals[k], 1);

  return { ok: true, meal: { name: str(value.meal_name, 80), confidence, notFood: false, items, totals, notes: str(value.notes, 300), warnings } };
}
