/* The NIH supplement label database client and the supplement barcode lookup order. The DSLD answers here are FIXTURES shaped like the
   live service as checked on 2026-10-21 (see scripts/verify-dsld.mjs): search hits carry NO barcode; a label's upcSku is a SPACED string;
   only a QUOTED, SPACED search ("0 31604 02697 4") finds a label by barcode; the bare digits find nothing. */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { tempData } from './helpers.mjs';

tempData();
const D = await import('../nutrition/dsld.js');
const { createLookup } = await import('../nutrition/lookup.js');
const { createDsldBudget, createBudget } = await import('../nutrition/usda-budget.js');
const { nutritionRoutes } = await import('../nutrition/routes.js');
const store = await import('../nutrition/store.js');
const ncfg = await import('../nutrition/config.js');

const json = (body, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });
const UPC = '012345678905';
const hit = (id, extra = {}) => ({ _id: String(id), _source: { fullName: 'Daily Multi', brandName: 'Brightwell', offMarket: 0, entryDate: '2020-01-01', ...extra } });
const SEARCH = { hits: { total: 4, hits: [hit(1001, { entryDate: '2019-03-01' }), hit(1002, { entryDate: '2022-05-01', offMarket: 1 }), hit(1003, { entryDate: '2021-01-01' }), hit(1004, { fullName: 'Other thing' })] } };
const row = (name, qty, unit, extra = {}) => ({ name, quantity: [{ servingSizeOrder: 1, quantity: qty, unit, ...(extra.pct ? { dailyValueTargetGroup: [{ percent: extra.pct }] } : {}) }], forms: extra.form ? [{ name: extra.form }] : [], nestedRows: extra.nested || [] });
const LABEL = id => ({ id: Number(id), fullName: 'Daily Multi', brandName: 'Brightwell', upcSku: id === '1004' ? '9 99999 99999 9' : id === '1003' ? '0 12345-67890 5' : '0 12345 67890 5', offMarket: id === '1002' ? 1 : 0, entryDate: { 1001: '2019-03-01', 1002: '2022-05-01', 1003: '2021-01-01' }[id] || '2020-01-01',
  servingSizes: [{ order: 1, minQuantity: 2, maxQuantity: 2, unit: 'Capsule(s)' }], servingsPerContainer: 30,
  ingredientRows: [row('Vitamin D3', 1000, 'IU', { pct: 125, form: 'Cholecalciferol' }), row('Vitamin C', 90, 'mg', { pct: 100 }), row('Folate', 400, 'mcg DFE'), row('Calories', 5, 'Calorie(s)'), row('Creatine Monohydrate', 3, 'Gram(s)'), row('Blend', null, '', { nested: [row('Ashwagandha', 300, 'mg')] })],
  otherIngredients: { text: 'Gelatin, rice flour.' } });

const SPACED = '"0 12345 67890 5"';
/** The live behaviour: only the quoted, spaced form finds the labels; anything else answers with no hits. */
const realSearch = url => (new URL(url).searchParams.get('q') === SPACED ? json(SEARCH) : json({ hits: { total: 0, hits: [] } }));
function fakeNet({ search = realSearch, label = id => json(LABEL(id)), off = () => json({ status: 0 }), usda = () => json({ foods: [] }) } = {}) {
  const f = { urls: [], dsld: 0, off: 0, usda: 0 };
  f.fetch = async (url, init = {}) => {
    url = String(url); f.urls.push(url);
    if (url.includes('ods.od.nih.gov')) { f.dsld++; const m = url.match(/\/label\/(\d+)/); return m ? label(m[1]) : search(url); }
    if (url.includes('openfoodfacts')) { f.off++; return off(url); }
    if (url.includes('nal.usda.gov')) { f.usda++; return usda(url, init); }
    throw new Error('unexpected url ' + url);
  };
  return f;
}
const mk = (f, o = {}) => createLookup({ fetch: f.fetch, sleep: async () => {}, timeoutMs: 1000, retryDelayMs: 0, ...o });

