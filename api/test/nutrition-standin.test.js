/* Filling in micronutrients from USDA stand-ins: the AI only picks which USDA food is closest; every number comes
   from USDA, scaled to the portion. Fake USDA + fake Agent SDK call, through the real routes. */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { tempData } from './helpers.mjs';

tempData();
const coach = await import('../coach/config.js');
const { forcePrivilegeVerdict } = await import('../coach/adapters/spawn.js');
const { nutritionRoutes } = await import('../nutrition/routes.js');
const { createAnalyzer } = await import('../nutrition/analyze.js');
const { createLookup } = await import('../nutrition/lookup.js');
const store = await import('../nutrition/store.js');
const ncfg = await import('../nutrition/config.js');
const S = await import('../nutrition/standin.js');
const M = await import('../nutrition/micros.js');
const { microsFromUsda } = await import('../nutrition/micros-sources.js');

const ok = o => ({ code: 0, text: typeof o === 'string' ? o : JSON.stringify(o), stderr: '', timedOut: false, spawnError: false });
const json = body => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
const DATE = '2026-10-12';

/* ---- USDA fixtures, shaped like FoodData Central ---- */
const nut = (id, amount, unitName) => ({ nutrient: { id, unitName }, amount });
// Taquitos live in Survey (FNDDS). Per 100 g: 250 kcal, 9 P, 26 C, 12 F. Vitamin D is in µg (micro sign), as the detail endpoint writes it.
const TAQUITO = { fdcId: 2003003, description: 'Taquito, beef and cheese', dataType: 'Survey (FNDDS)', foodNutrients: [
  nut(1008, 250, 'kcal'), nut(1003, 9, 'g'), nut(1004, 12, 'g'), nut(1005, 26, 'g'),
  nut(1162, 2, 'mg'), nut(1114, 0.5, 'µg'), nut(1106, 40, 'µg'), nut(1087, 120, 'mg'), nut(1089, 1.6, 'mg'), nut(1093, 480, 'mg'), nut(1079, 2, 'g')] };
// Much fattier: 25 g fat per 100 g.
const GREASY = { fdcId: 1000001, description: 'Chimichanga, fried', dataType: 'SR Legacy', foodNutrients: [nut(1008, 300, 'kcal'), nut(1003, 8, 'g'), nut(1004, 25, 'g'), nut(1005, 12, 'g'), nut(1087, 50, 'mg'), nut(1089, 1, 'mg')] };
const RAW = { fdcId: 1000002, description: 'Beef, raw', dataType: 'Foundation', foodNutrients: [nut(1008, 130, 'kcal'), nut(1003, 21, 'g'), nut(1004, 5, 'g'), nut(1005, 0, 'g')] };
const BY_ID = Object.fromEntries([TAQUITO, GREASY, RAW].map(f => [f.fdcId, f]));
const searchHit = f => ({ fdcId: f.fdcId, description: f.description, dataType: f.dataType });

function fakeUsda({ search = () => [TAQUITO, GREASY], fail = null } = {}) {
  const f = { searches: [], details: [], keys: [], urls: [] };
  f.fetch = async (url, init = {}) => {
    if (url.toString().includes('nal.usda.gov')) { f.keys.push(init.headers?.['X-Api-Key']); f.urls.push(String(url)); }
    url = String(url);
    if (fail === 'down') return { ok: false, status: 503, text: async () => '' };
    if (url.includes('/foods/search')) {
      const u = new URL(url);
      f.searches.push({ query: u.searchParams.get('query'), types: u.searchParams.get('dataType'), params: [...u.searchParams.keys()].sort() });
      return json({ foods: search(u.searchParams.get('query'), u.searchParams.get('dataType')).map(searchHit) });
    }
    const m = url.match(/\/food\/(\d+)(\?|$)/);
    if (m) { f.details.push(Number(m[1])); const d = BY_ID[m[1]]; return d ? json(d) : { ok: false, status: 404, text: async () => '' }; }
    throw new Error('unexpected url ' + url);
  };
  return f;
}

