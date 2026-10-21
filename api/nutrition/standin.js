/* Filling in an entry's missing vitamins and minerals from a USDA stand-in, without inventing a number.
 *
 * THE RULE: every nutrient amount comes from USDA FoodData Central, scaled to the entry's portion. The AI is only asked
 * which USDA food (from a short list the server found) is the closest match to what was eaten; it answers with an fdcId,
 * a short reason and a confidence, or "no good match". Whatever else a model says, numbers included, is dropped by
 * validateMatches below and never read. The server then fetches that food from USDA and scales it.
 *
 * What leaves the server: food names, brand names, amounts and calories and macros (to the model), and a food name, a brand
 * name or an fdcId (to USDA). Nothing about the person, no photo, no date.
 *
 * This file is pure (no network, no store); routes.js does the fetching and the saving.
 */
import { BY_KEY, KEYS, hasMicros, scaleMicros } from './micros.js';

export const MAX_BATCH = 12;
export const CONFIDENCE = ['low', 'medium', 'high'];
const MAX_GRAMS = 5000;                 // the same ceiling an entry's weight has
const isNum = v => typeof v === 'number' && Number.isFinite(v);
const round = (v, d = 0) => { const k = 10 ** d; return Math.round(v * k) / k; };
const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

/* ------------------------------ which entries ------------------------------ */

/** Does the entry already have a vitamin or a mineral of its own (label or database)? Fibre, sodium and the like do not count. */
export const hasVitaminOrMineral = m => !!m && KEYS.some(k => isNum(m[k]) && (BY_KEY[k].group === 'vitamins' || BY_KEY[k].group === 'minerals'));

/**
 * Why an entry cannot be filled in, or null when it can. An entry that already has its own vitamins or minerals is left
 * alone; one that has only fibre, sodium and so on is fine (those stay as they are, the stand-in adds the rest).
 */
export function skipReason(e, { replace = false } = {}) {
  if (!e || typeof e !== 'object') return 'missing';
  if (e.meal === 'supplements') return 'supplement';
  if (!clean(e.name, 120)) return 'no-name';
  if (hasVitaminOrMineral(e.micros)) return 'has-data';
  if (e.microsEst && !replace) return 'estimated';
  return null;
}

/* ------------------------------ what the model is asked ------------------------------ */

export const SYSTEM = [
  'You are the openGym food matcher.',
  'You are given foods someone ate and, for each, a short list of USDA FoodData Central foods. You pick the closest match from that list, or say there is none, and return exactly one JSON object: no prose, no code fence.',
  'You never give nutrient amounts or any number other than an fdc_id. You have no tools, filesystem access, external services, or memory; use only what you are given.'
].join(' ');

/** The one line of facts about an entry that the model gets. Only names, the amount, calories and macros. */
export function digest(e, key) {
  const amount = [e.qty != null && e.qty !== 1 ? `${round(e.qty, 2)} ×` : '', clean(e.serving, 80)].filter(Boolean).join(' ');
  return {
    id: key,
    name: clean(e.name, 120),
    ...(clean(e.brand, 60) ? { brand: clean(e.brand, 60) } : {}),
    ...(amount ? { amount } : {}),
    ...(isNum(e.grams) && e.grams > 0 ? { grams: round(e.grams, 1) } : {}),
    calories: round(e.calories || 0), protein_g: round(e.protein_g || 0, 1), carbs_g: round(e.carbs_g || 0, 1), fat_g: round(e.fat_g || 0, 1)
  };
}

/** @param {{ key:string, entry:object, candidates:{fdcId:number,name:string,dataType:string,brand?:string}[] }[]} items */
export function buildPrompt(items) {
  const blocks = items.map(({ key, entry, candidates }) => JSON.stringify({
    food: digest(entry, key),
    usda_candidates: candidates.map(c => ({ fdc_id: c.fdcId, name: c.name, data_type: c.dataType, ...(c.brand ? { brand: c.brand } : {}) }))
  }));
  return [
    'For each food below, choose the USDA FoodData Central candidate that is the closest stand-in for it (same food, same way of preparing it, similar ingredients), or say that none is a good match.',
    'Return this JSON shape and nothing else:',
    '{ "matches": [ { "id": "<the food id>", "fdc_id": <one of that food\'s candidate fdc_id values, or null>, "confidence": "low" | "medium" | "high", "reason": "<under 120 characters>" } ] }',
    'Rules:',
    '- One match object per food id. Use fdc_id null when no candidate is a good match (say why in reason).',
    '- fdc_id must be copied from that food\'s own candidate list. Never invent one.',
    '- Do NOT write calories, vitamins, minerals or any other amount. Only the fdc_id, the confidence and the reason.',
    '- Prefer the plainest candidate of the same preparation (a fried food over the raw ingredient, a mixed dish over one of its parts); low confidence is fine when unsure.',
    '',
    'Foods and candidates, one JSON object per line:',
    ...blocks
  ].join('\n');
}

/**
 * The model's answer, reduced to what is allowed to be read from it. Anything but the id, an fdc_id that is one of THAT
 * food's candidates, a confidence and a short reason is thrown away, numbers included. Foods the answer skips, and
 * picks that are not candidates, become "no match" rather than an error.
 * @param {Map<string, Set<number>>} allowed food id → its candidates' fdcIds
 * @returns {{ ok:true, meal: Map<string, {fdcId:number|null, confidence:string|null, reason:string}> } | { ok:false, errors:string[] }}
 *   (the field is called `meal` because the shared answer pipeline hands that field back)
 */
