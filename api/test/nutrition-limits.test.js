/* Limits: a server-wide USDA budget, the AI allowance reserved before USDA is asked, how much one profile can hold,
   a write rate limit per profile. (Body size caps are tested through the real server in nutrition-server.test.js.) */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempData } from './helpers.mjs';

const DIR = tempData();
const coach = await import('../coach/config.js');
const { forcePrivilegeVerdict } = await import('../coach/adapters/spawn.js');
const { nutritionRoutes } = await import('../nutrition/routes.js');
const { createAnalyzer } = await import('../nutrition/analyze.js');
const { createLookup } = await import('../nutrition/lookup.js');
const { createUsdaBudget, readCounter, TEXT } = await import('../nutrition/usda-budget.js');
const store = await import('../nutrition/store.js');
const ncfg = await import('../nutrition/config.js');
const v = await import('../nutrition/validate.js');

const json = body => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
const ok = o => ({ code: 0, text: JSON.stringify(o), stderr: '', timedOut: false, spawnError: false });
const DATE = '2026-10-12';
const clock = (t = Date.UTC(2026, 9, 12, 10, 30)) => { const c = { t, now: () => c.t, advance: ms => { c.t += ms; } }; return c; };
const env = (vars, fn) => async () => {
  const old = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try { await fn(); } finally { for (const [k, x] of Object.entries(old)) { if (x === undefined) delete process.env[k]; else process.env[k] = x; } }
};

/* ------------------------------ the USDA budget ------------------------------ */

test('USDA budget: per hour and per day for the server, per hour for a profile; resets on the hour and at midnight UTC; messages say which', env({ NUTRITION_USDA_HOURLY_CAP: '5', NUTRITION_USDA_DAILY_CAP: '10', NUTRITION_USDA_USER_HOURLY_CAP: '3' }, () => {
  const c = clock();
  const b = createUsdaBudget({ now: c.now });
  assert.deepEqual([b.take('a'), b.take('a'), b.take('a')], [null, null, null]);
  assert.equal(b.take('a'), 'user-hour', 'a profile has its own share');
  assert.deepEqual([b.take('b'), b.take('b')], [null, null]);
  assert.equal(b.take('c'), 'server-hour', '5 an hour for the server');
  assert.deepEqual(b.snapshot(), { hour: { used: 5, cap: 5 }, day: { used: 5, cap: 10 }, userHourCap: 3 });
  c.advance(3600000);                                                       // the next hour: 11:30
  assert.deepEqual([b.take('a'), b.take('a'), b.take('a')], [null, null, null], 'a new hour, a new share');
  c.advance(3600000);
  assert.deepEqual([b.take('d'), b.take('d')], [null, null]);
  assert.equal(b.take('e'), 'server-day', 'the day cap of 10 is reached across hours');
  c.advance(14 * 3600000);                                                  // past midnight UTC
  assert.equal(b.take('e'), null);
  assert.match(TEXT['server-hour'](), /server has used its USDA lookups for this hour \(5\).*top of the hour/);
  assert.match(TEXT['server-day'](), /for today \(10\).*midnight UTC/);
  assert.match(TEXT['user-hour'](), /You have used your share.*\(3\)/);
}));

test('USDA budget: the count survives a restart; defaults stay under USDA’s 1,000 an hour; a damaged counter file is kept aside, not trusted or deleted', () => {
  const file = path.join(DIR, 'nutrition', 'usda-usage-t.json');
  const c = clock();
  const a = createUsdaBudget({ file, now: c.now });
  a.take('u1'); a.take('u1');
  const b = createUsdaBudget({ file, now: c.now });
  assert.equal(b.snapshot().hour.used, 2);
  const d = createUsdaBudget({ file: path.join(DIR, 'nutrition', 'none.json'), now: c.now });
  assert.deepEqual([d.snapshot().hour.cap, d.snapshot().day.cap, d.snapshot().userHourCap], [800, 6000, 200]);
  fs.writeFileSync(file, '{not json');
  const logs = [];
  assert.equal(readCounter(file, m => logs.push(m)), null);
  assert.ok(fs.existsSync(file + '.damaged') && !fs.existsSync(file), 'kept as .damaged');
  assert.match(logs[0], /damaged/);
  assert.ok(!logs.join('').includes('not json'), 'the contents are not logged');
});