function connect() {
  coach.reset();
  coach.save({ enabled: true, provider: 'claude', authMode: 'instance', boundUid: {}, auth: { claude: { type: 'cli-token', account: 'o@example.test', data: coach.encrypt({ token: 'tok-owner' }) } } });
}
const USERS = { a: { id: 'sia' } };
function setup({ usda = fakeUsda(), invoke } = {}) {
  const calls = [];
  const analyzer = createAnalyzer({ invoke: async o => { calls.push(o); return invoke(o, calls.length); } });
  const lookup = createLookup({ fetch: usda.fetch, sleep: async () => {}, timeoutMs: 1000, retryDelayMs: 0 });
  const routes = nutritionRoutes({
    json: (res, code, obj) => { res.status = code; res.out = obj; },
    readBody: async q => q.body ?? {}, readSession: q => q.user || null, requireAdmin: () => null, lookup, analyzer
  });
  const call = async (key, { body, url } = {}) => { const res = {}; await routes[key]({ method: key.split(' ')[0], url: url || key.split(' ')[1], user: USERS.a, body }, res); return res; };
  const add = async entries => (await call('POST /api/nutrition/entries', { body: { date: DATE, entries } })).out.entries;
  const day = async () => (await call('GET /api/nutrition/day', { url: '/api/nutrition/day?date=' + DATE })).out;
  const used = () => store.aiUsed(store.read('sia'));
  return { calls, call, add, day, used, usda };
}
const TAQ_ENTRY = { name: 'Taquitos, Beef & Cheese', brand: '7-Eleven', meal: 'snack', qty: 1, serving: '1 taquito', calories: 190, protein_g: 7, carbs_g: 20, fat_g: 9, grams: 76 };
const pick = (id, fdc, extra = {}) => ({ id, fdc_id: fdc, confidence: 'high', reason: 'same dish', ...extra });

beforeEach(() => {
  forcePrivilegeVerdict({ ok: true, dropped: false, why: 'pinned by the test' });
  connect();
  ncfg.save({ aiDailyCap: 30, usdaKey: 'USDAKEY0123456789' });
  store.removeUser('sia');
});

/* ------------------------------ USDA ------------------------------ */

test('USDA candidates: reference datasets including Survey (FNDDS); Branded only with a brand; only the food and brand name leave', async () => {
  const usda = fakeUsda();
  const lk = createLookup({ fetch: usda.fetch, sleep: async () => {}, timeoutMs: 1000, retryDelayMs: 0 });
  const c = await lk.usdaCandidates('Taquitos, Beef & Cheese', '', 'KEY');
  assert.deepEqual(usda.searches.map(s => s.types), ['Foundation,SR Legacy,Survey (FNDDS)']);
  assert.deepEqual(c.map(x => [x.fdcId, x.dataType]), [[2003003, 'Survey (FNDDS)'], [1000001, 'SR Legacy']]);
  await lk.usdaCandidates('Taquitos', '7-Eleven', 'KEY');
  assert.ok(usda.searches.some(s => s.types === 'Branded' && /7-Eleven/.test(s.query)));
  for (const s of usda.searches) assert.deepEqual(s.params, ['dataType', 'pageSize', 'query']);
  assert.ok(usda.keys.every(k => k === 'KEY') && usda.urls.every(u => !u.includes('api_key') && !u.includes('KEY')), 'the key is in the header only');
  assert.deepEqual(await lk.usdaCandidates('x', '', 'KEY'), [], 'a one-letter name is not searched');
});

test('USDA detail: micronutrients in µg (micro sign), mg and g are all read; per 100 g', async () => {
  const lk = createLookup({ fetch: fakeUsda().fetch, sleep: async () => {}, timeoutMs: 1000, retryDelayMs: 0 });
  const f = await lk.usdaFood(2003003, 'KEY');
  assert.deepEqual(f.per100, { calories: 250, protein_g: 9, carbs_g: 26, fat_g: 12 });
  assert.deepEqual([f.micros100.vit_d_mcg, f.micros100.vit_a_mcg, f.micros100.vit_c_mg, f.micros100.calcium_mg, f.micros100.fiber_g], [0.5, 40, 2, 120, 2]);
  assert.equal(await lk.usdaFood(999, 'KEY'), null);
  assert.equal(await lk.usdaFood('12; drop', 'KEY'), null);
  assert.equal(microsFromUsda([{ nutrient: { id: 1114, unitName: 'µg' }, amount: 2 }, { nutrient: { id: 1114, unitName: 'μg' }, amount: 3 }]).vit_d_mcg, 2);
});

