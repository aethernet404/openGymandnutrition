/* FatSecret Platform API as a third food source. Fixtures are shaped like FatSecret's documented answers
   (foods.search v4 with its servings, the OAuth token answer, the error object with a numeric code). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fatsecret-test-'));
process.env.DATA_DIR = DIR;
fs.writeFileSync(path.join(DIR, 'secret'), 'c'.repeat(64), { mode: 0o600 });
const { createFatSecret, createUsage, normaliseFood } = await import('../nutrition/fatsecret.js');
const { createLookup } = await import('../nutrition/lookup.js');
const { rankHits } = await import('../nutrition/rank.js');
const cfg = await import('../nutrition/config.js');
const store = await import('../nutrition/store.js');
const { nutritionRoutes } = await import('../nutrition/routes.js');

const CLIENT = { clientId: 'a1b2c3d4e5f60718', clientSecret: 'SECRETSECRET0123456789abcdef0123' };
const TOKEN = 'TOKEN-eyJhbGciOiJSUzI1NiJ9.payload.signature';
const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
const timeoutErr = () => Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });

/* ---- fixtures shaped like the documented answers ---- */
const serving = (id, desc, g, unit, cal, p, c, f, extra = {}) => ({
  serving_id: String(id), serving_description: desc, serving_url: 'https://www.fatsecret.com/calories-nutrition/x', metric_serving_amount: g == null ? undefined : g.toFixed(3), metric_serving_unit: unit,
  number_of_units: '1.000', measurement_description: desc, calories: String(cal), carbohydrate: String(c), protein: String(p), fat: String(f), ...extra
});
const food = (id, name, type, brand, servings) => ({ food_id: String(id), food_name: name, food_type: type, ...(brand ? { brand_name: brand } : {}), food_url: 'https://www.fatsecret.com/calories-nutrition/x', servings: { serving: servings } });
const searchAnswer = foods => ({ foods_search: { max_results: '20', total_results: String(foods.length), page_number: '0', results: foods.length ? { food: foods } : undefined } });
const TAQUITO = food(3001, 'Taquitos, Beef & Cheese', 'Brand', '7-Eleven', [
  serving(5001, '1 taquito', 76, 'g', 190, 7, 20, 9, { is_default: '1' }),
  serving(0, '100 g', 100, 'g', 250, 9, 26, 12)
]);
const BIGBITE = food(3002, 'Big Bite Roller Grill Hot Dog', 'Brand', '7-Eleven', [serving(5002, '1 hot dog', 113, 'g', 340, 11, 30, 20)]);
const GENERIC_EGG = food(3003, 'Egg', 'Generic', null, [serving(5003, '1 large', 50, 'g', 72, 6, 0.4, 4.8), serving(0, '100 g', 100, 'g', 143, 12.6, 0.7, 9.5)]);

/** A fake FatSecret: token endpoint + API, with counters and switches. */
function fake(over = {}) {
  const f = { tokenCalls: [], apiCalls: [], offCalls: 0, usdaCalls: 0, mode: {}, answer: () => searchAnswer([TAQUITO, BIGBITE]), barcode: () => ({ food: TAQUITO }), tokenLife: 86400, ...over };
  f.fetch = async (url, init = {}) => {
    url = String(url);
    if (url.includes('oauth.fatsecret.com')) {
      f.tokenCalls.push({ url, method: init.method, auth: init.headers?.Authorization, body: String(init.body), contentType: init.headers?.['Content-Type'] });
      if (f.mode.token === 'invalid_client') return json({ error: 'invalid_client' }, 401);
      if (f.mode.token === 'invalid_scope' && /barcode/.test(String(init.body))) return json({ error: 'invalid_scope' }, 400);
      if (f.mode.token === 'down') return json('oops', 503);
      return json({ access_token: TOKEN + f.tokenCalls.length, expires_in: f.tokenLife, token_type: 'Bearer', scope: 'basic' });
    }
    if (url.includes('platform.fatsecret.com')) {
      f.apiCalls.push({ url, auth: init.headers?.Authorization });
      const m = f.mode.api;
      if (typeof m === 'function') { const r = m(f.apiCalls.length, url); if (r) return r; }
      else if (m === 'timeout') throw timeoutErr();
      else if (m === 'ip') return json({ error: { code: 21, message: "Invalid IP address detected: '203.0.113.9'" } });
      else if (m === '429') return json('slow down', 429);
      else if (m === 'limit') return json({ error: { code: 14, message: 'Too many requests: daily limit exceeded' } });
      else if (m === 'expired') { f.mode.api = null; return json({ error: { code: 13, message: 'Invalid access token: token expired' } }); }
      else if (m === 'shape') return json({ something: 'else' });
      if (url.includes('/barcode/')) return json(f.barcode(url));
      return json(f.answer(url));
    }
    if (url.includes('openfoodfacts')) { f.offCalls++; return json(f.off ? f.off(url) : { products: [] }); }
    if (url.includes('nal.usda.gov')) { f.usdaCalls++; return json(f.usda ? f.usda(url) : { foods: [] }); }
    throw new Error('unexpected url ' + url);
  };
  return f;
}
const clock = () => { const c = { t: 1_700_000_000_000, now: () => c.t, advance: ms => { c.t += ms; } }; return c; };
function build(f, o = {}) {
  const c = o.clock || clock();
  const logs = [];
  const usage = o.usage === undefined ? null : o.usage;
  const fatsecret = createFatSecret({ fetch: f.fetch, now: c.now, sleep: async () => {}, timeoutMs: 1000, retryDelayMs: 0, usage, log: (...a) => logs.push(a.join(' ')) });
  const lk = createLookup({ fetch: f.fetch, now: c.now, sleep: async () => {}, timeoutMs: 1000, retryDelayMs: 0, fatsecret });
  return { fatsecret, lk, logs, c };
}

