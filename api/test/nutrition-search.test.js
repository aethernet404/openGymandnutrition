/* Search quality and reliability, from the failures seen in real use: "whole egg" returning foie gras,
   a plain chocolate chip cookie not found at all, and searches that came back empty and then worked
   on the next tap with no word on why. Fixtures are shaped like the services' documented answers. */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createLookup, TIMEOUT_MS, RETRY_TIMEOUT_MS, normaliseOff } from '../nutrition/lookup.js';

const res = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
const timeoutErr = () => Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
const off = (code, name, brands, n, extra = {}) => ({ code, product_name: name, brands, nutriments: { 'energy-kcal_100g': n.kcal, proteins_100g: n.p ?? 1, carbohydrates_100g: n.c ?? 1, fat_100g: n.f ?? 1 }, countries_tags: ['en:united-states'], lang: 'en', ...extra });
const fdc = (id, description, dataType, kcal, extra = {}) => ({ fdcId: id, description, dataType, foodNutrients: [{ nutrientId: 1008, value: kcal }, { nutrientId: 1003, value: 5 }, { nutrientId: 1004, value: 5 }, { nutrientId: 1005, value: 5 }], ...extra });
const noSleep = async () => {};

const OFF_WHOLE_EGG = { products: [
  off('1', 'French foie gras with egg yolk', 'Delice', { kcal: 460 }),
  off('2', 'Gluten free bread', 'Schar', { kcal: 240 }),
  off('3', 'Whole eggs', 'Great Value', { kcal: 143, p: 12.6, f: 9.5, c: 0.7 }, { serving_size: '1 large egg (50 g)', serving_quantity: 50 }),
  off('4', 'Egg noodles', 'No Yolks', { kcal: 380 }),
  off('5', 'Eggs, whole, free range', 'Vital Farms', { kcal: 150 }, { countries_tags: ['en:france'], lang: 'fr' })
] };
const USDA_EGG = {
  generic: { foods: [fdc(748967, 'Egg, whole, raw, fresh', 'Foundation', 143), fdc(172184, 'Egg, whole, cooked, hard-boiled', 'SR Legacy', 155), fdc(172186, 'Egg, whole, cooked, fried', 'SR Legacy', 196), fdc(171287, 'Egg, white, raw, fresh', 'SR Legacy', 52)] },
  branded: { foods: [fdc(2000001, 'WHOLE EGGS', 'Branded', 140, { brandName: 'EGGLAND\'S BEST', servingSize: 50, servingSizeUnit: 'g', householdServingFullText: '1 large egg' }), fdc(2000002, 'EGG WHITES', 'Branded', 50)] }
};

function service(handler, opts = {}) {
  const urls = [];
  const lk = createLookup({ sleep: noSleep, ...opts, fetch: async (url, init) => { urls.push(String(url)); return handler(String(url), init); } });
  return { lk, urls };
}
const isOff = u => u.includes('openfoodfacts');
const isGenericUsda = u => u.includes('Foundation');

test('"whole egg" with no USDA key: eggs only — no foie gras, no gluten-free bread, no noodles; the US/English product first', async () => {
  const { lk } = service(u => res(OFF_WHOLE_EGG));
  const r = await lk.search('whole egg', { usdaKey: null });
  const names = r.results.map(x => x.name);
  assert.deepEqual(names, ['Whole eggs', 'Eggs, whole, free range']);
  assert.equal(r.results[0].brand, 'Great Value');
  assert.equal(r.sources.usda.skipped, 'no-key');
});