/* ------------------------------ the match ------------------------------ */

test('a good match: one AI call, the allowance counted once, the numbers from USDA scaled to the entry’s grams', async () => {
  const t = setup({ invoke: () => ok({ matches: [pick('e1', 2003003)] }) });
  const [e] = await t.add([TAQ_ENTRY]);
  const r = await t.call('POST /api/nutrition/micros/match', { body: { date: DATE, ids: [e.id] } });
  assert.equal(r.status, 200, JSON.stringify(r.out));
  const x = r.out.results[0];
  assert.deepEqual([x.status, x.confidence, x.reason], ['match', 'high', 'same dish']);
  assert.deepEqual([x.preview.name, x.preview.dataType, x.preview.grams, x.preview.how], ['Taquito, beef and cheese', 'Survey (FNDDS)', 76, 'entry']);
  // 76 g of the 100 g values.
  assert.deepEqual(x.preview.micros, { fiber_g: 1.52, calcium_mg: 91.2, iron_mg: 1.216, sodium_mg: 364.8, vit_a_mcg: 30.4, vit_c_mg: 1.52, vit_d_mcg: 0.38 });
  assert.deepEqual(x.preview.scaled, { calories: 190, protein_g: 6.8, carbs_g: 19.8, fat_g: 9.1 });
  assert.deepEqual(x.preview.diffs, [], 'close enough: nothing to warn about');
  assert.equal(t.calls.length, 1);
  assert.equal(t.used(), 1);
  assert.equal(r.out.ai.used, 1);
  assert.equal((await t.day()).entries[0].microsEst, undefined, 'nothing is saved by a match');
});

test('a batch of entries is ONE model call and ONE allowance', async () => {
  const t = setup({ invoke: () => ok({ matches: [pick('e1', 2003003), pick('e2', 2003003)] }) });
  const es = await t.add([TAQ_ENTRY, { ...TAQ_ENTRY, name: 'Beef taquito', brand: '' }]);
  const r = await t.call('POST /api/nutrition/micros/match', { body: { date: DATE, ids: es.map(e => e.id) } });
  assert.deepEqual(r.out.results.map(x => x.status), ['match', 'match']);
  assert.equal(t.calls.length, 1);
  assert.equal(t.used(), 1);
});

test('what the model sees: names, brands, amounts, calories and macros and the USDA candidates; nothing else', async () => {
  let prompt = '', system = '';
  const t = setup({ invoke: o => { prompt = o.promptText; system = o.systemPrompt; return ok({ matches: [pick('e1', 2003003)] }); } });
  const [e] = await t.add([TAQ_ENTRY]);
  await t.call('POST /api/nutrition/micros/match', { body: { date: DATE, ids: [e.id] } });
  assert.match(prompt, /Taquitos, Beef & Cheese/);
  assert.match(prompt, /7-Eleven/);
  assert.match(prompt, /"calories":190/);
  assert.match(prompt, /"fdc_id":2003003/);
  assert.doesNotMatch(prompt, new RegExp(e.id), 'no entry id');
  assert.doesNotMatch(prompt, /2026-10-12|sia|snack/, 'no date, profile or meal');
  assert.match(system, /never give nutrient amounts/);
});

