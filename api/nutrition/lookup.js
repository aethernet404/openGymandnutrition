/* Food lookups: Open Food Facts (search + barcode) and USDA FoodData Central (search).
 *
 * The outside world is slow, rate-limited and sometimes down, and its data is uneven, so this
 * module is written around three rules:
 *
 *   1. A source failing is a RESULT, not an exception. search() always answers with whatever the
 *      other source found, plus a per-source status the app can show ("Open Food Facts is not
 *      answering"), instead of an error page for the whole search.
 *   2. Everything is normalised once, here. A hit is { source, ext, name, brand, bases[] } where
 *      each base is one way to measure a portion — "1 serving (30 g)" or "100 g" — with its
 *      calories and macros for exactly that portion. The app never sees per-100 g vs per-serving
 *      field names, and an entry can always be priced as qty × base.
 *   3. Nothing is trusted. Numbers are bounded and rounded, text is cleaned, and a product with no
 *      usable calorie figure is dropped rather than shown as 0 kcal.
 *
 * `fetch` is injected so the tests never touch the network; the base URLs can be overridden by env
 * (a mirror, or a local stand-in in the end-to-end test).
 */
import { clean, round } from './validate.js';

const OFF_BASE = () => (process.env.NUTRITION_OFF_BASE || 'https://world.openfoodfacts.org').replace(/\/$/, '');
const USDA_BASE = () => (process.env.NUTRITION_USDA_BASE || 'https://api.nal.usda.gov/fdc/v1').replace(/\/$/, '');

export const TIMEOUT_MS = 6000;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_RESULTS = 20;
const SEARCH_TTL = 10 * 60000;
const BARCODE_TTL = 60 * 60000;
const CACHE_MAX = 200;

/** Why a source did not answer, in classes the app can word. */
export class LookupError extends Error {
  constructor(kind, message) { super(message); this.kind = kind; }
}
// kind: 'timeout' | 'down' | 'rate' | 'auth' | 'bad'
const WORDS = {
  timeout: 'did not answer in time',
  down: 'is not answering right now',
  rate: 'is rate-limiting requests; try again in a minute',
  auth: 'rejected the API key',
  bad: 'sent something unreadable'
};
export const describe = (name, err) => `${name} ${WORDS[err.kind] || WORDS.down}`;

const num = v => { const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v; return typeof n === 'number' && Number.isFinite(n) ? n : null; };
const clampMacro = (v, max) => (v == null ? null : Math.min(max, Math.max(0, v)));

/* ------------------------------ Open Food Facts ------------------------------ */

const OFF_FIELDS = 'code,product_name,product_name_en,brands,serving_size,serving_quantity,quantity,nutriments';

/** kcal from a nutriments block, for a suffix ('_100g' | '_serving'). kJ is converted if kcal is absent. */
function offKcal(n, suffix) {
  const kcal = num(n['energy-kcal' + suffix]);
  if (kcal != null) return kcal;
  const kj = num(n['energy' + suffix]) ?? num(n['energy-kj' + suffix]);
  return kj != null ? kj / 4.184 : null;
}
function offPer(n, suffix) {
  const calories = offKcal(n, suffix);
  if (calories == null) return null;
  return {
    calories: Math.round(clampMacro(calories, 20000)),
    protein_g: round(clampMacro(num(n['proteins' + suffix]) ?? 0, 2000), 1),
    carbs_g: round(clampMacro(num(n['carbohydrates' + suffix]) ?? 0, 2000), 1),
    fat_g: round(clampMacro(num(n['fat' + suffix]) ?? 0, 2000), 1)
  };
}
const scalePer = (per, k) => ({
  calories: Math.round(per.calories * k), protein_g: round(per.protein_g * k, 1), carbs_g: round(per.carbs_g * k, 1), fat_g: round(per.fat_g * k, 1)
});

/** Serving first (what people eat), then 100 g. Returns [] when there is no calorie figure at all. */
function offBases(p) {
  const n = p.nutriments && typeof p.nutriments === 'object' ? p.nutriments : {};
  const per100 = offPer(n, '_100g');
  const grams = num(p.serving_quantity);
  const bases = [];
  const sGrams = grams != null && grams > 0 && grams <= 5000 ? round(grams, 1) : null;
  let perServing = offPer(n, '_serving');
  if (!perServing && per100 && sGrams) perServing = scalePer(per100, sGrams / 100);
  if (perServing) {
    const label = clean(p.serving_size, 60) || (sGrams ? `${sGrams} g` : '1 serving');
    bases.push({ label, grams: sGrams, per: perServing });
  }
  if (per100) bases.push({ label: '100 g', grams: 100, per: per100 });
  return bases;
}