test('"whole egg" with USDA: the reference foods lead (Foundation first), then branded, then the rest', async () => {
  const { lk } = service(u => (isOff(u) ? res(OFF_WHOLE_EGG) : res(isGenericUsda(u) ? USDA_EGG.generic : USDA_EGG.branded)));
  const r = await lk.search('whole egg', { usdaKey: 'KEY12345' });
  const lines = r.results.map(x => `${x.source}/${x.kind}: ${x.name}`);
  assert.equal(lines[0], 'usda/foundation: Egg, whole, raw, fresh');
  assert.deepEqual(lines.slice(0, 3).map(l => l.split(':')[0]), ['usda/foundation', 'usda/sr', 'usda/sr']);
  assert.ok(!lines.some(l => /white/i.test(l)), 'egg white is not whole egg');
  assert.ok(!lines.some(l => /foie|bread|noodles/i.test(l)));
  const firstOther = r.results.findIndex(x => !(x.source === 'usda' && ['foundation', 'sr'].includes(x.kind)));
  assert.ok(firstOther === 3, lines.join('\n'));
  for (let i = 1; i < r.results.length; i++) assert.ok(r.results[i - 1].rank >= r.results[i].rank);
});

test('each source can be asked for on its own, ranks stay comparable, so a client can merge them as they arrive', async () => {
  const { lk } = service(u => (isOff(u) ? res(OFF_WHOLE_EGG) : res(isGenericUsda(u) ? USDA_EGG.generic : USDA_EGG.branded)));
  const a = await lk.search('whole egg', { usdaKey: 'KEY12345', sources: 'usda' });
  const b = await lk.search('whole egg', { usdaKey: 'KEY12345', sources: 'off' });
  assert.deepEqual(Object.keys(a.sources), ['usda']);
  assert.deepEqual(Object.keys(b.sources), ['off']);
  const merged = [...b.results, ...a.results].sort((x, y) => y.rank - x.rank);
  const all = (await lk.search('whole egg', { usdaKey: 'KEY12345' })).results;
  assert.deepEqual(merged.map(x => x.ext), all.map(x => x.ext));
});

test('chocolate chip cookie: the US/English ask comes up empty, so the whole catalogue is asked too — and it is found', async () => {
  const cookie = { products: [off('9', 'Chocolate Chip Cookies', 'Chips Ahoy!', { kcal: 480 }, { serving_size: '3 cookies (33 g)', serving_quantity: 33 })] };
  const { lk, urls } = service(u => (u.includes('tag_1=united-states') ? res({ products: [] }) : res(cookie)));
  const r = await lk.search('chocolate chip cookie', { sources: 'off' });
  assert.equal(r.results.length, 1);
  assert.equal(r.results[0].name, 'Chocolate Chip Cookies');
  assert.equal(r.results[0].bases[0].label, '3 cookies (33 g)');
  assert.equal(r.results[0].bases[0].per.calories, 158);          // 33 g of a 480 kcal/100 g cookie
  assert.equal(urls.length, 2);
  assert.ok(urls[0].includes('tag_0=english') && urls[0].includes('tag_1=united-states') && urls[0].includes('sort_by=unique_scans_n'));
  assert.ok(!urls[1].includes('tag_0') && !urls[1].includes('tag_1'));
});

test('USDA has the plain cookie too: Cookies, chocolate chip, is found by "chocolate chip cookie" and leads', async () => {
  const sr = { foods: [fdc(174, 'Cookies, chocolate chip, commercially prepared, regular, lower fat', 'SR Legacy', 468), fdc(175, 'Cookies, oatmeal, regular', 'SR Legacy', 450)] };
  const brandedCookie = { foods: [fdc(3, 'CHOCOLATE CHIP COOKIES', 'Branded', 480, { brandName: 'TATE\'S', servingSize: 28, servingSizeUnit: 'g' })] };
  const { lk } = service(u => (isOff(u) ? res({ products: [] }) : res(isGenericUsda(u) ? sr : brandedCookie)));
  const r = await lk.search('chocolate chip cookie', { usdaKey: 'KEY12345' });
  assert.equal(r.results[0].ext, '174');
  assert.deepEqual(r.results.map(x => x.ext), ['174', '3']);
  assert.deepEqual(r.sources.off, { ok: true, count: 0 }, 'an empty answer from a working source is just empty');
});

