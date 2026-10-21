/* Open Food Facts / USDA lookups: normalising uneven data, and surviving a slow or broken source.
   Nothing here touches the network; `fetch` is a script. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLookup, normaliseOff, normaliseUsda, cleanBarcode, LookupError } from '../nutrition/lookup.js';

const res = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });

/* Shapes follow the documented responses of each API, including their rough edges. */
const NUTELLA = {
  code: '3017620422003', product_name: 'Nutella', brands: 'Ferrero,Nutella', serving_size: '15 g', serving_quantity: 15,
  nutriments: { 'energy-kcal_100g': 539, 'energy-kcal_serving': 80.85, proteins_100g: 6.3, proteins_serving: 0.945, carbohydrates_100g: 57.5, carbohydrates_serving: 8.625, fat_100g: 30.9, fat_serving: 4.635 }
};
const KJ_ONLY = { code: '111', product_name: 'Crackers', brands: 'X', serving_quantity: '30', nutriments: { energy_100g: 1884, proteins_100g: '9', carbohydrates_100g: 70, fat_100g: 10 } };
const NO_NUTRITION = { code: '222', product_name: 'Mystery bar', nutriments: {} };
const CHEDDAR = {
  fdcId: 328637, description: 'CHEESE, CHEDDAR', dataType: 'SR Legacy',
  foodNutrients: [{ nutrientId: 1003, value: 23.3 }, { nutrientId: 1004, value: 33.3 }, { nutrientId: 1005, value: 3.09 }, { nutrientId: 1008, value: 404 }]
};
const BRANDED = {
  fdcId: 1999634, description: 'GREEK YOGURT', brandName: 'CHOBANI', dataType: 'Branded', servingSize: 170, servingSizeUnit: 'g', householdServingFullText: '1 container',
  foodNutrients: [{ nutrientId: 1003, value: 10 }, { nutrientId: 1004, value: 0 }, { nutrientId: 1005, value: 4.1 }, { nutrientId: 1008, value: 59 }]
};

test('OFF: serving first, then 100 g; brand is the first of several', () => {
  const p = normaliseOff(NUTELLA);
  assert.equal(p.source, 'off'); assert.equal(p.ext, '3017620422003'); assert.equal(p.brand, 'Ferrero');
  assert.equal(p.bases.length, 2);
  assert.deepEqual(p.bases[0], { label: '15 g', grams: 15, per: { calories: 81, protein_g: 0.9, carbs_g: 8.6, fat_g: 4.6 } });
  assert.deepEqual(p.bases[1], { label: '100 g', grams: 100, per: { calories: 539, protein_g: 6.3, carbs_g: 57.5, fat_g: 30.9 } });
});

test('OFF: kJ-only energy is converted, a serving is derived from per-100 g, numeric strings are read', () => {
  const p = normaliseOff(KJ_ONLY);
  assert.equal(p.bases[1].per.calories, 450);
  assert.equal(p.bases[0].grams, 30);
  assert.equal(p.bases[0].label, '30 g');
  assert.equal(p.bases[0].per.calories, 135);
  assert.equal(p.bases[0].per.protein_g, 2.7);
});

test('OFF: a product without any calorie figure is dropped, not shown as 0 kcal', () => {
  assert.equal(normaliseOff(NO_NUTRITION), null);
  assert.equal(normaliseOff({ code: '1', nutriments: { 'energy-kcal_100g': 5 } }), null, 'no name');
  assert.equal(normaliseOff(null), null);
  assert.equal(normaliseOff({ code: '1', product_name: 'x', nutriments: { 'energy-kcal_100g': -50, proteins_100g: 'abc' } }).bases[0].per.calories, 0, 'negative clamps to 0');
});

test('OFF: absurd values are clamped and text is cleaned', () => {
  const p = normaliseOff({ code: '9', product_name: '  Odd\u0000 name ' + 'x'.repeat(300), serving_quantity: 999999, nutriments: { 'energy-kcal_100g': 1e9, proteins_100g: 1e9 } });
  assert.ok(p.name.length <= 120 && !p.name.includes('\u0000'));
  assert.equal(p.bases.length, 1, 'an impossible serving size is ignored');
  assert.equal(p.bases[0].per.calories, 20000);
  assert.equal(p.bases[0].per.protein_g, 2000);
});