test('numbers in the model’s answer are never used: only the fdcId, confidence and reason are read', async () => {
  const t = setup({ invoke: () => ok({ matches: [{ ...pick('e1', 2003003), calories: 99999, vit_c_mg: 5000, micros: { iron_mg: 900 }, vit_d_mcg: 77 }], vit_c_mg: 123 }) });
  const [e] = await t.add([TAQ_ENTRY]);
  const r = await t.call('POST /api/nutrition/micros/match', { body: { date: DATE, ids: [e.id] } });
  const m = r.out.results[0].preview.micros;
  assert.equal(m.vit_c_mg, 1.52);
  assert.equal(m.vit_d_mcg, 0.38);
  assert.equal(m.iron_mg, 1.216);
  assert.ok(!JSON.stringify(r.out).includes('99999') && !JSON.stringify(r.out).includes('5000'));
  const v = S.validateMatches(new Map([['e1', new Set([5])]]))({ matches: [{ id: 'e1', fdc_id: 5, confidence: 'high', reason: 'ok', calories: 1, iron_mg: 3 }] });
  assert.deepEqual(v.meal.get('e1'), { fdcId: 5, confidence: 'high', reason: 'ok' });
});

test('no good match: the model says so, nothing to add; a pick that is not one of the candidates counts as no match', async () => {
  let n = 0;
  const t = setup({ invoke: () => ok(n++ === 0 ? { matches: [{ id: 'e1', fdc_id: null, confidence: 'low', reason: 'nothing like it' }] } : { matches: [pick('e1', 424242)] }) });
  const [e] = await t.add([TAQ_ENTRY]);
  const a = await t.call('POST /api/nutrition/micros/match', { body: { date: DATE, ids: [e.id] } });
  assert.deepEqual([a.out.results[0].status, a.out.results[0].reason], ['none', 'nothing like it']);
  assert.equal(t.used(), 1, 'the model ran, so it is counted');
  const b = await t.call('POST /api/nutrition/micros/match', { body: { date: DATE, ids: [e.id] } });
  assert.equal(b.out.results[0].status, 'none');
  assert.equal(b.out.results[0].preview, undefined);
  assert.equal(b.out.results[0].candidates.length, 2, 'the candidates are still offered to choose from');
});

test('a stand-in whose macros differ a lot is flagged (twice the fat), with the numbers', async () => {
  const t = setup({ invoke: () => ok({ matches: [pick('e1', 1000001, { confidence: 'low' })] }) });
  const [e] = await t.add([TAQ_ENTRY]);
  const p = (await t.call('POST /api/nutrition/micros/match', { body: { date: DATE, ids: [e.id] } })).out.results[0].preview;
  const fat = p.diffs.find(d => d.key === 'fat_g');
  assert.deepEqual([fat.entry, fat.standin, fat.ratio], [9, 19, 2.11]);
  assert.ok(p.diffs.some(d => d.key === 'carbs_g'), 'carbs are off too');
});

test('an entry without grams: the weight is worked out from its calories, and the macros are cross-checked', async () => {
  const t = setup({ invoke: () => ok({ matches: [pick('e1', 2003003)] }) });
  const [e] = await t.add([{ ...TAQ_ENTRY, grams: undefined }]);
  const p = (await t.call('POST /api/nutrition/micros/match', { body: { date: DATE, ids: [e.id] } })).out.results[0].preview;
  assert.deepEqual([p.how, p.grams], ['calories', 76]);                       // 190 kcal ÷ 250 kcal per 100 g
  assert.equal(p.scaled.calories, 190);
  assert.equal(S.sizeFor({ calories: 0 }, { per100: { calories: 250 } }).ok, false, 'no grams and no calories: cannot be sized');
  assert.equal(S.sizeFor({ calories: 100 }, { per100: { calories: 0 } }).ok, false, 'a stand-in without calories cannot size it');
  // The macros disagree with a calorie-sized weight: flagged.
  const [g] = await t.add([{ ...TAQ_ENTRY, name: 'Fried beef thing', grams: undefined }]);
  const pg = S.preview(store.read('sia').days[DATE].entries.find(x => x.id === g.id), { fdcId: 1000001, name: 'x', dataType: 'SR Legacy', per100: { calories: 300, protein_g: 8, carbs_g: 12, fat_g: 25 }, micros100: { calcium_mg: 50 } });
  assert.ok(pg.diffs.length > 0);
});