test('too few matches in the preferred market are topped up from the rest, preferred ones first', async () => {
  const filtered = { products: [off('1', 'Banana chips', 'US Brand', { kcal: 519 })] };
  const wide = { products: [off('1', 'Banana chips', 'US Brand', { kcal: 519 }), off('2', 'Banana', 'Euro Fruit', { kcal: 89 }, { countries_tags: ['en:germany'], lang: 'de' })] };
  const { lk } = service(u => res(u.includes('tag_1=') ? filtered : wide));
  const r = await lk.search('banana', { sources: 'off' });
  assert.deepEqual(r.results.map(x => x.ext), ['2', '1'], 'the plain banana from elsewhere beats US banana chips: closeness first, market second');
  assert.equal(r.results.length, 2);
  assert.ok(r.results.find(x => x.ext === '1').preferred && !r.results.find(x => x.ext === '2').preferred);
});

test('country and language filters can be switched off for a mirror or another market', async () => {
  process.env.NUTRITION_OFF_COUNTRY = ''; process.env.NUTRITION_OFF_LANG = '';
  try {
    const { lk, urls } = service(() => res({ products: [off('1', 'Banana', 'X', { kcal: 89 })] }));
    await lk.search('banana', { sources: 'off' });
    assert.equal(urls.length, 1);
    assert.ok(!urls[0].includes('tag_'));
  } finally { delete process.env.NUTRITION_OFF_COUNTRY; delete process.env.NUTRITION_OFF_LANG; }
});

/* ------------------------------ reliability ------------------------------ */

test('the timeouts: 10 s for the first try, 8 s for the retry', () => {
  assert.equal(TIMEOUT_MS, 10000);
  assert.equal(RETRY_TIMEOUT_MS, 8000);
});

test('a source that times out once is asked again, and the person never sees the hiccup', async () => {
  let n = 0;
  const slept = [];
  const { lk } = service(() => { if (++n === 1) throw timeoutErr(); return res({ products: [off('1', 'Banana', 'X', { kcal: 89 })] }); }, { sleep: async ms => { slept.push(ms); } });
  const r = await lk.search('banana', { sources: 'off' });
  assert.equal(r.sources.off.ok, true);
  assert.equal(r.results.length, 1);
  assert.equal(n >= 2, true);
  assert.deepEqual(slept, [300], 'a short pause before the retry');
});

test('errors, bad JSON and 5xx get exactly one retry; a second failure is reported with its class and words', async () => {
  for (const [first, kind, words] of [
    [() => { throw timeoutErr(); }, 'timeout', /did not answer in time/],
    [() => res('upstream', 502), 'down', /is not answering right now/],
    [() => res('<html>oops', 200), 'bad', /unreadable/],
    [() => { throw new Error('ECONNRESET'); }, 'down', /not answering/]
  ]) {
    let n = 0;
    const { lk } = service(() => { n++; return first(); });
    const r = await lk.search('banana', { sources: 'off' });
    assert.equal(n, 2, kind);
    assert.deepEqual([r.sources.off.ok, r.sources.off.kind], [false, kind]);
    assert.match(r.sources.off.error, words);
    assert.deepEqual(r.results, []);
  }
});

test('a rate limit or a rejected key is not retried: asking again only makes them worse', async () => {
  for (const [status, kind] of [[429, 'rate'], [403, 'auth'], [401, 'auth']]) {
    let n = 0;
    const { lk } = service(() => { n++; return res('', status); });
    const r = await lk.search('banana', { usdaKey: 'KEY12345', sources: 'usda' });
    assert.equal(n, 3, 'USDA is asked three times (reference, branded, mixed dishes), once each');
    assert.equal(r.sources.usda.kind, kind);
  }
  let n = 0;
  const { lk } = service(() => { n++; return res('', 429); });
  await lk.search('banana', { sources: 'off' });
  assert.equal(n, 1);
});

test('the retry is skipped when the time budget is nearly spent', async () => {
  let clock = 0, n = 0;
  const { lk } = service(() => { n++; clock += 20000; throw timeoutErr(); }, { now: () => clock, timeoutMs: 10000, retryTimeoutMs: 8000 });
  const r = await lk.search('banana', { sources: 'off' });
  assert.equal(n, 1);
  assert.equal(r.sources.off.kind, 'timeout');
});