/* ------------------------------ token handling ------------------------------ */

test('token: client credentials, Client ID and Secret as Basic auth, scope basic; cached until it expires, then renewed', async () => {
  const f = fake({ tokenLife: 3600 });
  const { fatsecret, c } = build(f);
  await fatsecret.search('taquito', CLIENT);
  assert.equal(f.tokenCalls.length, 1);
  const t = f.tokenCalls[0];
  assert.equal(t.url, 'https://oauth.fatsecret.com/connect/token');
  assert.equal(t.method, 'POST');
  assert.equal(t.auth, 'Basic ' + Buffer.from(`${CLIENT.clientId}:${CLIENT.clientSecret}`).toString('base64'));
  assert.equal(t.contentType, 'application/x-www-form-urlencoded');
  assert.equal(t.body, 'grant_type=client_credentials&scope=basic');
  assert.match(f.apiCalls[0].auth, /^Bearer TOKEN-/);
  assert.ok(!f.apiCalls[0].url.includes(CLIENT.clientSecret), 'the secret is never in an API URL');
  await fatsecret.search('hot dog', CLIENT);
  await fatsecret.search('egg', CLIENT);
  assert.equal(f.tokenCalls.length, 1, 'one token serves every call until it expires');
  c.advance(3600 * 1000 - 30 * 1000);                  // inside the one-minute safety margin: renewed
  await fatsecret.search('burrito', CLIENT);
  assert.equal(f.tokenCalls.length, 2);
  assert.equal(f.apiCalls.at(-1).auth, 'Bearer ' + TOKEN + '2');
});

test('token: searches at the same moment share one token request', async () => {
  const f = fake();
  const { fatsecret } = build(f);
  await Promise.all(['a1', 'b2', 'c3', 'd4'].map(q => fatsecret.search(q, CLIENT)));
  assert.equal(f.tokenCalls.length, 1);
});

test('token: one the service says has expired early is replaced, once, without bothering the person', async () => {
  const f = fake();
  f.mode.api = 'expired';
  const { lk } = build(f);
  const r = await lk.search('taquito', { fatsecret: CLIENT, sources: 'fatsecret' });
  assert.equal(r.sources.fatsecret.ok, true);
  assert.equal(f.tokenCalls.length, 2);
  assert.equal(r.results.length, 1);
});

test('token: wrong keys → "rejected the Client ID or Secret", named, not retried, no results', async () => {
  const f = fake();
  f.mode.token = 'invalid_client';
  const { lk, logs } = build(f);
  const r = await lk.search('taquito', { fatsecret: CLIENT, sources: 'fatsecret' });
  assert.equal(r.sources.fatsecret.ok, false);
  assert.equal(r.sources.fatsecret.kind, 'auth');
  assert.match(r.sources.fatsecret.error, /rejected the Client ID or Secret.*Goals → Admin → FatSecret/);
  assert.equal(f.tokenCalls.length, 1, 'asking again with wrong keys only makes it worse');
  assert.equal(f.apiCalls.length, 0);
  assert.ok(logs.every(l => !l.includes(CLIENT.clientSecret) && !l.includes(CLIENT.clientId)));
});

/* ------------------------------ normalising ------------------------------ */

test('a food becomes the same portion model as the other sources: the real serving first, 100 g where available', () => {
  const hit = normaliseFood(TAQUITO);
  assert.deepEqual({ source: hit.source, kind: hit.kind, ext: hit.ext, name: hit.name, brand: hit.brand }, { source: 'fatsecret', kind: 'brand', ext: '3001', name: 'Taquitos, Beef & Cheese', brand: '7-Eleven' });
  assert.deepEqual(hit.bases, [
    { label: '1 taquito (76 g)', grams: 76, per: { calories: 190, protein_g: 7, carbs_g: 20, fat_g: 9 } },
    { label: '100 g', grams: 100, per: { calories: 250, protein_g: 9, carbs_g: 26, fat_g: 12 } }
  ]);
  const egg = normaliseFood(GENERIC_EGG);
  assert.equal(egg.kind, 'generic'); assert.equal(egg.brand, '');
  assert.deepEqual(egg.bases.map(b => b.label), ['1 large (50 g)', '100 g']);
});

