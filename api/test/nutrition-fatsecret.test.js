/* FatSecret Platform API (free Basic edition) as a third food source: foods.search v1 for the rows, food.get v5 for the real
   servings. Fixtures follow the examples in FatSecret's method pages (the McDonald's cheeseburger single-result object, the
   generic "Per 100g" mushrooms, an array, zero results) and their Error Codes guide (14 missing scope, 13 invalid token, 21 IP). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fatsecret-test-'));
process.env.DATA_DIR = DIR;
fs.writeFileSync(path.join(DIR, 'secret'), 'c'.repeat(64), { mode: 0o600 });
const { createFatSecret, createUsage, normaliseFood, normaliseSearchRow, sanitizeMessage, scopesOfToken } = await import('../nutrition/fatsecret.js');
const { microsFromFatSecret } = await import('../nutrition/micros-sources.js');
const { createLookup } = await import('../nutrition/lookup.js');
const { rankHits } = await import('../nutrition/rank.js');
const cfg = await import('../nutrition/config.js');
const store = await import('../nutrition/store.js');
const { nutritionRoutes } = await import('../nutrition/routes.js');

const CLIENT = { clientId: 'a1b2c3d4e5f60718', clientSecret: 'SECRETSECRET0123456789abcdef0123' };
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = scope => `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iss: 'fatsecret', scope })}.SIGNATUREPART`;
const tokenFor = n => jwt('basic') .replace('SIGNATUREPART', 'SIG' + n);
const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
const timeoutErr = () => Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });

/* ---- fixtures, shaped like the docs' examples ---- */
const CHEESEBURGER = { brand_name: "McDonald's", food_description: 'Per 1 serving - Calories: 300kcal | Fat: 13.00g | Carbs: 32.00g | Protein: 15.00g', food_id: '1', food_name: 'Cheeseburger', food_type: 'Brand', food_url: 'https://www.fatsecret.com/calories-nutrition/mcdonalds/cheeseburger' };
const MUSHROOMS = { food_description: 'Per 100g - Calories: 22kcal | Fat: 0.34g | Carbs: 3.26g | Protein: 3.09g', food_id: '35755', food_name: 'Mushrooms', food_type: 'Generic', food_url: 'https://www.fatsecret.com/calories-nutrition/usda/mushrooms' };
const TAQUITO = { brand_name: '7-Eleven', food_description: 'Per 1 taquito - Calories: 190kcal | Fat: 9.00g | Carbs: 20.00g | Protein: 7.00g', food_id: '3001', food_name: 'Taquitos, Beef & Cheese', food_type: 'Brand', food_url: 'https://www.fatsecret.com/x' };
const searchAnswer = foods => ({ foods: { max_results: '20', page_number: '0', total_results: String(foods.length), ...(foods.length === 0 ? {} : { food: foods.length === 1 ? foods[0] : foods }) } });

const serving = (id, desc, g, unit, cal, p, c, f, extra = {}) => ({
  serving_id: String(id), serving_description: desc, serving_url: 'https://www.fatsecret.com/y', metric_serving_amount: g == null ? undefined : g.toFixed(3), metric_serving_unit: unit,
  number_of_units: '1.000', measurement_description: 'serving', calories: String(cal), carbohydrate: String(c), protein: String(p), fat: String(f),
  saturated_fat: '4.5', polyunsaturated_fat: '0.5', monounsaturated_fat: '5.1', trans_fat: '0.3', cholesterol: '35', sodium: '710', potassium: '240', fiber: '1.5', sugar: '7', added_sugars: '2',
  vitamin_a: '0', vitamin_c: '0', vitamin_d: '0', calcium: '0', iron: '0', ...extra
});
const BRAND_FOOD = { food: { food_id: '1', food_name: 'Cheeseburger', food_type: 'Brand', brand_name: "McDonald's", food_url: 'https://www.fatsecret.com/z', servings: { serving: [serving(100, '1 burger (119 g)', 119, 'g', 300, 15, 32, 13), serving(0, '100 g', 100, 'g', 252, 12.6, 26.9, 10.9)] } } };
const GENERIC_FOOD = { food: { food_id: '35755', food_name: 'Mushrooms', food_type: 'Generic', food_url: 'https://www.fatsecret.com/z', servings: { serving: [
  serving(33, '1 cup, whole', 87, 'g', 19, 2.7, 2.8, 0.3, { measurement_description: 'cup, whole', vitamin_a: '0', vitamin_c: '1.7', vitamin_d: '0', calcium: '0', iron: '0.4' }),
  serving(34, '100 g', 100, 'g', 22, 3.09, 3.26, 0.34, { vitamin_a: '0', vitamin_c: '2', vitamin_d: '0.2', calcium: '3', iron: '0.5' })] } } };

