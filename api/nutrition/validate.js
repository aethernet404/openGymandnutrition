/* Input checking for everything the nutrition routes accept.
 *
 * Every validator returns { ok:true, value } or { ok:false, error } with one plain sentence the
 * app can show as it is. Numbers are bounded, strings are trimmed and length-capped, enums are
 * closed, and unknown keys are dropped — a client never gets to put a field of its own choosing
 * into the file.
 */

export const MEALS = ['breakfast', 'lunch', 'dinner', 'snack'];
export const SOURCES = ['manual', 'quick', 'food', 'ai'];
export const FOOD_SOURCES = ['custom', 'off', 'usda', 'fatsecret', 'ai'];
// Where a saved (custom) food's numbers came from, beyond "typed by hand": 'ai' = an AI estimate the person confirmed and saved.
export const FOOD_ORIGINS = ['ai'];
export const CONFIDENCE = ['low', 'medium', 'high'];

export const LIMITS = {
  calories: 20000, protein_g: 2000, carbs_g: 2000, fat_g: 2000,
  qty: 1000, grams: 100000,
  name: 120, brand: 60, serving: 60, ext: 40,
  entriesPerDay: 200, entriesPerRequest: 30,
  foods: 2000, recentFoods: 300,
  rangeDays: 400
};
export const MACROS = ['calories', 'protein_g', 'carbs_g', 'fat_g'];

const bad = error => ({ ok: false, error });
const good = value => ({ ok: true, value });
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const isNum = v => typeof v === 'number' && Number.isFinite(v);

/** Trimmed, control characters stripped, length-capped. Never throws. */
export const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

export const round = (v, d = 1) => { const k = 10 ** d; return Math.round(v * k) / k; };

export function validDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s && +s.slice(0, 4) >= 2000 && +s.slice(0, 4) <= 2100;
}

export function dateParam(s) {
  return validDate(s) ? good(s) : bad('date must be a real day written YYYY-MM-DD');
}

export function mealParam(s) {
  return MEALS.includes(s) ? good(s) : bad(`meal must be one of ${MEALS.join(', ')}`);
}

/** A bounded, non-negative number; `null` allowed when `nullable`. Strings are not coerced. */
function num(v, name, max, { nullable = false, min = 0 } = {}) {
  if (v == null && nullable) return good(null);
  if (!isNum(v) || v < min || v > max) return bad(`${name} must be a number between ${min} and ${max}${nullable ? ', or empty' : ''}`);
  return good(v);
}

/** { calories, protein_g, carbs_g, fat_g } — all four required, or all optional with `partial`. */
export function macrosOf(body, { partial = false } = {}) {
  const out = {};
  for (const k of MACROS) {
    if (body[k] === undefined && partial) continue;
    const r = num(body[k], k, LIMITS[k]);
    if (!r.ok) return r;
    out[k] = round(r.value, k === 'calories' ? 0 : 1);
  }
  return good(out);
}

/* ---------- goals ---------- */

/** Each target is a number or null (= no target). The set may be empty. */
export function goals(body) {
  if (!isObj(body)) return bad('send the goals as an object');
  const out = {};
  for (const k of MACROS) {
    const r = num(body[k], k, LIMITS[k], { nullable: true });
    if (!r.ok) return r;
    out[k] = r.value == null || r.value === 0 ? null : round(r.value, k === 'calories' ? 0 : 1);
  }
  return good(out);
}

/* ---------- foods ---------- */

