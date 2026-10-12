/* Coach awareness of food: opt-in, numbers only, and strictly read-only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { tempData, writeState, sampleState } from './helpers.mjs';

const DIR = tempData();
const cfg = await import('../coach/config.js');
const jobs = await import('../coach/jobs.js');
const store = await import('../nutrition/store.js');
const summary = await import('../nutrition/coach-summary.js');
const { nutritionRoutes } = await import('../nutrition/routes.js');
const { forcePrivilegeVerdict } = await import('../coach/adapters/spawn.js');
const { CHANGE_TYPES, validateReview } = await import('../coach/core/validate.js');
const { LOCKDOWN } = await import('../coach/adapters/claude.js');
forcePrivilegeVerdict({ ok: true, dropped: false, why: 'pinned by the test suite' });

const API = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = (name, cal, p, c, f, meal = 'lunch') => ({ name, brand: 'SecretBrand', meal, source: 'quick', calories: cal, protein_g: p, carbs_g: c, fat_g: f, note: 'private note' });

async function seed(uid, { share = true, goals = { calories: 2400, protein_g: 160, carbs_g: null, fat_g: 70 } } = {}) {
  await store.mutate(uid, d => {
    d.coachShare = share; d.goals = goals;
    store.addEntries(d, '2026-10-10', [entry('Chicken wrap', 700, 40, 60, 25), entry('Oats', 300, 10, 50, 5, 'breakfast')]);   // 1000
    store.addEntries(d, '2026-10-11', [entry('Pasta', 1500, 50, 200, 40)]);                                                    // 1500
    store.addEntries(d, '2026-10-01', [entry('Too old', 9999, 1, 1, 1)]);                                                     // outside the window
    store.addEntries(d, '2026-10-13', [entry('Late-night snack', 200, 5, 20, 10, 'snack')]);                                   // user is a day ahead of the server
    store.addEntries(d, '2026-10-15', [entry('Far future', 8888, 1, 1, 1)]);                                                   // beyond tomorrow
  });
}

test('nothing is sent unless the person opted in, or when nothing is logged', async () => {
  await seed('u-off', { share: false });
  assert.equal(summary.nutritionForCoach('u-off', { today: '2026-10-12' }), null);
  assert.equal(summary.isSharing('u-off'), false);
  await store.mutate('u-empty', d => { d.coachShare = true; });
  assert.equal(summary.nutritionForCoach('u-empty', { today: '2026-10-12' }), null);
  assert.equal(summary.nutritionForCoach('u-never-existed', { today: '2026-10-12' }), null);
});

test('the summary: averages over logged days only, in a 14-day window that includes tomorrow', async () => {
  await seed('u-on');
  const s = summary.nutritionForCoach('u-on', { today: '2026-10-12' });
  // 09-30 … 10-13: the day-one entry, both middle days, and the late-night snack from a user a day ahead.
  assert.deepEqual(s.window, { from: '2026-09-30', to: '2026-10-13', days: 14, loggedDays: 4 });
  assert.deepEqual(s.perDay.map(x => x.d), ['2026-10-01', '2026-10-10', '2026-10-11', '2026-10-13']);
  assert.equal(s.average.calories, Math.round((9999 + 1000 + 1500 + 200) / 4), 'the mean of logged days — empty days are not zeros');
  assert.match(s.about, /unknown, not zero/);
});

test('the window drops what is older than two weeks and anything past tomorrow', async () => {
  await seed('u-win');
  const s = summary.nutritionForCoach('u-win', { today: '2026-10-20' });   // window 2026-10-08 … 2026-10-21
  assert.deepEqual(s.perDay.map(x => x.d), ['2026-10-10', '2026-10-11', '2026-10-13', '2026-10-15']);
  const t = summary.nutritionForCoach('u-win', { today: '2026-10-12' });   // window 2026-09-30 … 2026-10-13
  assert.ok(!t.perDay.some(x => x.d === '2026-10-15'));
  assert.deepEqual(t.perDay.find(x => x.d === '2026-10-10'), { d: '2026-10-10', kcal: 1000, p: 50, c: 110, f: 30 });
});

test('goals and the average against them', async () => {
  await store.mutate('u-goal', d => {
    d.coachShare = true; d.goals = { calories: 2000, protein_g: 150, carbs_g: null, fat_g: null };
    store.addEntries(d, '2026-10-11', [entry('a', 1800, 100, 200, 50)]);
    store.addEntries(d, '2026-10-12', [entry('b', 2200, 140, 250, 70)]);
  });
  const s = summary.nutritionForCoach('u-goal', { today: '2026-10-12' });
  assert.deepEqual(s.average, { calories: 2000, protein_g: 120, carbs_g: 225, fat_g: 60 });
  assert.deepEqual(s.goals, { calories: 2000, protein_g: 150, carbs_g: null, fat_g: null });
  assert.deepEqual(s.averageVsGoalPercent, { calories: 0, protein_g: -20 });
  await store.mutate('u-nogoal', d => { d.coachShare = true; store.addEntries(d, '2026-10-12', [entry('c', 500, 1, 1, 1)]); });
  const n = summary.nutritionForCoach('u-nogoal', { today: '2026-10-12' });
  assert.equal(n.goals, null);
  assert.ok(!('averageVsGoalPercent' in n));
});

test('numbers only: no food names, brands or notes can ride along, and it stays small', async () => {
  await seed('u-priv');
  await store.mutate('u-priv', d => { for (let i = 0; i < 40; i++) store.addEntries(d, '2026-10-12', [entry('Name' + i, 50, 1, 1, 1)]); });
  const text = JSON.stringify(summary.nutritionForCoach('u-priv', { today: '2026-10-12' }));
  for (const secret of ['Chicken', 'wrap', 'SecretBrand', 'private note', 'Name1', 'Oats', 'breakfast', 'u-priv']) assert.ok(!text.includes(secret), secret);
  assert.ok(text.length < 3000, `${text.length} characters`);
});

test('building the summary changes nothing on disk', async () => {
  await seed('u-ro');
  const file = path.join(DIR, 'nutrition', 'u-ro.json');
  const before = fs.readFileSync(file);
  const mtime = fs.statSync(file).mtimeMs;
  for (let i = 0; i < 5; i++) summary.nutritionForCoach('u-ro', { today: '2026-10-12' });
  assert.ok(fs.readFileSync(file).equals(before));
  assert.equal(fs.statSync(file).mtimeMs, mtime);
});

test('the Coach has no way to write food: no tools, no change type, no route, one read-only import', () => {
  assert.deepEqual(LOCKDOWN.tools, [], 'the model process has no tools at all');
  assert.ok(!CHANGE_TYPES.some(t => /nutri|food|diary|meal|goal|entry|calor|macro/i.test(t)), CHANGE_TYPES.join());
  const bad = validateReview({ coach_contract: 1, summary: 'x', evidence: { from: '2026-07-01', to: '2026-07-20', sessions: 1 }, changes: [{ id: 'c1', type: 'nutrition-goal', target: {}, before: 2400, after: 1800, why: 'x' }], notes: [] }, { routines: [], week: {} }, { customIds: [], equipment: [], offered: new Set() });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some(e => /not allowed/.test(e)));
  assert.deepEqual(Object.keys(summary).sort(), ['WINDOW_DAYS', 'isSharing', 'nutritionForCoach']);

  // Across the Coach's own source, the only reference to Nutrition is that one import in jobs.js.
  const refs = [];
  (function walk(d) {
    for (const n of fs.readdirSync(d)) {
      const f = path.join(d, n);
      if (fs.statSync(f).isDirectory()) walk(f);
      else if (/\.(js|mjs)$/.test(n)) for (const line of fs.readFileSync(f, 'utf8').split('\n')) if (/nutrition\//.test(line) && /\bimport\b|require\(/.test(line)) refs.push(path.relative(API, f) + ': ' + line.trim());
    }
  })(path.join(API, 'coach'));
  assert.deepEqual(refs, ["coach/jobs.js: import { nutritionForCoach } from '../nutrition/coach-summary.js';"]);
});

/* ---------------- end to end: a Coach review, with and without sharing ---------------- */