test('tolerance: small gaps are not raised, big ones are', () => {
  const entry = { calories: 200, protein_g: 10, carbs_g: 20, fat_g: 8 };
  assert.deepEqual(S.compare(entry, { calories: 230, protein_g: 12, carbs_g: 24, fat_g: 10 }), []);
  assert.deepEqual(S.compare(entry, { calories: 420, protein_g: 10, carbs_g: 20, fat_g: 20 }).map(d => d.key), ['calories', 'fat_g']);
  assert.deepEqual(S.compare({ calories: 40, protein_g: 0, carbs_g: 0, fat_g: 4 }, { calories: 60, protein_g: 3, carbs_g: 2, fat_g: 6 }), [], 'a few grams on a small number is not a warning');
});

test('own values are never overwritten: the stand-in adds only what the entry does not know', async () => {
  const t = setup({ invoke: () => ok({ matches: [pick('e1', 2003003)] }) });
  // Fibre and sodium from a label are real; there are no vitamins or minerals yet.
  const [e] = await t.add([{ ...TAQ_ENTRY, micros: { sodium_mg: 400, fiber_g: 3 } }]);
  const p = (await t.call('POST /api/nutrition/micros/match', { body: { date: DATE, ids: [e.id] } })).out.results[0].preview;
  assert.ok(!('sodium_mg' in p.micros) && !('fiber_g' in p.micros));
  assert.deepEqual(p.alreadyKnown.sort(), ['fiber_g', 'sodium_mg']);
  const acc = await t.call('POST /api/nutrition/micros/apply', { body: { date: DATE, id: e.id, fdcId: 2003003, confidence: 'high' } });
  assert.equal(acc.status, 200, JSON.stringify(acc.out));
  assert.deepEqual(acc.out.entry.micros, { sodium_mg: 400, fiber_g: 3 }, 'the label values are untouched');
  // An entry that already has its own vitamins or minerals is not offered at all.
  const [f] = await t.add([{ ...TAQ_ENTRY, name: 'Vitamin-rich', micros: { vit_c_mg: 10 } }]);
  const r = await t.call('POST /api/nutrition/micros/match', { body: { date: DATE, ids: [f.id] } });
  assert.deepEqual([r.out.results[0].status, r.out.results[0].why], ['skipped', 'has-data']);
  assert.equal((await t.call('POST /api/nutrition/micros/apply', { body: { date: DATE, id: f.id, fdcId: 2003003 } })).status, 409);
  assert.equal(t.calls.length, 1, 'skipped entries cost nothing');
});

/* ------------------------------ the allowance ------------------------------ */

test('the allowance is given back when the model never ran, kept when it ran', async () => {
  for (const [label, answer, spent] of [
    ['runtime missing', { code: -1, text: '', stderr: 'not installed', timedOut: false, spawnError: true }, 0],
    ['provider error', { code: 1, text: '', stderr: 'overloaded', timedOut: false, spawnError: false }, 0],
    ['rejected credential', { code: 1, text: '', stderr: '401 unauthorized', timedOut: false, spawnError: false }, 0],
    ['timed out', { code: -1, text: '', stderr: '', timedOut: true, spawnError: false }, 1],
    ['unreadable answer', ok('this is not json'), 1]
  ]) {
    store.removeUser('sia');
    const t = setup({ invoke: () => answer });
    const [e] = await t.add([TAQ_ENTRY]);
    const r = await t.call('POST /api/nutrition/micros/match', { body: { date: DATE, ids: [e.id] } });
    assert.ok(r.status >= 500 || r.status === 504, label + ' ' + r.status);
    assert.equal(t.used(), spent, label);
  }
});

