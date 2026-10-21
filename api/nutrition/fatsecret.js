/* FatSecret Platform API (the free "Basic" edition) as a food source: restaurant, chain and convenience-store
 * foods that Open Food Facts and USDA do not have.
 *
 * WHAT THIS RELIES ON. The Basic edition is limited to two methods, both with scope `basic` (read from FatSecret's own
 * method pages by the owner, who checked them against the Error Codes guide):
 *
 *   AUTH     OAuth 2.0 client credentials. POST https://oauth.fatsecret.com/connect/token, the Client ID and Secret as HTTP
 *            Basic credentials, form body grant_type=client_credentials&scope=basic. The answer has access_token (a JWT whose
 *            `scope` claim lists what was granted) and expires_in. Every API call is a GET with `Authorization: Bearer`.
 *   SEARCH   foods.search v1: GET …/rest/foods/search/v1?search_expression=…&max_results=…&page_number=0&format=json.
 *            Each food has food_id, food_name, food_type (Brand | Generic), brand_name (Brand only), food_url and a one-line
 *            food_description such as "Per 1 serving - Calories: 300kcal | Fat: 13.00g | Carbs: 32.00g | Protein: 15.00g".
 *            QUIRK: `foods.food` is an ARRAY only when several foods come back, a single OBJECT for one, and absent for none.
 *            No premier-only parameter is sent (region, language, generic_description, include_food_images, …).
 *   DETAIL   food.get v5: GET …/rest/food/v5?food_id=…&format=json, asked only when a result is tapped or added: the real
 *            servings (serving_id, serving_description, metric_serving_amount/unit, calories, carbohydrate, protein, fat,
 *            saturated_fat, cholesterol, sodium, potassium, fiber, sugar, vitamin_a mcg, vitamin_c mg, vitamin_d mcg, calcium mg,
 *            iron mg). For Brand foods number_of_units is 1, measurement_description is "serving", and a derived serving with
 *            serving_id 0 (100 g, 100 ml or 1 oz and 100 g) is added.
 *   NOT IN BASIC  foods.search v4 (Premier Exclusive, scope premier: it fails with error 14), and food.find_id_for_barcode
 *            (Premier Exclusive, scope `premier barcode`): there is NO FatSecret barcode lookup here; Open Food Facts is the
 *            barcode source.
 *   ERRORS   An API error is an HTTP 200 with {"error":{"code":N,"message":…}}. Documented codes used: 13 invalid token
 *            (a new token is fetched once), 14 missing scope (the key does not include this feature), 21 IP address not
 *            registered, 11 and 12 the rate limits. Any other code is shown as it is, sanitised, and never retried.
 *   LIMITS   Basic: 5,000 calls a day, US data, English, attribution required.
 *   STORING  Only ids may be stored; everything else may be cached for 24 hours at most. So: search rows and food.get answers are
 *            kept in memory for 10 minutes and never written to disk; a food logged from here stays in recents for 24 hours (store.js).
 *
 * Own safety nets: a per-profile and a server-wide daily budget of calls (persisted, so a restart does not reset them; the
 * admin Test button is not counted), the OAuth token cached in memory until it expires, and nothing — no key, no secret, no
 * token, no search text — ever written to a log or shown. Only the Client ID and Secret an admin saved leave this module,
 * and only to FatSecret.
 */
import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite } from '../durable.js';
import { readCounter } from './usda-budget.js';
import { clean, round } from './validate.js';
import { chooseServingGrams, sensibleGrams } from './rank.js';
import { LookupError } from './lookup.js';
import { hasMicros } from './micros.js';
import { microsFromFatSecret } from './micros-sources.js';

const TOKEN_URL = () => process.env.NUTRITION_FATSECRET_TOKEN_URL || 'https://oauth.fatsecret.com/connect/token';
const API_BASE = () => (process.env.NUTRITION_FATSECRET_BASE || 'https://platform.fatsecret.com/rest').replace(/\/$/, '');

export const SERVER_DAILY_CAP = () => Math.min(5000, Math.max(1, Number(process.env.NUTRITION_FATSECRET_DAILY_CAP) || 4000));
export const USER_DAILY_CAP = () => Math.max(1, Number(process.env.NUTRITION_FATSECRET_USER_CAP) || 400);
export const SEARCH_TTL = 10 * 60000;            // in memory only; well inside their 24-hour rule
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_RESULTS = 20;
const utcDay = ms => new Date(ms).toISOString().slice(0, 10);