test('USDA: generic foods are per 100 g; branded foods add their label serving; ALL CAPS is tidied', () => {
  const c = normaliseUsda(CHEDDAR);
  assert.equal(c.name, 'Cheese, Cheddar');
  assert.deepEqual(c.bases, [{ label: '100 g', grams: 100, per: { calories: 404, protein_g: 23.3, carbs_g: 3.1, fat_g: 33.3 } }]);
  const b = normaliseUsda(BRANDED);
  assert.equal(b.brand, 'Chobani'); assert.equal(b.ext, '1999634');
  assert.equal(b.bases[0].label, '1 container (170 g)');
  assert.equal(b.bases[0].per.calories, 100);
  assert.equal(b.bases[0].per.protein_g, 17);
});

test('USDA: the nested nutrient shape of the detail endpoint and kJ-only energy both work; no energy drops the food', () => {
  const nested = normaliseUsda({ fdcId: 1, description: 'Rice', foodNutrients: [{ nutrient: { id: 1008 }, amount: 130 }, { nutrient: { id: 1003 }, amount: 2.7 }] });
  assert.equal(nested.bases[0].per.calories, 130);
  const kj = normaliseUsda({ fdcId: 2, description: 'Oil', foodNutrients: [{ nutrientId: 1062, value: 3766 }] });
  assert.equal(kj.bases[0].per.calories, 900);
  assert.equal(normaliseUsda({ fdcId: 3, description: 'Water', foodNutrients: [] }), null);
});

test('search: both sources answer; the USDA reference food leads the rest', async () => {
  const urls = [];
  const inits = [];
  const lk = createLookup({ fetch: async (url, init) => { urls.push(String(url)); inits.push([String(url), init]); return String(url).includes('openfoodfacts') ? res({ products: [NUTELLA, KJ_ONLY, NO_NUTRITION] }) : res({ foods: [CHEDDAR, BRANDED] }); } });
  const r = await lk.search('cheddar', { usdaKey: 'KEY12345' });
  assert.equal(r.results[0].name, 'Cheese, Cheddar');
  assert.equal(r.results[0].kind, 'sr');
  assert.deepEqual(r.sources.usda, { ok: true, count: 1 });
  assert.equal(r.sources.off.ok, true);
  assert.ok(urls.some(u => u.includes('query=cheddar')));
  assert.ok(!urls.some(u => u.includes('KEY12345') || u.includes('api_key')), 'the USDA key is not in any URL');
  assert.ok(inits.filter(([u]) => u.includes('nal.usda.gov')).every(([, i]) => i.headers['X-Api-Key'] === 'KEY12345'), 'it travels in the X-Api-Key header');
  assert.ok(urls.some(u => u.includes('Foundation%2CSR+Legacy')), 'reference foods are asked for on their own…');
  assert.ok(urls.some(u => u.includes('dataType=Branded')), '…so the branded labels cannot crowd them out');
});

test('search without a USDA key says so and still returns Open Food Facts', async () => {
  const urls = [];
  const lk = createLookup({ fetch: async url => { urls.push(String(url)); return res({ products: [NUTELLA] }); } });
  const r = await lk.search('nutella', { usdaKey: null });
  assert.equal(r.results.length, 1);
  assert.deepEqual(r.sources.usda, { ok: false, skipped: 'no-key' });
  assert.ok(urls.every(u => !u.includes('usda.gov')), 'USDA is never contacted without a key');
});

test('search: one source down is reported, the other still delivers', async () => {
  const lk = createLookup({ fetch: async url => { if (String(url).includes('openfoodfacts')) return res('upstream', 503); return res({ foods: [CHEDDAR] }); } });
  const r = await lk.search('cheese', { usdaKey: 'KEY12345' });
  assert.equal(r.results.length, 1);
  assert.equal(r.sources.off.ok, false);
  assert.equal(r.sources.off.kind, 'down');
  assert.match(r.sources.off.error, /Open Food Facts is not answering/);
  assert.equal(r.sources.usda.ok, true);
});