test('nothing reaches the model, and nothing is spent, when there is nothing to ask: no USDA key, no candidates, nothing eligible, the daily cap, the Coach off', async () => {
  let t = setup({ invoke: () => ok({ matches: [] }), usda: fakeUsda({ search: () => [] }) });
  const [e] = await t.add([TAQ_ENTRY]);
  const none = await t.call('POST /api/nutrition/micros/match', { body: { date: DATE, ids: [e.id] } });
  assert.deepEqual([none.status, none.out.results[0].status, t.calls.length, t.used()], [200, 'none', 0, 0]);
  t = setup({ invoke: () => ok({ matches: [] }), usda: fakeUsda({ fail: 'down' }) });
  assert.equal((await t.call('POST /api/nutrition/micros/match', { body: { date: DATE, ids: [e.id] } })).status, 502);
  assert.equal(t.used(), 0);
  ncfg.save({ usdaKey: null });
  t = setup({ invoke: () => ok({}) });
  const nokey = await t.call('POST /api/nutrition/micros/match', { body: { date: DATE, ids: [e.id] } });
  assert.deepEqual([nokey.status, nokey.out.code, t.used()], [409, 'no-usda', 0]);
  ncfg.save({ usdaKey: 'USDAKEY0123456789', aiDailyCap: 1 });
  t = setup({ invoke: () => ok({ matches: [pick('e1', 2003003)] }) });
  assert.equal((await t.call('POST /api/nutrition/micros/match', { body: { date: DATE, ids: [e.id] } })).status, 200);
  const capped = await t.call('POST /api/nutrition/micros/match', { body: { date: DATE, ids: [e.id] } });
  assert.deepEqual([capped.status, capped.out.code, t.calls.length], [429, 'cap', 1]);
  ncfg.save({ aiDailyCap: 30 });
  coach.save({ enabled: false });
  assert.equal((await t.call('POST /api/nutrition/micros/match', { body: { date: DATE, ids: [e.id] } })).out.code, 'unavailable');
});

test('input is bounded: 1 to 12 entries, a real date; unknown ids, supplements and nameless entries are skipped', async () => {
  const t = setup({ invoke: () => ok({ matches: [pick('e1', 2003003)] }) });
  const [e] = await t.add([TAQ_ENTRY]);
  for (const body of [{ date: DATE, ids: [] }, { date: DATE, ids: Array.from({ length: 13 }, (_, i) => 'x' + i) }, { date: DATE }, { date: 'nope', ids: [e.id] }]) {
    assert.equal((await t.call('POST /api/nutrition/micros/match', { body })).status, 400, JSON.stringify(body).slice(0, 40));
  }
  assert.equal((await t.call('POST /api/nutrition/micros/match', { body: { date: DATE, ids: ['nope'] } })).out.results[0].why, 'missing');
  assert.equal(S.skipReason({ name: 'x', meal: 'supplements' }), 'supplement');
  assert.equal(S.skipReason({ name: ' ', meal: 'snack' }), 'no-name');
  assert.equal(S.skipReason({ name: 'x', meal: 'snack', micros: { sodium_mg: 5 } }), null, 'sodium alone is not a vitamin or a mineral');
  assert.equal(t.calls.length, 0);
});

/* ------------------------------ choose another, accept, remove ------------------------------ */

test('choose another: the preview of the picked candidate needs no AI; accepting stores it marked as an estimate with its USDA source', async () => {
  const t = setup({ invoke: () => ok({ matches: [pick('e1', 2003003)] }) });
  const [e] = await t.add([TAQ_ENTRY]);
  await t.call('POST /api/nutrition/micros/match', { body: { date: DATE, ids: [e.id] } });
  const used = t.used();
  const alt = await t.call('POST /api/nutrition/micros/preview', { body: { date: DATE, id: e.id, fdcId: 1000001 } });
  assert.equal(alt.out.preview.name, 'Chimichanga, fried');
  assert.equal(t.used(), used);
  assert.equal(t.calls.length, 1);
  assert.equal((await t.call('POST /api/nutrition/micros/preview', { body: { date: DATE, id: e.id, fdcId: 31337 } })).status, 404);
  assert.equal((await t.call('POST /api/nutrition/micros/preview', { body: { date: DATE, id: e.id, fdcId: 'x' } })).status, 400);

  // The client may send whatever it likes; the stored numbers are USDA's, recomputed here.
  const acc = await t.call('POST /api/nutrition/micros/apply', { body: { date: DATE, id: e.id, fdcId: 2003003, confidence: 'medium', micros: { iron_mg: 800 }, microsEst: { micros: { iron_mg: 800 } } } });
  assert.equal(acc.status, 200, JSON.stringify(acc.out));
  const est = acc.out.entry.microsEst;
  assert.deepEqual([est.fdcId, est.name, est.dataType, est.confidence, est.grams, est.how], [2003003, 'Taquito, beef and cheese', 'Survey (FNDDS)', 'medium', 76, 'entry']);
  assert.equal(est.micros.iron_mg, 1.216);
  assert.equal(acc.out.entry.micros, undefined, 'the entry’s own micros stay empty');
  // Nothing else on the entry changed.
  assert.deepEqual([acc.out.entry.calories, acc.out.entry.name], [190, 'Taquitos, Beef & Cheese']);
  // Removing it.
  const gone = await t.call('POST /api/nutrition/micros/apply', { body: { date: DATE, id: e.id, remove: true } });
  assert.equal(gone.out.entry.microsEst, undefined);
  assert.equal((await t.call('POST /api/nutrition/micros/apply', { body: { date: DATE, id: 'nope', fdcId: 2003003 } })).status, 404);
});

