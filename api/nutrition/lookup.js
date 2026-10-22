/* Food lookups: Open Food Facts (search + barcode) and USDA FoodData Central (search, and the stand-in lookups for micronutrients).
 *
 * The outside world is slow, rate-limited and sometimes down, and its data is uneven, so this
 * module is written around these rules:
 *
 *   1. A source failing is a RESULT, not an exception. search() always answers with whatever the
 *      sources that worked found, plus a per-source status the app can show ("Open Food Facts did
 *      not answer in time"). The app asks for each source separately, so a slow one never holds
 *      back a fast one.
 *   2. A source that times out or errors gets ONE automatic retry before it is reported as failed
 *      (not for a rejected key or a rate limit: asking again only makes those worse), inside an
 *      overall time budget so a dead source cannot hold a request for long.
 *   3. Everything is normalised once, here. A hit is { source, kind, ext, name, brand, bases[] }
 *      where each base is one way to measure a portion — "1 cookie (28 g)" or "100 g" — with its
 *      calories and macros for exactly that portion. An entry is always priced as qty × base.
 *   4. Nothing is trusted. Numbers are bounded and rounded, text is cleaned, a serving size must be
 *      believable (rank.js), a product with no calorie figure is dropped rather than shown as 0 kcal,
 *      and a response that is not the shape documented is a failure that is logged (once a minute,
 *      shape only — never the query, never a user's words).
 *   5. What is shown is what matches. Hits are filtered to those that contain every word typed and
 *      ordered by rank.js: USDA's reference foods first, then the rest by closeness.
 *
 * `fetch` is injected so the tests never touch the network; the base URLs, and the country and
 * language Open Food Facts results are preferred in, can be set by env.
 */
import { clean, round } from './validate.js';
import { rankHits, dupKey, chooseServingGrams, servingLabel } from './rank.js';
import { hasMicros, scaleMicros } from './micros.js';
import { microsFromOff, microsFromUsda } from './micros-sources.js';
import { TEXT as USDA_TEXT, DSLD_TEXT } from './usda-budget.js';
import * as dsld from './dsld.js';

const OFF_BASE = () => (process.env.NUTRITION_OFF_BASE || 'https://world.openfoodfacts.org').replace(/\/$/, '');
const USDA_BASE = () => (process.env.NUTRITION_USDA_BASE || 'https://api.nal.usda.gov/fdc/v1').replace(/\/$/, '');
// Preferred market and language for Open Food Facts search (tags as in its URLs). Empty = no filter.
const OFF_COUNTRY = () => process.env.NUTRITION_OFF_COUNTRY ?? 'united-states';
const OFF_LANG = () => process.env.NUTRITION_OFF_LANG ?? 'english';

// Open Food Facts is a volunteer-run service whose search regularly takes 3–8 s; the old 6 s was
// cutting off answers that were on their way. First attempt 10 s, the retry 8 s, and the whole
// source gives up after about 21 s.
export const TIMEOUT_MS = 10000;
export const RETRY_TIMEOUT_MS = 8000;
const RETRY_DELAY_MS = 300;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_RESULTS = 20;
const SEARCH_TTL = 5 * 60000;           // briefly: the same words typed again in the next few minutes
const BARCODE_TTL = 60 * 60000;
const CACHE_MAX = 200;

/** Why a source did not answer, in classes the app can word. */
export class LookupError extends Error {
  // `text` is a complete sentence for the person, used as it is (FatSecret's wrong-key and wrong-IP messages).
  constructor(kind, message, text) { super(message); this.kind = kind; if (text) this.text = text; }
}
// kind: 'timeout' | 'down' | 'rate' | 'auth' | 'bad' | 'ip' | 'plan' | 'limit' (the last three: FatSecret)
const WORDS = {
  timeout: 'did not answer in time',
  down: 'is not answering right now',
  rate: 'is rate-limiting requests; try again in a minute',
  auth: 'rejected the API key',
  bad: 'sent something unreadable'
};
export const describe = (name, err) => err.text || `${name} ${WORDS[err.kind] || WORDS.down}`;
const RETRYABLE = new Set(['timeout', 'down', 'bad']);