// FatSecret's documented rate-limit codes (Error Codes guide).
const RATE_CODES = new Set([11, 12]);
const TEXT = {
  auth: 'FatSecret rejected the Client ID or Secret. Check them in Goals → Admin → FatSecret.',
  token: 'FatSecret rejected the access token, even after getting a new one. Check the Client ID and Secret.',
  ip: 'FatSecret refused this server’s IP address. In your FatSecret developer dashboard, add the server’s public IP address (the one your home connection shows to the internet) under IP Restrictions.',
  rate: 'FatSecret is rate-limiting requests; try again in a minute.',
  plan: 'Your FatSecret key does not include this feature; the free Basic edition has no access to it.',
  timeout: 'FatSecret did not answer in time.',
  down: 'FatSecret is not answering right now.',
  bad: 'FatSecret sent something unreadable.'
};
/** What a code means, for the admin (the code and message are shown beside it). */
export const CODE_MEANING = { 11: TEXT.rate, 12: TEXT.rate, 13: 'Invalid access token.', 14: 'Missing scope: ' + TEXT.plan, 21: TEXT.ip };
/** FatSecret's own message, made safe to show: control characters out, anything address- or token-shaped hidden, short. */
export function sanitizeMessage(m) {
  return String(m ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, '[address]').replace(/[0-9a-f:]{6,}:[0-9a-f:]+/gi, '[address]')
    .replace(/[A-Za-z0-9._~+/=-]{30,}/g, '[hidden]').replace(/\s+/g, ' ').trim().slice(0, 160);
}
const err = (kind, message, text) => new LookupError(kind, message, text || TEXT[kind]);

/* ------------------------------ a daily budget ------------------------------ */

