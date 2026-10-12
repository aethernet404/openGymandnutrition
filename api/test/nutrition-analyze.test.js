/* AI logging: the guards, the allowance, and what happens to a photo — against a fake Agent SDK
   call (the real one is exercised by nutrition/spike/run.mjs on a live instance). */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempData } from './helpers.mjs';

const DIR = tempData();
const coach = await import('../coach/config.js');
const { forcePrivilegeVerdict } = await import('../coach/adapters/spawn.js');
const { nutritionRoutes } = await import('../nutrition/routes.js');
const { createAnalyzer, checkInput, availability, MAX_IMAGE_BYTES } = await import('../nutrition/analyze.js');
const store = await import('../nutrition/store.js');
const ncfg = await import('../nutrition/config.js');

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('this-is-the-secret-meal-photo-'), Buffer.alloc(200, 7)]);
const B64 = JPEG.toString('base64');
const GOOD = { meal_name: 'Eggs on toast', confidence: 'medium', items: [{ name: 'Egg', portion: '2', grams: 100, calories: 180, protein_g: 12, carbs_g: 1, fat_g: 14 }], notes: 'oil is a guess' };
const ok = text => ({ code: 0, text: typeof text === 'string' ? text : JSON.stringify(text), stderr: '', timedOut: false, spawnError: false });

function connect({ provider = 'claude', enabled = true, type = 'cli-token', bound = {} } = {}) {
  coach.reset();
  coach.save({ enabled, provider, authMode: 'instance', boundUid: bound, auth: { [provider]: { type, account: 'owner@example.test', data: coach.encrypt({ token: 'tok-owner' }) } } });
}

const USERS = { a: { id: 'ua' }, b: { id: 'ub' }, admin: { id: 'uadm', admin: true } };
function setup(invoke) {
  const calls = [];
  const analyzer = createAnalyzer({ invoke: async o => { calls.push(o); return invoke(o, calls.length); } });
  const routes = nutritionRoutes({
    json: (res, code, obj, h) => { res.status = code; res.out = obj; res.h = h; },
    readBody: async q => q.body ?? {}, readSession: q => q.user || null, requireAdmin: (q, r) => q.user?.admin ? q.user : null,
    lookup: {}, analyzer
  });
  const call = async (key, { as = 'a', body, url } = {}) => { const res = {}; await routes[key]({ method: key.split(' ')[0], url: url || key.split(' ')[1], user: USERS[as], body }, res); return res; };
  return { calls, call, analyzer };
}
const photo = (extra = {}) => ({ kind: 'photo', image: B64, ...extra });

beforeEach(() => {
  forcePrivilegeVerdict({ ok: true, dropped: false, why: 'pinned by the test' });
  connect();
  ncfg.save({ aiDailyCap: 30 });
  for (const u of Object.values(USERS)) store.removeUser(u.id);
});