const num = v => { const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v; return typeof n === 'number' && Number.isFinite(n) ? n : null; };
const clampMacro = (v, max) => (v == null ? null : Math.min(max, Math.max(0, v)));

/* ------------------------------ Open Food Facts ------------------------------ */

const OFF_FIELDS = 'code,product_name,product_name_en,brands,serving_size,serving_quantity,quantity,nutriments,countries_tags,lang';

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

/**
 * Serving first (what people eat), then 100 g. Returns [] when there is no calorie figure at all.
 * The serving's numbers come from the per-100 g figures and the believed weight; the pack's own
 * "per serving" figures are used only when they agree with that (they are often a typo'd copy).
 */
function offBases(p) {
  const n = p.nutriments && typeof p.nutriments === 'object' ? p.nutriments : {};
  const per100 = offPer(n, '_100g');
  const grams = chooseServingGrams(num(p.serving_quantity), p.serving_size);
  const bases = [];
  let perServing = null;
  const declared = offPer(n, '_serving');
  if (grams && per100) {
    perServing = scalePer(per100, grams / 100);
    if (declared && per100.calories > 0 && Math.abs(declared.calories - perServing.calories) <= Math.max(15, 0.25 * perServing.calories)) perServing = declared;
  } else if (declared && !per100) perServing = declared;
  // Micronutrients: per 100 g as Open Food Facts gives them, scaled to the serving the same way as the macros. Absent = unknown.
  const m100 = microsFromOff(n);
  const withMicros = (b, m) => (hasMicros(m) ? { ...b, micros: m } : b);
  if (perServing && (grams || !per100)) bases.push(withMicros({ label: servingLabel(p.serving_size, grams), grams: grams ?? null, per: perServing }, grams ? scaleMicros(m100, grams / 100) : undefined));
  if (per100) bases.push(withMicros({ label: '100 g', grams: 100, per: per100 }, m100));
  return bases;
}

export function normaliseOff(p) {
  if (!p || typeof p !== 'object') return null;
  const code = clean(p.code, 20);
  const name = clean(p.product_name_en || p.product_name, 120);
  if (!code || !name) return null;
  const bases = offBases(p);
  if (!bases.length) return null;
  const countries = Array.isArray(p.countries_tags) ? p.countries_tags : [];
  const preferred = countries.some(c => /united-states$/.test(String(c))) && (p.lang === 'en' || !!p.product_name_en);
  return { source: 'off', kind: 'off', ext: code, name, brand: clean(String(p.brands || '').split(',')[0], 60), bases, preferred };
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
export const USDA_DATATYPES = ['Foundation', 'SR Legacy', 'Survey (FNDDS)', 'Branded'];
const USDA_KIND = { 'foundation': 'foundation', 'sr legacy': 'sr', 'survey (fndds)': 'survey', 'branded': 'branded' };

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
  const m100 = microsFromUsda(list);
  const withMicros = (b, m) => (hasMicros(m) ? { ...b, micros: m } : b);
  // Branded foods list their label serving; the reference datasets are per 100 g only.
  const unit = String(f.servingSizeUnit || '').toLowerCase();
  const size = num(f.servingSize);
  const grams = ['g', 'grm', 'ml', 'mlt'].includes(unit) ? chooseServingGrams(size, '') : null;
  if (grams) {
    const household = clean(f.householdServingFullText, 40);
    bases.push(withMicros({ label: household ? `${household} (${round(grams, 1)} g)` : `${round(grams, 1)} g`, grams: round(grams, 1), per: scalePer(per100, grams / 100) }, scaleMicros(m100, grams / 100)));
  }
  bases.push(withMicros({ label: '100 g', grams: 100, per: per100 }, m100));
  const kind = Object.hasOwn(USDA_KIND, String(f.dataType || '').toLowerCase()) ? USDA_KIND[String(f.dataType).toLowerCase()] : 'other';
  return { source: 'usda', kind, ext: String(f.fdcId), name, brand: titleCase(clean(f.brandName || f.brandOwner, 60)), bases };
}

