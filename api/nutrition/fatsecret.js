/* FatSecret Platform API (the free "Basic" edition) as a food source: restaurant, chain and convenience-store
 * foods that Open Food Facts and USDA do not have.
 *
 * WHAT THIS RELIES ON, and how sure we are of it (their own docs host, platform.fatsecret.com, could not be
 * opened from where this was written; what follows is from search-engine excerpts of those pages and of their
 * blog, plus third-party client libraries — see docs/NUTRITION_FATSECRET.md for the full list):
 *
 *   AUTH      OAuth 2.0 client credentials. POST https://oauth.fatsecret.com/connect/token, the Client ID and
 *             Secret as HTTP Basic credentials, form body grant_type=client_credentials&scope=basic. The answer
 *             has access_token and expires_in (seconds; one day in their example). Then every API call is a
 *             GET with `Authorization: Bearer <token>`. Seen in their guide.
 *   SEARCH    GET https://platform.fatsecret.com/rest/foods/search/v4?search_expression=…&max_results=…&
 *             page_number=0&format=json. v4 returns each food WITH its servings (the standardised 100 g ones
 *             too), so one call is one search. Path and parameters seen in their docs; the exact JSON field
 *             names below are from a community client and are read defensively.
 *   DETAIL    GET …/rest/food/v5?food_id=…&format=json. Only used for the barcode route below.
 *   BARCODE   food.find_id_for_barcode (v1 returns the id, v2 the whole food). The Premier editions have it;
 *             NOT verified that Basic does not, so it is tried, and a refusal is remembered for an hour and
 *             reported as "not in your plan". The REST path used here (…/food/barcode/find-by-id/v2) is a guess
 *             from the pattern of the others: unverified.
 *   LIMITS    Basic: 5,000 calls a day, US data, English, attribution required. Calls from a non-registered IP
 *             address are refused (error code 21, "Invalid IP address detected"): the server's public IP has to
 *             be added in their dashboard.
 *   STORING   Their guide says only ids (food_id, serving_id…) may be stored; everything else may be cached for
 *             24 hours at most. So: search results are kept in memory for 10 minutes and never written to disk;
 *             a food logged from here is kept in recents for 24 hours only (store.js).
 *
 * Own safety nets: a per-profile and a server-wide daily budget of calls (persisted, so a restart does not reset
 * them), the OAuth token cached in memory until it expires, and nothing — no key, no secret, no token, no query —
 * ever written to a log. Only the Client ID and Secret an admin saved leave this module, and only to FatSecret.
 */
import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite } from '../durable.js';
import { clean, round } from './validate.js';
import { chooseServingGrams, sensibleGrams } from './rank.js';
import { LookupError } from './lookup.js';

const TOKEN_URL = () => process.env.NUTRITION_FATSECRET_TOKEN_URL || 'https://oauth.fatsecret.com/connect/token';
const API_BASE = () => (process.env.NUTRITION_FATSECRET_BASE || 'https://platform.fatsecret.com/rest').replace(/\/$/, '');

export const SERVER_DAILY_CAP = () => Math.min(5000, Math.max(1, Number(process.env.NUTRITION_FATSECRET_DAILY_CAP) || 4000));
export const USER_DAILY_CAP = () => Math.max(1, Number(process.env.NUTRITION_FATSECRET_USER_CAP) || 400);
export const SEARCH_TTL = 10 * 60000;            // in memory only; well inside their 24-hour rule
export const BARCODE_TTL = 60 * 60000;
const PLAN_MEMORY = 60 * 60000;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_RESULTS = 20;
const utcDay = ms => new Date(ms).toISOString().slice(0, 10);