/** A fake FatSecret: token endpoint + API, with counters and switches. */
function fake(over = {}) {
  const f = { tokenCalls: [], apiCalls: [], mode: {}, search: () => searchAnswer([CHEESEBURGER, TAQUITO]), foodGet: () => BRAND_FOOD, tokenLife: 86400, ...over };
  f.fetch = async (url, init = {}) => {
    url = String(url);
    if (url.includes('oauth.fatsecret.com')) {
      f.tokenCalls.push({ url, method: init.method, auth: init.headers?.Authorization, body: String(init.body), contentType: init.headers?.['Content-Type'] });
      if (f.mode.token === 'invalid_client') return json({ error: 'invalid_client' }, 401);
      if (f.mode.token === 'down') return json('oops', 503);
      return json({ access_token: f.jwtScope === undefined ? tokenFor(f.tokenCalls.length) : jwt(f.jwtScope).replace('SIGNATUREPART', 'S' + f.tokenCalls.length), expires_in: f.tokenLife, token_type: 'Bearer', scope: 'basic' });
    }
    if (url.includes('platform.fatsecret.com')) {
      f.apiCalls.push({ url, auth: init.headers?.Authorization });
      const m = f.mode.api;
      if (typeof m === 'function') { const r = m(f.apiCalls.length, url); if (r) return r; }
      else if (m === 'timeout') throw timeoutErr();
      else if (m === '429') return json('slow down', 429);
      else if (typeof m === 'object' && m) return json({ error: m });
      else if (m === 'shape') return json({ something: 'else' });
      if (url.includes('/food/v5')) return json(f.foodGet(url));
      return json(f.search(url));
    }
    if (url.includes('openfoodfacts')) return json(f.off ? f.off(url) : { products: [] });
    if (url.includes('nal.usda.gov')) return json(f.usda ? f.usda(url) : { foods: [] });
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
const searchFs = (lk, q = 'cheeseburger') => lk.search(q, { fatsecret: CLIENT, uid: 'u1', sources: 'fatsecret' });

/* ------------------------------ the request: v1 only, scope basic, nothing premier ------------------------------ */

test('search is foods.search v1 with only the documented basic parameters; no premier-only parameter is ever sent', async () => {
  const f = fake();
  const { fatsecret } = build(f);
  await fatsecret.search('cheeseburger', CLIENT);
  const u = new URL(f.apiCalls[0].url);
  assert.equal(u.origin + u.pathname, 'https://platform.fatsecret.com/rest/foods/search/v1');
  assert.deepEqual([...u.searchParams.keys()].sort(), ['format', 'max_results', 'page_number', 'search_expression']);
  assert.deepEqual([u.searchParams.get('search_expression'), u.searchParams.get('max_results'), u.searchParams.get('page_number'), u.searchParams.get('format')], ['cheeseburger', '20', '0', 'json']);
  for (const premier of ['generic_description', 'region', 'language', 'include_food_images', 'include_food_attributes', 'flag_default_serving', 'include_sub_categories']) assert.ok(!u.searchParams.has(premier), premier);
  assert.ok(!f.apiCalls[0].url.includes('/v4'), 'v4 is Premier Exclusive and fails with error 14 on a Basic key');
  assert.equal(f.tokenCalls[0].body, 'grant_type=client_credentials&scope=basic', 'only the basic scope is requested');
});

test('food.get v5 is asked only for the tapped food: food_id and format, nothing else; and cached', async () => {
  const f = fake();
  const { fatsecret } = build(f);
  await fatsecret.food('1', CLIENT);
  await fatsecret.food('1', CLIENT);
  assert.equal(f.apiCalls.length, 1, 'the second selection of the same food costs no call');
  const u = new URL(f.apiCalls[0].url);
  assert.equal(u.origin + u.pathname, 'https://platform.fatsecret.com/rest/food/v5');
  assert.deepEqual([...u.searchParams.keys()].sort(), ['food_id', 'format']);
});

/* ------------------------------ token handling ------------------------------ */

test('token: client credentials, Client ID and Secret as Basic auth; cached until it expires, then renewed; concurrent calls share one', async () => {
  const f = fake({ tokenLife: 3600 });
  const { fatsecret, c } = build(f);
  await Promise.all(['a1', 'b2', 'c3'].map(q => fatsecret.search(q, CLIENT)));
  assert.equal(f.tokenCalls.length, 1);
  const t = f.tokenCalls[0];
  assert.equal(t.url, 'https://oauth.fatsecret.com/connect/token'); assert.equal(t.method, 'POST');
  assert.equal(t.auth, 'Basic ' + Buffer.from(`${CLIENT.clientId}:${CLIENT.clientSecret}`).toString('base64'));
  assert.equal(t.contentType, 'application/x-www-form-urlencoded');
  assert.match(f.apiCalls[0].auth, /^Bearer /);
  assert.ok(!f.apiCalls[0].url.includes(CLIENT.clientSecret));
  c.advance(3600 * 1000 - 30 * 1000);
  await fatsecret.search('burrito', CLIENT);
  assert.equal(f.tokenCalls.length, 2, 'renewed inside the one-minute margin');
});

test('error 13 (invalid token): a new token is fetched once and the call repeated; if it is refused again it is named and not retried', async () => {
  const f = fake();
  let first = true;
  f.mode.api = () => { if (first) { first = false; return json({ error: { code: 13, message: 'Invalid access token' } }); } };
  const { lk } = build(f);
  const ok = await searchFs(lk);
  assert.equal(ok.sources.fatsecret.ok, true);
  assert.equal(f.tokenCalls.length, 2);
  const g = fake(); g.mode.api = { code: 13, message: 'Invalid access token' };
  const bad = await searchFs(build(g).lk);
  assert.equal(bad.sources.fatsecret.kind, 'auth');
  assert.match(bad.sources.fatsecret.error, /rejected the access token, even after getting a new one/);
  assert.equal(g.tokenCalls.length, 2); assert.equal(g.apiCalls.length, 2, 'refreshed once, then stopped');
});

test('wrong keys at the token endpoint: named, not retried', async () => {
  const f = fake(); f.mode.token = 'invalid_client';
  const { lk, logs } = build(f);
  const r = await searchFs(lk);
  assert.equal(r.sources.fatsecret.kind, 'auth');
  assert.match(r.sources.fatsecret.error, /rejected the Client ID or Secret.*Goals → Admin → FatSecret/);
  assert.equal(f.tokenCalls.length, 1); assert.equal(f.apiCalls.length, 0);
  assert.ok(logs.every(l => !l.includes(CLIENT.clientSecret) && !l.includes(CLIENT.clientId)));
});

/* ------------------------------ foods.search v1 rows ------------------------------ */

test('v1 single result arrives as an OBJECT (the McDonald’s cheeseburger): one hit, one base read from the summary line, flagged partial', async () => {
  const f = fake({ search: () => searchAnswer([CHEESEBURGER]) });
  assert.ok(!Array.isArray(f.search().foods.food), 'the fixture is the single-object form');
  const { fatsecret } = build(f);
  const hits = await fatsecret.search('cheeseburger', CLIENT);
  assert.equal(hits.length, 1);
  assert.deepEqual({ ...hits[0], bases: undefined }, { source: 'fatsecret', kind: 'brand', ext: '1', name: 'Cheeseburger', brand: "McDonald's", partial: true, bases: undefined });
  assert.deepEqual(hits[0].bases, [{ label: '1 serving', grams: null, per: { calories: 300, protein_g: 15, carbs_g: 32, fat_g: 13 } }]);
});

test('v1 generic "Per 100g" row (mushrooms): the label is 100 g with its weight; no brand', async () => {
  const f = fake({ search: () => searchAnswer([MUSHROOMS]) });
  const hit = (await build(f).fatsecret.search('mushrooms', CLIENT))[0];
  assert.deepEqual([hit.kind, hit.brand, hit.bases[0].label, hit.bases[0].grams], ['generic', '', '100 g', 100]);
  assert.deepEqual(hit.bases[0].per, { calories: 22, protein_g: 3.1, carbs_g: 3.3, fat_g: 0.3 });
});

test('v1 several results arrive as an ARRAY; zero results has no food key at all; both are handled', async () => {
  const f = fake({ search: () => searchAnswer([CHEESEBURGER, MUSHROOMS, TAQUITO]) });
  const { fatsecret } = build(f);
  assert.equal((await fatsecret.search('burger', CLIENT)).length, 3);
  f.search = () => searchAnswer([]);
  assert.ok(!('food' in f.search().foods));
  assert.deepEqual(await fatsecret.search('zzzzqx', CLIENT), []);
  const { lk } = build(fake({ search: () => searchAnswer([]) }));
  const r = await searchFs(lk, 'nothing here');
  assert.deepEqual(r.sources.fatsecret, { ok: true, count: 0 });
});

test('summary lines: servings with units, a weight in brackets, and rows that cannot be read are dropped, not shown as 0 kcal', () => {
  const row = d => normaliseSearchRow({ food_id: '9', food_name: 'X', food_type: 'Generic', food_description: d });
  assert.deepEqual([row('Per 100ml - Calories: 42kcal | Fat: 0.00g | Carbs: 10.60g | Protein: 0.00g').bases[0].label, row('Per 100ml - Calories: 42kcal | Fat: 0.00g | Carbs: 10.60g | Protein: 0.00g').bases[0].grams], ['100 ml', 100]);
  assert.deepEqual([row('Per 1 slice (28g) - Calories: 70kcal | Fat: 1.00g | Carbs: 13.00g | Protein: 3.00g').bases[0].label, row('Per 1 slice (28g) - Calories: 70kcal | Fat: 1.00g | Carbs: 13.00g | Protein: 3.00g').bases[0].grams], ['1 slice (28g)', 28]);
  assert.equal(row('Per 1 cup - Calories: 100kcal | Fat: 1.00g | Carbs: 1.00g | Protein: 1.00g').bases[0].grams, null);
  assert.equal(row('Per 5000g - Calories: 100kcal | Fat: 1.00g | Carbs: 1.00g | Protein: 1.00g').bases[0].grams, null, 'not a believable serving weight');
  for (const bad of [undefined, '', 'Calories: 300kcal', 'Per 1 serving - Calories: x', 'Per 1 serving - Fat: 3g']) assert.equal(row(bad), null, String(bad));
  assert.equal(normaliseSearchRow({ food_name: 'X', food_description: 'Per 1 serving - Calories: 1kcal | Fat: 1g | Carbs: 1g | Protein: 1g' }), null, 'no food_id');
  assert.equal(normaliseSearchRow(null), null);
});

/* ------------------------------ food.get v5 ------------------------------ */

test('food.get v5 for a Brand food: the real serving first, the derived 100 g (serving_id 0) last, the numbers FatSecret gives for each', () => {
  const hit = normaliseFood(BRAND_FOOD.food);
  assert.deepEqual({ source: hit.source, kind: hit.kind, ext: hit.ext, name: hit.name, brand: hit.brand }, { source: 'fatsecret', kind: 'brand', ext: '1', name: 'Cheeseburger', brand: "McDonald's" });
  assert.ok(!('partial' in hit));
  assert.deepEqual(hit.bases.map(b => [b.label, b.grams, b.per.calories]), [['1 burger (119 g)', 119, 300], ['100 g', 100, 252]]);
});

test('food.get v5 for a Generic food: several real servings, then 100 g; single-serving objects work too', () => {
  const hit = normaliseFood(GENERIC_FOOD.food);
  assert.equal(hit.kind, 'generic');
  assert.deepEqual(hit.bases.map(b => b.label), ['1 cup, whole (87 g)', '100 g']);
  const one = normaliseFood({ food_id: '5', food_name: 'Solo', food_type: 'Generic', servings: { serving: serving(7, '1 piece', 40, 'g', 100, 1, 1, 1) } });
  assert.deepEqual(one.bases.map(b => b.label), ['1 piece (40 g)']);
});

test('a serving of 1 oz and 100 g (the other derived forms), unbelievable weights and missing calories', () => {
  const hit = normaliseFood({ food_id: '5', food_name: 'Cheese', food_type: 'Brand', brand_name: 'B', servings: { serving: [
    serving(0, '1 oz', 28.35, 'g', 110, 7, 0.4, 9), serving(0, '100 g', 100, 'g', 390, 25, 1.4, 32), serving(8, '1 case', 5000, 'g', 9000, 1, 1, 1), serving(9, 'no calories', 10, 'g', undefined, 1, 1, 1)] } });
  assert.deepEqual(hit.bases.map(b => [b.label, b.grams]), [['1 oz (28.4 g)', 28.4], ['1 case', null], ['100 g', 100]]);
});

/* ------------------------------ micronutrients from FatSecret ------------------------------ */

test('micros: the amounts the docs list are mapped (vitamin A mcg, C mg, D mcg, calcium mg, iron mg, …)', () => {
  const s = serving(1, '1 x', 100, 'g', 100, 1, 1, 1, { vitamin_a: '120', vitamin_c: '9', vitamin_d: '2.5', calcium: '80', iron: '1.2' });
  assert.deepEqual(microsFromFatSecret(s, { brand: false }), { fiber_g: 1.5, sugar_g: 7, satfat_g: 4.5, sodium_mg: 710, cholesterol_mg: 35, potassium_mg: 240, vit_a_mcg: 120, vit_c_mg: 9, vit_d_mcg: 2.5, calcium_mg: 80, iron_mg: 1.2 });
});

test('micros: a Brand food’s 0 for vitamin A, C, D, calcium and iron is UNKNOWN (not provided), but its fibre, sodium and other stated fields stay real; positive values stay', () => {
  const brandZeros = microsFromFatSecret(serving(1, '1', 100, 'g', 100, 1, 1, 1), { brand: true });
  for (const k of ['vit_a_mcg', 'vit_c_mg', 'vit_d_mcg', 'calcium_mg', 'iron_mg']) assert.ok(!(k in brandZeros), k + ' is unknown for a Brand food reporting 0');
  assert.deepEqual([brandZeros.sodium_mg, brandZeros.fiber_g, brandZeros.potassium_mg], [710, 1.5, 240]);
  const some = microsFromFatSecret(serving(1, '1', 100, 'g', 100, 1, 1, 1, { vitamin_a: '0', calcium: '150', iron: '0' }), { brand: true });
  assert.deepEqual([some.calcium_mg, 'iron_mg' in some, 'vit_a_mcg' in some], [150, false, false]);
  const zerosAreSodium0 = microsFromFatSecret(serving(1, '1', 100, 'g', 10, 0, 0, 0, { sodium: '0', fiber: '0' }), { brand: true });
  assert.deepEqual([zerosAreSodium0.sodium_mg, zerosAreSodium0.fiber_g], [0, 0]);
});

test('micros: a Generic food’s zeros are trusted; through normaliseFood the Brand rule applies to the derived 100 g serving too', () => {
  const g = normaliseFood(GENERIC_FOOD.food);
  assert.equal(g.bases[0].micros.vit_a_mcg, 0); assert.equal(g.bases[0].micros.vit_c_mg, 1.7); assert.equal(g.bases[1].micros.calcium_mg, 3);
  const b = normaliseFood(BRAND_FOOD.food);
  for (const base of b.bases) { for (const k of ['vit_a_mcg', 'vit_c_mg', 'vit_d_mcg', 'calcium_mg', 'iron_mg']) assert.ok(!(k in base.micros), k); assert.equal(base.micros.sodium_mg, 710); }
  assert.deepEqual(microsFromFatSecret({}, {}), {}); assert.deepEqual(microsFromFatSecret(null), {});
});

/* ------------------------------ ranking and the other sources ------------------------------ */

const off = (code, name, brands, kcal) => ({ code, product_name: name, brands, nutriments: { 'energy-kcal_100g': kcal, proteins_100g: 5, carbohydrates_100g: 5, fat_100g: 5 }, countries_tags: ['en:united-states'], lang: 'en' });
const fdc = (id, description, dataType, kcal) => ({ fdcId: id, description, dataType, foodNutrients: [{ nutrientId: 1008, value: kcal }, { nutrientId: 1003, value: 5 }, { nutrientId: 1004, value: 5 }, { nutrientId: 1005, value: 5 }] });

test('"7-Eleven taquitos": the others have nothing, FatSecret has it, and it is shown with its source', async () => {
  const f = fake();
  const { lk } = build(f);
  const r = await lk.search('7-Eleven taquitos', { usdaKey: 'KEY12345', fatsecret: CLIENT, uid: 'u1' });
  assert.deepEqual([r.sources.off, r.sources.usda, r.sources.fatsecret], [{ ok: true, count: 0 }, { ok: true, count: 0 }, { ok: true, count: 1 }]);
  assert.deepEqual(r.results.map(h => [h.source, h.brand, h.name]), [['fatsecret', '7-Eleven', 'Taquitos, Beef & Cheese']]);
});

test('ranking with all three sources: every typed word must match; reference USDA first for a generic query; no duplicates', async () => {
  const f = fake();
  f.search = () => searchAnswer([
    { ...MUSHROOMS, food_name: 'Egg', food_description: 'Per 100g - Calories: 143kcal | Fat: 9.50g | Carbs: 0.70g | Protein: 12.60g' },
    { ...CHEESEBURGER, food_id: '10', food_name: 'Egg McMuffin', brand_name: "McDonald's" },
    { ...TAQUITO, food_id: '11', food_name: 'Egg Salad Sandwich' },
    { ...TAQUITO, food_id: '12', food_name: 'Ham Sandwich' }
  ]);
  f.off = () => ({ products: [off('1', 'Egg', '', 143), off('2', 'Egg Salad Sandwich', '7-Eleven', 230)] });
  f.usda = u => (u.includes('Foundation') ? { foods: [fdc(748967, 'Egg, whole, raw, fresh', 'Foundation', 143)] } : { foods: [] });
  const { lk } = build(f);
  const r = await lk.search('egg', { usdaKey: 'KEY12345', fatsecret: CLIENT, uid: 'u1' });
  const lines = r.results.map(h => `${h.source}:${h.name}`);
  assert.equal(lines[0], 'usda:Egg, whole, raw, fresh');
  assert.ok(!lines.some(l => /Ham/.test(l)));
  assert.equal(lines.filter(l => l === 'fatsecret:Egg').length + lines.filter(l => l === 'off:Egg').length, 1);
  for (let i = 1; i < r.results.length; i++) assert.ok(r.results[i - 1].rank >= r.results[i].rank);
});

test('a restaurant or convenience-store item whose typed words include its brand outranks a plain match of the same closeness', () => {
  const hit = (source, name, brand) => ({ source, kind: source === 'fatsecret' ? 'brand' : 'off', ext: name + brand, name, brand, bases: [{ label: '100 g', grams: 100, per: { calories: 200, protein_g: 5, carbs_g: 20, fat_g: 8 } }] });
  assert.deepEqual(rankHits([hit('off', 'Hot dog', 'Local Brand'), hit('fatsecret', 'Hot dog', '7-Eleven')], '7-eleven hot dog').map(h => h.source), ['fatsecret']);
  assert.equal(rankHits([hit('off', 'Taquitos', 'Local Brand'), hit('fatsecret', 'Taquitos', '7-Eleven')], 'taquitos')[0].source, 'off', 'no brand typed: no boost');
  assert.equal(rankHits([hit('off', 'Taquitos 7-Eleven style', 'Other'), hit('fatsecret', 'Taquitos', '7-Eleven')], '7-eleven taquitos')[0].source, 'fatsecret');
});

test('fallback: when Open Food Facts and USDA find nothing relevant, FatSecret’s results are still the answer', async () => {
  const f = fake({ search: () => searchAnswer([{ ...CHEESEBURGER, food_name: 'Big Bite Hot Dog', brand_name: '7-Eleven' }]) });
  f.off = () => ({ products: [off('1', 'Unrelated cereal', 'Kellogg', 380)] });
  f.usda = () => ({ foods: [fdc(1, 'Cheese, parmesan', 'Foundation', 431)] });
  const r = await build(f).lk.search('big bite hot dog', { usdaKey: 'KEY12345', fatsecret: CLIENT, uid: 'u1' });
  assert.deepEqual(r.results.map(h => h.name), ['Big Bite Hot Dog']);
});

test('no keys: FatSecret is off, says so, and is never contacted; the other sources are unaffected when it fails', async () => {
  const f = fake();
  const { lk } = build(f);
  assert.deepEqual((await lk.search('taquito', { fatsecret: null })).sources.fatsecret, { ok: false, skipped: 'no-key' });
  assert.equal(f.tokenCalls.length + f.apiCalls.length, 0);
  const g = fake(); g.mode.api = 'timeout'; g.off = () => ({ products: [off('1', 'Taquitos', 'Rolando', 250)] });
  const r = await build(g).lk.search('taquitos', { fatsecret: CLIENT, uid: 'u1' });
  assert.equal(r.sources.fatsecret.ok, false); assert.deepEqual(r.results.map(h => h.source), ['off']);
});

/* ------------------------------ errors, in plain words, by code ------------------------------ */

test('code 14 is MISSING SCOPE (not a rate limit): the key does not include this feature; not retried; the code is logged, no address or text', async () => {
  const f = fake(); f.mode.api = { code: 14, message: 'Missing scope: premier' };
  const { lk, logs } = build(f);
  const r = await searchFs(lk, 'secret taquito words');
  assert.equal(r.sources.fatsecret.kind, 'plan');
  assert.equal(r.sources.fatsecret.error, 'Your FatSecret key does not include this feature; the free Basic edition has no access to it.');
  assert.ok(!/rate/i.test(r.sources.fatsecret.error));
  assert.equal(f.apiCalls.length, 1, 'never retried');
  assert.ok(logs.some(l => /fatsecret search failed: plan \(code 14\)/.test(l)), logs.join('\n'));
  assert.ok(logs.every(l => !/secret taquito|Missing scope/.test(l)));
});

test('code 21 is the IP address: register the server’s public IP; not retried; the echoed address is not logged', async () => {
  const f = fake(); f.mode.api = { code: 21, message: "Invalid IP address detected: '203.0.113.9'" };
  const { lk, logs } = build(f);
  const r = await searchFs(lk);
  assert.equal(r.sources.fatsecret.kind, 'ip');
  assert.match(r.sources.fatsecret.error, /add the server’s public IP address.*IP Restrictions/);
  assert.equal(f.apiCalls.length, 1);
  assert.ok(logs.some(l => /search failed: ip \(code 21\)/.test(l)));
  assert.ok(logs.every(l => !l.includes('203.0.113.9')));
});

test('the documented rate-limit codes (11, 12) and HTTP 429 are rate limits and are not retried; other codes are NOT called rate limits', async () => {
  for (const mode of [{ code: 11, message: 'x' }, { code: 12, message: 'x' }, '429']) {
    const f = fake(); f.mode.api = mode;
    const r = await searchFs(build(f).lk);
    assert.equal(r.sources.fatsecret.kind, 'rate', JSON.stringify(mode));
    assert.match(r.sources.fatsecret.error, /rate-limiting requests/);
    assert.equal(f.apiCalls.length, 1, JSON.stringify(mode));
  }
  for (const code of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 15, 22, 24, 106]) {
    const f = fake(); f.mode.api = { code, message: 'Too many requests, limit exceeded' };       // wording that once fooled a guess
    const r = await searchFs(build(f).lk);
    assert.notEqual(r.sources.fatsecret.kind, 'rate', 'code ' + code);
    assert.match(r.sources.fatsecret.error, new RegExp(`error \\(code ${code}\\)`), 'the code is shown');
    assert.equal(f.apiCalls.length, 1, 'an unknown code is never retried');
  }
});

test('timeout: one automatic retry that can succeed; two timeouts are a timeout; an outage is "not answering"', async () => {
  const f = fake(); f.mode.api = n => { if (n === 1) throw timeoutErr(); };
  assert.equal((await searchFs(build(f).lk)).sources.fatsecret.ok, true); assert.equal(f.apiCalls.length, 2);
  const g = fake(); g.mode.api = 'timeout';
  const bad = await searchFs(build(g).lk);
  assert.deepEqual([bad.sources.fatsecret.kind, bad.sources.fatsecret.error, g.apiCalls.length], ['timeout', 'FatSecret did not answer in time.', 2]);
  const h = fake(); h.mode.api = () => json('boom', 503);
  const down = await searchFs(build(h).lk);
  assert.deepEqual([down.sources.fatsecret.kind, down.sources.fatsecret.error], ['down', 'FatSecret is not answering right now.']);
});

test('an answer that is JSON but not the documented shape is a failure, logged by key names only; a v4-shaped answer is not accepted as v1', async () => {
  const f = fake(); f.mode.api = 'shape';
  const { lk, logs } = build(f);
  assert.equal((await searchFs(lk, 'taquito')).sources.fatsecret.kind, 'bad');
  assert.ok(logs.some(l => /shape-something/.test(l)));
  assert.ok(logs.every(l => !/taquito/i.test(l)));
  const g = fake({ search: () => ({ foods_search: { results: { food: [] } } }) });
  assert.equal((await searchFs(build(g).lk)).sources.fatsecret.kind, 'bad');
});

test('FatSecret’s message is sanitised before it is shown: addresses, token-shaped strings, control characters, length', () => {
  assert.equal(sanitizeMessage("Invalid IP address detected: '203.0.113.9' and 2001:db8:85a3::8a2e:370:7334"), "Invalid IP address detected: '[address]' and [address]");
  assert.equal(sanitizeMessage('token ' + 'A'.repeat(60) + ' bad'), 'token [hidden] bad');
  assert.equal(sanitizeMessage('a\u0000b\nc'), 'a b c');
  assert.equal(sanitizeMessage('x'.repeat(500)).length <= 160, true);
  assert.equal(sanitizeMessage(undefined), '');
});

/* ------------------------------ budgets ------------------------------ */

test('rate protection: per-profile and server-wide daily budgets stop calls before FatSecret is asked; a food.get costs one call like a search', async () => {
  const f = fake();
  const c = clock();
  const file = path.join(DIR, 'usage-a.json');
  process.env.NUTRITION_FATSECRET_USER_CAP = '3'; process.env.NUTRITION_FATSECRET_DAILY_CAP = '5';
  try {
    const usage = createUsage({ file, now: c.now });
    const { lk, fatsecret } = build(f, { usage, clock: c });
    for (let i = 0; i < 2; i++) assert.equal((await lk.search('q' + i + 'x', { fatsecret: CLIENT, uid: 'alice', sources: 'fatsecret' })).sources.fatsecret.ok, true);
    await fatsecret.food('1', CLIENT, { uid: 'alice' });
    const user = await lk.search('q9x', { fatsecret: CLIENT, uid: 'alice', sources: 'fatsecret' });
    assert.equal(user.sources.fatsecret.kind, 'limit');
    assert.match(user.sources.fatsecret.error, /used today’s FatSecret lookups \(3 per person\).*midnight UTC/);
    assert.equal(f.apiCalls.length, 3);
    await lk.search('b1x', { fatsecret: CLIENT, uid: 'bob', sources: 'fatsecret' }); await lk.search('b2x', { fatsecret: CLIENT, uid: 'bob', sources: 'fatsecret' });
    const server = await lk.search('b3x', { fatsecret: CLIENT, uid: 'bob', sources: 'fatsecret' });
    assert.match(server.sources.fatsecret.error, /This server has used its FatSecret budget for today \(5 of the free 5,000 calls\)/);
    assert.equal(createUsage({ file, now: c.now }).snapshot().used, 5, 'kept across a restart');
    c.advance(24 * 3600 * 1000);
    assert.equal(createUsage({ file, now: c.now }).take('alice'), null);
  } finally { delete process.env.NUTRITION_FATSECRET_USER_CAP; delete process.env.NUTRITION_FATSECRET_DAILY_CAP; }
});

test('the server-wide cap can never be configured above FatSecret’s own free limit', async () => {
  const m = await import('../nutrition/fatsecret.js');
  process.env.NUTRITION_FATSECRET_DAILY_CAP = '999999';
  try { assert.equal(m.SERVER_DAILY_CAP(), 5000); } finally { delete process.env.NUTRITION_FATSECRET_DAILY_CAP; }
  assert.equal(m.SERVER_DAILY_CAP(), 4000);
});

/* ------------------------------ the Test button ------------------------------ */

test('Test: token OK with the granted scopes read from the JWT, then a one-result v1 search for "apple"; not counted in the budget; the token is never in the answer', async () => {
  const f = fake({ search: () => searchAnswer([{ ...CHEESEBURGER, food_name: 'Apple', food_description: 'Per 1 medium - Calories: 95kcal | Fat: 0.31g | Carbs: 25.13g | Protein: 0.47g' }]) });
  f.jwtScope = 'basic';
  const usage = createUsage({ file: path.join(DIR, 'usage-t.json') });
  const { fatsecret, logs } = build(f, { usage });
  const r = await fatsecret.test(CLIENT);
  assert.deepEqual(r, { token: { ok: true, scopes: ['basic'] }, search: { ok: true, count: 1 } });
  const u = new URL(f.apiCalls[0].url);
  assert.deepEqual([u.pathname, u.searchParams.get('search_expression'), u.searchParams.get('max_results')], ['/rest/foods/search/v1', 'apple', '1']);
  assert.equal(usage.snapshot().used, 0, 'Test presses are not counted against the daily budget');
  await fatsecret.test(CLIENT); await fatsecret.test(CLIENT);
  assert.equal(usage.snapshot().used, 0);
  assert.ok(!JSON.stringify(r).includes('SIG') && !JSON.stringify(r).includes('eyJ'));
  assert.ok(logs.every(l => !l.includes('SIG')));
});

test('Test: several scopes, an array scope claim, and a token that is not a JWT (falls back to the answer’s own scope field)', async () => {
  assert.deepEqual(scopesOfToken(jwt('basic premier')), ['basic', 'premier']);
  assert.deepEqual(scopesOfToken(jwt(['basic', 'barcode'])), ['basic', 'barcode']);
  assert.deepEqual(scopesOfToken('opaque-token', 'basic'), ['basic']);
  assert.equal(scopesOfToken('opaque-token'), null);
  assert.equal(scopesOfToken(`a.${Buffer.from('not json').toString('base64url')}.c`), null);
  const f = fake(); f.jwtScope = 'basic premier';
  assert.deepEqual((await build(f).fatsecret.test(CLIENT)).token.scopes, ['basic', 'premier']);
});

test('Test: code 14 on the search shows the exact code, its message and its meaning; code 21 and wrong keys likewise', async () => {
  const f = fake(); f.mode.api = { code: 14, message: 'Missing scope: basic' };
  const r = await build(f).fatsecret.test(CLIENT);
  assert.equal(r.token.ok, true);
  assert.deepEqual([r.search.ok, r.search.kind, r.search.code, r.search.message], [false, 'plan', 14, 'Missing scope: basic']);
  assert.match(r.search.meaning, /^Missing scope: Your FatSecret key does not include this feature/);
  const g = fake(); g.mode.api = { code: 21, message: "Invalid IP address detected: '198.51.100.7'" };
  const ip = (await build(g).fatsecret.test(CLIENT)).search;
  assert.deepEqual([ip.kind, ip.code, ip.message], ['ip', 21, "Invalid IP address detected: '[address]'"]);
  const h = fake(); h.mode.token = 'invalid_client';
  const bad = await build(h).fatsecret.test(CLIENT);
  assert.deepEqual([bad.token.ok, bad.token.kind, bad.search], [false, 'auth', null]);
});

/* ------------------------------ barcode: not a FatSecret feature on Basic ------------------------------ */

test('barcode: only Open Food Facts; FatSecret is never contacted (its barcode lookup is Premier Exclusive)', async () => {
  const f = fake(); f.off = () => ({ status: 0 });
  const { lk } = build(f);
  const r = await lk.barcode('0044000032029', { fatsecret: CLIENT, uid: 'u1' });
  assert.deepEqual([r.found, r.reason], [false, 'unknown']);
  assert.equal(f.tokenCalls.length + f.apiCalls.length, 0);
  assert.ok(!('fatsecret' in r));
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

test('the Test button: token, granted scopes and search verdict; the plan limit and wrong keys are named; the keys and token are not in the answer', async () => {
  const f = fake(); f.jwtScope = 'basic';
  const { call, logs, restore } = routes(f);
  try {
    assert.equal((await call('POST /api/admin/nutrition/test-fatsecret', { as: 'admin' })).status, 400);
    await call('PUT /api/admin/nutrition', { as: 'admin', body: SAVE });
    assert.equal((await call('POST /api/admin/nutrition/test-fatsecret', { as: 'a' })).status, 403);
    const ok = await call('POST /api/admin/nutrition/test-fatsecret', { as: 'admin' });
    assert.deepEqual([ok.out.ok, ok.out.token, ok.out.search], [true, { ok: true, scopes: ['basic'] }, { ok: true, count: 2 }]);
    f.mode.api = { code: 14, message: 'Missing scope: premier' };
    const plan = await call('POST /api/admin/nutrition/test-fatsecret', { as: 'admin' });
    assert.deepEqual([plan.out.ok, plan.out.token.ok, plan.out.search.code, plan.out.search.kind], [false, true, 14, 'plan']);
    f.mode.api = null; f.mode.token = 'invalid_client'; await call('PUT /api/admin/nutrition', { as: 'admin', body: SAVE });
    const wrong = await call('POST /api/admin/nutrition/test-fatsecret', { as: 'admin' });
    assert.deepEqual([wrong.out.ok, wrong.out.token.ok, wrong.out.token.kind], [false, false, 'auth']);
    assert.match(wrong.out.token.text, /rejected the Client ID or Secret/);
    for (const out of [ok.out, plan.out, wrong.out]) assert.ok(!JSON.stringify(out).includes(CLIENT.clientSecret) && !JSON.stringify(out).includes('eyJ') && !JSON.stringify(out).includes('SIG'));
    assert.ok(logs.every(l => !l.includes(CLIENT.clientSecret) && !l.includes('eyJ')));
  } finally { restore(); }
});

test('the secret and the token are never logged, through every path: saving, searching, failing, wrong keys, refused IP, rate limit', async () => {
  const f = fake();
  const { call, logs, restore } = routes(f);
  try {
    await call('PUT /api/admin/nutrition', { as: 'admin', body: SAVE });
    const run = () => call('GET /api/nutrition/search', { as: 'a', url: '/api/nutrition/search?q=secret+taquito+words&source=fatsecret' });
    await run();
    for (const mode of [{ code: 21, message: 'ip 203.0.113.9' }, { code: 14, message: 'Missing scope' }, '429', { code: 11, message: 'x' }, 'timeout', 'shape']) { f.mode.api = mode; await run(); }
    f.mode.api = null; f.mode.token = 'invalid_client'; await call('PUT /api/admin/nutrition', { as: 'admin', body: SAVE }); await run();
    const all = logs.join('\n');
    for (const secretish of [CLIENT.clientSecret, CLIENT.clientId, 'eyJ', 'Bearer', 'Basic ', Buffer.from(`${CLIENT.clientId}:${CLIENT.clientSecret}`).toString('base64'), 'secret taquito words', '203.0.113.9']) {
      assert.ok(!all.includes(secretish), `a log line contains ${secretish.slice(0, 12)}…`);
    }
  } finally { restore(); }
});

test('through the route, the search sends FatSecret nothing but the search text, paging and format; a tapped food nothing but its id', async () => {
  const f = fake(); f.off = () => ({ status: 0 });
  const { call, restore } = routes(f);
  try {
    await call('PUT /api/admin/nutrition', { as: 'admin', body: SAVE });
    await call('GET /api/nutrition/search', { as: 'a', url: '/api/nutrition/search?q=7-Eleven+taquitos&source=fatsecret' });
    const one = await call('GET /api/nutrition/fatsecret/food', { as: 'a', url: '/api/nutrition/fatsecret/food?id=1' });
    assert.equal(one.status, 200, JSON.stringify(one.out));
    assert.equal((await call('GET /api/nutrition/fatsecret/food', { as: 'a', url: '/api/nutrition/fatsecret/food?id=1;x' })).status, 400);
    for (const c of f.apiCalls) {
      const u = new URL(c.url);
      assert.ok([...u.searchParams.keys()].every(k => ['search_expression', 'max_results', 'page_number', 'food_id', 'format'].includes(k)), 'only search text, paging and format: ' + [...u.searchParams.keys()]);
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