/* ------------------------------ parsing ------------------------------ */

test('barcodes that are spelled differently are the same product (UPC-A, EAN-13 with a leading 0, spaces, hyphens)', () => {
  assert.equal(D.sameBarcode('012345678905', '0012345678905'), true);
  assert.equal(D.sameBarcode('0 12345-67890 5', '012345678905'), true);
  assert.equal(D.sameBarcode('012345678905', '012345678906'), false);
  assert.equal(D.sameBarcode('', ''), false); assert.equal(D.sameBarcode('123', '123'), false);
});

test('the search answer is read in both shapes the guide suggests; garbage is "not the shape", not a crash', () => {
  assert.deepEqual(D.parseSearch(SEARCH).map(h => [h.id, h.offMarket, h.date]), [['1001', false, '2019-03-01'], ['1002', true, '2022-05-01'], ['1003', false, '2021-01-01'], ['1004', false, '2020-01-01']]);
  assert.deepEqual(D.parseSearch([{ id: 7, fullName: 'Flat one', brandName: 'B', upcSku: UPC, offMarket: '1' }]).map(h => [h.id, h.name, h.offMarket]), [['7', 'Flat one', true]]);
  assert.equal(D.parseSearch({ nothing: 1 }), null); assert.equal(D.parseSearch('x'), null);
  assert.deepEqual(D.parseSearch({ hits: { hits: [] } }), []);
  assert.deepEqual(D.parseSearch({ hits: [{ _source: { fullName: 'no id' } }, { _id: '../etc', _source: {} }] }), [], 'an id that is not digits is dropped');
});

test('several versions of one barcode: the newest one still on the market wins; if all are off the market the newest wins', () => {
  const l = id => D.parseLabel(LABEL(id));
  assert.equal(D.pickBest([l('1001'), l('1002'), l('1003')]).id, '1003', '1002 is newest but off the market');
  assert.equal(D.pickBest([l('1002')]).id, '1002');
  assert.equal(D.pickBest([{ id: '5', offMarket: true, date: '2018-01-01' }, { id: '6', offMarket: true, date: '2020-01-01' }]).id, '6');
  assert.equal(D.pickBest([]), null);
});

test('a label becomes a hit: serving, supplement facts mapped to our nutrients with units, other ingredients kept, NIH named', () => {
  const h = D.hitOfLabel(D.parseLabel(LABEL('1001')));
  assert.deepEqual([h.source, h.kind, h.name, h.brand, h.upc, h.ext], ['dsld', 'supplement', 'Daily Multi', 'Brightwell', UPC, '1001']);
  assert.equal(h.bases[0].label, '2 Capsule');
  assert.deepEqual(h.bases[0].micros, { vit_d_mcg: 25, vit_c_mg: 90, folate_mcg: 400 });
  assert.equal(h.bases[0].per.calories, 5);
  assert.deepEqual(h.otherIngredients.map(o => [o.name, o.amount, o.unit]), [['Creatine Monohydrate', 3, 'g'], ['Ashwagandha', 300, 'mg']]);
  assert.equal(h.otherIngredientsText, 'Gelatin, rice flour.');
  assert.match(h.attribution, /NIH Office of Dietary Supplements/);
  assert.equal(h.url, 'https://dsld.od.nih.gov/label/1001');
  assert.equal(D.parseLabel({ id: 1 }), null, 'no name: no product');
});

/* ------------------------------ the lookup ------------------------------ */