export function validateMatches(allowed) {
  return value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, errors: ['the answer must be a JSON object'] };
    if (!Array.isArray(value.matches)) return { ok: false, errors: ['"matches" must be an array with one object per food'] };
    const out = new Map();
    for (const m of value.matches.slice(0, MAX_BATCH * 2)) {
      if (!m || typeof m !== 'object') continue;
      const id = typeof m.id === 'string' ? m.id : null;
      if (!id || !allowed.has(id) || out.has(id)) continue;
      const reason = clean(m.reason, 160);
      const fdcId = isNum(m.fdc_id) && Number.isInteger(m.fdc_id) && allowed.get(id).has(m.fdc_id) ? m.fdc_id : null;
      if (fdcId == null) { out.set(id, { fdcId: null, confidence: null, reason: reason || 'no good match' }); continue; }
      out.set(id, { fdcId, confidence: CONFIDENCE.includes(m.confidence) ? m.confidence : 'low', reason });
    }
    for (const id of allowed.keys()) if (!out.has(id)) out.set(id, { fdcId: null, confidence: null, reason: 'no answer for this food' });
    return { ok: true, meal: out };
  };
}

/* ------------------------------ from a USDA food to this portion ------------------------------ */

/** How much the entry weighs: its own grams if it has them, else the weight that makes the stand-in's calories equal the entry's. */
export function sizeFor(entry, food) {
  if (isNum(entry.grams) && entry.grams > 0) return entry.grams > MAX_GRAMS ? { ok: false, why: 'The weight is not plausible.' } : { ok: true, grams: round(entry.grams, 1), how: 'entry' };
  const per100 = food.per100?.calories;
  if (!(entry.calories > 0)) return { ok: false, why: 'This entry has no weight and no calories to work the weight out from.' };
  if (!(per100 > 0)) return { ok: false, why: 'The stand-in has no calories, so the entry\'s weight cannot be worked out from them.' };
  const grams = round(entry.calories / per100 * 100, 1);
  return grams > MAX_GRAMS ? { ok: false, why: 'The weight worked out from the calories is not plausible.' } : { ok: true, grams, how: 'calories' };
}

// How far a stand-in's calories or macros may be from the entry's before the person is told: it takes both an absolute
// and a relative gap, so a few grams on a small number never raise it.
const TOLERANCE = { calories: { abs: 50, rel: 0.25 }, protein_g: { abs: 5, rel: 0.4 }, carbs_g: { abs: 8, rel: 0.4 }, fat_g: { abs: 4, rel: 0.4 } };
export const MACRO_KEYS = Object.keys(TOLERANCE);

/** The calories and macros of the stand-in at this weight that differ from the entry's by more than is sensible. */
export function compare(entry, scaled) {
  const diffs = [];
  for (const [key, tol] of Object.entries(TOLERANCE)) {
    const a = entry[key] || 0, b = scaled[key];
    if (Math.abs(a - b) > Math.max(tol.abs, tol.rel * Math.max(a, b))) diffs.push({ key, entry: round(a, key === 'calories' ? 0 : 1), standin: b, ratio: a > 0 ? round(b / a, 2) : null });
  }
  return diffs;
}

/** Whole-entry micronutrients that are within what one entry may hold (a unit slip upstream drops that nutrient, it never clamps one). */
export function boundedMicros(m) {
  const out = {};
  if (!m) return out;
  for (const k of KEYS) if (isNum(m[k]) && m[k] >= 0 && m[k] <= BY_KEY[k].max) out[k] = round(m[k], 4);
  return out;
}

/**
 * What accepting this USDA food for this entry would add. Never a nutrient USDA does not state for the food, never one the
 * entry already has.
 * @param {object} entry   a stored diary entry
 * @param {{fdcId:number,name:string,dataType:string,per100:object,micros100:object}} food  from lookup.usdaFood
 */
export function preview(entry, food) {
  const base = { fdcId: food.fdcId, name: food.name, dataType: food.dataType, per100: food.per100 };
  const size = sizeFor(entry, food);
  if (!size.ok) return { ...base, ok: false, why: size.why };
  const k = size.grams / 100;
  const scaled = {
    calories: Math.round(food.per100.calories * k), protein_g: round(food.per100.protein_g * k, 1),
    carbs_g: round(food.per100.carbs_g * k, 1), fat_g: round(food.per100.fat_g * k, 1)
  };
  const all = boundedMicros(scaleMicros(food.micros100, k));
  const micros = {};
  const alreadyKnown = [];
  for (const key of Object.keys(all)) { if (isNum(entry.micros?.[key])) alreadyKnown.push(key); else micros[key] = all[key]; }
  return { ...base, ok: true, grams: size.grams, how: size.how, scaled, diffs: compare(entry, scaled), micros, alreadyKnown, empty: !hasMicros(micros) };
}

/** The record stored on the entry (`microsEst`) for an accepted preview. `qty` lets later amount edits scale it. */
export function estimateRecord(entry, p, confidence, at = Date.now()) {
  return {
    fdcId: p.fdcId, name: clean(p.name, 120), dataType: p.dataType, confidence: CONFIDENCE.includes(confidence) ? confidence : null,
    grams: p.grams, how: p.how, qty: isNum(entry.qty) && entry.qty > 0 ? entry.qty : 1, micros: p.micros, at
  };
}