test('serving selection: the default serving leads, duplicates go, only believable weights are kept', () => {
  const hit = normaliseFood(food(1, 'Burrito', 'Brand', 'Chain', [
    serving(1, '1 oz', 28.35, 'g', 70, 3, 8, 3),
    serving(2, '1 burrito', 300, 'g', 600, 20, 70, 25, { is_default: '1' }),
    serving(3, '1 burrito', 300, 'g', 600, 20, 70, 25),                         // the same again
    serving(4, '1 case', 5000, 'g', 10000, 300, 1000, 400),                      // not a believable serving weight
    serving(5, '1 pinch', 0.1, 'g', 1, 0, 0, 0),                                  // under a gram
    serving(6, '1 mystery', 50, 'oz', 100, 1, 1, 1),                              // a unit that is not a weight here
    serving(7, 'broken', 10, 'g', undefined, 1, 1, 1)                             // no calories: dropped
  ]));
  assert.deepEqual(hit.bases.map(b => [b.label, b.grams]), [['1 burrito (300 g)', 300], ['1 oz (28.3 g)', 28.35 > 28.3 ? 28.4 : 28.3], ['1 case', null], ['1 pinch', null], ['1 mystery', null]].map(([l, g], i) => (i === 1 ? ['1 oz (28.4 g)', 28.4] : [l, g])));
  assert.ok(hit.bases.every(b => b.per.calories >= 0));
});

test('FatSecret collapses one-item lists into the item itself: a single food and a single serving still work; no results is an empty list', async () => {
  const f = fake();
  f.answer = () => ({ foods_search: { max_results: '20', total_results: '1', page_number: '0', results: { food: { food_id: '9', food_name: 'Taquito', food_type: 'Brand', brand_name: 'X', servings: { serving: serving(1, '1 taquito', 70, 'g', 180, 6, 20, 8) } } } } });
  const { fatsecret } = build(f);
  const one = await fatsecret.search('taquito', CLIENT);
  assert.deepEqual(one.map(h => h.bases[0].label), ['1 taquito (70 g)']);
  f.answer = () => ({ foods_search: { max_results: '20', total_results: '0', page_number: '0' } });
  assert.deepEqual(await fatsecret.search('nothing at all', CLIENT), []);
});

test('numbers are bounded and text is cleaned', () => {
  const hit = normaliseFood(food(1, '  <b>Big</b>\n food ', 'Brand', 'B'.repeat(200), [serving(1, '1', 100, 'g', 99999, 99999, 99999, 99999)]));
  assert.ok(hit.brand.length <= 60 && !hit.name.includes('\n'));
  assert.deepEqual(hit.bases[0].per, { calories: 20000, protein_g: 2000, carbs_g: 2000, fat_g: 2000 });
  for (const bad of [null, 'x', {}, { food_id: 1 }, { food_id: 1, food_name: '' }, { food_id: 1, food_name: 'x', servings: { serving: [] } }]) assert.equal(normaliseFood(bad), null);
});

/* ------------------------------ search with all three sources ------------------------------ */

const off = (code, name, brands, kcal) => ({ code, product_name: name, brands, nutriments: { 'energy-kcal_100g': kcal, proteins_100g: 5, carbohydrates_100g: 5, fat_100g: 5 }, countries_tags: ['en:united-states'], lang: 'en' });
const fdc = (id, description, dataType, kcal) => ({ fdcId: id, description, dataType, foodNutrients: [{ nutrientId: 1008, value: kcal }, { nutrientId: 1003, value: 5 }, { nutrientId: 1004, value: 5 }, { nutrientId: 1005, value: 5 }] });

test('"7-Eleven taquitos": the others have nothing, FatSecret has it, and it is shown with its source', async () => {
  const f = fake();
  const { lk } = build(f);
  const r = await lk.search('7-Eleven taquitos', { usdaKey: 'KEY12345', fatsecret: CLIENT, uid: 'u1' });
  assert.deepEqual(r.sources.off, { ok: true, count: 0 });
  assert.deepEqual(r.sources.usda, { ok: true, count: 0 });
  assert.deepEqual(r.sources.fatsecret, { ok: true, count: 1 });
  assert.deepEqual(r.results.map(h => [h.source, h.brand, h.name]), [['fatsecret', '7-Eleven', 'Taquitos, Beef & Cheese']]);
});

test('ranking with all three sources: every typed word must match; reference USDA first for a generic query; closest names first; no duplicates', async () => {
  const f = fake();
  f.answer = () => searchAnswer([
    GENERIC_EGG,
    food(10, 'Egg McMuffin', 'Brand', "McDonald's", [serving(1, '1 sandwich', 138, 'g', 310, 17, 30, 13)]),
    food(11, 'Egg Salad Sandwich', 'Brand', '7-Eleven', [serving(1, '1 sandwich', 170, 'g', 390, 12, 33, 23)]),
    food(12, 'Ham Sandwich', 'Brand', '7-Eleven', [serving(1, '1 sandwich', 170, 'g', 330, 14, 34, 14)])      // no "egg": dropped
  ]);
  f.off = () => ({ products: [off('1', 'Egg', '', 143), off('2', 'Egg Salad Sandwich', '7-Eleven', 230)] });
  f.usda = u => (u.includes('Foundation') ? { foods: [fdc(748967, 'Egg, whole, raw, fresh', 'Foundation', 143)] } : { foods: [] });
  const { lk } = build(f);
  const r = await lk.search('egg', { usdaKey: 'KEY12345', fatsecret: CLIENT, uid: 'u1' });
  const lines = r.results.map(h => `${h.source}:${h.name}`);
  assert.equal(lines[0], 'usda:Egg, whole, raw, fresh', 'generic USDA foods lead a generic query: ' + lines.join(' | '));
  assert.ok(!lines.some(l => /Ham/.test(l)), 'a hit without every typed word is dropped');
  assert.equal(lines.filter(l => l === 'fatsecret:Egg').length + lines.filter(l => l === 'off:Egg').length, 1, 'the same food (same name, brand, calories) from two sources is shown once');
  for (let i = 1; i < r.results.length; i++) assert.ok(r.results[i - 1].rank >= r.results[i].rank);
  assert.ok(r.results.every(h => ['off', 'usda', 'fatsecret'].includes(h.source)));
});