test('one source down never hides the other, either way round', async () => {
  const offDown = service(u => (isOff(u) ? res('x', 503) : res(isGenericUsda(u) ? USDA_EGG.generic : USDA_EGG.branded)));
  const a = await offDown.lk.search('whole egg', { usdaKey: 'KEY12345' });
  assert.equal(a.sources.off.ok, false);
  assert.match(a.sources.off.error, /Open Food Facts is not answering/);
  assert.equal(a.sources.usda.ok, true);
  assert.ok(a.results.length >= 3 && a.results.every(x => x.source === 'usda'));

  const usdaDown = service(u => (isOff(u) ? res(OFF_WHOLE_EGG) : (() => { throw timeoutErr(); })()));
  const b = await usdaDown.lk.search('whole egg', { usdaKey: 'KEY12345' });
  assert.equal(b.sources.usda.kind, 'timeout');
  assert.match(b.sources.usda.error, /USDA FoodData Central did not answer in time/);
  assert.deepEqual(b.results.map(x => x.name), ['Whole eggs', 'Eggs, whole, free range']);
});

test('USDA answering for only one of its two asks still counts as an answer', async () => {
  const { lk } = service(u => (isGenericUsda(u) ? res('', 500) : res(USDA_EGG.branded)));
  const r = await lk.search('whole eggs', { usdaKey: 'KEY12345', sources: 'usda' });
  assert.equal(r.sources.usda.ok, true);
  assert.deepEqual(r.results.map(x => x.name), ['Whole Eggs']);
});

test('no results at all is an honest, empty, successful answer from every source', async () => {
  const { lk } = service(u => (isOff(u) ? res({ products: [] }) : res({ foods: [] })));
  const r = await lk.search('zzzzqx', { usdaKey: 'KEY12345' });
  assert.deepEqual(r.results, []);
  assert.deepEqual(r.sources, { off: { ok: true, count: 0 }, usda: { ok: true, count: 0 }, fatsecret: { ok: false, skipped: 'no-key' } });
});

test('hits that do not contain what was typed are dropped even when the source returned nothing else', async () => {
  const { lk } = service(() => res({ products: [off('1', 'French foie gras', 'Delice', { kcal: 460 })] }));
  const r = await lk.search('whole egg', { sources: 'off' });
  assert.deepEqual(r.results, []);
  assert.deepEqual(r.sources.off, { ok: true, count: 0 });
});

/* ------------------------------ unexpected answers are logged ------------------------------ */

test('an answer of the wrong shape is a failure, logged once a minute with its status and key names only', async () => {
  const err = mock.method(console, 'error', () => {});
  try {
    let clock = 5_000_000;
    const { lk } = service(() => res({ unexpected: 'x', count: 3, secretish: 'my-private-query' }), { now: () => clock });
    const r = await lk.search('my private query', { sources: 'off' });
    assert.deepEqual([r.sources.off.ok, r.sources.off.kind], [false, 'bad']);
    const lines = err.mock.calls.map(c => String(c.arguments[0]));
    assert.equal(lines.length, 1, 'logged once even though it was asked twice (retry)');
    assert.match(lines[0], /^nutrition: Open Food Facts search returned an unexpected response shape \(HTTP 200; top-level keys: unexpected,count,secretish\)$/);
    assert.ok(!/private|query|my-private/.test(lines[0]), 'no search words, no values');

    await lk.search('another one', { sources: 'off' });
    assert.equal(err.mock.calls.length, 1, 'not again within the minute');
    clock += 61000;
    await lk.search('a third', { sources: 'off' });
    assert.equal(err.mock.calls.length, 2, 'and again after it');
  } finally { err.mock.restore(); }
});