const seen = [];
const provider = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    seen.push({ url: req.url, body: body ? JSON.parse(body) : null });
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.url.startsWith('/v1/models')) return res.end(JSON.stringify({ data: [{ id: 'model-a' }] }));
    res.end(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify({ coach_contract: 1, nochange: true, reading: 'Nothing to change yet.' }) }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }));
  });
});
await new Promise(r => provider.listen(0, '127.0.0.1', r));
test.after(() => provider.close());

async function review(uid) {
  seen.length = 0;
  cfg.reset();
  cfg.save({ enabled: true, provider: 'anthropic', authMode: 'instance', boundUid: {}, log: [], caps: { perProfileDaily: 50, instanceDaily: 0 },
    auth: { anthropic: { type: 'apikey', account: '', data: cfg.encrypt({ token: 'sk-ant-test' }) } }, models: { anthropic: 'model-a' },
    providerOptions: { anthropic: { baseUrl: `http://127.0.0.1:${provider.address().port}` } } });
  writeState(DIR, uid, sampleState());
  jobs.enqueue(uid, { kind: 'review' });
  const until = Date.now() + 20000;
  while (jobs.status(uid).job && Date.now() < until) await new Promise(r => setTimeout(r, 25));
  return seen.find(s => s.url === '/v1/messages');
}
const payloadOf = req => JSON.parse(/```json\n([\s\S]*?)\n```/.exec(req.body.messages[0].content)[1]);