test('every USDA request counts once; a cached answer costs nothing; a search that lost a request is shown but not remembered', env({ NUTRITION_USDA_HOURLY_CAP: '4' }, async () => {
  const seen = [];
  const f = async url => { seen.push(new URL(url).searchParams.get('dataType')); return json({ foods: [{ fdcId: 1, description: 'Apple, raw', dataType: 'Foundation', foodNutrients: [{ nutrientId: 1008, value: 52 }] }] }); };
  const budget = createUsdaBudget({});
  const lk = createLookup({ fetch: f, sleep: async () => {}, timeoutMs: 1000, retryDelayMs: 0, usdaBudget: budget });
  const first = await lk.search('apple', { usdaKey: 'KEY12345', sources: 'usda', uid: 'u1' });
  assert.equal(first.sources.usda.ok, true);
  assert.equal(budget.snapshot().hour.used, 3, 'reference + branded + mixed dishes');
  await lk.search('apple', { usdaKey: 'KEY12345', sources: 'usda', uid: 'u1' });
  assert.equal(budget.snapshot().hour.used, 3, 'served from the memory cache');
  // One request left: the next search gets one of its three, and says so by showing what it has.
  const second = await lk.search('banana', { usdaKey: 'KEY12345', sources: 'usda', uid: 'u1' });
  assert.equal(second.sources.usda.ok, true);
  const third = await lk.search('banana', { usdaKey: 'KEY12345', sources: 'usda', uid: 'u1' });
  assert.equal(third.sources.usda.ok, false);
  assert.equal(third.sources.usda.kind, 'limit');
  assert.match(third.sources.usda.error, /USDA lookups for this hour \(4\)/);
}));

/* ------------------------------ the AI allowance comes first ------------------------------ */

const USERS = { a: { id: 'lma' } };
function setup({ usdaSearch, invoke, usdaBudget }) {
  const calls = [];
  const searches = [];
  const analyzer = createAnalyzer({ invoke: async o => { calls.push(o); return invoke(o); } });
  const f = async url => {
    url = String(url);
    if (url.includes('/foods/search')) { searches.push(store.aiUsed(store.read('lma'))); return json({ foods: usdaSearch() }); }
    throw new Error('unexpected ' + url);
  };
  const lookup = createLookup({ fetch: f, sleep: async () => {}, timeoutMs: 1000, retryDelayMs: 0, usdaBudget });
  const routes = nutritionRoutes({ json: (res, code, obj) => { res.status = code; res.out = obj; }, readBody: async q => q.body ?? {}, readSession: q => q.user || null, requireAdmin: () => null, lookup, analyzer, usdaBudget });
  const call = async (key, { body, url } = {}) => { const res = {}; await routes[key]({ method: key.split(' ')[0], url: url || key.split(' ')[1], user: USERS.a, body }, res); return res; };
  return { calls, searches, call, used: () => store.aiUsed(store.read('lma')) };
}
const TAQ = { name: 'Taquito', meal: 'snack', calories: 190, protein_g: 7, carbs_g: 20, fat_g: 9, qty: 1, grams: 76 };
const FOOD = [{ fdcId: 7, description: 'Taquito, beef', dataType: 'Survey (FNDDS)' }];

beforeEach(() => {
  forcePrivilegeVerdict({ ok: true, dropped: false, why: 'pinned by the test' });
  coach.reset();
  coach.save({ enabled: true, provider: 'claude', authMode: 'instance', boundUid: {}, auth: { claude: { type: 'cli-token', account: 'o@example.test', data: coach.encrypt({ token: 'tok-owner' }) } } });
  ncfg.save({ aiDailyCap: 30, usdaKey: 'USDAKEY0123456789' });
  store.removeUser('lma');
});

test('stand-in match: the allowance is reserved before USDA is asked', async () => {
  const t = setup({ usdaSearch: () => FOOD, invoke: () => ok({ matches: [{ id: 'e1', fdc_id: null, confidence: 'low', reason: 'x' }] }) });
  const [e] = (await t.call('POST /api/nutrition/entries', { body: { date: DATE, entries: [TAQ] } })).out.entries;
  await t.call('POST /api/nutrition/micros/match', { body: { date: DATE, ids: [e.id] } });
  assert.ok(t.searches.length > 0 && t.searches.every(n => n === 1), 'at the time of every USDA search the allowance was already taken: ' + t.searches);
});