test('USDA and barcode answers of the wrong shape are logged under their own names', async () => {
  const err = mock.method(console, 'error', () => {});
  try {
    const usda = service(() => res({ error: { code: 'X' } }));
    const r = await usda.lk.search('banana', { usdaKey: 'KEY12345', sources: 'usda' });
    assert.equal(r.sources.usda.kind, 'bad');
    const bc = service(() => res([1, 2, 3]));
    const b = await bc.lk.barcode('12345678');
    assert.deepEqual([b.found, b.reason, b.kind], [false, 'error', 'bad']);
    const lines = err.mock.calls.map(c => String(c.arguments[0]));
    assert.ok(lines.some(l => /USDA FoodData Central search returned an unexpected response shape \(HTTP 200; top-level keys: error\)/.test(l)));
    assert.ok(lines.some(l => /Open Food Facts barcode returned an unexpected response shape \(HTTP 200; top-level keys: array\)/.test(l)));
    assert.ok(lines.every(l => !l.includes('12345678') && !l.includes('KEY12345')), 'neither the barcode nor the key');
  } finally { err.mock.restore(); }
});

/* ------------------------------ sensible serving sizes ------------------------------ */

test('serving sizes shown are believable', () => {
  // The number field is the pack size (100); the text says one cookie is 28 g.
  const cookie = normaliseOff(off('1', 'Cookie', 'X', { kcal: 500 }, { serving_size: '1 cookie (28 g)', serving_quantity: 100 }));
  assert.deepEqual([cookie.bases[0].label, cookie.bases[0].grams, cookie.bases[0].per.calories], ['1 cookie (28 g)', 28, 140]);
  // A "per serving" figure that contradicts the per-100 g one is ignored.
  const typo = normaliseOff({ ...off('2', 'Bar', 'X', { kcal: 400 }, { serving_size: '40 g', serving_quantity: 40 }), nutriments: { 'energy-kcal_100g': 400, 'energy-kcal_serving': 4000, proteins_100g: 10, carbohydrates_100g: 50, fat_100g: 15 } });
  assert.equal(typo.bases[0].per.calories, 160);
  // A kilo-and-a-half "serving" is a pack size, not a portion: per 100 g only.
  const pack = normaliseOff(off('3', 'Rice', 'X', { kcal: 350 }, { serving_size: '1500 g', serving_quantity: 1500 }));
  assert.deepEqual(pack.bases.map(b => b.label), ['100 g']);
  // A bare number is given its unit; no serving at all is just per 100 g.
  assert.equal(normaliseOff(off('4', 'Oats', 'X', { kcal: 380 }, { serving_size: '40', serving_quantity: 40 })).bases[0].label, '40 g');
  assert.deepEqual(normaliseOff(off('5', 'Oats', 'X', { kcal: 380 })).bases.map(b => b.label), ['100 g']);
  // Ounces are read as grams.
  assert.equal(normaliseOff(off('6', 'Chips', 'X', { kcal: 540 }, { serving_size: '1 oz (28g)' })).bases[0].grams, 28);
});

test('USDA Survey (FNDDS) mixed dishes are searched too, labelled kind "survey", and rank after Foundation / SR Legacy foods', async () => {
  const types = [];
  const { lk } = service(url => {
    const t = new URL(url).searchParams.get('dataType'); types.push(t);
    if (t === 'Survey (FNDDS)') return res({ foods: [fdc(3, 'Burrito, beef and bean', 'Survey (FNDDS)', 210)] });
    if (t === 'Branded') return res({ foods: [] });
    return res({ foods: [fdc(1, 'Beans, refried burrito filling', 'SR Legacy', 90)] });
  });
  const r = await lk.search('burrito', { usdaKey: 'KEY12345', sources: 'usda' });
  assert.deepEqual(types.sort(), ['Branded', 'Foundation,SR Legacy', 'Survey (FNDDS)']);
  assert.deepEqual(r.results.map(h => [h.name, h.kind]), [['Beans, refried burrito filling', 'sr'], ['Burrito, beef and bean', 'survey']]);
  assert.ok(r.results[0].rank >= 2000 && r.results[1].rank >= 1500 && r.results[1].rank < 2000);
  // One of the three failing still gives the others' results.
  const f = service(url => (new URL(url).searchParams.get('dataType') === 'Survey (FNDDS)' ? res('', 503) : res({ foods: [fdc(1, 'Burrito shell', 'SR Legacy', 300)] })));
  assert.equal((await f.lk.search('burrito', { usdaKey: 'KEY12345', sources: 'usda' })).results.length, 1);
});