test('UPC search: the quoted SPACED form is searched; hits have no barcode, so labels are opened and compared; the right version is chosen; the unrelated one is ignored', async () => {
  const f = fakeNet();
  const r = await mk(f).dsldByUpc(UPC);
  assert.equal(r.found, true);
  assert.equal(r.product.ext, '1003');
  const searches = f.urls.filter(u => u.includes('search-filter')).map(u => new URL(u).searchParams.get('q'));
  assert.deepEqual(searches, [SPACED], 'the first candidate found them, so no second search');
  assert.ok(f.urls.some(u => u.includes('/label/1004')), 'a hit has no barcode, so it is opened to see');
  assert.equal(r.versions, 3, 'the other product (1004) has another barcode and is dropped');
});

test('the candidates: 12 digits → spaced 1-5-5-1 then the plain quoted digits; 13 digits starting with 0 → its 12-digit spaced form then the plain digits; other lengths → plain digits; never more than 3', () => {
  assert.deepEqual(D.upcQueries('031604026974'), ['"0 31604 02697 4"', '"031604026974"']);
  assert.deepEqual(D.upcQueries('0031604026974'), ['"0 31604 02697 4"', '"0031604026974"']);
  assert.deepEqual(D.upcQueries('4006381333931'), ['"4006381333931"']);
  assert.deepEqual(D.upcQueries('96385074'), ['"96385074"']);
  assert.deepEqual(D.upcQueries('abc'), []);
  assert.ok(D.upcQueries('031604026974').length <= D.MAX_UPC_QUERIES);
});

test('the live examples: label 179744 "Ultra Fish Oil 1400 mg" and label 1225 "Calcium With Vitamin D3" are found by their scanned digits (digits-only search returns nothing)', async () => {
  const LIVE = { '"0 31604 02697 4"': 179744, '"0 74312 76274 1"': 1225 };
  const NAME = { 179744: 'Ultra Fish Oil 1400 mg', 1225: 'Calcium With Vitamin D3' };
  const UPCSKU = { 179744: '0 31604 02697 4', 1225: '0 74312 76274 1' };
  const f = fakeNet({
    search: url => { const id = LIVE[new URL(url).searchParams.get('q')]; return json({ hits: { total: id ? 1 : 0, hits: id ? [{ _id: String(id), _source: { fullName: NAME[id], brandName: 'Nature Made', offMarket: 0 } }] : [] } }); },
    label: id => json({ id: Number(id), fullName: NAME[id], brandName: 'Nature Made', upcSku: UPCSKU[id], offMarket: 0, entryDate: '2021-02-02', servingSizes: [{ minQuantity: 1, unit: 'Softgel(s)' }], ingredientRows: [] })
  });
  const lk = mk(f);
  const a = await lk.dsldByUpc('031604026974');
  assert.deepEqual([a.found, a.product.ext, a.product.name, a.product.upc], [true, '179744', 'Ultra Fish Oil 1400 mg', '031604026974']);
  assert.equal((await lk.dsldByUpc('074312762741')).product.ext, '1225');
  assert.equal(f.dsld, 4, 'each barcode: one search and one label');
  const qs = f.urls.filter(u => u.includes('search-filter')).map(u => new URL(u).searchParams.get('q'));
  assert.ok(!qs.includes('031604026974') && !qs.includes('"031604026974"'), 'the digits-only query was never needed');
});

test('a 13-digit EAN that starts with 0 is searched by its 12-digit spaced form; a real EAN-13 is searched as plain quoted digits', async () => {
  const f = fakeNet();
  assert.equal((await mk(f).dsldByUpc('0012345678905')).found, true);
  assert.equal(new URL(f.urls[0]).searchParams.get('q'), SPACED);
  const g = fakeNet({ search: () => json({ hits: { hits: [] } }) });
  assert.deepEqual(await mk(g).dsldByUpc('4006381333931'), { found: false });
  assert.deepEqual(g.urls.map(u => new URL(u).searchParams.get('q')), ['"4006381333931"']);
});

