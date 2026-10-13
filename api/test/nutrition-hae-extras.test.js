/* Health Auto Export extras: workouts, exercise minutes, body weight. Display-only data (workouts are
   already part of Active Energy), so the central test here is that they never reach Burned or Net. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hae-extras-'));
process.env.DATA_DIR = DIR;
fs.writeFileSync(path.join(DIR, 'secret'), 'e'.repeat(64), { mode: 0o600 });
const store = await import('../nutrition/store.js');
const hae = await import('../nutrition/hae.js');
const haeDebug = await import('../nutrition/hae-debug.js');
const cfg = await import('../nutrition/config.js');
const { nutritionRoutes } = await import('../nutrition/routes.js');

const today = new Date().toISOString().slice(0, 10);
const shift = n => { const d = new Date(today + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const D0 = shift(-1), D1 = shift(-2);

const at = (day, time, off = '+0100') => `${day} ${time} ${off}`;
const metric = (name, units, data) => ({ name, units, data });
const one = (name, units, entries) => metric(name, units, entries.map(([date, qty]) => ({ date, qty, source: '' })));
const energy = day => [one('active_energy', 'kcal', [[at(day, '00:00:00'), 600]]), one('basal_energy_burned', 'kcal', [[at(day, '00:00:00'), 1700]])];
const workout = (day, name, time, durationSec, kcal, extra = {}) => ({
  id: name + time, name, start: at(day, time), end: at(day, time), duration: durationSec,
  activeEnergyBurned: kcal == null ? undefined : { qty: kcal, units: 'kcal' }, ...extra
});
const body = (metrics, workouts = []) => ({ data: { metrics, workouts } });

const USERS = { a: { id: 'hxa' }, admin: { id: 'hxadm', admin: true } };
function setup() {
  for (const u of Object.values(USERS)) store.removeUser(u.id);
  fs.rmSync(path.join(DIR, 'nutrition', 'health-tokens.json'), { force: true });
  haeDebug.clear(); cfg.save({ healthDebug: false });
  const R = nutritionRoutes({
    json: (res, code, obj) => { res.status = code; res.out = obj; },
    readBody: async q => q.body, readSession: q => q.user || null,
    requireAdmin: (q, r) => (q.user?.admin ? q.user : (r.status = 403, null)), lookup: {}, analyzer: {},
    limitAddress: () => '10.0.0.9', userActive: () => true
  });
  const call = async (key, { as, token, body: b, url } = {}) => {
    const res = {};
    await R[key]({ method: key.split(' ')[0], url: url || key.split(' ')[1], user: as ? USERS[as] : null, body: b, headers: token ? { authorization: 'Bearer ' + token } : {} }, res);
    return res;
  };
  return { call };
}
const HAE = 'POST /api/nutrition/health/hae';
const mk = async call => (await call('POST /api/nutrition/health/token', { as: 'a' })).out.token;
const dayOf = (call, date) => call('GET /api/nutrition/day', { as: 'a', url: `/api/nutrition/day?date=${date}` }).then(r => r.out);

/* ------------------------------ parsing ------------------------------ */

test('workouts: several in a day, kJ converted, distance optional, each placed on its start day', () => {
  const r = hae.parseHae(body(energy(D0), [
    workout(D0, 'Traditional Strength Training', '18:30:00', 2700, 320),
    { id: 'r1', name: 'Running', start: at(D0, '07:05:00'), duration: 1805, activeEnergyBurned: { qty: 1046, units: 'kJ' }, distance: { qty: 5.2, units: 'km' } },
    { id: 'w1', name: 'Walking', start: at(D1, '12:00:00'), duration: 600, activeEnergyBurned: { qty: 40, units: 'kcal' }, distance: { qty: 1, units: 'mi' } }
  ]));
  assert.equal(r.ok, true);
  const d0 = r.activity.find(a => a.date === D0), d1 = r.activity.find(a => a.date === D1);
  assert.deepEqual(d0.workouts.map(w => [w.name, w.time, w.duration_min, w.kcal, w.km]), [
    ['Running', '07:05', 30, 250, 5.2],                    // 1046 kJ ≈ 250 kcal; sorted by start time
    ['Traditional Strength Training', '18:30', 45, 320, null]   // no distance
  ]);
  assert.deepEqual(d1.workouts.map(w => [w.kcal, w.km]), [[40, 1.61]]);
  assert.equal(d0.exercise_min, null, 'no exercise-minutes metric was sent');
});