test('input checks: photo bytes decide the type, sizes are bounded, text is trimmed', () => {
  const good = checkInput(photo({ note: '  no sauce \n' }));
  assert.equal(good.ok, true); assert.equal(good.mode, 'inline'); assert.equal(good.image.mediaType, 'image/jpeg'); assert.equal(good.note, 'no sauce');
  assert.equal(checkInput({ kind: 'photo', image: 'data:image/jpeg;base64,' + B64 }).ok, true, 'a data: URL is accepted');
  assert.equal(checkInput({ kind: 'photo', image: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64') }).ok, false, 'SVG is not an image here');
  assert.equal(checkInput({ kind: 'photo', image: Buffer.alloc(MAX_IMAGE_BYTES + 10, 1).toString('base64') }).ok, false);
  for (const bad of ['', '!!!not base64!!!', null, 5, '../../etc/passwd']) assert.equal(checkInput({ kind: 'photo', image: bad }).ok, false, String(bad));
  assert.equal(checkInput({ kind: 'text', text: ' two eggs\tand  toast ' }).description, 'two eggs and toast');
  assert.equal(checkInput({ kind: 'text', text: 'x' }).ok, false);
  assert.equal(checkInput({ kind: 'text', text: 'y'.repeat(900) }).description.length, 500);
  for (const bad of [null, {}, { kind: 'video' }, 'photo']) assert.equal(checkInput(bad).ok, false);
});

test('the AI runs only when the Coach is on and connected to Claude, and says why not', () => {
  assert.equal(availability('ua').ok, true);
  connect({ enabled: false });
  assert.deepEqual([availability('ua').ok, availability('ua').code], [false, 'unavailable']);
  connect({ provider: 'anthropic', type: 'apikey' });
  assert.equal(availability('ua').code, 'unavailable', 'another provider is not this feature’s path');
  connect({ bound: { claude: 'ub' } });
  assert.equal(availability('ua').code, 'shared', 'the Coach’s one-account rule applies unchanged');
  assert.equal(availability('ub').ok, true);
  connect();
  forcePrivilegeVerdict({ ok: false, dropped: false, why: 'no coach user' });
  assert.equal(availability('ua').code, 'unprivileged');
});

test('a photo analysis returns a draft, nothing is saved, and the photo is never written anywhere', async () => {
  let dirDuring = null, dirListing = null;
  const t = setup(o => { dirDuring = o.jobDir; dirListing = fs.readdirSync(o.jobDir); return ok(GOOD); });
  const r = await t.call('POST /api/nutrition/analyze', { body: photo({ note: 'homemade' }) });
  assert.equal(r.status, 200, JSON.stringify(r.out));
  assert.equal(r.out.draft.totals.calories, 180);
  assert.equal(r.out.draft.confidence, 'medium');
  assert.deepEqual(r.out.ai, { limit: 30, used: 1, remaining: 29 });

  // The call went through the Coach's credential path, inline, with the lockdown inputs.
  const c = t.calls[0];
  assert.equal(c.mode, 'inline');
  assert.equal(c.image.mediaType, 'image/jpeg');
  assert.ok(c.image.data.equals(JPEG));
  assert.equal(c.note, 'homemade');
  assert.equal(c.env.CLAUDE_CODE_OAUTH_TOKEN, 'tok-owner');
  assert.ok(!('ANTHROPIC_API_KEY' in c.env));
  assert.equal(c.env.HOME, c.jobDir);
  // The scratch directory was empty during the call and is gone after it.
  assert.deepEqual(dirListing, []);
  assert.ok(!fs.existsSync(dirDuring));

  // Nothing in the diary, and no byte of the photo anywhere under DATA_DIR.
  assert.deepEqual(store.read('ua').days, {});
  const hits = [];
  (function walk(d) { for (const n of fs.readdirSync(d)) { const f = path.join(d, n); if (fs.statSync(f).isDirectory()) walk(f); else { const b = fs.readFileSync(f); if (b.includes('this-is-the-secret-meal-photo-') || b.includes(B64.slice(20, 60))) hits.push(f); } } })(DIR);
  assert.deepEqual(hits, []);
});

test('analysing spends the Coach token the way a Coach job does: it binds it to the first profile', async () => {
  const t = setup(() => ok(GOOD));
  assert.equal(coach.boundUidFor(), null);
  await t.call('POST /api/nutrition/analyze', { as: 'a', body: photo() });
  assert.equal(coach.boundUidFor(), 'ua');
  const other = await t.call('POST /api/nutrition/analyze', { as: 'b', body: photo() });
  assert.equal(other.status, 409);
  assert.equal(other.out.code, 'shared');
  assert.equal(t.calls.length, 1, 'the second profile never reached the model');
  assert.equal(other.out.ai.used, 0, 'and was not charged');
});

test('a refused call (unavailable, shared, off) binds nothing', async () => {
  const t = setup(() => ok(GOOD));
  connect({ enabled: false });
  assert.equal((await t.call('POST /api/nutrition/analyze', { body: photo() })).status, 503);
  assert.equal(coach.boundUidFor(), null);
});

test('text mode sends the description and no image', async () => {
  const t = setup(() => ok(GOOD));
  const r = await t.call('POST /api/nutrition/analyze', { body: { kind: 'text', text: 'two eggs and toast' } });
  assert.equal(r.status, 200);
  assert.equal(t.calls[0].mode, 'text');
  assert.equal(t.calls[0].description, 'two eggs and toast');
  assert.equal(t.calls[0].image, undefined);
});

test('an unreadable answer gets one repair round, with the previous answer and the errors', async () => {
  const t = setup((o, n) => (n === 1 ? ok({ ...GOOD, confidence: 'certain' }) : ok(GOOD)));
  const r = await t.call('POST /api/nutrition/analyze', { body: photo() });
  assert.equal(r.status, 200);
  assert.equal(r.out.calls, 2);
  assert.match(t.calls[1].repair.errors[0], /confidence/);
  assert.equal(r.out.ai.used, 1, 'a repaired answer is still one analysis');
});

test('failures: the allowance is given back only when the model produced nothing', async () => {
  const cases = [
    ['missing', { code: -1, text: '', stderr: 'not installed', spawnError: true }, 503, 0],
    ['auth', { code: 1, text: '', stderr: 'Invalid API key · 401 unauthorized' }, 502, 0],
    ['provider', { code: 1, text: '', stderr: 'the Agent SDK stopped: error_during_execution' }, 502, 0],
    ['timeout', { code: -1, text: '', stderr: '', timedOut: true }, 504, 1],
    ['unusable', ok('no json at all'), 502, 1]
  ];
  for (const [code, reply, status, used] of cases) {
    store.removeUser('ua');
    const t = setup(() => reply);
    const r = await t.call('POST /api/nutrition/analyze', { body: photo() });
    assert.equal(r.out.code, code, code);
    assert.equal(r.status, status, code);
    assert.equal(r.out.ai.used, used, `${code}: used`);
    assert.ok(r.out.error.length > 10, 'a sentence the app can show');
    assert.deepEqual(store.read('ua').days, {});
  }
});

test('the daily allowance: spent per profile, refused when used up, and the model is not called', async () => {
  ncfg.save({ aiDailyCap: 2 });
  const t = setup(() => ok(GOOD));
  assert.equal((await t.call('POST /api/nutrition/analyze', { body: photo() })).out.ai.remaining, 1);
  assert.equal((await t.call('POST /api/nutrition/analyze', { body: { kind: 'text', text: 'toast' } })).out.ai.remaining, 0);
  const third = await t.call('POST /api/nutrition/analyze', { body: photo() });
  assert.equal(third.status, 429);
  assert.equal(third.out.code, 'cap');
  assert.deepEqual(third.out.ai, { limit: 2, used: 2, remaining: 0 });
  assert.equal(t.calls.length, 2);
  assert.equal(coach.load().caps.perProfileDaily, 10, 'the Coach cap is a different counter, untouched');
  // text and photo share one allowance; a different profile has its own (but is refused by the shared token)
  ncfg.save({ aiDailyCap: 3 });
  assert.equal((await t.call('POST /api/nutrition/analyze', { body: photo() })).status, 200);
});

test('a cap of 0 switches AI logging off with its own message', async () => {
  ncfg.save({ aiDailyCap: 0 });
  const t = setup(() => ok(GOOD));
  const r = await t.call('POST /api/nutrition/analyze', { body: photo() });
  assert.deepEqual([r.status, r.out.code], [403, 'ai-off']);
  assert.equal(t.calls.length, 0);
  const cfg = await t.call('GET /api/nutrition/config');
  assert.deepEqual([cfg.out.ai.available, cfg.out.ai.reason], [false, 'off']);
});

test('one analysis at a time per profile; the loser is told to wait and is not charged', async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  const t = setup(async () => { await gate; return ok(GOOD); });
  const first = t.call('POST /api/nutrition/analyze', { body: photo() });
  await new Promise(r => setTimeout(r, 20));
  const second = await t.call('POST /api/nutrition/analyze', { body: photo() });
  assert.deepEqual([second.status, second.out.code], [409, 'busy']);
  release();
  const done = await first;
  assert.equal(done.status, 200);
  assert.equal(done.out.ai.used, 1);
  assert.equal(t.calls.length, 1);
});

test('the time budget: a slow first answer leaves no time for a repair round', async () => {
  let clock = 1000;
  const analyzer = createAnalyzer({ now: () => clock, budgetMs: 30000, invoke: async o => { clock += 25000; return o.repair ? ok(GOOD) : ok('not json'); } });
  const r = await analyzer.analyze('ua', checkInput(photo()));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'timeout', 'gave up rather than start a second call it could not finish');
});

test('bad input costs nothing', async () => {
  const t = setup(() => ok(GOOD));
  for (const body of [{ kind: 'photo', image: '' }, { kind: 'text', text: '' }, { kind: 'nope' }, null]) {
    const r = await t.call('POST /api/nutrition/analyze', { body });
    assert.equal(r.status, 400);
  }
  assert.equal(t.calls.length, 0);
  assert.equal(store.aiUsed(store.read('ua')), 0);
});

test('config tells the app whether AI can run and why not', async () => {
  const t = setup(() => ok(GOOD));
  assert.deepEqual((await t.call('GET /api/nutrition/config')).out.ai, { limit: 30, used: 0, remaining: 30, available: true, reason: null });
  connect({ enabled: false });
  const off = (await t.call('GET /api/nutrition/config')).out.ai;
  assert.deepEqual([off.available, off.reason], [false, 'unavailable']);
});

test('an analysis that throws unexpectedly gives the allowance back and frees the profile', async () => {
  let boom = true;
  const t = setup(() => { if (boom) throw new Error('kaboom'); return ok(GOOD); });
  const r = await t.call('POST /api/nutrition/analyze', { body: photo() }).catch(e => e);
  // The pipeline turns a throw from the adapter into an exception; the route must still clean up.
  assert.ok(r instanceof Error || r.status >= 500);
  assert.equal(store.aiUsed(store.read('ua')), 0);
  boom = false;
  assert.equal((await t.call('POST /api/nutrition/analyze', { body: photo() })).status, 200, 'not stuck busy');
});