const TEXT = {
  auth: 'FatSecret rejected the Client ID or Secret. Check them in Goals → Admin → FatSecret.',
  ip: 'FatSecret refused this server’s IP address. In your FatSecret developer dashboard, add the server’s public IP address (the one your home connection shows to the internet) under IP Restrictions.',
  rate: 'FatSecret is rate-limiting requests; try again in a minute.',
  plan: 'FatSecret barcode lookup is not part of the free Basic edition.',
  timeout: 'FatSecret did not answer in time.',
  down: 'FatSecret is not answering right now.',
  bad: 'FatSecret sent something unreadable.'
};
const err = (kind, message, text) => new LookupError(kind, message, text || TEXT[kind]);

/* ------------------------------ a daily budget ------------------------------ */

/** Calls made today (UTC), in total and per profile. Persisted, so a restart cannot be used to start over. */
export function createUsage({ file, now = Date.now, serverCap = SERVER_DAILY_CAP, userCap = USER_DAILY_CAP } = {}) {
  let state = null;
  const load = () => {
    const today = utcDay(now());
    if (!state) {
      try { state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { state = null; }
      if (!state || typeof state !== 'object') state = { day: today, total: 0, users: {} };
    }
    if (state.day !== today) state = { day: today, total: 0, users: {} };
    return state;
  };
  const save = () => { try { fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); atomicWrite(file, JSON.stringify(state), 0o600); } catch { /* counting must never break a search */ } };
  return {
    /** Spend one call. Returns null if allowed, or 'server' / 'user' for the budget that is used up. */
    take(uid) {
      const s = load();
      if (s.total >= serverCap()) return 'server';
      if (uid && (s.users[uid] || 0) >= userCap()) return 'user';
      s.total++;
      if (uid) s.users[uid] = (s.users[uid] || 0) + 1;
      save();
      return null;
    },
    snapshot: () => { const s = load(); return { day: s.day, used: s.total, cap: serverCap(), userCap: userCap() }; }
  };
}

/* ------------------------------ normalising ------------------------------ */

const num = v => { const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v; return typeof n === 'number' && Number.isFinite(n) ? n : null; };
const clampMacro = (v, max) => (v == null ? null : Math.min(max, Math.max(0, v)));
/** FatSecret collapses a one-item list into the item itself (and an empty one into nothing). */
const listOf = v => (Array.isArray(v) ? v : v && typeof v === 'object' ? [v] : []);

function perOf(s) {
  const calories = num(s.calories);
  if (calories == null) return null;
  return {
    calories: Math.round(clampMacro(calories, 20000)),
    protein_g: round(clampMacro(num(s.protein) ?? 0, 2000), 1),
    carbs_g: round(clampMacro(num(s.carbohydrate) ?? 0, 2000), 1),
    fat_g: round(clampMacro(num(s.fat) ?? 0, 2000), 1)
  };
}

/** The weight a serving stands for, if its metric amount is in grams or millilitres and believable; else null. */
function servingWeight(s) {
  const unit = String(s.metric_serving_unit || '').toLowerCase();
  const amount = num(s.metric_serving_amount);
  if (amount == null || !['g', 'ml'].includes(unit)) return null;
  return sensibleGrams(amount) ? round(amount, 1) : null;
}

/**
 * One FatSecret food → { source:'fatsecret', kind, ext, name, brand, bases[] }, or null.
 * Bases: the real servings first ("1 taquito (76 g)"), the standardised 100 g last, each with the numbers FatSecret
 * gives for exactly that serving. A serving with no calorie figure is dropped; one whose weight is not believable
 * (under 1 g or over a kilogram) is offered without a weight rather than with a wrong one.
 */