test('workouts: a workout missing calories is kept without them; unreadable ones are skipped with a warning', () => {
  const r = hae.parseHae(body(energy(D0), [
    workout(D0, 'Yoga', '09:00:00', 1800, null),
    { name: '', start: at(D0, '10:00:00'), duration: 60 },
    { name: 'No time', duration: 60 },
    { name: 'Bad duration', start: at(D0, '11:00:00'), duration: 'x' },
    { name: 'Huge', start: at(D0, '11:00:00'), duration: 1e9 },
    'nonsense', null
  ]));
  assert.equal(r.ok, true);
  assert.deepEqual(r.activity[0].workouts.map(w => [w.name, w.kcal]), [['Yoga', null]]);
  assert.match(r.warnings.join(' '), /6 workout\(s\).*skipped/);
});

test('workouts: the same workout twice in one payload counts once; absurd calories and distance are dropped from the workout, not the day', () => {
  const w = workout(D0, 'Cycling', '08:00:00', 3600, 99999, { distance: { qty: 5000, units: 'km' } });
  const r = hae.parseHae(body(energy(D0), [w, { ...w }]));
  assert.equal(r.activity[0].workouts.length, 1);
  assert.equal(r.activity[0].workouts[0].kcal, null);
  assert.equal(r.activity[0].workouts[0].km, null);
});

test('workouts: duration falls back to end − start', () => {
  const r = hae.parseHae(body(energy(D0), [{ name: 'Swim', start: at(D0, '06:00:00'), end: at(D0, '06:40:00'), activeEnergyBurned: { qty: 300, units: 'kcal' } }]));
  assert.equal(r.activity[0].workouts[0].duration_min, 40);
});

test('exercise minutes: summed per day, minutes or seconds', () => {
  const r = hae.parseHae(body([...energy(D0), one('apple_exercise_time', 'min', [[at(D0, '08:00:00'), 20], [at(D0, '18:00:00'), 25.4]])]));
  assert.equal(r.activity.find(a => a.date === D0).exercise_min, 45);
  const s = hae.parseHae(body([...energy(D0), one('apple_exercise_time', 's', [[at(D0, '00:00:00'), 1800]])]));
  assert.equal(s.activity[0].exercise_min, 30);
  const bad = hae.parseHae(body([...energy(D0), one('apple_exercise_time', 'furlongs', [[at(D0, '00:00:00'), 5]])]));
  assert.equal(bad.ok, true, 'a unit it does not know costs the extra, not the payload');
  assert.deepEqual(bad.activity, []);
  assert.match(bad.warnings.join(' '), /units "furlongs" are not understood/);
});

test('weight: kg and lb are converted to kg; the latest reading of a day stands; implausible values are skipped', () => {
  const lb = hae.parseHae(body([...energy(D0), one('weight_body_mass', 'lb', [[at(D0, '07:00:00'), 180], [at(D0, '21:00:00'), 181]])]));
  assert.deepEqual(lb.weights, [{ date: D0, kg: 82.1 }]);
  const kg = hae.parseHae(body([...energy(D0), one('weight_body_mass', 'kg', [[at(D0, '07:00:00'), 80.25], [at(D1, '07:00:00'), 81]])]));
  assert.deepEqual(kg.weights, [{ date: D1, kg: 81 }, { date: D0, kg: 80.25 }]);
  const wild = hae.parseHae(body([...energy(D0), one('weight_body_mass', 'kg', [[at(D0, '07:00:00'), 8], [at(D0, '08:00:00'), 900], [at(D0, '09:00:00'), NaN]])]));
  assert.deepEqual(wild.weights, []);
  assert.match(wild.warnings.join(' '), /weight point\(s\) were unreadable or not plausible/);
});