test('a Coach review carries the summary only for a profile that shared it — and leaves the food file alone', async () => {
  await seed('u-e2e', { share: true });
  const file = path.join(DIR, 'nutrition', 'u-e2e.json');
  const before = fs.readFileSync(file);
  const req = await review('u-e2e');
  assert.ok(req, 'the review reached the provider');
  const p = payloadOf(req);
  assert.ok(p.nutrition, 'the nutrition block is in the payload');
  assert.equal(p.nutrition.window.days, 14);
  assert.ok(!JSON.stringify(p.nutrition).includes('SecretBrand'));
  assert.match(req.body.system[0].text, /`nutrition` — present only when this person chose to share it/);
  assert.ok(fs.readFileSync(file).equals(before), 'the Coach job did not touch the diary');

  await store.mutate('u-e2e', d => { d.coachShare = false; });
  const off = payloadOf(await review('u-e2e'));
  assert.ok(!('nutrition' in off), 'switched off → absent');

  const never = payloadOf(await review('u-never'));
  assert.ok(!('nutrition' in never), 'a profile with no food data is unaffected');
});

test('the opt-in route: signed in, boolean only, reported in config with whether a Coach exists', async () => {
  const users = { a: { id: 'u-route' } };
  const routes = nutritionRoutes({ json: (res, code, obj) => { res.status = code; res.out = obj; }, readBody: async q => q.body, readSession: q => q.user, requireAdmin() {}, lookup: {}, analyzer: {} });
  const call = async (key, body, user = users.a) => { const res = {}; await routes[key]({ method: 'X', url: key.split(' ')[1], user, body }, res); return res; };
  assert.equal((await call('PUT /api/nutrition/coach-share', { share: true }, null)).status, 401);
  for (const bad of [{}, { share: 'yes' }, { share: 1 }, null]) assert.equal((await call('PUT /api/nutrition/coach-share', bad)).status, 400);
  assert.equal((await call('GET /api/nutrition/config', undefined)).out.coach.share, false, 'off by default');
  assert.equal((await call('PUT /api/nutrition/coach-share', { share: true })).out.share, true);
  const c = (await call('GET /api/nutrition/config', undefined)).out.coach;
  assert.deepEqual(c, { available: true, share: true });
  assert.equal(summary.isSharing('u-route'), true);
  cfg.save({ enabled: false });
  assert.equal((await call('GET /api/nutrition/config', undefined)).out.coach.available, false);
});