export function normaliseOff(p) {
  if (!p || typeof p !== 'object') return null;
  const code = clean(p.code, 20);
  const name = clean(p.product_name_en || p.product_name, 120);
  if (!code || !name) return null;
  const bases = offBases(p);
  if (!bases.length) return null;
  return { source: 'off', ext: code, name, brand: clean(String(p.brands || '').split(',')[0], 60), bases };
}

/* ------------------------------ USDA FoodData Central ------------------------------ */

const NUTRIENT = { kcal: [1008, 2047, 2048], kj: [1062], protein: [1003], fat: [1004], carbs: [1005] };
const valueOf = (list, ids) => {
  for (const id of ids) {
    const hit = list.find(x => (x.nutrientId ?? x.nutrient?.id) === id);
    const v = num(hit?.value ?? hit?.amount);
    if (v != null) return v;
  }
  return null;
};
const titleCase = s => (s === s.toUpperCase() && /[A-Z]{3}/.test(s) ? s.toLowerCase().replace(/(^|[\s(,/-])([a-z])/g, (_, a, b) => a + b.toUpperCase()) : s);

export function normaliseUsda(f) {
  if (!f || typeof f !== 'object' || f.fdcId == null) return null;
  const list = Array.isArray(f.foodNutrients) ? f.foodNutrients : [];
  let kcal = valueOf(list, NUTRIENT.kcal);
  if (kcal == null) { const kj = valueOf(list, NUTRIENT.kj); if (kj != null) kcal = kj / 4.184; }
  if (kcal == null) return null;
  const per100 = {
    calories: Math.round(clampMacro(kcal, 20000)),
    protein_g: round(clampMacro(valueOf(list, NUTRIENT.protein) ?? 0, 2000), 1),
    carbs_g: round(clampMacro(valueOf(list, NUTRIENT.carbs) ?? 0, 2000), 1),
    fat_g: round(clampMacro(valueOf(list, NUTRIENT.fat) ?? 0, 2000), 1)
  };
  const name = titleCase(clean(f.description, 120));
  if (!name) return null;
  const bases = [];
  // Branded foods list their label serving; the generic datasets are per 100 g only.
  const unit = String(f.servingSizeUnit || '').toLowerCase();
  const size = num(f.servingSize);
  if (size != null && size > 0 && size <= 5000 && ['g', 'grm', 'ml', 'mlt'].includes(unit)) {
    const household = clean(f.householdServingFullText, 40);
    bases.push({ label: household ? `${household} (${round(size, 1)} g)` : `${round(size, 1)} g`, grams: round(size, 1), per: scalePer(per100, size / 100) });
  }
  bases.push({ label: '100 g', grams: 100, per: per100 });
  return { source: 'usda', ext: String(f.fdcId), name, brand: titleCase(clean(f.brandName || f.brandOwner, 60)), bases };
}

/* ------------------------------ transport ------------------------------ */

async function getJson(fetchFn, url, { headers, timeoutMs = TIMEOUT_MS } = {}) {
  let res;
  try {
    res = await fetchFn(url, { headers, signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
  } catch (e) {
    throw new LookupError(e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'timeout' : 'down', String(e?.message || e));
  }
  if (res.status === 429) throw new LookupError('rate', 'HTTP 429');
  if (res.status === 401 || res.status === 403) throw new LookupError('auth', 'HTTP ' + res.status);
  if (res.status >= 500) throw new LookupError('down', 'HTTP ' + res.status);
  if (res.status === 404) return { notFound: true };
  if (!res.ok) throw new LookupError('bad', 'HTTP ' + res.status);
  let text;
  try { text = await res.text(); } catch (e) { throw new LookupError(e?.name === 'TimeoutError' ? 'timeout' : 'down', String(e?.message || e)); }
  if (text.length > MAX_BYTES) throw new LookupError('bad', 'response too large');
  try { return { data: JSON.parse(text) }; } catch { throw new LookupError('bad', 'not JSON'); }
}

/* ------------------------------ the service ------------------------------ */

export function createLookup({ fetch: fetchFn = globalThis.fetch, now = Date.now, timeoutMs = TIMEOUT_MS, userAgent = 'openGym-nutrition (self-hosted)' } = {}) {
  const cache = new Map();
  const remember = (key, value, ttl) => {
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(key, { value, until: now() + ttl });
    return value;
  };
  const recall = key => {
    const hit = cache.get(key);
    if (!hit) return undefined;
    if (hit.until < now()) { cache.delete(key); return undefined; }
    return hit.value;
  };
  const headers = { 'User-Agent': userAgent, Accept: 'application/json' };

  async function searchOff(q) {
    const key = 'off|' + q.toLowerCase();
    const hit = recall(key); if (hit) return hit;
    const url = `${OFF_BASE()}/cgi/search.pl?` + new URLSearchParams({ search_terms: q, search_simple: '1', action: 'process', json: '1', page_size: '24', fields: OFF_FIELDS });
    const r = await getJson(fetchFn, url, { headers, timeoutMs });
    const items = Array.isArray(r.data?.products) ? r.data.products : [];
    return remember(key, items.map(normaliseOff).filter(Boolean).slice(0, MAX_RESULTS), SEARCH_TTL);
  }

  async function searchUsda(q, apiKey) {
    const key = 'usda|' + q.toLowerCase();
    const hit = recall(key); if (hit) return hit;
    const url = `${USDA_BASE()}/foods/search?` + new URLSearchParams({ api_key: apiKey, query: q, pageSize: '24', dataType: 'Foundation,SR Legacy,Branded' });
    const r = await getJson(fetchFn, url, { headers, timeoutMs });
    const items = Array.isArray(r.data?.foods) ? r.data.foods : [];
    return remember(key, items.map(normaliseUsda).filter(Boolean).slice(0, MAX_RESULTS), SEARCH_TTL);
  }

  /**
   * @param {string} q
   * @param {{ usdaKey?: string|null, sources?: 'all'|'off'|'usda' }} o
   * @returns {{ results: object[], sources: Record<string, {ok:boolean, skipped?:string, error?:string, kind?:string, count?:number}> }}
   */
  async function search(q, { usdaKey = null, sources = 'all', fresh = false } = {}) {
    if (fresh) for (const k of [...cache.keys()]) if (k.startsWith('usda|')) cache.delete(k);
    const status = {};
    const jobs = [];
    const run = (id, name, p) => jobs.push(p.then(
      list => { status[id] = { ok: true, count: list.length }; return list; },
      err => { status[id] = { ok: false, kind: err.kind || 'down', error: describe(name, err instanceof LookupError ? err : new LookupError('down')) }; return []; }
    ));
    if (sources === 'all' || sources === 'off') run('off', 'Open Food Facts', searchOff(q));
    if (sources === 'all' || sources === 'usda') {
      if (usdaKey) run('usda', 'USDA FoodData Central', searchUsda(q, usdaKey));
      else status.usda = { ok: false, skipped: 'no-key' };
    }
    const lists = await Promise.all(jobs);
    // Interleave so neither source buries the other, USDA's generic foods first at each rank.
    // `lists` follows the order the jobs were started in: off, then usda.
    const byId = {};
    let i = 0;
    for (const id of ['off', 'usda']) if (id in status && !status[id].skipped) byId[id] = lists[i++];
    const out = [];
    const a = byId.usda || [], b = byId.off || [];
    for (let k = 0; k < Math.max(a.length, b.length); k++) { if (a[k]) out.push(a[k]); if (b[k]) out.push(b[k]); }
    return { results: out.slice(0, MAX_RESULTS * 2), sources: status };
  }

  /** @returns {{ found: boolean, product?: object, error?: string, kind?: string }} */
  async function barcode(code) {
    const key = 'bc|' + code;
    const hit = recall(key); if (hit) return hit;
    try {
      const r = await getJson(fetchFn, `${OFF_BASE()}/api/v2/product/${encodeURIComponent(code)}.json?fields=${OFF_FIELDS}`, { headers });
      const p = r.notFound ? null : (r.data?.status === 0 ? null : r.data?.product);
      const product = p ? normaliseOff({ ...p, code: p.code || code }) : null;
      if (product) return remember(key, { found: true, product }, BARCODE_TTL);
      // Known product but no usable nutrition data is different from an unknown barcode.
      const known = !!p && !!clean(p.product_name || p.product_name_en, 120);
      return remember(key, known ? { found: false, reason: 'no-nutrition', name: clean(p.product_name || p.product_name_en, 120) } : { found: false, reason: 'unknown' }, 5 * 60000);
    } catch (e) {
      const err = e instanceof LookupError ? e : new LookupError('down', String(e));
      return { found: false, reason: 'error', kind: err.kind, error: describe('Open Food Facts', err) };
    }
  }

  return { search, barcode, _cache: cache };
}

/** A barcode as typed or scanned: digits only, 8–14 of them (EAN-8, UPC-A, EAN-13, GTIN-14). */
export function cleanBarcode(s) {
  const d = String(s ?? '').replace(/[\s-]/g, '');
  return /^\d{8,14}$/.test(d) ? d : null;
}