export function normaliseFood(f) {
  if (!f || typeof f !== 'object' || f.food_id == null) return null;
  const name = clean(f.food_name, 120);
  if (!name) return null;
  const servings = listOf(f.servings?.serving ?? f.servings);
  const real = [], standard = [];
  for (const s of servings) {
    if (!s || typeof s !== 'object') continue;
    const per = perOf(s);
    if (!per) continue;
    const grams = servingWeight(s);
    const desc = clean(s.serving_description || s.measurement_description, 60);
    const is100 = grams === 100 && (String(s.serving_id) === '0' || /^100\s?(g|ml)\b/i.test(desc) || !desc);
    if (is100) { standard.push({ label: '100 g', grams: 100, per }); continue; }
    let label = desc || (grams ? `${grams} g` : '1 serving');
    if (grams && !/\d\s?(g|ml)\b/i.test(label) && !/\(.*\)/.test(label)) label = `${label} (${grams} g)`.slice(0, 60);
    real.push({ label, grams, per, isDefault: String(s.is_default) === '1' });
  }
  real.sort((a, b) => (b.isDefault ? 1 : 0) - (a.isDefault ? 1 : 0));
  const seen = new Set();
  const bases = [...real, ...standard].filter(b => { const k = b.label + '|' + b.per.calories; if (seen.has(k)) return false; seen.add(k); return true; })
    .slice(0, 5).map(({ label, grams, per }) => ({ label, grams, per }));
  if (!bases.length) return null;
  const brand = clean(f.brand_name, 60);
  return { source: 'fatsecret', kind: String(f.food_type || '').toLowerCase() === 'brand' || brand ? 'brand' : 'generic', ext: String(f.food_id), name, brand, bases };
}

/* ------------------------------ the service ------------------------------ */

const loggedAt = new Map();
/** One short, non-sensitive line, at most one a minute per reason: kind and FatSecret's error CODE, never a message, key, token or query. */
function logReason(what, kind, code, now, log) {
  const key = what + '|' + kind + '|' + code;
  if (now() - (loggedAt.get(key) || 0) < 60000) return;
  loggedAt.set(key, now());
  log(`nutrition: fatsecret ${what} failed: ${kind}${code != null ? ' (code ' + String(code).replace(/[^\w.-]/g, '').slice(0, 40) + ')' : ''}`);
}