test('a restaurant or convenience-store item whose typed words include its brand outranks a plain match of the same closeness', () => {
  const hit = (source, name, brand) => ({ source, kind: source === 'fatsecret' ? 'brand' : 'off', ext: name + brand, name, brand, bases: [{ label: '100 g', grams: 100, per: { calories: 200, protein_g: 5, carbs_g: 20, fat_g: 8 } }] });
  const ranked = rankHits([hit('off', 'Hot dog', 'Local Brand'), hit('fatsecret', 'Hot dog', '7-Eleven')], '7-eleven hot dog');
  assert.deepEqual(ranked.map(h => h.source), ['fatsecret']);                   // the other does not contain "7-eleven": dropped
  const tie = rankHits([hit('off', 'Taquitos', 'Local Brand'), hit('fatsecret', 'Taquitos', '7-Eleven')], 'taquitos');
  assert.equal(tie[0].source, 'off', 'with no brand typed there is no boost');
  const typed = rankHits([hit('off', 'Taquitos 7-Eleven style', 'Other'), hit('fatsecret', 'Taquitos', '7-Eleven')], '7-eleven taquitos');
  assert.equal(typed[0].source, 'fatsecret');
});

test('fallback: when Open Food Facts and USDA find nothing relevant, FatSecret’s results are still the answer', async () => {
  const f = fake();
  f.off = () => ({ products: [off('1', 'Unrelated cereal', 'Kellogg', 380)] });
  f.usda = () => ({ foods: [fdc(1, 'Cheese, parmesan', 'Foundation', 431)] });
  const { lk } = build(f);
  const r = await lk.search('big bite hot dog', { usdaKey: 'KEY12345', fatsecret: CLIENT, uid: 'u1' });
  assert.equal(r.sources.off.count, 0); assert.equal(r.sources.usda.count, 0);
  assert.deepEqual(r.results.map(h => h.name), ['Big Bite Roller Grill Hot Dog']);
});

test('no keys: FatSecret is simply off, says so, and is never contacted', async () => {
  const f = fake();
  const { lk } = build(f);
  const r = await lk.search('taquito', { fatsecret: null });
  assert.deepEqual(r.sources.fatsecret, { ok: false, skipped: 'no-key' });
  assert.equal(f.tokenCalls.length + f.apiCalls.length, 0);
  const only = await lk.search('taquito', { fatsecret: null, sources: 'fatsecret' });
  assert.deepEqual(Object.keys(only.sources), ['fatsecret']);
});

test('the other sources are unaffected when FatSecret fails', async () => {
  const f = fake();
  f.mode.api = 'timeout';
  f.off = () => ({ products: [off('1', 'Taquitos', 'Rolando', 250)] });
  const { lk } = build(f);
  const r = await lk.search('taquitos', { fatsecret: CLIENT, uid: 'u1' });
  assert.equal(r.sources.fatsecret.ok, false);
  assert.deepEqual(r.results.map(h => h.source), ['off']);
});

/* ------------------------------ errors, in plain words ------------------------------ */

test('a rejected IP address says to register the server’s public IP; it is not retried; the log has the code, not the address', async () => {
  const f = fake();
  f.mode.api = 'ip';
  const { lk, logs } = build(f);
  const r = await lk.search('taquito', { fatsecret: CLIENT, sources: 'fatsecret' });
  assert.equal(r.sources.fatsecret.kind, 'ip');
  assert.match(r.sources.fatsecret.error, /add the server’s public IP address.*IP Restrictions/);
  assert.equal(f.apiCalls.length, 1);
  assert.ok(logs.some(l => /fatsecret search failed: ip \(code 21\)/.test(l)), logs.join('\n'));
  assert.ok(logs.every(l => !l.includes('203.0.113.9')), 'the address FatSecret echoed is not logged');
});

test('rate limits: HTTP 429 and FatSecret’s own limit message are named and not retried', async () => {
  for (const mode of ['429', 'limit']) {
    const f = fake();
    f.mode.api = mode;
    const { lk } = build(f);
    const r = await lk.search('taquito', { fatsecret: CLIENT, sources: 'fatsecret' });
    assert.equal(r.sources.fatsecret.kind, 'rate', mode);
    assert.match(r.sources.fatsecret.error, /rate-limiting requests; try again in a minute/);
    assert.equal(f.apiCalls.length, 1, mode);
  }
});

test('timeout: one automatic retry that can succeed; two timeouts are reported as a timeout; an outage is "not answering"', async () => {
  const f = fake();
  f.mode.api = n => { if (n === 1) throw timeoutErr(); };
  const { lk } = build(f);
  const ok = await lk.search('taquito', { fatsecret: CLIENT, sources: 'fatsecret' });
  assert.equal(ok.sources.fatsecret.ok, true);
  assert.equal(f.apiCalls.length, 2);

  const g = fake(); g.mode.api = 'timeout';
  const bad = await build(g).lk.search('taquito', { fatsecret: CLIENT, sources: 'fatsecret' });
  assert.equal(bad.sources.fatsecret.kind, 'timeout');
  assert.equal(bad.sources.fatsecret.error, 'FatSecret did not answer in time.');
  assert.equal(g.apiCalls.length, 2, 'exactly one retry');

  const h = fake(); h.mode.api = () => json('boom', 503);
  const down = await build(h).lk.search('taquito', { fatsecret: CLIENT, sources: 'fatsecret' });
  assert.equal(down.sources.fatsecret.kind, 'down');
  assert.equal(down.sources.fatsecret.error, 'FatSecret is not answering right now.');
});