test('stand-in match: with no allowance left USDA is never asked', async () => {
  ncfg.save({ aiDailyCap: 1 });
  const t = setup({ usdaSearch: () => FOOD, invoke: () => ok({ matches: [{ id: 'e1', fdc_id: 7, confidence: 'high', reason: 'x' }] }) });
  const [e] = (await t.call('POST /api/nutrition/entries', { body: { date: DATE, entries: [TAQ] } })).out.entries;
  await store.reserveAi('lma', 1);
  const r = await t.call('POST /api/nutrition/micros/match', { body: { date: DATE, ids: [e.id] } });
  assert.deepEqual([r.status, r.out.code, t.searches.length], [429, 'cap', 0]);
});

test('stand-in match: an empty or failed USDA lookup gives the allowance back; so does a model that never ran; a model that ran keeps it', async () => {
  const t = setup({ usdaSearch: () => [], invoke: () => ok({ matches: [{ id: 'e1', fdc_id: 7, confidence: 'high', reason: 'x' }] }) });
  const [e] = (await t.call('POST /api/nutrition/entries', { body: { date: DATE, entries: [TAQ] } })).out.entries;
  const run = () => t.call('POST /api/nutrition/micros/match', { body: { date: DATE, ids: [e.id] } });
  let r = await run();
  assert.deepEqual([r.status, r.out.results[0].status, t.used(), t.calls.length], [200, 'none', 0, 0], 'USDA had nothing: nothing was spent');
  const exhausted = createUsdaBudget({}); for (let i = 0; i < 800; i++) exhausted.take(null);
  const t2 = setup({ usdaSearch: () => FOOD, invoke: () => ok({}), usdaBudget: exhausted });
  r = await t2.call('POST /api/nutrition/micros/match', { body: { date: DATE, ids: [e.id] } });
  assert.equal(r.status, 502);
  assert.match(r.out.error, /USDA lookups for this hour/);
  assert.equal(t2.used(), 0, 'a budget refusal wastes no allowance');
  // (A fresh service: the first one remembers that USDA had nothing for this name.)
  let invoke2 = () => ({ code: -1, text: '', stderr: 'not installed', timedOut: false, spawnError: true });
  const t3 = setup({ usdaSearch: () => FOOD, invoke: o => invoke2(o) });
  const run3 = () => t3.call('POST /api/nutrition/micros/match', { body: { date: DATE, ids: [e.id] } });
  r = await run3();
  assert.deepEqual([r.status >= 500, t3.used()], [true, 0], 'the model never ran');
  invoke2 = () => ({ code: -1, text: '', stderr: '', timedOut: true, spawnError: false });
  r = await run3();
  assert.equal(t3.used(), 1, 'it ran and timed out: spent');
});

test('stand-in match: nothing eligible costs nothing and asks nobody', async () => {
  const t = setup({ usdaSearch: () => FOOD, invoke: () => ok({}) });
  const r = await t.call('POST /api/nutrition/micros/match', { body: { date: DATE, ids: ['nope'] } });
  assert.deepEqual([r.status, r.out.results[0].status, t.used(), t.searches.length], [200, 'skipped', 0, 0]);
});

/* ------------------------------ what one profile can hold ------------------------------ */

const bare = () => ({ json: (res, code, obj) => { res.status = code; res.out = obj; }, readBody: async q => q.body ?? {}, readSession: q => q.user || null, requireAdmin: () => null, lookup: {}, analyzer: {} });
const callOn = routes => async (key, user, { body, url } = {}) => { const res = {}; await routes[key]({ method: key.split(' ')[0], url: url || key.split(' ')[1], user, body }, res); return res; };
const day = n => new Date(Date.UTC(2000, 0, 1) + n * 86400000).toISOString().slice(0, 10);