test('unknown metrics are ignored: stand hours, flights, nutrition, symptoms never reach the output', () => {
  const r = hae.parseHae(body([...energy(D0),
    one('apple_stand_hour', 'hr', [[at(D0, '10:00:00'), 1]]), one('apple_stand_time', 'min', [[at(D0, '10:00:00'), 5]]),
    one('flights_climbed', 'count', [[at(D0, '10:00:00'), 4]]), one('dietary_energy', 'kcal', [[at(D0, '12:00:00'), 700]]),
    one('dietary_protein', 'g', [[at(D0, '12:00:00'), 40]]), one('headache', 'count', [[at(D0, '12:00:00'), 1]]), one('physical_effort', 'kcal/hr·kg', [[at(D0, '12:00:00'), 3]])]));
  assert.equal(r.ok, true);
  assert.deepEqual(r.ignoredMetrics.sort(), ['apple_stand_hour', 'apple_stand_time', 'dietary_energy', 'dietary_protein', 'flights_climbed', 'headache', 'physical_effort']);
  assert.deepEqual(r.activity, []); assert.deepEqual(r.weights, []);
  assert.equal(r.days[0].active_kcal, 600, 'dietary energy was not mistaken for active energy');
});

test('extras alone are enough: a payload with only workouts or only weight is accepted, calories are simply not updated', () => {
  const r = hae.parseHae(body([one('weight_body_mass', 'kg', [[at(D0, '07:00:00'), 80]])], [workout(D0, 'Run', '07:00:00', 600, 90)]));
  assert.equal(r.ok, true);
  assert.deepEqual(r.days, []);
  assert.match(r.warnings.join(' '), /calories were not updated/);
  const wo = hae.parseHae({ data: { workouts: [workout(D0, 'Run', '07:00:00', 600, 90)] } });
  assert.equal(wo.ok, true);
});

/* ------------------------------ storage and the diary ------------------------------ */

test('through the route: workouts, exercise minutes and weight are stored and shown in the day view', async () => {
  const { call } = setup(); const t = await mk(call);
  const r = await call(HAE, { token: t, body: body([...energy(D0), one('apple_exercise_time', 'min', [[at(D0, '00:00:00'), 52]]), one('weight_body_mass', 'kg', [[at(D0, '07:00:00'), 79.8]])],
    [workout(D0, 'Traditional Strength Training', '18:30:00', 2700, 320)]) });
  assert.equal(r.status, 200, JSON.stringify(r.out));
  assert.deepEqual(r.out.activity, [{ date: D0, exercise_min: 52, workouts: 1, action: 'stored' }]);
  assert.deepEqual(r.out.weights, [{ date: D0, kg: 79.8, action: 'stored' }]);
  const view = await dayOf(call, D0);
  assert.deepEqual(view.activity.workouts, [{ name: 'Traditional Strength Training', time: '18:30', duration_min: 45, kcal: 320, km: null }]);
  assert.equal(view.activity.exercise_min, 52);
  const w = (await call('GET /api/nutrition/weight', { as: 'a', url: `/api/nutrition/weight?date=${today}` })).out;
  assert.deepEqual(w.latest, { date: D0, kg: 79.8 });
  assert.equal(w.count, 1);
});

test('workout calories are NEVER added to Burned or Net', async () => {
  const { call } = setup(); const t = await mk(call);
  await call(HAE, { token: t, body: body(energy(D0), [workout(D0, 'HIIT', '07:00:00', 1800, 400), workout(D0, 'Run', '17:00:00', 1800, 500)]) });
  const view = await dayOf(call, D0);
  assert.equal(view.health.active_kcal, 600);
  assert.equal(view.health.resting_kcal, 1700);
  assert.equal(view.health.burned_kcal, 2300, 'Burned = Active + Resting only; 900 kcal of workouts are inside the 600 already (or not at all), never on top');
  assert.equal(Object.hasOwn(view.health, 'workouts'), false);
  const stored = store.read('hxa').health;
  assert.equal(stored.days[D0].active, 600);
  assert.equal(JSON.stringify(stored.days[D0]).includes('400'), false);
  // And a workouts-only export leaves the energy numbers alone.
  await call(HAE, { token: t, body: body([], [workout(D0, 'Walk', '12:00:00', 600, 9999 / 100)]) });
  assert.equal((await dayOf(call, D0)).health.burned_kcal, 2300);
  // A day with workouts but no energy has no Burned at all.
  await call(HAE, { token: t, body: body([], [workout(D1, 'Walk', '12:00:00', 600, 50)]) });
  const only = await dayOf(call, D1);
  assert.equal(only.health, null);
  assert.equal(only.activity.workouts[0].kcal, 50);
});