test('an answer that is JSON but not the documented shape is a failure, logged by key names only', async () => {
  const f = fake();
  f.mode.api = 'shape';
  const { lk, logs } = build(f);
  const r = await lk.search('taquito', { fatsecret: CLIENT, sources: 'fatsecret' });
  assert.equal(r.sources.fatsecret.kind, 'bad');
  assert.ok(logs.some(l => /shape-something/.test(l)), logs.join('\n'));
  assert.ok(logs.every(l => !/taquito/i.test(l)), 'never the query');
});

/* ------------------------------ budgets ------------------------------ */

test('rate protection: a per-profile and a server-wide daily budget stop calls before FatSecret is asked, with a clear message', async () => {
  const f = fake();
  const c = clock();
  const file = path.join(DIR, 'usage-a.json');
  process.env.NUTRITION_FATSECRET_USER_CAP = '3';
  process.env.NUTRITION_FATSECRET_DAILY_CAP = '5';
  try {
    const usage = createUsage({ file, now: c.now });
    const { lk } = build(f, { usage, clock: c });
    for (let i = 0; i < 3; i++) assert.equal((await lk.search('q' + i + 'x', { fatsecret: CLIENT, uid: 'alice', sources: 'fatsecret' })).sources.fatsecret.ok, true);
    const user = await lk.search('q9x', { fatsecret: CLIENT, uid: 'alice', sources: 'fatsecret' });
    assert.equal(user.sources.fatsecret.kind, 'limit');
    assert.match(user.sources.fatsecret.error, /used today’s FatSecret lookups \(3 per person\).*midnight UTC/);
    assert.equal(f.apiCalls.length, 3, 'the refused search made no call');
    // Another profile still has its own allowance, until the server-wide budget is gone.
    assert.equal((await lk.search('b1x', { fatsecret: CLIENT, uid: 'bob', sources: 'fatsecret' })).sources.fatsecret.ok, true);
    assert.equal((await lk.search('b2x', { fatsecret: CLIENT, uid: 'bob', sources: 'fatsecret' })).sources.fatsecret.ok, true);
    const server = await lk.search('b3x', { fatsecret: CLIENT, uid: 'bob', sources: 'fatsecret' });
    assert.equal(server.sources.fatsecret.kind, 'limit');
    assert.match(server.sources.fatsecret.error, /This server has used its FatSecret budget for today \(5 of the free 5,000 calls\).*midnight UTC/);
    // It survives a restart (a new usage object reading the same file) and resets at the next UTC day.
    const again = createUsage({ file, now: c.now });
    assert.equal(again.snapshot().used, 5);
    assert.equal(again.take('carol'), 'server');
    c.advance(24 * 3600 * 1000);
    assert.equal(createUsage({ file, now: c.now }).take('alice'), null);
    // The search cache does not cost a call.
    const f2 = fake();
    const b = build(f2, { usage: createUsage({ file: path.join(DIR, 'usage-b.json') }) });
    await b.lk.search('same words', { fatsecret: CLIENT, uid: 'alice', sources: 'fatsecret' });
    await b.lk.search('same words', { fatsecret: CLIENT, uid: 'alice', sources: 'fatsecret' });
    assert.equal(f2.apiCalls.length, 1);
    assert.equal(b.fatsecret.usage.snapshot().used, 1);
  } finally { delete process.env.NUTRITION_FATSECRET_USER_CAP; delete process.env.NUTRITION_FATSECRET_DAILY_CAP; }
});

test('the server-wide cap can never be configured above FatSecret’s own free limit', async () => {
  process.env.NUTRITION_FATSECRET_DAILY_CAP = '999999';
  try { assert.equal((await import('../nutrition/fatsecret.js')).SERVER_DAILY_CAP(), 5000); } finally { delete process.env.NUTRITION_FATSECRET_DAILY_CAP; }
  assert.equal((await import('../nutrition/fatsecret.js')).SERVER_DAILY_CAP(), 4000, 'the default leaves headroom');
});

/* ------------------------------ barcode ------------------------------ */

test('barcode: Open Food Facts first; FatSecret only when it does not know the code', async () => {
  const f = fake();
  f.off = () => ({ status: 1, product: off('012345678905', 'Known thing', 'Brand', 100) });
  const { lk } = build(f);
  const known = await lk.barcode('012345678905', { fatsecret: CLIENT, uid: 'u1' });
  assert.equal(known.found, true); assert.equal(known.product.source, 'off');
  assert.equal(f.apiCalls.length + f.tokenCalls.length, 0, 'FatSecret was not asked');

  const g = fake();
  g.off = () => ({ status: 0 });
  const b = build(g);
  const r = await b.lk.barcode('0044000032029', { fatsecret: CLIENT, uid: 'u1' });
  assert.equal(r.found, true);
  assert.equal(r.product.source, 'fatsecret');
  assert.equal(r.product.name, 'Taquitos, Beef & Cheese');
  const call = g.apiCalls[0].url;
  assert.match(call, /food\/barcode\/find-by-id\/v2\?barcode=0044000032029&format=json/);
  assert.match(g.tokenCalls[0].body, /scope=basic\+barcode|scope=basic%20barcode/);
});