export function createFatSecret({
  fetch: fetchFn = globalThis.fetch, now = Date.now, sleep = ms => new Promise(r => setTimeout(r, ms)),
  timeoutMs = 10000, retryTimeoutMs = Math.min(8000, timeoutMs), retryDelayMs = 300, budgetMs = timeoutMs + retryTimeoutMs + 3000,
  usage = null, userAgent = 'openGym-nutrition (self-hosted)', log = console.error
} = {}) {
  const tokens = new Map();          // `${clientId}|${scope}` → { token, until }
  const pending = new Map();         // the same, while a token is being fetched
  const cache = new Map();           // search results, in memory only
  let noBarcodeUntil = 0;

  const remember = (key, value, ttl) => { if (cache.size >= 200) cache.delete(cache.keys().next().value); cache.set(key, { value, until: now() + ttl }); return value; };
  const recall = key => { const h = cache.get(key); if (!h) return undefined; if (h.until < now()) { cache.delete(key); return undefined; } return h.value; };

  async function readJson(res, what) {
    let text;
    try { text = await res.text(); } catch (e) { throw err(e?.name === 'TimeoutError' ? 'timeout' : 'down', 'read failed'); }
    if (text.length > MAX_BYTES) throw err('bad', 'too large');
    try { return JSON.parse(text); } catch { return null; }
  }
  const timeoutOf = e => e?.name === 'TimeoutError' || e?.name === 'AbortError';

  /** A bearer token for the scope, cached until shortly before it expires. */
  function token(creds, scope, ms) {
    const key = creds.clientId + '|' + scope;
    const hit = tokens.get(key);
    if (hit && hit.until > now()) return Promise.resolve(hit.token);
    if (pending.has(key)) return pending.get(key);
    const p = (async () => {
      let res;
      try {
        res = await fetchFn(TOKEN_URL(), {
          method: 'POST',
          headers: { Authorization: 'Basic ' + Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', 'User-Agent': userAgent },
          body: new URLSearchParams({ grant_type: 'client_credentials', scope }).toString(),
          signal: AbortSignal.timeout(ms), redirect: 'error'
        });
      } catch (e) { throw err(timeoutOf(e) ? 'timeout' : 'down', 'token request failed'); }
      const body = await readJson(res, 'token');
      if (res.status === 429) throw err('rate', 'HTTP 429');
      if (res.status >= 500) throw err('down', 'HTTP ' + res.status);
      if (!res.ok) {
        const e = String(body?.error || '');
        if (e === 'invalid_scope' || e === 'unauthorized_client') throw err('plan', 'scope refused', scope.includes('barcode') ? TEXT.plan : 'FatSecret did not grant access to its food search with these keys.');
        throw err('auth', 'HTTP ' + res.status);
      }
      if (!body || typeof body.access_token !== 'string' || !body.access_token) throw err('bad', 'no access_token');
      const life = Math.max(60, Math.min(Number(body.expires_in) || 3600, 86400));
      tokens.set(key, { token: body.access_token, until: now() + (life - 60) * 1000 });
      return body.access_token;
    })().finally(() => pending.delete(key));
    pending.set(key, p);
    return p;
  }

  /** What FatSecret's own error object means, in our kinds. Codes are from their forum and clients (unverified). */
  function apiError(e) {
    const code = e?.code, msg = String(e?.message || '');
    if (code === 21 || /invalid ip|ip address/i.test(msg)) return err('ip', 'code ' + code, TEXT.ip);
    if (/limit|too many|exceed|throttl/i.test(msg) || code === 14 || code === 15) return err('rate', 'code ' + code);
    if ([2, 5, 8, 9, 10, 12, 13].includes(code) || /token|oauth|credential|signature|consumer|client/i.test(msg)) return Object.assign(err('auth', 'code ' + code), { expired: /token|expired/i.test(msg) || code === 13 });
    return err('bad', 'code ' + code);
  }

  /**
   * One API GET with the budget, a cached token, and one automatic retry (timeouts, outages and unreadable answers;
   * not a rejected key, a refused IP, or a rate limit: asking again only makes those worse). A token that expired
   * early is replaced once, silently.
   */
  async function call(pathname, params, creds, { uid = null, scope = 'basic', deadline = now() + budgetMs } = {}) {
    let last;
    let refreshed = false;
    for (let n = 0; n < 2; n++) {
      const left = deadline - now();
      if (n > 0 && left < 1500) break;
      const ms = Math.max(200, Math.min(n === 0 ? timeoutMs : retryTimeoutMs, left));
      const over = usage?.take(uid);
      if (over) throw err('limit', 'budget ' + over, over === 'user'
        ? `You have used today’s FatSecret lookups (${USER_DAILY_CAP()} per person). It resets at midnight UTC.`
        : `This server has used its FatSecret budget for today (${SERVER_DAILY_CAP()} of the free 5,000 calls). It resets at midnight UTC.`);
      try {
        const bearer = await token(creds, scope, ms);
        const url = `${API_BASE()}/${pathname}?` + new URLSearchParams({ ...params, format: 'json' });
        let res;
        try { res = await fetchFn(url, { headers: { Authorization: 'Bearer ' + bearer, Accept: 'application/json', 'User-Agent': userAgent }, signal: AbortSignal.timeout(ms), redirect: 'error' }); }
        catch (e) { throw err(timeoutOf(e) ? 'timeout' : 'down', 'request failed'); }
        if (res.status === 429) throw err('rate', 'HTTP 429');
        if (res.status === 401) { tokens.delete(creds.clientId + '|' + scope); throw Object.assign(err('auth', 'HTTP 401'), { expired: true }); }
        if (res.status === 403) throw err('auth', 'HTTP 403');
        if (res.status >= 500) throw err('down', 'HTTP ' + res.status);
        if (!res.ok) throw err('bad', 'HTTP ' + res.status);
        const body = await readJson(res, 'api');
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw err('bad', 'not an object');
        if (body.error) throw Object.assign(apiError(body.error), { fsCode: body.error.code, fsBody: body });
        return body;
      } catch (e) {
        last = e instanceof LookupError ? e : err('down', String(e?.message || e));
        if (last.expired && !refreshed) { refreshed = true; tokens.delete(creds.clientId + '|' + scope); n--; continue; }   // a stale token is replaced for free
        if (!['timeout', 'down', 'bad'].includes(last.kind)) break;
        if (n === 0) await sleep(retryDelayMs);
      }
    }
    logReason(pathname.startsWith('foods/search') ? 'search' : 'barcode lookup', last.kind, last.fsCode, now, log);
    throw last;
  }

  /** @returns the normalised hits for a search (unranked: lookup.js ranks every source the same way) */
  async function search(q, creds, { uid = null, fresh = false } = {}) {
    const key = 'fs|' + creds.clientId + '|' + q.toLowerCase();
    if (fresh) cache.delete(key);
    const hit = recall(key); if (hit) return hit;
    const body = await call('foods/search/v4', { search_expression: q, max_results: String(MAX_RESULTS), page_number: '0' }, creds, { uid });
    if (!body.foods_search || typeof body.foods_search !== 'object') {
      logReason('search', 'bad', 'shape-' + Object.keys(body).slice(0, 4).map(k => k.replace(/[^\w]/g, '').slice(0, 16)).join(','), now, log);
      throw err('bad', 'unexpected shape');
    }
    const hits = listOf(body.foods_search.results?.food).map(normaliseFood).filter(Boolean);
    return remember(key, hits, SEARCH_TTL);
  }

  /**
   * Barcode → { found, product? , unavailable? }. Tried only for scans Open Food Facts did not know. A refusal for
   * the plan is remembered for an hour so the free edition is not asked every time.
   */
  async function barcode(code, creds, { uid = null } = {}) {
    if (now() < noBarcodeUntil) return { found: false, unavailable: 'plan' };
    let gtin = code;
    if (code.length === 14 && code[0] === '0') gtin = code.slice(1);
    if (gtin.length > 13) return { found: false, unavailable: 'format' };
    gtin = gtin.padStart(13, '0');
    const key = 'fsbc|' + creds.clientId + '|' + gtin;
    const hit = recall(key); if (hit) return hit;
    try {
      let body = await call('food/barcode/find-by-id/v2', { barcode: gtin }, creds, { uid, scope: 'basic barcode' });
      let food = body.food;
      const id = body.food_id?.value ?? (typeof body.food_id === 'string' ? body.food_id : null);
      if (!food && id) food = (await call('food/v5', { food_id: String(id) }, creds, { uid, scope: 'basic barcode' })).food;
      const product = normaliseFood(food);
      return remember(key, product ? { found: true, product } : { found: false }, product ? BARCODE_TTL : 5 * 60000);
    } catch (e) {
      // "No food for this barcode" is an answer, not a failure (the code is from forum posts: unverified).
      if (e.fsCode === 211 || /no food|not found|no match/i.test(String(e.fsBody?.error?.message || ''))) return remember(key, { found: false }, 5 * 60000);
      const refused = e.kind === 'plan' || (e.kind === 'auth' && /scope|permission|premier|not (available|allowed|included)/i.test(String(e.fsBody?.error?.message || '')));
      if (refused) { noBarcodeUntil = now() + PLAN_MEMORY; return { found: false, unavailable: 'plan' }; }
      throw e;
    }
  }

  /** For the admin's Test button: can we get a token, can we search, and does this plan allow barcodes. */
  async function test(creds, { uid = null } = {}) {
    tokens.clear();                    // a fresh look at what these keys are allowed, not a remembered answer
    const hits = await search('apple', creds, { uid, fresh: true });
    let barcodeScope = 'unknown';
    try { await token(creds, 'basic barcode', timeoutMs); barcodeScope = 'available'; }
    catch (e) { barcodeScope = e.kind === 'plan' ? 'not-in-plan' : 'unknown'; }
    return { count: hits.length, barcode: barcodeScope };
  }

  return { search, barcode, test, usage, _tokens: tokens, _cache: cache, forget() { tokens.clear(); cache.clear(); noBarcodeUntil = 0; } };
}