/* ------------------------------ transport ------------------------------ */

async function getJson(fetchFn, url, { headers, timeoutMs }) {
  let res;
  try {
    res = await fetchFn(url, { headers, signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
  } catch (e) {
    throw new LookupError(e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'timeout' : 'down', String(e?.message || e));
  }
  if (res.status === 429) throw new LookupError('rate', 'HTTP 429');
  if (res.status === 401 || res.status === 403) throw new LookupError('auth', 'HTTP ' + res.status);
  if (res.status >= 500) throw new LookupError('down', 'HTTP ' + res.status);
  if (res.status === 404) return { notFound: true, status: 404 };
  if (!res.ok) throw new LookupError('bad', 'HTTP ' + res.status);
  let text;
  try { text = await res.text(); } catch (e) { throw new LookupError(e?.name === 'TimeoutError' ? 'timeout' : 'down', String(e?.message || e)); }
  if (text.length > MAX_BYTES) throw new LookupError('bad', 'response too large');
  try { return { data: JSON.parse(text), status: res.status }; } catch { throw new LookupError('bad', 'not JSON'); }
}

/* An answer that is JSON but not the shape the service documents is logged — once a minute per
   service and kind, with the HTTP status and the names of the top-level keys and nothing else:
   no query, no barcode, no value. Enough to see that an API changed; nothing to leak. */
const loggedAt = new Map();
function logShape(source, kind, status, data, now) {
  const key = source + '|' + kind;
  if (now() - (loggedAt.get(key) || 0) < 60000) return;
  loggedAt.set(key, now());
  const keys = data && typeof data === 'object' && !Array.isArray(data) ? Object.keys(data).slice(0, 8).map(k => String(k).replace(/[^\w-]/g, '').slice(0, 24)).join(',') : (Array.isArray(data) ? 'array' : typeof data);
  console.error(`nutrition: ${source} ${kind} returned an unexpected response shape (HTTP ${status}; top-level keys: ${keys || 'none'})`);
}

/* ------------------------------ the service ------------------------------ */

export function createLookup({
  fetch: fetchFn = globalThis.fetch, now = Date.now, sleep = ms => new Promise(r => setTimeout(r, ms)),
  timeoutMs = TIMEOUT_MS, retryTimeoutMs = Math.min(RETRY_TIMEOUT_MS, timeoutMs), retryDelayMs = RETRY_DELAY_MS,
  budgetMs = timeoutMs + retryTimeoutMs + 3000, userAgent = 'openGym-nutrition (self-hosted)',
  fatsecret: fs = null,          // fatsecret.js's client, injected so this file never imports it (it imports this one)
  usdaBudget = null,             // usda-budget.js: every request sent to USDA is counted against it
  dsldBudget = null              // the same for the NIH supplement database
} = {}) {
  const cache = new Map();
  const inflight = new Map();
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

  /** One request, retried once if the source timed out, errored or sent rubbish; inside `deadline`. */
  async function fetchRetry(url, deadline, extraHeaders = null) {
    let err;
    for (let n = 0; n < 2; n++) {
      const left = deadline - now();
      if (n > 0 && left < 1500) break;
      try { return { ...(await getJson(fetchFn, url, { headers: extraHeaders ? { ...headers, ...extraHeaders } : headers, timeoutMs: Math.max(200, Math.min(n === 0 ? timeoutMs : retryTimeoutMs, left)) })), retried: n }; }
      catch (e) {
        err = e instanceof LookupError ? e : new LookupError('down', String(e));
        if (!RETRYABLE.has(err.kind)) break;
        if (n === 0) await sleep(retryDelayMs);
      }
    }
    throw err;
  }

  /**
   * A request to USDA, counted against the server's USDA budget first (a refusal is a 'limit' failure the person can read).
   * The key travels in the X-Api-Key header, not in the URL, so it cannot end up in a proxy or access log that records URLs.
   * (USDA's FoodData Central sits behind api.data.gov, which takes the key as a header or as `api_key`; the header could not be
   * checked against their pages when this was written. If USDA refuses a header key, the same request is repeated once with
   * `api_key` in the URL, and if that is accepted the server keeps using the URL form and logs one line saying so.)
   */
  let usdaKeyInUrl = false;
  let keyBadUntil = 0;                 // both forms were refused a moment ago: the key itself is bad, do not try the second form each time
  async function usdaFetch(url, deadline, uid, apiKey) {
    const over = usdaBudget?.take(uid);
    if (over) throw new LookupError('limit', 'USDA budget: ' + over, USDA_TEXT[over]());
    const withKey = u => u + (u.includes('?') ? '&' : '?') + new URLSearchParams({ api_key: apiKey });
    if (usdaKeyInUrl) return fetchRetry(withKey(url), deadline);
    try { return await fetchRetry(url, deadline, { 'X-Api-Key': apiKey }); }
    catch (e) {
      if (!(e instanceof LookupError) || e.kind !== 'auth' || now() < keyBadUntil) throw e;
      let r;
      try { r = await fetchRetry(withKey(url), deadline); }        // a bad key fails again here, and says so
      catch (e2) { if (e2 instanceof LookupError && e2.kind === 'auth') keyBadUntil = now() + 10 * 60000; throw e2; }
      if (!usdaKeyInUrl) { usdaKeyInUrl = true; console.error('nutrition: USDA did not accept the key in the X-Api-Key header; using the api_key parameter instead'); }
      return r;
    }
  }

  /** The `products`/`foods` array of an answer, or a LookupError('bad') (and a log line) if it is not one. */
  function listOf(source, kind, r, field) {
    const list = r.data?.[field];
    if (!Array.isArray(list)) { logShape(source, kind, r.status, r.data, now); throw new LookupError('bad', 'unexpected shape'); }
    return list;
  }

  const offUrl = (q, filtered) => `${OFF_BASE()}/cgi/search.pl?` + new URLSearchParams({
    search_terms: q, search_simple: '1', action: 'process', json: '1', page_size: '40', fields: OFF_FIELDS, sort_by: 'unique_scans_n',
    ...(filtered && OFF_LANG() ? { tagtype_0: 'languages', tag_contains_0: 'contains', tag_0: OFF_LANG() } : {}),
    ...(filtered && OFF_COUNTRY() ? { tagtype_1: 'countries', tag_contains_1: 'contains', tag_1: OFF_COUNTRY() } : {})
  });

  async function searchOff(q) {
    const key = 'off|' + q.toLowerCase();
    const hit = recall(key); if (hit) return hit;
    const deadline = now() + budgetMs;
    const filtered = !!(OFF_COUNTRY() || OFF_LANG());
    const r1 = await fetchRetry(offUrl(q, filtered), deadline);
    let hits = rankHits(listOf('Open Food Facts', 'search', r1, 'products').map(normaliseOff).filter(Boolean), q);
    // The preferred market is a preference, not a wall: too few good matches there (or none, which
    // is also what an overloaded index tends to answer) and the whole catalogue is asked as well.
    if (filtered && hits.length < 5 && deadline - now() > 2500) {
      try {
        const r2 = await fetchRetry(offUrl(q, false), deadline);
        const more = rankHits(listOf('Open Food Facts', 'search', r2, 'products').map(normaliseOff).filter(Boolean), q);
        hits = rankHits([...hits, ...more], q);
      } catch (e) {
        // The first answer is good enough to show if it had anything in it; otherwise say what failed.
        if (!hits.length) throw e;
      }
    }
    return remember(key, hits.slice(0, MAX_RESULTS), SEARCH_TTL);
  }

  async function searchUsda(q, apiKey, uid) {
    const key = 'usda|' + q.toLowerCase();
    const hit = recall(key); if (hit) return hit;
    const deadline = now() + budgetMs;
    const url = types => `${USDA_BASE()}/foods/search?` + new URLSearchParams({ query: q, pageSize: '25', dataType: types });
    // Two requests, so that the plain reference foods are never crowded out by the thousands of
    // branded labels: the reference foods are asked for on their own.
    // Survey (FNDDS) — the mixed dishes (burritos, taquitos, pizza) — is a third request, ranked after the reference foods.
    const [generic, branded, survey] = await Promise.allSettled([
      usdaFetch(url('Foundation,SR Legacy'), deadline, uid, apiKey),
      usdaFetch(url('Branded'), deadline, uid, apiKey),
      usdaFetch(url('Survey (FNDDS)'), deadline, uid, apiKey)
    ]);
    if ([generic, branded, survey].every(r => r.status === 'rejected')) throw generic.reason;
    const take = r => (r.status === 'fulfilled' ? listOf('USDA FoodData Central', 'search', r.value, 'foods').map(normaliseUsda).filter(Boolean) : []);
    // A failure of only one of the two is shown as what it is: results from the other.
    const out = rankHits([...take(generic), ...take(survey), ...take(branded)], q).slice(0, MAX_RESULTS);
    // A search that lost one of its three requests (a budget, a timeout) is shown but not remembered: the next one asks again.
    return [generic, branded, survey].some(r => r.status === 'rejected') ? out : remember(key, out, SEARCH_TTL);
  }

  async function searchFatSecret(q, creds, uid) {
    // Ranked like the others. Their own result cache lives in fatsecret.js (10 minutes, memory only).
    const hits = await fs.search(q, creds, { uid });
    return rankHits(hits, q).slice(0, MAX_RESULTS);
  }

  /** Identical searches asked at once share one trip to the service. */
  function once(key, make) {
    if (inflight.has(key)) return inflight.get(key);
    const p = make().finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  }

  /**
   * @param {string} q
   * @param {{ usdaKey?: string|null, fatsecret?: {clientId:string, clientSecret:string}|null, uid?: string, sources?: 'all'|'off'|'usda'|'fatsecret', fresh?: boolean }} o
   * @returns {{ results: object[], sources: Record<string, {ok:boolean, skipped?:string, error?:string, kind?:string, count?:number}> }}
   *   `results` are ranked best first; `rank` is comparable across sources.
   */
  async function search(q, { usdaKey = null, fatsecret: fsCreds = null, uid = null, sources = 'all', fresh = false } = {}) {
    if (fresh) for (const k of [...cache.keys()]) if (k.startsWith('usda|')) cache.delete(k);
    const status = {};
    const lists = {};
    const jobs = [];
    const run = (id, name, make) => jobs.push(make().then(
      list => { status[id] = { ok: true, count: list.length }; lists[id] = list; },
      err => { status[id] = { ok: false, kind: err.kind || 'down', error: describe(name, err instanceof LookupError ? err : new LookupError('down')) }; lists[id] = []; }
    ));
    if (sources === 'all' || sources === 'off') run('off', 'Open Food Facts', () => once('off|' + q.toLowerCase(), () => searchOff(q)));
    if (sources === 'all' || sources === 'usda') {
      if (usdaKey) run('usda', 'USDA FoodData Central', () => once('usda|' + q.toLowerCase(), () => searchUsda(q, usdaKey, uid)));
      else status.usda = { ok: false, skipped: 'no-key' };
    }
    if (sources === 'all' || sources === 'fatsecret') {
      if (fsCreds && fs) run('fatsecret', 'FatSecret', () => once('fs|' + q.toLowerCase() + '|' + (uid || ''), () => searchFatSecret(q, fsCreds, uid)));
      else status.fatsecret = { ok: false, skipped: 'no-key' };
    }
    await Promise.all(jobs);
    // Best first, and a food that two sources both have (same name, brand and calories) is shown once.
    const seen = new Set();
    const results = [...(lists.usda || []), ...(lists.off || []), ...(lists.fatsecret || [])].sort((a, b) => b.rank - a.rank)
      .filter(h => { const k = dupKey(h); if (seen.has(k)) return false; seen.add(k); return true; });
    return { results: results.slice(0, MAX_RESULTS * 2), sources: status };
  }

  /** @returns {{ found: boolean, product?: object, error?: string, kind?: string }}
   *  Open Food Facts only: FatSecret's barcode lookup is a Premier feature, not part of the free Basic edition. */
  async function barcode(code) {
    const key = 'bc|' + code;
    const hit = recall(key); if (hit) return hit;
    try {
      const r = await fetchRetry(`${OFF_BASE()}/api/v2/product/${encodeURIComponent(code)}.json?fields=${OFF_FIELDS}`, now() + budgetMs);
      if (!r.notFound && (!r.data || typeof r.data !== 'object' || Array.isArray(r.data))) { logShape('Open Food Facts', 'barcode', r.status, r.data, now); throw new LookupError('bad', 'unexpected shape'); }
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

  /* ----- stand-ins for the micronutrient fill-in (standin.js) -----
     What this asks USDA, and nothing else: a food name (and a brand name, for the Branded dataset) and, later, an fdcId.
     Reference datasets only unless there is a brand: Foundation, SR Legacy and Survey (FNDDS: the mixed dishes such as
     taquitos and burritos). */
  const STANDIN_REFERENCE = 'Foundation,SR Legacy,Survey (FNDDS)';
  const queryOf = s => clean(String(s ?? '').replace(/[^\p{L}\p{N}\s'&,.-]/gu, ' '), 80);
  const candidateOf = f => {
    const id = Number(f?.fdcId);
    const dataType = USDA_DATATYPES.find(t => t.toLowerCase() === String(f?.dataType || '').toLowerCase());
    const name = titleCase(clean(f?.description, 120));
    if (!Number.isInteger(id) || id < 1 || id > 1e9 || !dataType || !name) return null;
    return { fdcId: id, name, dataType, ...(f.brandName || f.brandOwner ? { brand: titleCase(clean(f.brandName || f.brandOwner, 60)) } : {}) };
  };

  /** Up to `max` USDA foods that could stand in for a food of this name: reference foods first, then (with a brand) branded ones. */
  async function usdaCandidates(name, brand, apiKey, { max = 8, uid = null } = {}) {
    const q = queryOf(name);
    if (q.length < 2) return [];
    const b = queryOf(brand);
    const key = 'usdac|' + q.toLowerCase() + '|' + b.toLowerCase();
    const hit = recall(key); if (hit) return hit;
    const deadline = now() + budgetMs;
    const url = (query, types, size) => `${USDA_BASE()}/foods/search?` + new URLSearchParams({ query, pageSize: String(size), dataType: types });
    const take = r => (r.status === 'fulfilled' ? listOf('USDA FoodData Central', 'search', r.value, 'foods').map(candidateOf).filter(Boolean) : []);
    const asks = [usdaFetch(url(q, STANDIN_REFERENCE, 10), deadline, uid, apiKey)];
    if (b) asks.push(usdaFetch(url(`${b} ${q}`, 'Branded', 5), deadline, uid, apiKey));
    const done = await Promise.allSettled(asks);
    if (done.every(r => r.status === 'rejected')) throw done[0].reason;
    const seen = new Set();
    const out = [...take(done[0]).slice(0, b ? 6 : max), ...(done[1] ? take(done[1]) : [])].filter(c => !seen.has(c.fdcId) && seen.add(c.fdcId)).slice(0, max);
    return remember(key, out, SEARCH_TTL);
  }

  /**
   * One USDA food, per 100 g: its name, data type, calories and macros, and every micronutrient it states (micros.js units).
   * null when USDA does not know that id or has no energy value for it. Public-domain data, so it is kept for an hour.
   */
  async function usdaFood(fdcId, apiKey, { uid = null } = {}) {
    const id = Number(fdcId);
    if (!Number.isInteger(id) || id < 1 || id > 1e9) return null;
    const key = 'usdaf|' + id;
    const hit = recall(key); if (hit) return hit;
    const r = await usdaFetch(`${USDA_BASE()}/food/${id}`, now() + budgetMs, uid, apiKey);
    if (r.notFound) return remember(key, null, 5 * 60000);
    if (!r.data || typeof r.data !== 'object' || Array.isArray(r.data)) { logShape('USDA FoodData Central', 'food', r.status, r.data, now); throw new LookupError('bad', 'unexpected shape'); }
    const cand = candidateOf(r.data);
    const n = normaliseUsda(r.data);
    const b100 = n?.bases.find(x => x.label === '100 g');
    if (!cand || !b100) return remember(key, null, 5 * 60000);
    return remember(key, { ...cand, per100: b100.per, micros100: b100.micros || {} }, BARCODE_TTL);
  }


  /* ----- supplement barcodes: NIH DSLD, then USDA Branded (Open Food Facts is barcode() above) ----- */

  /** A request to the NIH DSLD, counted against its budget first. No key is sent (none is documented in anything I could read). */
  function dsldFetch(url, deadline, uid) {
    const over = dsldBudget?.take(uid);
    if (over) return Promise.reject(new LookupError('limit', 'DSLD budget: ' + over, DSLD_TEXT[over]()));
    return fetchRetry(url, deadline);
  }

  /**
   * The label for this barcode in DSLD: search-filter with the digits in quotes (what the API guide says to do for a barcode),
   * then each candidate's label confirms the UPC; the newest label still on the market wins.
   * @returns {Promise<{found:boolean, product?:object}>} (throws LookupError when DSLD cannot answer)
   */
  async function dsldByUpc(code, { uid = null } = {}) {
    const key = 'dsld|' + code;
    const hit = recall(key); if (hit) return hit;
    const deadline = now() + budgetMs * 2;
    const s = await dsldFetch(`${dsld.base()}/search-filter?q=${encodeURIComponent('"' + code + '"')}`, deadline, uid);
    const hits = s.notFound ? [] : dsld.parseSearch(s.data);
    if (!hits) { logShape('NIH DSLD', 'search', s.status, s.data, now); throw new LookupError('bad', 'unexpected shape'); }
    const cands = hits.filter(h => !h.upc || dsld.sameBarcode(h.upc, code)).slice(0, 4);
    const labels = [];
    for (const c of cands) {
      try {
        const r = await dsldFetch(`${dsld.base()}/label/${encodeURIComponent(c.id)}`, deadline, uid);
        const l = r.notFound ? null : dsld.parseLabel(r.data && typeof r.data === 'object' ? { id: c.id, ...r.data } : null);
        if (l && dsld.sameBarcode(l.upc, code)) labels.push({ ...l, id: l.id || c.id });
      } catch (e) { if (!labels.length && c === cands[cands.length - 1]) throw e; }
    }
    const best = dsld.pickBest(labels);
    return remember(key, best ? { found: true, product: dsld.hitOfLabel(best), versions: labels.length } : { found: false }, best ? BARCODE_TTL : 10 * 60000);
  }

  /** A USDA Branded food by its barcode (the search takes the digits), or { found:false }. */
  async function usdaByUpc(code, apiKey, { uid = null } = {}) {
    const key = 'usdaupc|' + code;
    const hit = recall(key); if (hit) return hit;
    const r = await usdaFetch(`${USDA_BASE()}/foods/search?` + new URLSearchParams({ query: code, pageSize: '5', dataType: 'Branded' }), now() + budgetMs, uid, apiKey);
    const foods = listOf('USDA FoodData Central', 'search', r, 'foods').filter(f => dsld.sameBarcode(f.gtinUpc, code));
    const n = foods.map(normaliseUsda).filter(Boolean)[0];
    return remember(key, n ? { found: true, product: { ...n, upc: code } } : { found: false }, n ? BARCODE_TTL : 10 * 60000);
  }

  return { search, barcode, dsldByUpc, usdaByUpc, usdaCandidates, usdaFood, _cache: cache };
}

/** A barcode as typed or scanned: digits only, 8–14 of them (EAN-8, UPC-A, EAN-13, GTIN-14). */
export function cleanBarcode(s) {
  const d = String(s ?? '').replace(/[\s-]/g, '');
  return /^\d{8,14}$/.test(d) ? d : null;
}