test('a profile can hold at most 3,660 days: a new day is refused at the limit, an existing day still takes entries', async () => {
  const call = callOn(nutritionRoutes(bare()));
  const U = { id: 'lmdays' };
  store.removeUser('lmdays');
  await store.mutate('lmdays', d => { for (let i = 0; i < v.LIMITS.days; i++) d.days[day(i)] = { entries: [{ id: 'e' + i, meal: 'snack', name: 'x', calories: 1, protein_g: 0, carbs_g: 0, fat_g: 0, qty: 1 }] }; });
  const e = { name: 'y', meal: 'snack', calories: 5, protein_g: 0, carbs_g: 0, fat_g: 0 };
  const r = await call('POST /api/nutrition/entries', U, { body: { date: '2026-12-31', entries: [e] } });
  assert.equal(r.status, 409);
  assert.match(r.out.error, /at most 3660 days/);
  assert.equal((await call('POST /api/nutrition/entries', U, { body: { date: day(5), entries: [e] } })).status, 201, 'a day it already has');
  // Moving an entry to a new day is the same thing.
  const moved = await call('PUT /api/nutrition/entries', U, { url: `/api/nutrition/entries?date=${day(5)}&id=e5`, body: { newDate: '2026-12-31' } });
  assert.equal(moved.status, 409);
  store.removeUser('lmdays');
});

test('a profile can hold at most 50,000 entries', async () => {
  const call = callOn(nutritionRoutes(bare()));
  const U = { id: 'lment' };
  store.removeUser('lment');
  await store.mutate('lment', d => { for (let i = 0; i < 250; i++) d.days[day(i)] = { entries: Array.from({ length: 200 }, (_, j) => ({ id: `e${i}_${j}`, meal: 'snack', name: 'x', calories: 1, protein_g: 0, carbs_g: 0, fat_g: 0, qty: 1 })) }; });
  const r = await call('POST /api/nutrition/entries', U, { body: { date: day(400), entries: [{ name: 'y', meal: 'snack', calories: 5, protein_g: 0, carbs_g: 0, fat_g: 0 }] } });
  assert.equal(r.status, 409);
  assert.match(r.out.error, /at most 50000 entries/);
  store.removeUser('lment');
});

test('a profile file cannot grow past its size limit: the change is refused and the file stays as it was', async () => {
  store.removeUser('lmsize');
  await store.mutate('lmsize', d => { d.goals = { calories: 2000, protein_g: null, carbs_g: null, fat_g: null }; });
  const before = fs.readFileSync(path.join(DIR, 'nutrition', 'lmsize.json'), 'utf8');
  await assert.rejects(store.mutate('lmsize', d => { d.junk = 'x'.repeat(v.LIMITS.fileBytes + 10); }), store.NutritionLimitError);
  assert.equal(fs.readFileSync(path.join(DIR, 'nutrition', 'lmsize.json'), 'utf8'), before);
  store.removeUser('lmsize');
});

/* ------------------------------ writes per minute ------------------------------ */

test('writes are limited per profile per minute; reads and other profiles are not affected', env({ NUTRITION_WRITES_PER_MINUTE: '5' }, async () => {
  const routes = nutritionRoutes(bare());
  const call = callOn(routes);
  const A = { id: 'lmw1' }, B = { id: 'lmw2' };
  store.removeUser('lmw1'); store.removeUser('lmw2');
  const goals = { body: { calories: 2000, protein_g: null, carbs_g: null, fat_g: null } };
  const answers = [];
  for (let i = 0; i < 7; i++) answers.push((await call('PUT /api/nutrition/goals', A, goals)).status);
  assert.deepEqual(answers, [200, 200, 200, 200, 200, 429, 429]);
  const limited = await call('PUT /api/nutrition/goals', A, goals);
  assert.equal(limited.out.code, 'rate');
  assert.ok(limited.out.retryAfter >= 1);
  assert.equal((await call('GET /api/nutrition/goals', A)).status, 200, 'reads are not counted');
  assert.equal((await call('PUT /api/nutrition/goals', B, goals)).status, 200, 'another profile has its own');
  store.removeUser('lmw1'); store.removeUser('lmw2');
}));

test('the default is 120 changes a minute', async () => {
  const call = callOn(nutritionRoutes(bare()));
  const A = { id: 'lmw3' };
  store.removeUser('lmw3');
  const goals = { body: { calories: 2000, protein_g: null, carbs_g: null, fat_g: null } };
  let last;
  for (let i = 0; i < 121; i++) last = await call('PUT /api/nutrition/goals', A, goals);
  assert.equal(last.status, 429);
  store.removeUser('lmw3');
});