test('a stand-in with no vitamins or minerals to add is refused, not stored as nothing', async () => {
  const t = setup({ invoke: () => ok({}) });
  const [e] = await t.add([{ ...TAQ_ENTRY, name: 'Beef' }]);
  const r = await t.call('POST /api/nutrition/micros/apply', { body: { date: DATE, id: e.id, fdcId: 1000002 } });
  assert.equal(r.status, 422);
});

/* ------------------------------ the day: estimated values apart ------------------------------ */

test('the day separates labels and databases, estimated stand-ins and no data; estimated amounts are kept apart and follow later amount edits', async () => {
  const t = setup({ invoke: () => ok({}) });
  const es = await t.add([
    { ...TAQ_ENTRY, name: 'Label food', micros: { vit_c_mg: 10, iron_mg: 1 } },
    { ...TAQ_ENTRY, name: 'Taquito' },
    { ...TAQ_ENTRY, name: 'Mystery' }
  ]);
  await t.call('POST /api/nutrition/micros/apply', { body: { date: DATE, id: es[1].id, fdcId: 2003003 } });
  let m = (await t.day()).micros.food;
  assert.deepEqual(m.groups, { labels: 1, estimated: 1, none: 1 });
  assert.equal(m.withData, 1);
  assert.deepEqual(m.totals, { vit_c_mg: 10, iron_mg: 1 }, 'totals are label and database amounts only');
  assert.equal(m.est.totals.vit_c_mg, 1.52);
  assert.equal(m.est.totals.calcium_mg, 91.2);
  // Doubling the amount doubles the estimate.
  await t.call('PUT /api/nutrition/entries', { url: `/api/nutrition/entries?date=${DATE}&id=${es[1].id}`, body: { qty: 2, calories: 380, protein_g: 14, carbs_g: 40, fat_g: 18 } });
  m = (await t.day()).micros.food;
  assert.equal(m.est.totals.calcium_mg, 182.4);
  // A label value for the same nutrient wins: the estimate never adds on top of it.
  await t.call('PUT /api/nutrition/entries', { url: `/api/nutrition/entries?date=${DATE}&id=${es[1].id}`, body: { micros: { calcium_mg: 300 } } });
  m = (await t.day()).micros.food;
  assert.equal(m.totals.calcium_mg, 300);
  assert.equal(m.est.totals.calcium_mg, undefined);
  assert.equal(m.groups.estimated, 1);
});

test('old entries (no estimate fields at all) still load and count as labels or none', async () => {
  const t = setup({ invoke: () => ok({}) });
  await t.add([{ ...TAQ_ENTRY, micros: { iron_mg: 1 } }, TAQ_ENTRY]);
  const s = (await t.day()).micros;
  assert.deepEqual(s.food.groups, { labels: 1, estimated: 0, none: 1 });
  assert.deepEqual(s.food.est, { totals: {} });
  assert.deepEqual(M.sumMicros([]), { totals: {}, withData: 0, entries: 0, est: { totals: {} }, groups: { labels: 0, estimated: 0, none: 0 } });
});