/** A food as stored: per-serving macros plus the serving it is measured in. */
export function food(body, { partial = false } = {}) {
  if (!isObj(body)) return bad('send the food as an object');
  const out = {};
  if (!partial || body.name !== undefined) {
    const name = clean(body.name, LIMITS.name);
    if (!name) return bad('a food needs a name');
    out.name = name;
  }
  if (!partial || body.brand !== undefined) out.brand = clean(body.brand, LIMITS.brand);
  if (!partial || body.serving !== undefined || body.grams !== undefined) {
    const label = clean(body.serving, LIMITS.serving) || '1 serving';
    const g = num(body.grams ?? null, 'grams', LIMITS.grams, { nullable: true });
    if (!g.ok) return g;
    out.serving = { label, grams: g.value == null || g.value === 0 ? null : round(g.value, 1) };
  }
  const per = body.per !== undefined ? body.per : body;
  if (!partial || body.per !== undefined || MACROS.some(k => body[k] !== undefined)) {
    if (!isObj(per)) return bad('per must be an object');
    const m = macrosOf(per);
    if (!m.ok) return m;
    out.per = m.value;
  }
  if (body.source !== undefined) {
    if (!FOOD_SOURCES.includes(body.source)) return bad(`source must be one of ${FOOD_SOURCES.join(', ')}`);
    out.source = body.source;
  }
  if (body.origin !== undefined) {
    if (body.origin !== null && !FOOD_ORIGINS.includes(body.origin)) return bad(`origin must be one of ${FOOD_ORIGINS.join(', ')}`);
    out.origin = body.origin;
  }
  if (body.ext !== undefined) out.ext = body.ext == null ? null : clean(body.ext, LIMITS.ext) || null;
  if (body.favorite !== undefined) {
    if (typeof body.favorite !== 'boolean') return bad('favorite must be true or false');
    out.favorite = body.favorite;
  }
  return good(out);
}

/* ---------- diary entries ---------- */

/**
 * One entry. Macros are the TOTAL for what was eaten (already multiplied by `qty`), so editing
 * an entry never has to know how it was made. With a `foodId`, macros may be left out and the
 * route fills them from the food × qty — that is `needsFood` here.
 */
export function entry(body, { partial = false, foodGiven = false } = {}) {
  if (!isObj(body)) return bad('send each entry as an object');
  const out = {};
  if (!partial || body.name !== undefined) {
    const name = clean(body.name, LIMITS.name);
    // With a foodId the name comes from the food.
    if (!name && !((body.foodId || foodGiven) && !partial)) return bad('an entry needs a name');
    out.name = name;
  }
  if (!partial || body.brand !== undefined) out.brand = clean(body.brand, LIMITS.brand);
  if (!partial || body.serving !== undefined) out.serving = clean(body.serving, LIMITS.serving);
  if (!partial || body.qty !== undefined) {
    const q = num(body.qty ?? 1, 'qty', LIMITS.qty, { min: 0.01 });
    if (!q.ok) return q;
    out.qty = round(q.value, 2);
  }
  if (body.grams !== undefined) {
    const g = num(body.grams, 'grams', LIMITS.grams, { nullable: true });
    if (!g.ok) return g;
    out.grams = g.value == null ? null : round(g.value, 1);
  }
  if (body.meal !== undefined || !partial) {
    const m = mealParam(body.meal);
    if (!m.ok) return m;
    out.meal = m.value;
  }
  if (body.source !== undefined || !partial) {
    const s = body.source === undefined ? 'manual' : body.source;
    if (!SOURCES.includes(s)) return bad(`source must be one of ${SOURCES.join(', ')}`);
    out.source = s;
  }
  if (body.confidence !== undefined) {
    if (body.confidence !== null && !CONFIDENCE.includes(body.confidence)) return bad(`confidence must be one of ${CONFIDENCE.join(', ')}`);
    out.confidence = body.confidence;
  }
  // The per-serving values this entry was made from. Kept so that changing the amount later is always
  // base × amount, never a re-scaling of already rounded totals (which would drift with each edit).
  if (body.base !== undefined) {
    if (body.base === null) out.base = null;
    else {
      if (!isObj(body.base)) return bad('base must be an object');
      const b = {};
      for (const k of MACROS) {
        const r = num(body.base[k], `base ${k}`, LIMITS[k]);
        if (!r.ok) return r;
        b[k] = round(r.value, k === 'calories' ? 2 : 3);
      }
      const g = num(body.base.grams ?? null, 'base grams', LIMITS.grams, { nullable: true });
      if (!g.ok) return g;
      b.grams = g.value == null || g.value === 0 ? null : round(g.value, 2);
      out.base = b;
    }
  }
  if (body.foodId !== undefined) out.foodId = body.foodId == null ? null : clean(body.foodId, 40) || null;
  if (body.note !== undefined) out.note = clean(body.note, 200);

  const hasMacros = MACROS.some(k => body[k] !== undefined);
  if (hasMacros || (!partial && !out.foodId && !foodGiven)) {
    const m = macrosOf(body, { partial });
    if (!m.ok) return m;
    Object.assign(out, m.value);
  } else if (!partial) {
    out.needsFood = true;
  }
  return good(out);
}