test('repeated exports of the same day replace its workouts and minutes, never add', async () => {
  const { call } = setup(); const t = await mk(call);
  const first = () => body([...energy(D0), one('apple_exercise_time', 'min', [[at(D0, '00:00:00'), 30]])], [workout(D0, 'Run', '07:00:00', 1800, 300)]);
  await call(HAE, { token: t, body: first() });
  const again = await call(HAE, { token: t, body: first() });
  assert.equal(again.out.activity[0].action, 'replaced');
  let v = await dayOf(call, D0);
  assert.equal(v.activity.workouts.length, 1);
  assert.equal(v.activity.exercise_min, 30);
  const more = await call(HAE, { token: t, body: body([...energy(D0), one('apple_exercise_time', 'min', [[at(D0, '00:00:00'), 75]])], [workout(D0, 'Run', '07:00:00', 1800, 300), workout(D0, 'Lift', '18:00:00', 3000, 250)]) });
  assert.equal(more.out.activity[0].workouts, 2);
  v = await dayOf(call, D0);
  assert.deepEqual([v.activity.workouts.length, v.activity.exercise_min], [2, 75]);
  // a workout deleted in Health disappears from the day on the next export
  await call(HAE, { token: t, body: body(energy(D0), [workout(D0, 'Lift', '18:00:00', 3000, 250)]) });
  v = await dayOf(call, D0);
  assert.deepEqual(v.activity.workouts.map(w => w.name), ['Lift']);
  assert.equal(v.activity.exercise_min, 75, 'minutes not sent this time are left as they were');
});

test('a partial export cannot lower the day’s exercise minutes', async () => {
  const { call } = setup(); const t = await mk(call);
  await call(HAE, { token: t, body: body([...energy(D0), one('apple_exercise_time', 'min', [[at(D0, '00:00:00'), 60]])]) });
  const r = await call(HAE, { token: t, body: body([...energy(D0), one('apple_exercise_time', 'min', [[at(D0, '15:00:00'), 10]])]) });
  assert.equal(r.out.activity[0].action, 'kept');
  assert.equal((await dayOf(call, D0)).activity.exercise_min, 60);
});

test('weight: one reading per date, replaced on resend; the trend is the last 30 days; unit conversion is the client’s', async () => {
  const { call } = setup(); const t = await mk(call);
  const send = (day, kg, unit = 'kg') => call(HAE, { token: t, body: body([one('weight_body_mass', unit, [[at(day, '07:00:00'), kg]])]) });
  await send(shift(-3), 81); await send(shift(-2), 80.5); await send(shift(-1), 177.5, 'lb');
  assert.equal((await send(shift(-1), 177, 'lb')).out.weights[0].action, 'replaced');
  const w = (await call('GET /api/nutrition/weight', { as: 'a', url: `/api/nutrition/weight?date=${today}` })).out;
  assert.deepEqual(w.readings.map(x => x.kg), [81, 80.5, 80.29]);
  assert.deepEqual(w.latest, { date: shift(-1), kg: 80.29 });
  assert.equal(w.count, 3);
  const old = store.weightView({ health: { weights: [{ date: '2026-01-01', kg: 90 }, { date: '2026-02-20', kg: 85 }, { date: '2026-03-01', kg: 84 }] } }, '2026-03-01', 30);
  assert.deepEqual(old.readings.map(x => x.kg), [85, 84], 'only the last 30 days are in the trend, but latest is the newest');
  assert.equal(old.count, 3);
  assert.deepEqual(store.weightView({}, today), { latest: null, readings: [], count: 0 });
});

test('weight and workouts are capped: per-day workouts, readings per year', async () => {
  const { call } = setup(); const t = await mk(call);
  const many = Array.from({ length: 30 }, (_, i) => workout(D0, 'W' + i, `${String(i % 24).padStart(2, '0')}:${String(i).padStart(2, '0')}:00`, 600, 10));
  const r = await call(HAE, { token: t, body: body(energy(D0), many) });
  assert.equal(r.status, 200);
  assert.equal((await dayOf(call, D0)).activity.workouts.length, 20);
  assert.match(r.out.warnings.join(' '), /only the first 20 are kept/);
  const big = store.read('hxa');
  assert.equal(big.health.weights, undefined);
  // The year cap, exercised on the writer directly.
  const health = await import('../nutrition/health.js');
  const id = big.health.token.id;
  for (let i = 0; i < 400; i += 100) {
    const weights = Array.from({ length: 100 }, (_, j) => { const d = new Date(Date.UTC(2025, 0, 1 + i + j)).toISOString().slice(0, 10); return { date: d, kg: 80 }; });
    await health.recordHae('hxa', id, { weights });
  }
  const kept = store.read('hxa').health.weights;
  assert.equal(kept.length, 366);
  assert.equal(kept.at(-1).date, new Date(Date.UTC(2025, 0, 400)).toISOString().slice(0, 10), 'the oldest readings go first');
});