/** Calls made today (UTC), in total and per profile. Persisted, so a restart cannot be used to start over. */
export function createUsage({ file, now = Date.now, serverCap = SERVER_DAILY_CAP, userCap = USER_DAILY_CAP, log = console.error } = {}) {
  let state = null;
  const load = () => {
    const today = utcDay(now());
    if (!state) {
      state = readCounter(file, log);                 // a damaged counter file is kept aside, then counting starts again
      if (!state || !Number.isInteger(state.total)) state = { day: today, total: 0, users: {} };
      state.users = Object.assign(Object.create(null), state.users && typeof state.users === 'object' ? state.users : {});
    }
    if (state.day !== today) state = { day: today, total: 0, users: Object.create(null) };
    return state;
  };
  const save = () => { try { fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); atomicWrite(file, JSON.stringify(state), 0o600); } catch { /* counting must never break a search */ } };
  return {
    /** Spend one call. Returns null if allowed, or 'server' / 'user' for the budget that is used up. */
    take(uid) {
      const s = load();
      if (s.total >= serverCap()) return 'server';
      const mine = uid && Object.hasOwn(s.users, uid) ? s.users[uid] : 0;
      if (uid && mine >= userCap()) return 'user';
      s.total++;
      if (uid) s.users[uid] = mine + 1;
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
  const brandName = clean(f.brand_name, 60);
  const isBrand = String(f.food_type || '').toLowerCase() === 'brand' || !!brandName;
  const servings = listOf(f.servings?.serving ?? f.servings);
  const real = [], standard = [];
  for (const s of servings) {
    if (!s || typeof s !== 'object') continue;
    const per = perOf(s);
    if (!per) continue;
    const grams = servingWeight(s);
    const desc = clean(s.serving_description || s.measurement_description, 60);
    const is100 = grams === 100 && (String(s.serving_id) === '0' || /^100\s?(g|ml)\b/i.test(desc) || !desc);
    const micros = microsFromFatSecret(s, { brand: isBrand });
    if (is100) { standard.push({ label: '100 g', grams: 100, per, ...(hasMicros(micros) ? { micros } : {}) }); continue; }
    let label = desc || (grams ? `${grams} g` : '1 serving');
    if (grams && !/\d\s?(g|ml)\b/i.test(label) && !/\(.*\)/.test(label)) label = `${label} (${grams} g)`.slice(0, 60);
    real.push({ label, grams, per, ...(hasMicros(micros) ? { micros } : {}), isDefault: String(s.is_default) === '1' });
  }
  real.sort((a, b) => (b.isDefault ? 1 : 0) - (a.isDefault ? 1 : 0));
  const seen = new Set();
  const bases = [...real, ...standard].filter(b => { const k = b.label + '|' + b.per.calories; if (seen.has(k)) return false; seen.add(k); return true; })
    .slice(0, 5).map(({ label, grams, per, micros }) => ({ label, grams, per, ...(micros ? { micros } : {}) }));
  if (!bases.length) return null;
  return { source: 'fatsecret', kind: isBrand ? 'brand' : 'generic', ext: String(f.food_id), name, brand: brandName, bases };
}

/**
 * A foods.search v1 row → a hit with ONE base read from its one-line description, flagged `partial`: the real servings
 * come from food.get v5 when the person taps it. "Per 1 serving - Calories: 300kcal | Fat: 13.00g | Carbs: 32.00g | Protein:
 * 15.00g" and "Per 100g - Calories: 22kcal | …" are the two forms the docs show; anything else is not a usable row.
 */
const DESC_RE = /^per\s+(.+?)\s+-\s+calories:\s*([\d.,]+)\s*kcal\s*\|\s*fat:\s*([\d.,]+)\s*g\s*\|\s*carbs:\s*([\d.,]+)\s*g\s*\|\s*protein:\s*([\d.,]+)\s*g/i;
export function normaliseSearchRow(f) {
  if (!f || typeof f !== 'object' || f.food_id == null) return null;
  const name = clean(f.food_name, 120);
  const m = DESC_RE.exec(String(f.food_description || '').trim());
  if (!name || !m) return null;
  const n = x => num(String(x).replace(',', '.'));
  const calories = n(m[2]);
  if (calories == null) return null;
  const raw = clean(m[1], 60);
  const simple = /^(\d+(?:\.\d+)?)\s?(g|ml)$/i.exec(raw);
  const label = simple ? `${Number(simple[1])} ${simple[2].toLowerCase()}` : raw;
  const grams = simple ? (sensibleGrams(Number(simple[1])) ? round(Number(simple[1]), 1) : null) : chooseServingGrams(null, raw);
  const brand = clean(f.brand_name, 60);
  return {
    source: 'fatsecret', kind: String(f.food_type || '').toLowerCase() === 'brand' || brand ? 'brand' : 'generic', ext: String(f.food_id), name, brand, partial: true,
    bases: [{ label, grams, per: { calories: Math.round(clampMacro(calories, 20000)), protein_g: round(clampMacro(n(m[5]) ?? 0, 2000), 1), carbs_g: round(clampMacro(n(m[4]) ?? 0, 2000), 1), fat_g: round(clampMacro(n(m[3]) ?? 0, 2000), 1) } }]
  };
}

/** The scopes a token grants, from its JWT `scope` claim (the token itself is never shown), or null if it cannot be read. */
export function scopesOfToken(t, fallback) {
  const clean_ = v => [].concat(v ?? []).flatMap(x => String(x).split(/\s+/)).filter(x => /^[\w.:-]{1,40}$/.test(x));
  try {
    const parts = String(t).split('.');
    if (parts.length === 3) {
      const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
      const c = clean_(claims.scope ?? claims.scp);
      if (c.length) return c;
    }
  } catch { /* not a JWT */ }
  const f = clean_(fallback);
  return f.length ? f : null;
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
  let lastError = null;               // the last failure, sanitised, for the admin card

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
        if (e === 'invalid_scope' || e === 'unauthorized_client') throw err('plan', 'scope refused', TEXT.plan);
        throw err('auth', 'HTTP ' + res.status);
      }
      if (!body || typeof body.access_token !== 'string' || !body.access_token) throw err('bad', 'no access_token');
      const life = Math.max(60, Math.min(Number(body.expires_in) || 3600, 86400));
      tokens.set(key, { token: body.access_token, until: now() + (life - 60) * 1000, scope: body.scope });
      return body.access_token;
    })().finally(() => pending.delete(key));
    pending.set(key, p);
    return p;
  }

  /** FatSecret's own error object → our kinds, by the documented CODE only (never by guessing at the wording). */
  function apiError(e) {
    const code = Number(e?.code);
    if (code === 14) return err('plan', 'code 14', TEXT.plan);                       // missing scope: the key does not include this feature
    if (code === 21) return err('ip', 'code 21', TEXT.ip);
    if (code === 13) return Object.assign(err('auth', 'code 13', TEXT.token), { expired: true });   // invalid token: a new one, once
    if (RATE_CODES.has(code)) return err('rate', 'code ' + code);
    return err('bad', 'code ' + code, `FatSecret answered with an error (code ${Number.isFinite(code) ? code : '?'}): ${sanitizeMessage(e?.message) || 'no message'}`);
  }

  /**
   * One API GET with the budget, a cached token, and one automatic retry (timeouts, outages and unreadable answers;
   * not a rejected key, a refused IP, or a rate limit: asking again only makes those worse). A token that expired
   * early is replaced once, silently.
   */
  async function call(pathname, params, creds, { uid = null, scope = 'basic', deadline = now() + budgetMs, budget = true } = {}) {
    let last;
    let refreshed = false;
    for (let n = 0; n < 2; n++) {
      const left = deadline - now();
      if (n > 0 && left < 1500) break;
      const ms = Math.max(200, Math.min(n === 0 ? timeoutMs : retryTimeoutMs, left));
      const over = budget ? usage?.take(uid) : null;
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
        if (body.error) throw Object.assign(apiError(body.error), { fsCode: Number(body.error.code), fsMessage: sanitizeMessage(body.error.message) });
        return body;
      } catch (e) {
        last = e instanceof LookupError ? e : err('down', String(e?.message || e));
        if (last.expired && !refreshed) { refreshed = true; tokens.delete(creds.clientId + '|' + scope); n--; continue; }   // a stale token is replaced for free
        if (!['timeout', 'down', 'bad'].includes(last.kind) || last.fsCode !== undefined) break;   // an error code is an answer, not a hiccup
        if (n === 0) await sleep(retryDelayMs);
      }
    }
    lastError = { at: now(), kind: last.kind, code: last.fsCode ?? null, message: last.fsMessage || null, text: last.text || null };
    logReason(pathname.startsWith('foods/search') ? 'search' : 'food lookup', last.kind, last.fsCode, now, log);
    throw last;
  }

  /** @returns the normalised hits for a search (unranked: lookup.js ranks every source the same way). Rows carry one base from their summary line. */
  async function search(q, creds, { uid = null, fresh = false, budget = true, max = MAX_RESULTS } = {}) {
    const key = 'fs|' + creds.clientId + '|' + max + '|' + q.toLowerCase();
    if (fresh) cache.delete(key);
    const hit = recall(key); if (hit) return hit;
    const body = await call('foods/search/v1', { search_expression: q, max_results: String(max), page_number: '0' }, creds, { uid, budget });
    if (!body.foods || typeof body.foods !== 'object' || Array.isArray(body.foods)) {
      logReason('search', 'bad', 'shape-' + Object.keys(body).slice(0, 4).map(k => k.replace(/[^\w]/g, '').slice(0, 16)).join(','), now, log);
      throw err('bad', 'unexpected shape');
    }
    // One food is an object, several are an array, none is no `food` key at all.
    const hits = listOf(body.foods.food).map(normaliseSearchRow).filter(Boolean);
    return remember(key, hits, SEARCH_TTL);
  }

  /** The full food (every real serving) for one search result, asked when it is tapped. Cached like a search. */
  async function food(id, creds, { uid = null } = {}) {
    const key = 'fsfood|' + creds.clientId + '|' + id;
    const hit = recall(key); if (hit) return hit;
    const body = await call('food/v5', { food_id: String(id) }, creds, { uid });
    const f = normaliseFood(body.food);
    if (!f) throw err('bad', 'no usable food in the answer');
    return remember(key, f, SEARCH_TTL);
  }

  /**
   * For the admin's Test button, in the order that would fail: a token (its granted scopes read from the JWT's `scope` claim),
   * then a tiny search (v1, "apple", one result). Not counted against the daily budget. Never returns the token.
   */
  async function test(creds) {
    const info = e => ({ ok: false, kind: e?.kind || 'down', text: e?.text || TEXT.down, code: e?.fsCode ?? null, message: e?.fsMessage || null, meaning: CODE_MEANING[e?.fsCode] || null });
    tokens.clear();
    let bearer;
    try { bearer = await token(creds, 'basic', timeoutMs); } catch (e) { lastError = { at: now(), kind: e?.kind || 'down', code: null, message: null, text: e?.text || null }; return { token: info(e), search: null }; }
    const out = { token: { ok: true, scopes: scopesOfToken(bearer, tokens.get(creds.clientId + '|basic')?.scope) }, search: null };
    try { const hits = await search('apple', creds, { fresh: true, budget: false, max: 1 }); out.search = { ok: true, count: hits.length }; }
    catch (e) { out.search = info(e); }
    return out;
  }

  /** The last failure (sanitised), for the admin card. */
  const status = () => ({ lastError });

  return { search, food, test, status, usage, _tokens: tokens, _cache: cache, forget() { tokens.clear(); cache.clear(); lastError = null; } };
}
