/* GET /api/nutrition/health/history: the Apple Health stats page and Home card read this. Session auth only,
   your own profile only, bounded, and a figure that was never sent is null (not a made-up zero). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'health-history-'));
process.env.DATA_DIR = DIR;
fs.writeFileSync(path.join(DIR, 'secret'), 'a'.repeat(64), { mode: 0o600 });
const store = await import('../nutrition/store.js');
const { nutritionRoutes } = await import('../nutrition/routes.js');

const today = new Date().toISOString().slice(0, 10);
const shift = n => { const d = new Date(today + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const USERS = { a: { id: 'hha' }, b: { id: 'hhb' } };
let R;
function setup() {
  for (const u of Object.values(USERS)) store.removeUser(u.id);
  fs.rmSync(path.join(DIR, 'nutrition', 'health-tokens.json'), { force: true });
  R = nutritionRoutes({
    json: (res, code, obj) => { res.status = code; res.out = obj; },
    readBody: async q => q.body, readSession: q => q.user || null, requireAdmin: () => null, lookup: {}, analyzer: {},
    limitAddress: () => '10.0.0.9', userActive: () => true
  });
}
const call = async (key, { as, url, body, token } = {}) => {
  const res = {};
  await R[key]({ method: key.split(' ')[0], url: url || key.split(' ')[1], user: as ? USERS[as] : null, body, headers: token ? { authorization: 'Bearer ' + token } : {} }, res);
  return res;
};
const HIST = '/api/nutrition/health/history';
const hist = (as, qs = '') => call('GET ' + HIST, { as, url: HIST + qs });
const at = (day, t) => `${day} ${t} +0000`;
const send = (token, day, extra = {}) => call('POST /api/nutrition/health/hae', { token, body: { data: {
  metrics: [
    { name: 'active_energy', units: 'kcal', data: [{ date: at(day, '00:00:00'), qty: 500 }] },
    { name: 'basal_energy_burned', units: 'kcal', data: [{ date: at(day, '00:00:00'), qty: 1700 }] },
    ...(extra.metrics || [])
  ], workouts: extra.workouts || []
} } });
const mk = async as => (await call('POST /api/nutrition/health/token', { as })).out.token;

test('needs a signed-in session; the Health token is not a session', async () => {
  setup();
  const t = await mk('a');
  assert.equal((await call('GET ' + HIST, {})).status, 401);
  assert.equal((await call('GET ' + HIST, { token: t })).status, 401);
});

test('an empty profile: every day present, every figure null, nothing invented', async () => {
  setup();
  const r = await hist('a', `?date=${today}&days=7`);
  assert.equal(r.status, 200);
  assert.equal(r.out.days.length, 7);
  assert.equal(r.out.days.at(-1).date, today);
  assert.equal(r.out.days.at(0).date, shift(-6));
  for (const d of r.out.days) assert.deepEqual([d.active_kcal, d.burned_kcal, d.steps, d.exercise_min, d.workouts.length, d.updatedAt], [null, null, null, null, 0, null]);
  assert.deepEqual([r.out.hasData, r.out.token, r.out.updatedAt, r.out.workouts, r.out.weight.latest], [false, false, null, [], null]);
});

test('full data: totals per day, Burned is active + resting only, recent workouts newest first, weight, last update', async () => {
  setup();
  const t = await mk('a');
  const y = shift(-1);
  await send(t, y, { metrics: [
    { name: 'step_count', units: 'count', data: [{ date: at(y, '00:00:00'), qty: 9000 }] },
    { name: 'apple_exercise_time', units: 'min', data: [{ date: at(y, '00:00:00'), qty: 40 }] },
    { name: 'weight_body_mass', units: 'kg', data: [{ date: at(y, '07:00:00'), qty: 80.5 }] }
  ], workouts: [
    { name: 'Run', start: at(y, '07:00:00'), duration: 1800, activeEnergyBurned: { qty: 300, units: 'kcal' }, distance: { qty: 5, units: 'km' } },
    { name: 'Lift', start: at(y, '18:00:00'), duration: 3000, activeEnergyBurned: { qty: 250, units: 'kcal' } }
  ] });
  await send(t, today);
  const r = (await hist('a', `?date=${today}&days=30`)).out;
  const dy = r.days.find(d => d.date === y), dt = r.days.at(-1);
  assert.deepEqual([dy.burned_kcal, dy.steps, dy.exercise_min, dy.workouts.length], [2200, 9000, 40, 2]);
  assert.deepEqual([dt.burned_kcal, dt.steps, dt.exercise_min], [2200, null, null], 'steps and minutes were not sent today: null, not 0');
  assert.deepEqual(r.workouts.map(w => [w.date, w.time, w.name]), [[y, '18:00', 'Lift'], [y, '07:00', 'Run']]);
  assert.equal(r.weight.latest.kg, 80.5);
  assert.deepEqual([r.hasData, r.token], [true, true]);
  assert.ok(r.updatedAt > Date.now() - 60000);
});

test('a token with no data yet: token true, hasData false (the page says "waiting for the first sync")', async () => {
  setup();
  await mk('a');
  const r = (await hist('a')).out;
  assert.deepEqual([r.token, r.hasData], [true, false]);
});

test('profiles are isolated', async () => {
  setup();
  const ta = await mk('a');
  await send(ta, shift(-1));
  assert.equal((await hist('a')).out.hasData, true);
  const b = (await hist('b')).out;
  assert.deepEqual([b.hasData, b.token, b.workouts.length], [false, false, 0]);
  assert.ok(b.days.every(d => d.burned_kcal === null));
});

test('bounds: days is a whole number from 1 to 60; a bad date falls back to today; the recent-workouts list is capped', async () => {
  setup();
  for (const bad of ['0', '61', '-1', 'x', '1.5', '1e3', '']) assert.equal((await hist('a', `?days=${bad}`)).status, 400, bad);
  assert.equal((await hist('a', '?days=1')).out.days.length, 1);
  assert.equal((await hist('a', '?days=60')).out.days.length, 60);
  const odd = (await hist('a', '?date=2026-02-30&days=1')).out;
  assert.equal(odd.to, today);
  const t = await mk('a');
  const many = day => Array.from({ length: 20 }, (_, i) => ({ name: 'W' + i, start: at(day, `${String(i).padStart(2, '0')}:00:00`), duration: 600 }));
  await send(t, shift(-1), { workouts: many(shift(-1)) });
  await send(t, shift(-2), { workouts: many(shift(-2)) });
  const r = (await hist('a')).out;
  assert.equal(r.workouts.length, 30);
});