test('validation: one failed field does not break the others', async () => {
  const { call } = setup(); const t = await mk(call);
  const r = await call(HAE, { token: t, body: body([
    ...energy(D0), one('apple_exercise_time', 'min', [[at(D0, '00:00:00'), 9999]]),            // implausible minutes
    one('weight_body_mass', 'kg', [[at(shift(-200), '07:00:00'), 80], [at(D0, '07:00:00'), 79]])   // one reading too old
  ], [workout(D0, 'Run', '07:00:00', 600, 90)]) });
  assert.equal(r.status, 200, JSON.stringify(r.out));
  assert.equal(r.out.days[0].action, 'stored');
  assert.deepEqual(r.out.weights.map(w => w.kg), [79]);
  assert.ok(r.out.skipped.some(s => s.kind === 'weight' && /60 days/.test(s.reason)));
  const v = await dayOf(call, D0);
  assert.equal(v.activity.workouts.length, 1);
  assert.equal(v.activity.exercise_min, null);
  assert.equal(v.health.burned_kcal, 2300);
});

test('an export of only bad extras is refused with the reason, and stores nothing', async () => {
  const { call } = setup(); const t = await mk(call);
  const r = await call(HAE, { token: t, body: body([one('weight_body_mass', 'kg', [[at(shift(-300), '07:00:00'), 80]])]) });
  assert.equal(r.status, 400);
  assert.equal(r.out.code, 'invalid');
});

test('the Shortcut endpoint still works and its day view is unchanged', async () => {
  const { call } = setup(); const t = await mk(call);
  const r = await call('POST /api/nutrition/health', { token: t, body: { date: D0, active_kcal: 400, resting_kcal: 1600, steps: 5000 } });
  assert.equal(r.status, 200);
  const v = await dayOf(call, D0);
  assert.equal(v.health.burned_kcal, 2000);
  assert.equal(v.activity, null);
});

test('debug: shows the shape of workouts and the new metrics too', async () => {
  const { call } = setup(); const t = await mk(call);
  await call('PUT /api/admin/nutrition', { as: 'admin', body: { healthDebug: true } });
  await call(HAE, { token: t, body: body([...energy(D0), one('weight_body_mass', 'kg', [[at(D0, '07:00:00'), 80]])], [workout(D0, 'Run', '07:00:00', 600, 90)]) });
  const cap = (await call('GET /api/admin/nutrition/health-debug', { as: 'admin' })).out.capture;
  assert.equal(cap.shape.other.workouts._length, 1);
  assert.ok(cap.shape.metrics.some(m => m.name === 'weight_body_mass'));
  assert.equal(cap.outcome.weights[0].kg, 80);
  assert.equal(JSON.stringify(cap).includes('ogh_'), false);
  await call('PUT /api/admin/nutrition', { as: 'admin', body: { healthDebug: false } });
  assert.equal((await call('GET /api/admin/nutrition/health-debug', { as: 'admin' })).out.capture, null);
});

test('the sample payload in docs/NUTRITION_HEALTH_AUTO_EXPORT.md is accepted as written (dates moved to yesterday)', async () => {
  const doc = fs.readFileSync(new URL('../../docs/NUTRITION_HEALTH_AUTO_EXPORT.md', import.meta.url), 'utf8');
  const sample = [...doc.matchAll(/```json\n([\s\S]*?)\n```/g)].map(m => m[1]).find(j => j.includes('"workouts"'));
  assert.ok(sample, 'the doc has the sample');
  const { call } = setup(); const t = await mk(call);
  const r = await call(HAE, { token: t, body: JSON.parse(sample.replaceAll('2026-10-13', D0)) });
  assert.equal(r.status, 200, JSON.stringify(r.out));
  assert.deepEqual(r.out.ignored_metrics, ['apple_stand_hour']);
  const v = await dayOf(call, D0);
  assert.equal(v.health.burned_kcal, 2322.4);
  assert.equal(v.activity.workouts.length, 2);
  assert.equal(v.activity.exercise_min, 52);
  assert.equal(v.activity.workouts[0].kcal, 250, '1046 kJ is 250 kcal');
});