test('barcode: the code is padded to 13 digits (UPC-A 12 → leading zero, EAN-8 → zeros) and a 14-digit GTIN with a leading 0 is shortened', async () => {
  const f = fake(); f.off = () => ({ status: 0 });
  const { lk } = build(f);
  await lk.barcode('036000291452', { fatsecret: CLIENT });
  await lk.barcode('96385074', { fatsecret: CLIENT });
  await lk.barcode('00012345678905', { fatsecret: CLIENT });
  assert.deepEqual(f.apiCalls.map(c => new URL(c.url).searchParams.get('barcode')), ['0036000291452', '0000096385074', '0012345678905']);
});

test('barcode: an edition without barcode lookup is named once and remembered, so every later scan skips the call', async () => {
  const f = fake(); f.off = () => ({ status: 0 }); f.mode.token = 'invalid_scope';
  const { lk } = build(f);
  const a = await lk.barcode('0044000032029', { fatsecret: CLIENT });
  assert.equal(a.found, false); assert.equal(a.reason, 'unknown');
  assert.deepEqual(a.fatsecret, { skipped: 'plan' });
  const tokenCalls = f.tokenCalls.length;
  await lk.barcode('0044000032111', { fatsecret: CLIENT });
  assert.equal(f.tokenCalls.length, tokenCalls, 'the second scan did not ask again');
});

test('barcode: FatSecret not knowing it is just "not found"; an outage is reported beside Open Food Facts’ answer, with a way to try again', async () => {
  const f = fake(); f.off = () => ({ status: 0 });
  f.barcode = () => ({ error: { code: 211, message: 'No food item detected for the barcode specified' } });
  const { lk } = build(f);
  const nf = await lk.barcode('0044000032029', { fatsecret: CLIENT });
  assert.deepEqual([nf.found, nf.reason], [false, 'unknown']);
  assert.deepEqual(nf.fatsecret, { ok: true, found: false }, 'the app can say it looked in both');

  const g = fake(); g.off = () => ({ status: 0 }); g.mode.api = 'timeout';
  const down = await build(g).lk.barcode('0044000032029', { fatsecret: CLIENT });
  assert.equal(down.found, false);
  assert.deepEqual([down.fatsecret.ok, down.fatsecret.kind], [false, 'timeout']);
  assert.equal(down.fatsecret.error, 'FatSecret did not answer in time.');
});

test('barcode: no keys means FatSecret is not involved at all', async () => {
  const f = fake(); f.off = () => ({ status: 0 });
  const { lk } = build(f);
  const r = await lk.barcode('0044000032029', {});
  assert.equal(r.found, false);
  assert.equal(f.tokenCalls.length, 0);
});

/* ------------------------------ through the routes: the secret, the budget, the privacy ------------------------------ */