test('a barcode with no match: every candidate is searched (at most 3 calls), no label is opened, and the answer is a plain "not found"', async () => {
  const f = fakeNet();
  const r = await mk(f).dsldByUpc('999999999999');
  assert.deepEqual(r, { found: false });
  assert.equal(f.dsld, 2); assert.ok(f.dsld <= 3);
  assert.ok(!f.urls.some(u => u.includes('/label/')));
});

test('hits that are similar products but none has this barcode: not found, flagged "similar", and no more than 5 labels are opened', async () => {
  const many = { hits: { hits: Array.from({ length: 12 }, (_, i) => hit(2000 + i)) } };
  const f = fakeNet({ search: () => json(many), label: id => json({ ...LABEL('1001'), id: Number(id), upcSku: '1 11111 11111 1' }) });
  const r = await mk(f).dsldByUpc(UPC);
  assert.deepEqual([r.found, r.similar], [false, true]);
  assert.equal(f.urls.filter(u => u.includes('/label/')).length, 5);
});

test('the route says "NIH has similar products but not this barcode" and falls through to Open Food Facts', async () => {
  const f = fakeNet({ search: () => json({ hits: { hits: [hit(2000)] } }), label: id => json({ ...LABEL('1001'), id: Number(id), upcSku: '1 11111 11111 1' }), off: () => json({ status: 0 }) });
  const r = await setup(f).scan(UPC);
  assert.equal(r.out.found, false);
  assert.equal(r.out.tried.find(t => t.source === 'dsld').note, 'NIH has similar products but not this barcode.');
  assert.equal(f.off, 1);
});

test('EAN-13 and UPC-A spellings find the same label; nothing found is a plain "not found"; results are cached', async () => {
  const f = fakeNet();
  const lk = mk(f);
  assert.equal((await lk.dsldByUpc('0012345678905')).found, true);
  const n = f.dsld;
  await lk.dsldByUpc('0012345678905');
  assert.equal(f.dsld, n, 'the second ask is served from memory');
  const h = fakeNet({ label: () => json({ id: 1, fullName: 'Other', upcSku: '111111111111' }) });
  assert.equal((await mk(h).dsldByUpc(UPC)).found, false, 'a label whose own barcode differs does not count');
});

test('failures in plain words: a rate limit, a refused request, an outage, a shape it does not know; the budget stops requests before NIH does', async () => {
  for (const [status, kind] of [[429, 'rate'], [403, 'auth'], [401, 'auth'], [503, 'down']]) {
    const f = fakeNet({ search: () => ({ ok: false, status, text: async () => '' }) });
    await assert.rejects(mk(f).dsldByUpc(UPC), e => e.kind === kind, String(status));
  }
  const bad = fakeNet({ search: () => json({ unexpected: true }) });
  const logs = []; const orig = console.error; console.error = (...a) => logs.push(a.join(' '));
  try { await assert.rejects(mk(bad).dsldByUpc(UPC), e => e.kind === 'bad'); } finally { console.error = orig; }
  assert.match(logs.join(''), /NIH DSLD search returned an unexpected response shape/);
  assert.ok(!logs.join('').includes(UPC), 'the barcode is not logged');
  const f = fakeNet();
  const budget = createBudget({ caps: { hour: () => 1, day: () => 100, user: () => 100 } });
  await assert.rejects(mk(f, { dsldBudget: budget }).dsldByUpc(UPC), e => e.kind === 'limit' && /NIH supplement database lookups/.test(e.text));
  assert.equal(f.dsld, 1, 'it stopped itself at the budget');
  assert.deepEqual([createDsldBudget({}).snapshot().hour.cap, createDsldBudget({}).snapshot().userHourCap], [300, 60]);
});

test('a timeout is retried once, then reported', async () => {
  let n = 0;
  const f = fakeNet({ search: () => { n++; throw Object.assign(new Error('t'), { name: 'TimeoutError' }); } });
  await assert.rejects(mk(f).dsldByUpc(UPC), e => e.kind === 'timeout');
  assert.equal(n, 2);
});