test('search: failures are classified — timeout, rate limit, bad key, garbage', async () => {
  const cases = [
    [() => { throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }); }, 'timeout', /did not answer in time/],
    [() => res('', 429), 'rate', /rate-limiting/],
    [() => res('', 403), 'auth', /rejected the API key/],
    [() => res('<html>', 200), 'bad', /unreadable/],
    [() => { throw new Error('ECONNREFUSED'); }, 'down', /not answering/]
  ];
  for (const [act, kind, words] of cases) {
    const lk = createLookup({ fetch: async () => act() });
    const r = await lk.search('apple', { usdaKey: 'KEY12345', sources: 'usda' });
    assert.equal(r.sources.usda.kind, kind);
    assert.match(r.sources.usda.error, words);
    assert.deepEqual(r.results, []);
  }
});

test('search really gives up on a source that hangs', async () => {
  const hang = (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
  const lk = createLookup({ fetch: hang, timeoutMs: 40 });
  const keepAlive = setInterval(() => {}, 20);   // AbortSignal.timeout's timer is unref'd; a real socket keeps the loop alive
  try {
    const t0 = Date.now();
    const r = await lk.search('apple', { sources: 'off' });
    assert.equal(r.sources.off.kind, 'timeout');
    assert.ok(Date.now() - t0 < 1000);
    const b = await lk.barcode('12345678');
    assert.equal(b.kind, 'timeout');
  } finally { clearInterval(keepAlive); }
});

test('search results are cached for a few minutes, failures are not, and identical searches in flight share one trip', async () => {
  let calls = 0, fail = true, clock = 1000;
  const lk = createLookup({ now: () => clock, sleep: async () => {}, fetch: async () => { calls++; return fail ? res('', 500) : res({ products: [NUTELLA] }); } });
  await lk.search('nutella', { sources: 'off' });
  assert.equal(calls, 2, 'the ask and its one retry; nothing remembered');
  fail = false; calls = 0;
  await lk.search('nutella', { sources: 'off' });
  const afterFirst = calls;
  await lk.search('NUTELLA', { sources: 'off' });
  assert.equal(calls, afterFirst, 'the success is remembered, case-insensitively');
  clock += 6 * 60000;
  await lk.search('nutella', { sources: 'off' });
  assert.ok(calls > afterFirst, 'and forgotten after five minutes');

  calls = 0;
  const slow = createLookup({ fetch: async () => { calls++; await new Promise(r => setTimeout(r, 20)); return res({ products: [NUTELLA, NUTELLA, NUTELLA, NUTELLA, NUTELLA, NUTELLA] }); } });
  await Promise.all([slow.search('nutella', { sources: 'off' }), slow.search('nutella', { sources: 'off' }), slow.search('Nutella', { sources: 'off' })]);
  assert.ok(calls <= 2, `three simultaneous identical searches made ${calls} request(s)`);
});

test('barcode: found, unknown, known-without-nutrition, and source down', async () => {
  const lk = createLookup({
    fetch: async url => {
      const u = String(url);
      if (u.includes('/3017620422003.json')) return res({ status: 1, code: '3017620422003', product: NUTELLA });
      if (u.includes('/222.json')) return res({ status: 1, product: NO_NUTRITION });
      if (u.includes('/00000000.json')) return res({ status: 0, status_verbose: 'product not found' }, 404);
      return res('x', 502);
    }
  });
  const hit = await lk.barcode('3017620422003');
  assert.equal(hit.found, true); assert.equal(hit.product.name, 'Nutella');
  assert.deepEqual(await lk.barcode('00000000'), { found: false, reason: 'unknown' });
  const known = await lk.barcode('222');
  assert.deepEqual([known.found, known.reason, known.name], [false, 'no-nutrition', 'Mystery bar']);
  const down = await lk.barcode('12345678');
  assert.deepEqual([down.found, down.reason, down.kind], [false, 'error', 'down']);
});

test('barcode input is digits only, 8 to 14', () => {
  assert.equal(cleanBarcode(' 3017 6204-22003 '), '3017620422003');
  for (const bad of ['', '1234567', '123456789012345', 'abcdefgh', '../../etc', null, undefined]) assert.equal(cleanBarcode(bad), null, String(bad));
});

test('a barcode never reaches the URL unencoded', async () => {
  const seen = [];
  const lk = createLookup({ fetch: async url => { seen.push(String(url)); return res({ status: 0 }, 404); } });
  await lk.barcode('12345678');
  assert.ok(seen[0].includes('/api/v2/product/12345678.json'));
  assert.ok(LookupError);
});