const USERS = { a: { id: 'fsa' }, admin: { id: 'fsadm', admin: true } };
function routes(f, extra = {}) {
  for (const u of Object.values(USERS)) store.removeUser(u.id);
  fs.rmSync(path.join(DIR, 'nutrition', 'config.json'), { force: true });
  fs.rmSync(path.join(DIR, 'nutrition', 'fatsecret-usage.json'), { force: true });
  const logs = [];
  const orig = { error: console.error, log: console.log, warn: console.warn };
  const sink = (...a) => logs.push(a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
  console.error = sink; console.log = sink; console.warn = sink;
  const c = clock();
  const usage = createUsage({ file: path.join(DIR, 'nutrition', 'fatsecret-usage.json'), now: c.now });
  const fatsecret = createFatSecret({ fetch: f.fetch, now: c.now, sleep: async () => {}, timeoutMs: 1000, retryDelayMs: 0, usage });
  const lookup = createLookup({ fetch: f.fetch, now: c.now, sleep: async () => {}, timeoutMs: 1000, retryDelayMs: 0, fatsecret });
  const R = nutritionRoutes({
    json: (res, code, obj) => { res.status = code; res.out = obj; }, readBody: async q => q.body, readSession: q => q.user || null,
    requireAdmin: (q, r) => (q.user?.admin ? q.user : (r.status = 403, null)), lookup, fatsecret, analyzer: {}, limitAddress: () => '10.0.0.1', userActive: () => true, ...extra
  });
  const call = async (key, { as, body, url } = {}) => { const res = {}; await R[key]({ method: key.split(' ')[0], url: url || key.split(' ')[1], user: as ? USERS[as] : null, body, headers: {} }, res); return res; };
  return { call, logs, restore: () => Object.assign(console, orig), fatsecret };
}
const SAVE = { fatsecret: { clientId: CLIENT.clientId, clientSecret: CLIENT.clientSecret } };

test('admin: keys are saved encrypted, never echoed, never in the user config, never on disk in the clear; Remove turns the source off', async () => {
  const f = fake();
  const { call, restore } = routes(f);
  try {
    assert.equal((await call('PUT /api/admin/nutrition', { as: 'a', body: SAVE })).status, 403);
    const set = await call('PUT /api/admin/nutrition', { as: 'admin', body: SAVE });
    assert.equal(set.status, 200, JSON.stringify(set.out));
    assert.equal(set.out.fatsecretSet, true);
    assert.equal(set.out.fatsecretIdHint, '…0718');
    for (const out of [set.out, (await call('GET /api/admin/nutrition', { as: 'admin' })).out, (await call('GET /api/nutrition/config', { as: 'a' })).out]) {
      const s = JSON.stringify(out);
      assert.ok(!s.includes(CLIENT.clientSecret) && !s.includes(CLIENT.clientId), 'no key reaches a client');
    }
    assert.equal((await call('GET /api/nutrition/config', { as: 'a' })).out.lookup.fatsecret, true);
    const disk = fs.readFileSync(path.join(DIR, 'nutrition', 'config.json'), 'utf8');
    assert.ok(!disk.includes(CLIENT.clientSecret) && !disk.includes(CLIENT.clientId), 'encrypted at rest');
    assert.equal(cfg.fatsecretCreds().clientSecret, CLIENT.clientSecret);
    // Bad input is refused in words that do not echo it.
    for (const bad of [{ fatsecret: { clientId: 'x', clientSecret: 'y' } }, { fatsecret: { clientId: CLIENT.clientId } }, { fatsecret: 'nope' }, { fatsecret: { clientId: 'has space 12345', clientSecret: CLIENT.clientSecret } }]) {
      const r = await call('PUT /api/admin/nutrition', { as: 'admin', body: bad });
      assert.equal(r.status, 400); assert.ok(!JSON.stringify(r.out).includes(CLIENT.clientSecret));
    }
    assert.equal(cfg.fatsecretCreds().clientId, CLIENT.clientId, 'a refused change changes nothing');
    const gone = await call('PUT /api/admin/nutrition', { as: 'admin', body: { fatsecret: null } });
    assert.equal(gone.out.fatsecretSet, false);
    assert.equal(cfg.fatsecretCreds(), null);
    const s = await call('GET /api/nutrition/search', { as: 'a', url: '/api/nutrition/search?q=taquito&source=fatsecret' });
    assert.deepEqual(s.out.sources.fatsecret, { ok: false, skipped: 'no-key' });
  } finally { restore(); }
});

test('the Test button: a verdict in words and what the edition allows; wrong keys are named; the keys and token are not in the answer', async () => {
  const f = fake();
  const { call, logs, restore } = routes(f);
  try {
    assert.equal((await call('POST /api/admin/nutrition/test-fatsecret', { as: 'admin' })).status, 400);
    await call('PUT /api/admin/nutrition', { as: 'admin', body: SAVE });
    assert.equal((await call('POST /api/admin/nutrition/test-fatsecret', { as: 'a' })).status, 403);
    const ok = await call('POST /api/admin/nutrition/test-fatsecret', { as: 'admin' });
    assert.deepEqual([ok.out.ok, ok.out.count, ok.out.barcode], [true, 2, 'available']);
    f.mode.token = 'invalid_scope';
    const plan = await call('POST /api/admin/nutrition/test-fatsecret', { as: 'admin' });
    assert.equal(plan.out.barcode, 'not-in-plan');
    f.mode.token = 'invalid_client'; await call('PUT /api/admin/nutrition', { as: 'admin', body: SAVE });
    const wrong = await call('POST /api/admin/nutrition/test-fatsecret', { as: 'admin' });
    assert.deepEqual([wrong.out.ok, wrong.out.kind], [false, 'auth']);
    assert.match(wrong.out.error, /rejected the Client ID or Secret/);
    for (const out of [ok.out, plan.out, wrong.out]) assert.ok(!JSON.stringify(out).includes(CLIENT.clientSecret) && !JSON.stringify(out).includes(TOKEN));
    f.mode.token = 'invalid_client'; f.mode.api = 'ip';
    assert.ok(logs.every(l => !l.includes(CLIENT.clientSecret) && !l.includes(TOKEN)));
  } finally { restore(); }
});

test('the secret and the token are never logged, through every path: saving, searching, failing, wrong keys, refused IP, rate limit', async () => {
  const f = fake();
  const { call, logs, restore } = routes(f);
  try {
    await call('PUT /api/admin/nutrition', { as: 'admin', body: SAVE });
    const run = () => call('GET /api/nutrition/search', { as: 'a', url: '/api/nutrition/search?q=secret+taquito+words&source=fatsecret' });
    await run();
    for (const mode of ['ip', '429', 'limit', 'timeout', 'shape']) { f.mode.api = mode; await run(); }
    f.mode.api = null; f.mode.token = 'invalid_client'; await call('PUT /api/admin/nutrition', { as: 'admin', body: SAVE }); await run();
    await call('GET /api/nutrition/barcode', { as: 'a', url: '/api/nutrition/barcode?code=0044000032029' });
    const all = logs.join('\n');
    for (const secretish of [CLIENT.clientSecret, CLIENT.clientId, TOKEN, 'Bearer', 'Basic ', Buffer.from(`${CLIENT.clientId}:${CLIENT.clientSecret}`).toString('base64'), 'secret taquito words', '203.0.113.9']) {
      assert.ok(!all.includes(secretish), `a log line contains ${secretish.slice(0, 12)}…`);
    }
  } finally { restore(); }
});

test('through the route, the search sends FatSecret nothing but the search text; the barcode nothing but the digits', async () => {
  const f = fake(); f.off = () => ({ status: 0 });
  const { call, restore } = routes(f);
  try {
    await call('PUT /api/admin/nutrition', { as: 'admin', body: SAVE });
    await call('GET /api/nutrition/search', { as: 'a', url: '/api/nutrition/search?q=7-Eleven+taquitos&source=fatsecret' });
    await call('GET /api/nutrition/barcode', { as: 'a', url: '/api/nutrition/barcode?code=0044000032029' });
    for (const c of f.apiCalls) {
      const u = new URL(c.url);
      assert.ok([...u.searchParams.keys()].every(k => ['search_expression', 'max_results', 'page_number', 'barcode', 'format'].includes(k)), 'only search text, paging and format: ' + [...u.searchParams.keys()]);
      for (const needle of ['fsa', 'fsadm', 'Me', 'user', 'uid']) assert.ok(!c.url.includes('=' + needle), 'no profile identity');
    }
    assert.equal(new URL(f.apiCalls[0].url).searchParams.get('search_expression'), '7-Eleven taquitos');
  } finally { restore(); }
});

test('a FatSecret food logged to the diary keeps the numbers (the person’s own record) and goes to recents for 24 hours only', async () => {
  const f = fake();
  const { call, restore } = routes(f);
  try {
    await call('PUT /api/admin/nutrition', { as: 'admin', body: SAVE });
    const hit = (await call('GET /api/nutrition/search', { as: 'a', url: '/api/nutrition/search?q=taquito&source=fatsecret' })).out.results[0];
    const base = hit.bases[0];
    const add = await call('POST /api/nutrition/entries', { as: 'a', body: { date: '2026-10-12', meal: 'snack', source: 'food', qty: 2, food: { name: hit.name, brand: hit.brand, source: 'fatsecret', ext: hit.ext, serving: base.label, grams: base.grams, per: base.per } } });
    assert.equal(add.status, 201, JSON.stringify(add.out));
    const e = add.out.entries[0];
    assert.deepEqual([e.calories, e.protein_g, e.carbs_g, e.fat_g, e.qty], [380, 14, 40, 18, 2]);
    assert.equal(e.base.calories, 190);
    // Nothing else of FatSecret's came along: no url, no id beyond the food's own, no servings list.
    assert.deepEqual(Object.keys(store.read('fsa').foods).length, 1);
    const kept = Object.values(store.read('fsa').foods)[0];
    assert.equal(kept.source, 'fatsecret');
    assert.ok(!JSON.stringify(kept).includes('fatsecret.com'));
    assert.equal((await call('GET /api/nutrition/foods', { as: 'a', url: '/api/nutrition/foods?scope=recent' })).out.foods.length, 1);
    // 24 hours on it is gone from recents (and the file), while the diary entry still has its numbers.
    const d = store.read('fsa');
    Object.values(d.foods)[0].lastUsed = Date.now() - 25 * 3600 * 1000;
    const id = Object.keys(d.foods)[0];
    await store.mutate('fsa', x => { x.foods[id].lastUsed = Date.now() - 25 * 3600 * 1000; });
    assert.equal((await call('GET /api/nutrition/foods', { as: 'a', url: '/api/nutrition/foods?scope=recent' })).out.foods.length, 0);
    assert.equal((await call('GET /api/nutrition/day', { as: 'a', url: '/api/nutrition/day?date=2026-10-12' })).out.entries[0].calories, 380);
    // And it cannot be starred (that would be keeping it).
    await store.mutate('fsa', x => { x.foods[id].lastUsed = Date.now(); });
    const star = await call('PUT /api/nutrition/foods', { as: 'a', url: `/api/nutrition/foods?id=${id}`, body: { favorite: true } });
    assert.equal(star.status, 400);
    assert.match(star.out.error, /terms do not allow keeping/);
    // A new log after expiry sweeps the expired ones.
    await store.mutate('fsa', x => { x.foods[id].lastUsed = Date.now() - 25 * 3600 * 1000; });
    await call('POST /api/nutrition/entries', { as: 'a', body: { date: '2026-10-12', meal: 'snack', source: 'food', qty: 1, food: { name: 'Other', source: 'off', ext: '1', serving: '100 g', grams: 100, per: { calories: 10, protein_g: 1, carbs_g: 1, fat_g: 1 } } } });
    assert.ok(!Object.values(store.read('fsa').foods).some(x => x.source === 'fatsecret'));
  } finally { restore(); }
});

test('the search route’s source parameter accepts fatsecret and rejects anything else', async () => {
  const f = fake();
  const { call, restore } = routes(f);
  try {
    await call('PUT /api/admin/nutrition', { as: 'admin', body: SAVE });
    assert.equal((await call('GET /api/nutrition/search', { as: 'a', url: '/api/nutrition/search?q=taquito&source=fatsecret' })).status, 200);
    assert.equal((await call('GET /api/nutrition/search', { as: 'a', url: '/api/nutrition/search?q=taquito&source=nope' })).status, 400);
    assert.equal((await call('GET /api/nutrition/search', { url: '/api/nutrition/search?q=taquito&source=fatsecret' })).status, 401);
  } finally { restore(); }
});
