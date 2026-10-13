/* Health Auto Export (the iPhone app) → Apple Health numbers. Fixtures are shaped like the app's
   documented REST API export: { data: { metrics: [ { name, units, data: [ { date, qty, source } ] } ] } }. */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hae-test-'));
process.env.DATA_DIR = DIR;
fs.writeFileSync(path.join(DIR, 'secret'), 'd'.repeat(64), { mode: 0o600 });
const store = await import('../nutrition/store.js');
const health = await import('../nutrition/health.js');
const hae = await import('../nutrition/hae.js');
const haeDebug = await import('../nutrition/hae-debug.js');
const cfg = await import('../nutrition/config.js');
const { nutritionRoutes } = await import('../nutrition/routes.js');

const today = new Date().toISOString().slice(0, 10);
const shift = n => { const d = new Date(today + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const D0 = shift(-1), D1 = shift(-2), D2 = shift(-3);

/* ---- fixture builders ---- */
const at = (day, time, off = '+0100') => `${day} ${time} ${off}`;
const pt = (date, qty, source = '') => ({ date, qty, source });
const metric = (name, units, data) => ({ name, units, data });
const payload = (metrics, workouts = []) => ({ data: { metrics, workouts } });
/** A full day, one point per hour. */
const hourly = (day, perHour, off = '+0100', source = '') => Array.from({ length: 24 }, (_, h) => pt(at(day, String(h).padStart(2, '0') + ':00:00', off), perHour, source));
const daily = (name, units, entries) => metric(name, units, entries.map(([day, qty]) => pt(at(day, '00:00:00'), qty)));
const standard = (day, a, r, s) => payload([daily('active_energy', 'kcal', [[day, a]]), daily('basal_energy_burned', 'kcal', [[day, r]]), daily('step_count', 'count', [[day, s]])]);

/* ------------------------------ dates ------------------------------ */

test('dates: the day is the one written in the payload, at the offset it carries', () => {
  assert.deepEqual(hae.parseDate('2026-10-13 14:05:00 +0100'), { date: '2026-10-13', minutes: 845, offset: '+0100' });
  // 23:30 in Los Angeles is still the 13th for the person there, though it is the 14th in UTC.
  assert.equal(hae.parseDate('2026-10-13 23:30:00 -0700').date, '2026-10-13');
  // 00:10 in Paris is the 13th for the person there, though it is the 12th in UTC.
  assert.equal(hae.parseDate('2026-10-13 00:10:00 +0200').date, '2026-10-13');
  assert.equal(hae.parseDate('2026-10-13 00:10:00 +0200').minutes, 10);
  assert.equal(hae.parseDate('2026-10-13T14:05:00+01:00').date, '2026-10-13');
  assert.equal(hae.parseDate('2026-10-13T14:05:00Z').offset, 'Z');
  assert.equal(hae.parseDate('2026-10-13').minutes, 0, 'a bare date is the start of that day');
  assert.equal(hae.parseDate('2026-10-13 14:05:00.250 +0100').minutes, 845);
});

test('dates: the 12-hour form, with the narrow no-break space iOS puts before AM/PM', () => {
  assert.equal(hae.parseDate('2026-10-13 2:05:00 PM +0100').minutes, 14 * 60 + 5);
  assert.equal(hae.parseDate('2026-10-13 2:05:00 PM +0100').minutes, 14 * 60 + 5);
  assert.equal(hae.parseDate('2026-10-13 12:30:00 AM +0100').minutes, 30);
  assert.equal(hae.parseDate('2026-10-13 12:30:00 pm +0100').minutes, 12 * 60 + 30);
  assert.equal(hae.parseDate('2026-10-13 11:59:59 PM -0500').minutes, 23 * 60 + 59);
});

test('dates: nonsense is not a date', () => {
  for (const bad of ['', 'yesterday', '2026-13-40 00:00:00 +0000', '2026-02-30 00:00:00 +0000', '2026-10-13 25:00:00 +0000', '2026-10-13 13:00:00 PM +0000', 1760000000, null, undefined, {}, '13/10/2026']) {
    assert.equal(hae.parseDate(bad), null, String(bad));
  }
});

/* ------------------------------ units ------------------------------ */

test('units: kJ becomes kcal, kcal stays, the large Cal is a kcal, the small cal is a thousandth', () => {
  assert.equal(hae.energyFactor('kcal'), 1);
  assert.equal(hae.energyFactor('Cal'), 1);
  assert.equal(hae.energyFactor('kJ'), 1 / 4.184);
  assert.equal(hae.energyFactor('KJ'), 1 / 4.184);
  assert.equal(hae.energyFactor('cal'), 0.001);
  for (const bad of ['J', 'BTU', 'count', '', null, undefined, 'kcal/day']) assert.equal(hae.energyFactor(bad), null, String(bad));
  for (const ok of ['count', 'steps', '', undefined, null]) assert.equal(hae.stepsUnitOk(ok), true);
  assert.equal(hae.stepsUnitOk('km'), false);
});

/* ------------------------------ the payload ------------------------------ */

test('one total per day (the app already summarised): used as it is', () => {
  const r = hae.parseHae(payload([
    daily('active_energy', 'kcal', [[D1, 480.5], [D0, 512.4]]),
    daily('basal_energy_burned', 'kcal', [[D1, 1600], [D0, 1650]]),
    daily('step_count', 'count', [[D1, 7000], [D0, 8432]])
  ]));
  assert.equal(r.ok, true);
  assert.deepEqual(r.days.map(d => [d.date, d.active_kcal, d.resting_kcal, d.steps, d.covers]), [[D1, 480.5, 1600, 7000, true], [D0, 512.4, 1650, 8432, true]]);
  assert.deepEqual(r.ignoredMetrics, []);
});

test('many points per day (hourly, or minute by minute) are summed into the day', () => {
  const r = hae.parseHae(payload([
    metric('active_energy', 'kcal', hourly(D0, 25)),
    metric('basal_energy_burned', 'kcal', hourly(D0, 70)),
    metric('step_count', 'count', hourly(D0, 350))
  ]));
  assert.deepEqual(r.days.map(d => [d.active_kcal, d.resting_kcal, d.steps]), [[600, 1680, 8400]]);
  const minutes = Array.from({ length: 1440 }, (_, i) => pt(at(D0, `${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00`), 0.5));
  const m = hae.parseHae(payload([metric('active_energy', 'kcal', minutes), metric('basal_energy_burned', 'kcal', minutes)]));
  assert.equal(m.days[0].active_kcal, 720);
  assert.equal(m.days[0].steps, null, 'steps are optional: no step metric, no steps');
});

test('kJ is converted to kcal, per metric or per point', () => {
  const r = hae.parseHae(payload([
    daily('active_energy', 'kJ', [[D0, 2092]]),                                  // 500 kcal
    metric('basal_energy_burned', 'kcal', [{ ...pt(at(D0, '00:00:00'), 6276), units: 'kJ' }]),   // the point's own unit wins: 1500 kcal
    daily('step_count', 'count', [[D0, 5000]])
  ]));
  assert.deepEqual([r.days[0].active_kcal, r.days[0].resting_kcal], [500, 1500]);
  const mixed = hae.parseHae(payload([metric('active_energy', 'kJ', [pt(at(D0, '00:00:00'), 1046), pt(at(D0, '12:00:00'), 1046)]), daily('basal_energy_burned', 'kcal', [[D0, 1500]])]));
  assert.equal(mixed.days[0].active_kcal, 500);
});

test('units that cannot be converted are refused by name, not guessed', () => {
  const e = hae.parseHae(payload([daily('active_energy', 'J', [[D0, 5]]), daily('basal_energy_burned', 'kcal', [[D0, 1500]])]));
  assert.deepEqual([e.ok, e.code], [false, 'units']);
  assert.match(e.error, /active_energy has units "J".*kcal or kJ/);
  const s = hae.parseHae(payload([daily('active_energy', 'kcal', [[D0, 5]]), daily('basal_energy_burned', 'kcal', [[D0, 1500]]), daily('step_count', 'km', [[D0, 5]])]));
  assert.equal(s.code, 'units');
  assert.match(s.error, /step_count has units "km"/);
});

test('time zones: each point is placed on its own local day, offsets mixed or not', () => {
  const r = hae.parseHae(payload([
    metric('active_energy', 'kcal', [
      pt(`${D0} 23:30:00 -0700`, 100),        // 23:30 on D0 where the phone was (06:30 the next day in UTC)
      pt(`${D0} 00:10:00 +0200`, 50),         // 00:10 on D0 where the phone was (22:10 the day before in UTC)
      pt(`${D0}T12:00:00+01:00`, 25),         // ISO
      pt(`${D1} 23:59:59 +0000`, 7)
    ]),
    metric('basal_energy_burned', 'kcal', [pt(`${D0} 00:05:00 +0200`, 1500), pt(`${D1} 00:00:00 +0200`, 1400)])
  ]));
  const by = Object.fromEntries(r.days.map(d => [d.date, d]));
  assert.equal(by[D0].active_kcal, 175, 'all three D0 points are D0, whatever their offset');
  assert.equal(by[D1].active_kcal, 7);
  assert.equal(by[D0].resting_kcal, 1500);
  assert.equal(Object.keys(by).length, 2);
});

test('whether the data starts at the beginning of the day is worked out from the first point', () => {
  const full = hae.parseHae(payload([metric('active_energy', 'kcal', hourly(D0, 10)), metric('basal_energy_burned', 'kcal', hourly(D0, 60))]));
  assert.equal(full.days[0].covers, true);
  const sinceLastSync = hae.parseHae(payload([metric('active_energy', 'kcal', [pt(at(D0, '14:00:00'), 30)]), metric('basal_energy_burned', 'kcal', [pt(at(D0, '14:00:00'), 70)])]));
  assert.equal(sinceLastSync.days[0].covers, false);
});

test('repeated points in one payload count once; the warning says so', () => {
  const p = pt(at(D0, '10:00:00'), 100, 'Apple Watch');
  const r = hae.parseHae(payload([metric('active_energy', 'kcal', [p, p, { ...p }, pt(at(D0, '11:00:00'), 100, 'Apple Watch')]), daily('basal_energy_burned', 'kcal', [[D0, 1500]])]));
  assert.equal(r.days[0].active_kcal, 200);
  assert.equal(r.stats.duplicates, 2);
  assert.ok(r.warnings.some(w => /2 repeated data point/.test(w)));
});

test('several sources contributing separate points to one day are flagged (they may double count)', () => {
  const r = hae.parseHae(payload([
    metric('active_energy', 'kcal', [pt(at(D0, '10:00:00'), 100, 'Apple Watch'), pt(at(D0, '10:00:00'), 100, 'iPhone')]),
    metric('basal_energy_burned', 'kcal', [pt(at(D0, '00:00:00'), 1500)])
  ]));
  assert.equal(r.days[0].active_kcal, 200);
  assert.ok(r.warnings.some(w => /2 sources.*Summarize Data/.test(w)), r.warnings.join('|'));
  const merged = hae.parseHae(payload([metric('active_energy', 'kcal', hourly(D0, 10, '+0100', '')), daily('basal_energy_burned', 'kcal', [[D0, 1500]])]));
  assert.deepEqual(merged.warnings, [], 'the app’s merged data (empty source) raises nothing');
});

test('extra metrics are ignored, and named', () => {
  const r = hae.parseHae(payload([
    metric('heart_rate', 'count/min', [{ date: at(D0, '10:00:00'), Min: 50, Avg: 70, Max: 120, source: 'Apple Watch' }]),
    daily('active_energy', 'kcal', [[D0, 500]]),
    metric('sleep_analysis', 'hr', [{ date: at(D0, '00:00:00'), qty: 7 }]),
    daily('basal_energy_burned', 'kcal', [[D0, 1500]]),
    metric('walking_running_distance', 'km', [{ date: at(D0, '00:00:00'), qty: 5.2 }]),
    null, 5, { nope: true }
  ], [{ id: 'x', name: 'Running' }]));
  assert.equal(r.ok, true);
  assert.deepEqual(r.ignoredMetrics.sort(), ['heart_rate', 'sleep_analysis', 'walking_running_distance']);
  assert.equal(r.days[0].active_kcal, 500);
});

test('metric names: the documented snake_case ones, and the display-name spellings', () => {
  for (const [a, b, s] of [['active_energy', 'basal_energy_burned', 'step_count'], ['Active Energy', 'Basal Energy Burned', 'Step Count'], ['active_energy_burned', 'resting_energy', 'steps']]) {
    const r = hae.parseHae(payload([daily(a, 'kcal', [[D0, 400]]), daily(b, 'kcal', [[D0, 1500]]), daily(s, 'count', [[D0, 900]])]));
    assert.deepEqual([r.ok, r.days[0].active_kcal, r.days[0].resting_kcal, r.days[0].steps], [true, 400, 1500, 900], `${a} / ${b} / ${s}`);
  }
});

test('a metric present but empty for a day counts as zero for that day; bad points are skipped and counted', () => {
  const r = hae.parseHae(payload([
    daily('active_energy', 'kcal', [[D0, 500]]),
    metric('basal_energy_burned', 'kcal', [pt(at(D0, '00:00:00'), 1500), pt(at(D1, '00:00:00'), 1400), { date: 'garbage', qty: 5 }, { date: at(D0, '01:00:00'), qty: 'x' }, { date: at(D0, '02:00:00'), qty: -3 }, { date: at(D0, '03:00:00') }, null])
  ]));
  assert.deepEqual(r.days.map(d => [d.date, d.active_kcal, d.resting_kcal]), [[D1, 0, 1400], [D0, 500, 1500]]);
  assert.equal(r.stats.badPoints, 5);
  assert.ok(r.warnings.some(w => /5 data point\(s\) could not be read/.test(w)));
});

test('wrong shapes get a clear error that names the problem', () => {
  const cases = [
    ['a string', 'x', 'shape', /not a JSON object.*Export Format is JSON/],
    ['an array', [1], 'shape', /not a JSON object/],
    ['null', null, 'shape', /not a JSON object/],
    ['data as a list', { data: [] }, 'shape', /"data" is not an object/],
    ['no metrics', { data: { foo: 1 } }, 'shape', /No "metrics" list found.*keys under the payload: foo/],
    ['metrics as text', { data: { metrics: 'x' } }, 'shape', /No "metrics" list/],
    ['a workouts export', { data: { workouts: [{ name: 'Run' }] } }, 'wrong-type', /Workouts export.*Health Metrics/],
    ['a CSV-ish body', { csv: 'a,b' }, 'shape', /top-level keys|keys under the payload: csv/]
  ];
  for (const [label, body, code, words] of cases) {
    const r = hae.parseHae(body);
    assert.equal(r.ok, false, label);
    assert.equal(r.code, code, label);
    assert.match(r.error, words, label);
  }
  const noEnergy = hae.parseHae(payload([daily('step_count', 'count', [[D0, 100]]), daily('heart_rate', 'count/min', [[D0, 60]])]));
  assert.equal(noEnergy.code, 'metrics');
  assert.match(noEnergy.error, /no active_energy \(Active Energy\) and no basal_energy_burned \(Resting Energy\).*Metrics received: step_count, heart_rate/);
  const noResting = hae.parseHae(payload([daily('active_energy', 'kcal', [[D0, 100]])]));
  assert.match(noResting.error, /no basal_energy_burned \(Resting Energy\)/);
  assert.ok(!/active_energy \(Active/.test(noResting.error));
  const none = hae.parseHae(payload([metric('active_energy', 'kcal', []), metric('basal_energy_burned', 'kcal', [])]));
  assert.equal(none.code, 'dates');
  const bad = hae.parseHae(payload([metric('active_energy', 'kcal', [{ date: 'x', qty: 1 }]), metric('basal_energy_burned', 'kcal', [{ qty: 2 }])]));
  assert.equal(bad.code, 'dates');
  assert.match(bad.error, /2 unreadable/);
});

test('names in error messages are cleaned, and an enormous export is refused', () => {
  const e = hae.parseHae(payload([daily('<script>alert(1)</script>' + 'x'.repeat(100), 'kcal', [[D0, 1]])]));
  assert.ok(!e.error.includes('<script>'));
  const many = Array.from({ length: 501 }, (_, i) => metric('m' + i, 'x', []));
  assert.equal(hae.parseHae(payload(many)).code, 'too-large');
  const pts = Array.from({ length: 200001 }, (_, i) => pt(at(D0, '00:00:00'), i));
  assert.equal(hae.parseHae(payload([metric('active_energy', 'kcal', pts), metric('basal_energy_burned', 'kcal', [])])).code, 'too-large');
});

/* ------------------------------ through the route ------------------------------ */

const USERS = { a: { id: 'hua' }, b: { id: 'hub' }, admin: { id: 'hadm', admin: true } };
let active = () => true;
function setup() {
  for (const u of Object.values(USERS)) store.removeUser(u.id);
  fs.rmSync(path.join(DIR, 'nutrition', 'health-tokens.json'), { force: true });
  haeDebug.clear();
  cfg.save({ healthDebug: false });
  const R = nutritionRoutes({
    json: (res, code, obj, h) => { res.status = code; res.out = obj; res.h = h; },
    readBody: async q => { if (q.rawBody instanceof Error) throw q.rawBody; return q.body; },
    readSession: q => q.user || null, requireAdmin: (q, r) => (q.user?.admin ? q.user : (r.status = 403, null)), lookup: {}, analyzer: {},
    limitAddress: q => q.addr || '10.0.0.1', userActive: uid => active(uid)
  });
  const call = async (key, { as, token, body, addr, url } = {}) => {
    const res = {};
    await R[key]({ method: key.split(' ')[0], url: url || key.split(' ')[1], user: as ? USERS[as] : null, body, addr, headers: token ? { authorization: 'Bearer ' + token } : {} }, res);
    return res;
  };
  return { call };
}
const HAE = 'POST /api/nutrition/health/hae';
const SHORTCUT = 'POST /api/nutrition/health';
const mk = async (call, as) => (await call('POST /api/nutrition/health/token', { as })).out.token;

test('a payload from the app is stored under the profile and shows in the diary', async () => {
  const { call } = setup();
  const t = await mk(call, 'a');
  const r = await call(HAE, { token: t, body: standard(D0, 512.4, 1650, 8432) });
  assert.equal(r.status, 200, JSON.stringify(r.out));
  assert.deepEqual(r.out.days.map(d => [d.date, d.active_kcal, d.resting_kcal, d.steps, d.burned_kcal, d.action]), [[D0, 512.4, 1650, 8432, 2162.4, 'stored']]);
  const day = (await call('GET /api/nutrition/day', { as: 'a', url: `/api/nutrition/day?date=${D0}` })).out.health;
  assert.deepEqual([day.active_kcal, day.resting_kcal, day.steps], [512.4, 1650, 8432]);
  assert.equal((await call('GET /api/nutrition/health/token', { as: 'a' })).out.lastUsedAt > 0, true);
});

test('auth: the same token, the same checks — valid, wrong, missing, revoked, someone else’s', async () => {
  const { call } = setup();
  const ta = await mk(call, 'a'), tb = await mk(call, 'b');
  const body = standard(D0, 500, 1600, 100);
  assert.equal((await call(HAE, { token: ta, body })).status, 200);
  assert.equal((await call(HAE, { token: ta.slice(0, -1) + (ta.endsWith('0') ? '1' : '0'), body, addr: '7.7.7.1' })).status, 401);
  assert.equal((await call(HAE, { body, addr: '7.7.7.2' })).status, 401, 'no header');
  assert.equal((await call(HAE, { as: 'a', body, addr: '7.7.7.3' })).status, 401, 'a session is not a token');
  assert.equal((await call(HAE, { token: 'ogh_nope', body, addr: '7.7.7.4' })).status, 401);
  // isolation: each token writes only its own profile
  await call(HAE, { token: tb, body: standard(D0, 111, 999, 5) });
  assert.equal(store.read('hua').health.days[D0].active, 500);
  assert.equal(store.read('hub').health.days[D0].active, 111);
  // revoke / rotate
  await call('DELETE /api/nutrition/health/token', { as: 'a' });
  assert.equal((await call(HAE, { token: ta, body, addr: '7.7.7.5' })).status, 401);
  const tb2 = (await call('POST /api/nutrition/health/token', { as: 'b' })).out.token;
  assert.equal((await call(HAE, { token: tb, body, addr: '7.7.7.6' })).status, 401, 'replaced');
  assert.equal((await call(HAE, { token: tb2, body })).status, 200);
});

test('rate limits are shared with the Shortcut route: 60 an hour per token, wrong tokens lock the address', async () => {
  const { call } = setup();
  const t = await mk(call, 'a');
  const body = standard(D0, 500, 1600, 100);
  const codes = [];
  for (let i = 0; i < 31; i++) codes.push((await call(HAE, { token: t, body })).status);
  for (let i = 0; i < 31; i++) codes.push((await call(SHORTCUT, { token: t, body: { date: D0, active_kcal: 500, resting_kcal: 1600 } })).status);
  assert.equal(codes.filter(c => c === 200).length, 60);
  assert.equal(codes.filter(c => c === 429).length, 2);
  const codes2 = [];
  for (let i = 0; i < 12; i++) codes2.push((await call(HAE, { token: 'ogh_' + 'a'.repeat(16) + '_' + 'b'.repeat(64), body, addr: '203.0.113.50' })).status);
  assert.equal(codes2.at(-1), 429);
});

test('the same export sent twice replaces, never doubles; a re-send with new numbers replaces them', async () => {
  const { call } = setup();
  const t = await mk(call, 'a');
  const hourlyPayload = n => payload([metric('active_energy', 'kcal', hourly(D0, n)), metric('basal_energy_burned', 'kcal', hourly(D0, 70)), metric('step_count', 'count', hourly(D0, 300))]);
  const first = await call(HAE, { token: t, body: hourlyPayload(20) });
  assert.deepEqual([first.out.days[0].active_kcal, first.out.days[0].action], [480, 'stored']);
  const again = await call(HAE, { token: t, body: hourlyPayload(20) });
  assert.deepEqual([again.out.days[0].active_kcal, again.out.days[0].resting_kcal, again.out.days[0].steps, again.out.days[0].action], [480, 1680, 7200, 'replaced']);
  const newer = await call(HAE, { token: t, body: hourlyPayload(25) });
  assert.equal(newer.out.days[0].active_kcal, 600);
  const stored = store.read('hua').health.days[D0];
  assert.deepEqual([stored.active, stored.resting, stored.steps], [600, 1680, 7200]);
  assert.deepEqual(stored.history.map(h => h.active), [480], 'one history row: identical re-sends add none');
});

test('several days in one export are each stored; yesterday’s final numbers and today’s so far', async () => {
  const { call } = setup();
  const t = await mk(call, 'a');
  const r = await call(HAE, { token: t, body: payload([
    daily('active_energy', 'kcal', [[D1, 700], [D0, 300]]), daily('basal_energy_burned', 'kcal', [[D1, 1700], [D0, 900]]), daily('step_count', 'count', [[D1, 9000], [D0, 4000]])
  ]) });
  assert.deepEqual(r.out.days.map(d => [d.date, d.active_kcal]), [[D1, 700], [D0, 300]]);
  assert.deepEqual(Object.keys(store.read('hua').health.days).sort(), [D1, D0].sort());
});

test('a partial export (starts partway through the day) never lowers what is stored, and is reported', async () => {
  const { call } = setup();
  const t = await mk(call, 'a');
  await call(HAE, { token: t, body: standard(D0, 600, 1700, 8000) });
  const partial = payload([metric('active_energy', 'kcal', [pt(at(D0, '15:00:00'), 40)]), metric('basal_energy_burned', 'kcal', [pt(at(D0, '15:00:00'), 70)]), metric('step_count', 'count', [pt(at(D0, '15:00:00'), 500)])]);
  const r = await call(HAE, { token: t, body: partial });
  assert.equal(r.status, 200);
  assert.equal(r.out.days[0].action, 'kept');
  assert.equal(r.out.days[0].active_kcal, 600);
  assert.ok(r.out.warnings.some(w => /starts partway through the day.*Date Range to Today/.test(w)));
  assert.equal(store.read('hua').health.days[D0].active, 600);
  // …but a partial export for a day with nothing stored is better than nothing…
  const other = await call(HAE, { token: t, body: payload([metric('active_energy', 'kcal', [pt(at(D1, '15:00:00'), 40)]), metric('basal_energy_burned', 'kcal', [pt(at(D1, '15:00:00'), 70)])]) });
  assert.equal(other.out.days[0].action, 'stored');
  // …and a later full-day export replaces it with the real totals.
  const full = await call(HAE, { token: t, body: standard(D1, 650, 1700, 9000) });
  assert.deepEqual([full.out.days[0].active_kcal, full.out.days[0].action], [650, 'replaced']);
});

test('the Shortcut endpoint still works, and the two routes write the same record', async () => {
  const { call } = setup();
  const t = await mk(call, 'a');
  const s = await call(SHORTCUT, { token: t, body: { date: D0, active_kcal: 400, resting_kcal: 1500, steps: 3000 } });
  assert.deepEqual([s.status, s.out.ok, s.out.burned_kcal, s.out.replaced], [200, true, 1900, false]);
  const h = await call(HAE, { token: t, body: standard(D0, 450, 1550, 3500) });
  assert.equal(h.out.days[0].action, 'replaced', 'the app replaces what the Shortcut stored');
  const back = await call(SHORTCUT, { token: t, body: { date: D0, active_kcal: 460, resting_kcal: 1560 } });
  assert.deepEqual([back.out.replaced, back.out.steps], [true, null]);
  assert.equal(store.read('hua').health.days[D0].active, 460);
  assert.equal((await call(SHORTCUT, { token: t, body: { date: D0, active_kcal: '460', resting_kcal: 1 } })).status, 400, 'the Shortcut route is as strict as before');
});

test('the same bounds and refusals as the Shortcut: absurd values, both-zero, bad days; the good days still go in', async () => {
  const { call } = setup();
  const t = await mk(call, 'a');
  const ok = await call(HAE, { token: t, body: payload([
    daily('active_energy', 'kcal', [[D0, 500], [D1, 0], [D2, 99999]]),
    daily('basal_energy_burned', 'kcal', [[D0, 1500], [D1, 0], [D2, 1500]]),
    daily('step_count', 'count', [[D0, 100], [D1, 0], [D2, 100]])
  ]) });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.out.days.map(d => d.date), [D0]);
  const skipped = Object.fromEntries(ok.out.skipped.map(s => [s.date, s]));
  assert.match(skipped[D1].reason, /both 0.*locked/, 'both zero is refused');
  assert.match(skipped[D2].reason, /not plausible/);
  assert.equal(store.read('hua').health.days[D1], undefined);

  const all = await call(HAE, { token: t, body: payload([daily('active_energy', 'kcal', [[D1, 0]]), daily('basal_energy_burned', 'kcal', [[D1, 0]])]) });
  assert.equal(all.status, 400);
  assert.equal(all.out.code, 'invalid');
  assert.match(all.out.error, /Nothing was stored.*both 0/);

  const old = await call(HAE, { token: t, body: standard(shift(-200), 500, 1500, 1) });
  assert.equal(old.status, 400);
  assert.match(old.out.error, /days ago/);
  const future = await call(HAE, { token: t, body: standard(shift(5), 500, 1500, 1) });
  assert.match(future.out.error, /future/);
  const kj = await call(HAE, { token: t, body: payload([daily('active_energy', 'kJ', [[D0, 80000]]), daily('basal_energy_burned', 'kJ', [[D0, 6000]])]) });
  assert.equal(kj.status, 400, '80,000 kJ is 19,000 kcal: not plausible');
});

test('a payload that is not the app’s shape is a 400 naming the problem, and stores nothing', async () => {
  const { call } = setup();
  const t = await mk(call, 'a');
  for (const [body, words] of [[{ foo: 1 }, /No "metrics" list/], ['text', /not a JSON object/], [{ data: { workouts: [{ a: 1 }] } }, /Workouts export/], [payload([daily('step_count', 'count', [[D0, 1]])]), /no active_energy/], [payload([daily('active_energy', 'J', [[D0, 1]]), daily('basal_energy_burned', 'kcal', [[D0, 1]])]), /units "J"/]]) {
    const r = await call(HAE, { token: t, body });
    assert.equal(r.status, 400);
    assert.match(r.out.error, words);
    assert.ok(r.out.code);
  }
  assert.equal(store.read('hua').health.days[D0], undefined);
  assert.equal(store.read('hua').health.token.lastUsedAt, null, 'a rejected payload does not count as a use');
});

test('extra metrics ride along and are ignored; the answer lists them', async () => {
  const { call } = setup();
  const t = await mk(call, 'a');
  const body = payload([daily('heart_rate', 'count/min', [[D0, 62]]), daily('active_energy', 'kcal', [[D0, 500]]), daily('basal_energy_burned', 'kcal', [[D0, 1500]]), daily('sleep_analysis', 'hr', [[D0, 7]])]);
  const r = await call(HAE, { token: t, body });
  assert.equal(r.status, 200);
  assert.deepEqual(r.out.ignored_metrics.sort(), ['heart_rate', 'sleep_analysis']);
  assert.equal(Object.keys(store.read('hua').health.days).length, 1);
});

test('a gone or disabled profile’s token is dead for this route too; Nutrition off switches it off', async () => {
  const { call } = setup();
  const t = await mk(call, 'a');
  const body = standard(D0, 500, 1500, 1);
  cfg.save({ enabled: false });
  try { assert.equal((await call(HAE, { token: t, body })).status, 503); } finally { cfg.save({ enabled: true }); }
  active = uid => uid !== 'hua';
  try { assert.equal((await call(HAE, { token: t, body })).status, 401); } finally { active = () => true; }
  assert.equal((await call(HAE, { token: t, body })).status, 401, 'and stays dead');
});

test('nothing sensitive is logged', async () => {
  const { call } = setup();
  const spies = ['log', 'error', 'warn', 'info'].map(m => mock.method(console, m, () => {}));
  try {
    const t = await mk(call, 'a');
    await call(HAE, { token: t, body: standard(D0, 777, 1777, 9) });
    await call(HAE, { token: t, body: { junk: true } });
    await call(HAE, { token: t.slice(0, -2) + 'zz', body: standard(D0, 1, 1, 1), addr: '4.4.4.4' });
    assert.equal(spies.reduce((n, s) => n + s.mock.calls.length, 0), 0);
  } finally { spies.forEach(s => s.mock.restore()); }
});

/* ------------------------------ the admin debug capture ------------------------------ */

test('debug: off by default — nothing is kept, and the admin view says so', async () => {
  const { call } = setup();
  const t = await mk(call, 'a');
  await call(HAE, { token: t, body: standard(D0, 500, 1500, 1) });
  const view = await call('GET /api/admin/nutrition/health-debug', { as: 'admin' });
  assert.deepEqual([view.out.enabled, view.out.capture], [false, null]);
  assert.equal(haeDebug.read(), null);
});

test('debug: admin only', async () => {
  const { call } = setup();
  assert.equal((await call('GET /api/admin/nutrition/health-debug', { as: 'a' })).status, 403);
  assert.equal((await call('DELETE /api/admin/nutrition/health-debug', { as: 'a' })).status, 403);
  assert.equal((await call('GET /api/admin/nutrition/health-debug')).status, 403);
  assert.equal((await call('PUT /api/admin/nutrition', { as: 'a', body: { healthDebug: true } })).status, 403);
});

test('debug: switched on, it keeps the SHAPE of the last payload — keys and one example per metric — and what the parser made of it', async () => {
  const { call } = setup();
  const t = await mk(call, 'a');
  assert.equal((await call('PUT /api/admin/nutrition', { as: 'admin', body: { healthDebug: true } })).out.healthDebug, true);
  const body = payload([
    metric('active_energy', 'kJ', [pt(at(D0, '09:00:00'), 100, "Duarte's Apple Watch"), pt(at(D0, '10:00:00'), 120, "Duarte's Apple Watch")]),
    metric('basal_energy_burned', 'kJ', [pt(at(D0, '00:00:00'), 6000)]),
    metric('heart_rate', 'count/min', [{ date: at(D0, '09:00:00'), Min: 50, Avg: 70, Max: 90, source: 'W' }])
  ]);
  await call(HAE, { token: t, body });
  const view = (await call('GET /api/admin/nutrition/health-debug', { as: 'admin' })).out;
  assert.equal(view.enabled, true);
  const cap = view.capture;
  assert.deepEqual(cap.shape.topLevelKeys, ['data']);
  assert.deepEqual(cap.shape.dataKeys, ['metrics', 'workouts']);
  assert.equal(cap.shape.metricCount, 3);
  const active = cap.shape.metrics.find(m => m.name === 'active_energy');
  assert.deepEqual([active.units, active.points, active.pointKeys.sort()], ['kJ', 2, ['date', 'qty', 'source']]);
  assert.equal(active.example.date, `${D0} 09:00:00 +0100`, 'the real date format is visible, which is the point');
  assert.deepEqual(cap.shape.metrics.find(m => m.name === 'heart_rate').pointKeys.sort(), ['Avg', 'Max', 'Min', 'date', 'source']);
  assert.equal(cap.outcome.ok, true);
  assert.deepEqual(cap.outcome.ignoredMetrics, ['heart_rate']);
  assert.equal(cap.outcome.days[0].active_kcal, 52.6, '220 kJ');
  assert.equal(cap.expiresAt - cap.at, 3600000);
  assert.equal(view.ttlMinutes, 60);
  // only the LAST one is kept
  await call(HAE, { token: t, body: standard(D1, 1, 1500, 1) });
  assert.equal((await call('GET /api/admin/nutrition/health-debug', { as: 'admin' })).out.capture.shape.metrics.length, 3);
  assert.equal((await call('GET /api/admin/nutrition/health-debug', { as: 'admin' })).out.capture.outcome.days[0].date, D1);
});

test('debug: a payload that failed is captured too, with the reason — that is when it is needed', async () => {
  const { call } = setup();
  const t = await mk(call, 'a');
  await call('PUT /api/admin/nutrition', { as: 'admin', body: { healthDebug: true } });
  await call(HAE, { token: t, body: { data: { something: { else: [1, 2, 3] } } } });
  const cap = (await call('GET /api/admin/nutrition/health-debug', { as: 'admin' })).out.capture;
  assert.equal(cap.outcome.ok, false);
  assert.equal(cap.outcome.code, 'shape');
  assert.deepEqual(cap.shape.dataKeys, ['something']);
  assert.deepEqual(cap.shape.other.something.else, { _length: 3, _example: 1 });
});

test('debug: no token ever gets in — not from headers, not from keys, not from values', async () => {
  const { call } = setup();
  const t = await mk(call, 'a');
  await call('PUT /api/admin/nutrition', { as: 'admin', body: { healthDebug: true } });
  const body = {
    ...standard(D0, 500, 1500, 1), authorization: 'Bearer ' + t, apiKey: 'sk-live-1', token: t,
    data: { ...standard(D0, 500, 1500, 1).data, note: 'sent with Bearer ' + t, meta: { Authorization: 'Bearer ' + t, session: 'abc', ok: 'ogh_' + 'a'.repeat(16) + '_' + 'b'.repeat(64) } }
  };
  await call(HAE, { token: t, body });
  const json = JSON.stringify((await call('GET /api/admin/nutrition/health-debug', { as: 'admin' })).out);
  const secret = t.split('_')[2];
  assert.ok(!json.includes(secret) && !json.includes(t) && !json.includes('sk-live-1') && !/Bearer\s+ogh/i.test(json), json.slice(0, 400));
  assert.ok(json.includes('[redacted]'));
});

test('debug: kept in memory only, for an hour, and wiped when switched off', async () => {
  const { call } = setup();
  const t = await mk(call, 'a');
  await call('PUT /api/admin/nutrition', { as: 'admin', body: { healthDebug: true } });
  await call(HAE, { token: t, body: standard(D0, 54321, 1500, 1) });
  // never on disk
  const hits = [];
  (function walk(d) { for (const n of fs.readdirSync(d)) { const f = path.join(d, n); if (fs.statSync(f).isDirectory()) walk(f); else if (fs.readFileSync(f, 'utf8').includes('54321') && !f.endsWith(`${USERS.a.id}.json`)) hits.push(f); } })(DIR);
  assert.deepEqual(hits, [], 'the capture is not written anywhere');
  // expiry (the module takes the clock)
  const cap = haeDebug.read();
  assert.ok(cap);
  assert.ok(haeDebug.read(cap.at + 59 * 60000));
  assert.equal(haeDebug.read(cap.at + 61 * 60000), null, 'gone after an hour');
  // switching off wipes
  await call(HAE, { token: t, body: standard(D0, 1, 1500, 1) });
  assert.ok(haeDebug.read());
  await call('PUT /api/admin/nutrition', { as: 'admin', body: { healthDebug: false } });
  const view = (await call('GET /api/admin/nutrition/health-debug', { as: 'admin' })).out;
  assert.deepEqual([view.enabled, view.capture], [false, null]);
  await call('PUT /api/admin/nutrition', { as: 'admin', body: { healthDebug: true } });
  await call(HAE, { token: t, body: standard(D0, 1, 1500, 1) });
  await call('DELETE /api/admin/nutrition/health-debug', { as: 'admin' });
  assert.equal(haeDebug.read(), null, 'and the admin can clear it by hand');
  assert.equal((await call('PUT /api/admin/nutrition', { as: 'admin', body: { healthDebug: 'yes' } })).status, 400);
});

test('debug: the shape is bounded however large the payload', () => {
  const many = Array.from({ length: 300 }, (_, i) => metric('metric_' + i, 'u', Array.from({ length: 5 }, (_, j) => ({ date: at(D0, '00:00:00'), qty: j, source: 'x'.repeat(500) }))));
  haeDebug.capture(payload(many), { ok: true });
  const cap = haeDebug.read();
  assert.ok(JSON.stringify(cap).length < 40000);
  assert.ok(cap.shape.metrics.length <= 60);
  assert.ok(cap.shape.metrics[0].example.source.length <= 40);
  haeDebug.clear();
});