/* ------------------------------ the order of the barcode lookup ------------------------------ */

const USERS = { a: { id: 'dsa' } };
function setup(f, { usdaKey = null } = {}) {
  ncfg.save({ usdaKey });
  const lookup = mk(f);
  const routes = nutritionRoutes({ json: (res, code, obj) => { res.status = code; res.out = obj; }, readBody: async q => q.body ?? {}, readSession: q => q.user || null, requireAdmin: () => null, lookup, analyzer: {} });
  const call = async (key, { body, url } = {}) => { const res = {}; await routes[key]({ method: key.split(' ')[0], url: url || key.split(' ')[1], user: USERS.a, body, headers: {} }, res); return res; };
  const scan = (code, kind = 'supplement') => call('GET /api/nutrition/barcode', { url: `/api/nutrition/barcode?code=${code}&kind=${kind}` });
  return { call, scan };
}
beforeEach(() => { store.removeUser('dsa'); ncfg.save({ usdaKey: null }); });
const SAVED = { name: 'My own multi', brand: 'Home', serving: '1 tablet', per: { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 }, type: 'supplement', upc: UPC, micros: { vit_c_mg: 60 } };

test('supplement barcode, order 1: my own saved supplement is found first and nothing outside is asked', async () => {
  const f = fakeNet();
  const t = setup(f);
  await t.call('POST /api/nutrition/foods', { body: SAVED });
  const r = await t.scan(UPC);
  assert.deepEqual([r.out.found, r.out.via, r.out.product.name, r.out.product.source, r.out.product.upc], [true, 'mine', 'My own multi', 'mine', UPC]);
  assert.equal(f.urls.length, 0);
});

test('order 2: DSLD next, and the lookup stops there (no Open Food Facts, no USDA)', async () => {
  const f = fakeNet();
  const r = await setup(f, { usdaKey: 'USDAKEY0123456789' }).scan(UPC);
  assert.deepEqual([r.out.found, r.out.via, r.out.product.source, r.out.product.ext], [true, 'dsld', 'dsld', '1003']);
  assert.match(r.out.product.attribution, /NIH/);
  assert.deepEqual([f.off, f.usda], [0, 0]);
});

test('order 3: DSLD has nothing → Open Food Facts; then USDA Branded by the barcode; failures along the way are listed and skipped, not fatal', async () => {
  const none = () => json({ hits: { hits: [] } });
  const OFF = { status: 1, product: { code: UPC, product_name: 'Vitamin thing', brands: 'B', nutriments: { 'energy-kcal_100g': 0, proteins_100g: 0, carbohydrates_100g: 0, fat_100g: 0 }, serving_size: '1 tablet' } };
  let f = fakeNet({ search: none, off: () => json(OFF) });
  let r = await setup(f).scan(UPC);
  assert.deepEqual([r.out.found, r.out.via, f.usda], [true, 'off', 0]);
  assert.deepEqual(r.out.tried.map(t => [t.source, t.found]), [['dsld', false], ['off', true]]);
  // DSLD down: Open Food Facts answers; the DSLD failure is listed in words.
  f = fakeNet({ search: () => ({ ok: false, status: 503, text: async () => '' }), off: () => json(OFF) });
  r = await setup(f).scan(UPC);
  assert.deepEqual([r.out.found, r.out.via], [true, 'off']);
  assert.deepEqual([r.out.tried[0].source, r.out.tried[0].ok, /NIH supplement database/.test(r.out.tried[0].error)], ['dsld', false, true]);
  // Neither knows it; USDA Branded does.
  const BR = { foods: [{ fdcId: 55, description: 'MULTI VITAMIN', dataType: 'Branded', brandOwner: 'BRIGHTWELL', gtinUpc: UPC, servingSize: 1, servingSizeUnit: 'g', foodNutrients: [{ nutrientId: 1008, value: 0 }, { nutrientId: 1162, value: 60, unitName: 'MG' }] }] };
  f = fakeNet({ search: none, off: () => json({ status: 0 }), usda: () => json(BR) });
  r = await setup(f, { usdaKey: 'USDAKEY0123456789' }).scan(UPC);
  assert.deepEqual([r.out.found, r.out.via, r.out.product.source, r.out.product.upc], [true, 'usda', 'usda', UPC]);
  assert.deepEqual(r.out.tried.map(t => t.source), ['dsld', 'off', 'usda']);
  const asked = f.urls.find(u => u.includes('nal.usda.gov'));
  assert.equal(new URL(asked).searchParams.get('query'), UPC);
});

test('order 4: nothing found anywhere → "not found" (the app offers to photograph the label); incomplete says some source could not answer', async () => {
  const none = () => json({ hits: { hits: [] } });
  let r = await setup(fakeNet({ search: none }), { usdaKey: 'USDAKEY0123456789' }).scan(UPC);
  assert.deepEqual([r.out.found, r.out.reason, r.out.incomplete, r.out.tried.map(t => t.ok)], [false, 'unknown', undefined, [true, true, true]]);
  r = await setup(fakeNet({ search: () => ({ ok: false, status: 429, text: async () => '' }) })).scan(UPC);
  assert.deepEqual([r.out.found, r.out.incomplete], [false, true]);
  assert.equal((await setup(fakeNet()).scan('12')).status, 400);
});

test('a food barcode: my saved food with that barcode first, then Open Food Facts as before; DSLD is not asked', async () => {
  const f = fakeNet();
  const t = setup(f);
  await t.call('POST /api/nutrition/foods', { body: { ...SAVED, name: 'My bar', type: null, upc: '036000291452' } });
  const r = await t.scan('036000291452', 'food');
  assert.deepEqual([r.out.via, r.out.product.name], ['mine', 'My bar']);
  const g = fakeNet({ off: () => json({ status: 0 }) });
  const o = await setup(g).scan('111111111116', 'food');
  assert.deepEqual([o.out.found, g.dsld, g.off], [false, 0, 1]);
});

test('supplement search by name and one label by id: newest on-market first, plain-word failures, ids are digits only', async () => {
  const f = fakeNet({ search: () => json(SEARCH) });          // a name search, unlike a barcode search, answers with the products
  const t = setup(f);
  const s = await t.call('GET /api/nutrition/supplements/search', { url: '/api/nutrition/supplements/search?q=daily%20multi' });
  assert.equal(s.status, 200, JSON.stringify(s.out));
  assert.deepEqual(s.out.results.slice(0, 3).map(r => [r.id, r.offMarket]), [['1003', false], ['1004', false], ['1001', false]]);
  assert.equal(s.out.results.at(-1).id, '1002', 'the off-market one last');
  assert.match(s.out.attribution, /NIH/);
  assert.equal((await t.call('GET /api/nutrition/supplements/search', { url: '/api/nutrition/supplements/search?q=ab' })).status, 400);
  const l = await t.call('GET /api/nutrition/supplements/label', { url: '/api/nutrition/supplements/label?id=1003' });
  assert.deepEqual([l.status, l.out.product.source, l.out.product.bases[0].micros.vit_d_mcg], [200, 'dsld', 25]);
  for (const bad of ['abc', '../x', '1;2', '']) assert.equal((await t.call('GET /api/nutrition/supplements/label', { url: '/api/nutrition/supplements/label?id=' + encodeURIComponent(bad) })).status, 400, bad);
  const down = setup(fakeNet({ search: () => ({ ok: false, status: 429, text: async () => '' }) }));
  const e = await down.call('GET /api/nutrition/supplements/search', { url: '/api/nutrition/supplements/search?q=vitamin%20c' });
  assert.deepEqual([e.status, e.out.kind, /rate-limiting/.test(e.out.error)], [502, 'rate', true]);
});
