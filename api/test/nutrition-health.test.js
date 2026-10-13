/* Apple Health numbers from an iOS Shortcut: the token, the one route that accepts it, the
   validation, replace-on-repost, isolation between profiles, and the net calculation inputs. */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'health-test-'));
process.env.DATA_DIR = DIR;
fs.writeFileSync(path.join(DIR, 'secret'), 'c'.repeat(64), { mode: 0o600 });
const store = await import('../nutrition/store.js');
const health = await import('../nutrition/health.js');
const cfg = await import('../nutrition/config.js');
const { nutritionRoutes } = await import('../nutrition/routes.js');

const USERS = { a: { id: 'ua' }, b: { id: 'ub' } };
let active = () => true;
function setup() {
  // every test starts from nothing
  for (const u of Object.values(USERS)) store.removeUser(u.id);
  fs.rmSync(path.join(DIR, 'nutrition', 'health-tokens.json'), { force: true });
  const R = nutritionRoutes({
    json: (res, code, obj, h) => { res.status = code; res.out = obj; res.h = h; },
    readBody: async q => { if (q.rawBody instanceof Error) throw q.rawBody; return q.body; },
    readSession: q => q.user || null, requireAdmin() {}, lookup: {}, analyzer: {},
    limitAddress: q => q.addr || '10.0.0.1', userActive: uid => active(uid)
  });
  const call = async (key, { as, token, body, url, addr, raw, headers } = {}) => {
    const res = {};
    const req = { method: key.split(' ')[0], url: url || key.split(' ')[1], user: as ? USERS[as] : null, body, addr, headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), ...(raw ? { authorization: raw } : {}), ...(headers || {}) } };
    await R[key](req, res);
    return res;
  };
  return { R, call };
}
const INGEST = 'POST /api/nutrition/health';
const GOOD = { date: '2026-10-12', active_kcal: 512.4, resting_kcal: 1650, steps: 8432 };
const mk = async (call, as) => (await call('POST /api/nutrition/health/token', { as })).out.token;
const today = new Date().toISOString().slice(0, 10);
const shift = n => { const d = new Date(today + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
// Days the ingest accepts (from 60 days back to tomorrow), relative to when the suite runs.
const D20 = shift(-3), D21 = shift(-2), D22 = shift(-4), D23 = shift(-5), D01 = shift(-6), D02 = shift(-7), D03 = shift(-8);

/* ------------------------------ validation ------------------------------ */

test('validateIngest accepts what a Shortcut sends', () => {
  const r = health.validateIngest({ date: today, active_kcal: 512.44, resting_kcal: 1650, steps: 8432 });
  assert.deepEqual(r, { ok: true, value: { date: today, active_kcal: 512.4, resting_kcal: 1650, steps: 8432 } });
  assert.equal(health.validateIngest({ date: today, active_kcal: 0, resting_kcal: 1400 }).value.steps, null, 'steps are optional; zero active energy is a real day');
  assert.equal(health.validateIngest({ date: today, active_kcal: 1, resting_kcal: 1, steps: null }).ok, true);
  assert.equal(health.validateIngest({ date: shift(1), active_kcal: 1, resting_kcal: 1 }).ok, true, 'a phone can be a day ahead of the server');
  assert.equal(health.validateIngest({ date: shift(-60), active_kcal: 1, resting_kcal: 1 }).ok, true);
  assert.equal(health.validateIngest({ ...GOOD, date: today, extra: 'ignored', foods: {} }).ok, true);
});

test('validateIngest refuses text, NaN, infinity, negatives, absurd values, missing fields and bad dates — and says which', () => {
  const v = (patch, drop = []) => { const b = { date: today, active_kcal: 500, resting_kcal: 1600, steps: 5000, ...patch }; for (const k of drop) delete b[k]; return health.validateIngest(b); };
  const cases = [
    [{ active_kcal: '512' }, [], 'active_kcal', /not text/],
    [{ resting_kcal: '1650 kcal' }, [], 'resting_kcal', /not text/],
    [{ active_kcal: NaN }, [], 'active_kcal', /must be a number/],
    [{ resting_kcal: Infinity }, [], 'resting_kcal', /must be a number/],
    [{ active_kcal: -1 }, [], 'active_kcal', /negative/],
    [{ resting_kcal: -0.5 }, [], 'resting_kcal', /negative/],
    [{ active_kcal: 10001 }, [], 'active_kcal', /not plausible/],
    [{ resting_kcal: 6001 }, [], 'resting_kcal', /not plausible/],
    [{ active_kcal: 9500, resting_kcal: 5900 }, [], 'active_kcal', /together/],
    [{ active_kcal: 0, resting_kcal: 0 }, [], 'active_kcal', /no data.*locked/],
    [{}, ['active_kcal'], 'active_kcal', /required/],
    [{ resting_kcal: null }, [], 'resting_kcal', /required/],
    [{ active_kcal: true }, [], 'active_kcal', /must be a number/],
    [{ active_kcal: [500] }, [], 'active_kcal', /must be a number/],
    [{ active_kcal: {} }, [], 'active_kcal', /must be a number/],
    [{ steps: '8000' }, [], 'steps', /not text/],
    [{ steps: 8000.5 }, [], 'steps', /whole number/],
    [{ steps: -1 }, [], 'steps', /not plausible/],
    [{ steps: 200001 }, [], 'steps', /not plausible/],
    [{ steps: NaN }, [], 'steps', /whole number/],
    [{}, ['date'], 'date', /YYYY-MM-DD/],
    [{ date: '2026-02-30' }, [], 'date', /real day/],
    [{ date: '12/10/2026' }, [], 'date', /YYYY-MM-DD/],
    [{ date: 20261012 }, [], 'date', /YYYY-MM-DD/],
    [{ date: shift(2) }, [], 'date', /future/],
    [{ date: shift(-61) }, [], 'date', /days ago/],
    [{ date: '0000-00-00' }, [], 'date', /real day/]
  ];
  for (const [patch, drop, field, words] of cases) {
    const r = v(patch, drop);
    assert.equal(r.ok, false, JSON.stringify(patch));
    assert.equal(r.field, field, JSON.stringify(patch));
    assert.match(r.error, words, JSON.stringify(patch));
  }
  for (const body of [null, undefined, 'x', 5, [], [GOOD]]) assert.equal(health.validateIngest(body).ok, false);
});

/* ------------------------------ the token ------------------------------ */

test('a token is shown once, stored only as a hash, and never appears in status or in any file', async () => {
  const { call } = setup();
  assert.deepEqual((await call('GET /api/nutrition/health/token', { as: 'a' })).out, { set: false, createdAt: null, lastUsedAt: null, hint: null });
  const made = await call('POST /api/nutrition/health/token', { as: 'a' });
  assert.equal(made.status, 201);
  const token = made.out.token;
  assert.match(token, /^ogh_[0-9a-f]{16}_[0-9a-f]{64}$/);
  assert.equal(made.out.rotated, false);
  const secret = token.split('_')[2];

  const status = await call('GET /api/nutrition/health/token', { as: 'a' });
  assert.equal(status.out.set, true);
  assert.equal(status.out.lastUsedAt, null);
  assert.match(status.out.hint, /^…[0-9a-f]{4}$/);
  assert.ok(!JSON.stringify(status.out).includes(secret) && !JSON.stringify(status.out).includes(token));
  assert.ok(!JSON.stringify((await call('GET /api/nutrition/config', { as: 'a' })).out).includes(secret));
  assert.ok(!JSON.stringify((await call('GET /api/nutrition/day', { as: 'a', url: '/api/nutrition/day?date=2026-10-12' })).out).includes(secret));

  // On disk: the index holds a hash and the user file holds an id and dates — not the secret.
  const all = [];
  (function walk(d) { for (const n of fs.readdirSync(d)) { const f = path.join(d, n); if (fs.statSync(f).isDirectory()) walk(f); else all.push([f, fs.readFileSync(f, 'utf8')]); } })(DIR);
  assert.ok(all.every(([, text]) => !text.includes(secret)), 'the secret is in no file');
  const index = JSON.parse(fs.readFileSync(path.join(DIR, 'nutrition', 'health-tokens.json'), 'utf8'));
  assert.equal(Object.keys(index).length, 1);
  const [id, entry] = Object.entries(index)[0];
  assert.equal(id, token.split('_')[1]);
  assert.equal(entry.uid, 'ua');
  assert.match(entry.hash, /^[0-9a-f]{64}$/);
  assert.notEqual(entry.hash, secret);
  assert.equal(fs.statSync(path.join(DIR, 'nutrition', 'health-tokens.json')).mode & 0o777, 0o600);
  // and the token is not returned by a second look: a new POST makes a NEW one
  assert.notEqual((await call('POST /api/nutrition/health/token', { as: 'a' })).out.token, token);
});

test('token management needs a signed-in profile', async () => {
  const { call } = setup();
  for (const key of ['GET /api/nutrition/health/token', 'POST /api/nutrition/health/token', 'DELETE /api/nutrition/health/token', 'PUT /api/nutrition/health/settings']) assert.equal((await call(key)).status, 401, key);
});

test('rotate replaces the token: the old one stops working at once, the new one works', async () => {
  const { call } = setup();
  const old = await mk(call, 'b');
  assert.equal((await call(INGEST, { token: old, body: GOOD })).status, 200);
  const second = (await call('POST /api/nutrition/health/token', { as: 'b' })).out;
  assert.equal(second.rotated, true);
  assert.equal((await call(INGEST, { token: old, body: GOOD })).status, 401);
  assert.equal((await call(INGEST, { token: second.token, body: GOOD })).status, 200);
  const index = JSON.parse(fs.readFileSync(path.join(DIR, 'nutrition', 'health-tokens.json'), 'utf8'));
  assert.equal(Object.values(index).filter(e => e.uid === 'ub').length, 1, 'one token per profile');
});

test('revoke kills the token and clears the status', async () => {
  const { call } = setup();
  const t = await mk(call, 'a');
  assert.equal((await call(INGEST, { token: t, body: GOOD })).status, 200);
  assert.deepEqual((await call('DELETE /api/nutrition/health/token', { as: 'a' })).out, { revoked: true });
  assert.equal((await call(INGEST, { token: t, body: GOOD })).status, 401);
  assert.equal((await call('GET /api/nutrition/health/token', { as: 'a' })).out.set, false);
  assert.deepEqual((await call('DELETE /api/nutrition/health/token', { as: 'a' })).out, { revoked: false });
});

/* ------------------------------ the ingest route ------------------------------ */

test('valid, wrong, malformed, missing and revoked tokens', async () => {
  const { call } = setup();
  const t = await mk(call, 'a');
  const [, id, secret] = t.split('_');
  const ok = await call(INGEST, { token: t, body: GOOD });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.out, { ok: true, date: '2026-10-12', active_kcal: 512.4, resting_kcal: 1650, steps: 8432, burned_kcal: 2162.4, replaced: false, updatedAt: ok.out.updatedAt });

  const wrong = [
    `ogh_${id}_${'0'.repeat(64)}`,                       // right id, wrong secret
    `ogh_${'f'.repeat(16)}_${secret}`,                   // unknown id
    `ogh_${id}_${secret.slice(0, 63)}`,                  // truncated
    `ogh_${id}_${secret.toUpperCase()}`,                 // wrong case
    id + '_' + secret, 'ogh_', 'x', '', `ogh_${id}_${secret} extra`
  ];
  for (const bad of wrong) assert.equal((await call(INGEST, { token: bad, body: GOOD, addr: '9.9.' + Math.random() })).status, 401, bad);
  assert.equal((await call(INGEST, { body: GOOD, addr: '9.8.7.6' })).status, 401, 'no header');
  assert.equal((await call(INGEST, { raw: 'Basic ' + Buffer.from('a:b').toString('base64'), body: GOOD, addr: '9.8.7.5' })).status, 401, 'not a Bearer');
  assert.equal((await call(INGEST, { raw: 'Bearer', body: GOOD, addr: '9.8.7.4' })).status, 401);
  assert.equal((await call(INGEST, { as: 'a', body: GOOD, addr: '9.8.7.3' })).status, 401, 'a signed-in session is not a token');
  assert.equal((await call(INGEST, { token: t, body: GOOD })).status, 200, 'and the real one still works');
});

test('the answer to a post reveals nothing but what was just posted', async () => {
  const { call } = setup();
  await store.mutate('ua', d => { d.goals = { calories: 2000, protein_g: null, carbs_g: null, fat_g: null }; store.addEntries(d, '2026-10-12', [{ name: 'Secret meal', meal: 'lunch', calories: 600, protein_g: 1, carbs_g: 1, fat_g: 1 }]); });
  const t = await mk(call, 'a');
  const r = await call(INGEST, { token: t, body: { date: '2026-10-12', active_kcal: 300, resting_kcal: 1500 } });
  assert.deepEqual(Object.keys(r.out).sort(), ['active_kcal', 'burned_kcal', 'date', 'ok', 'replaced', 'resting_kcal', 'steps', 'updatedAt']);
  assert.ok(!JSON.stringify(r.out).includes('Secret') && !JSON.stringify(r.out).includes('2000'));
});

test('posting a day again replaces its numbers and keeps a short history', async () => {
  const { call } = setup();
  const t = await mk(call, 'a');
  const post = (n, extra = {}) => call(INGEST, { token: t, body: { date: D20, active_kcal: n, resting_kcal: 1600, ...extra } });
  assert.equal((await post(100)).out.replaced, false);
  const second = await post(250, { steps: 4000 });
  assert.deepEqual([second.out.replaced, second.out.active_kcal, second.out.steps], [true, 250, 4000]);
  const day = (await call('GET /api/nutrition/day', { as: 'a', url: `/api/nutrition/day?date=${D20}` })).out.health;
  assert.deepEqual([day.active_kcal, day.resting_kcal, day.steps, day.burned_kcal], [250, 1600, 4000, 1850]);
  const third = await post(250);                       // same numbers except steps dropped: still a replacement
  assert.equal(third.out.steps, null, 'a repost replaces the whole record, steps included');
  const stored = store.read('ua').health.days[D20];
  assert.equal(stored.active, 250);
  assert.deepEqual(stored.history.map(h => h.active), [100, 250]);
  await post(250);                                      // identical: no new history row
  assert.equal(store.read('ua').health.days[D20].history.length, 2);
  for (let i = 0; i < 10; i++) await post(300 + i);
  assert.equal(store.read('ua').health.days[D20].history.length, health.LIMITS.historyPerDay, 'history is short');
  // other days are untouched, and one record per day
  await call(INGEST, { token: t, body: { date: D21, active_kcal: 1, resting_kcal: 1 } });
  assert.deepEqual(Object.keys(store.read('ua').health.days).sort(), [D20, D21].sort());
});

test('last used is recorded; a day view carries the numbers and the eat-back setting', async () => {
  const { call } = setup();
  const t = await mk(call, 'a');
  assert.equal((await call('GET /api/nutrition/health/token', { as: 'a' })).out.lastUsedAt, null);
  const before = Date.now();
  await call(INGEST, { token: t, body: { date: D22, active_kcal: 400, resting_kcal: 1500 } });
  const status = (await call('GET /api/nutrition/health/token', { as: 'a' })).out;
  assert.ok(status.lastUsedAt >= before);
  const day = (await call('GET /api/nutrition/day', { as: 'a', url: `/api/nutrition/day?date=${D22}` })).out;
  assert.equal(day.health.burned_kcal, 1900);
  assert.ok(day.health.updatedAt >= before);
  assert.deepEqual(day.eatBack, { enabled: false, percent: 50 }, 'off by default');
  assert.equal((await call('GET /api/nutrition/day', { as: 'a', url: `/api/nutrition/day?date=${D23}` })).out.health, null);
  const cfgOut = (await call('GET /api/nutrition/config', { as: 'a' })).out.health;
  assert.deepEqual([cfgOut.set, cfgOut.eatBack.enabled], [true, false]);
});

test('tokens are tied to their profile: A’s token only ever writes A’s file, B’s only B’s', async () => {
  const { call } = setup();
  await store.mutate('ua', () => {}); await store.mutate('ub', () => {});
  const ta = await mk(call, 'a'), tb = await mk(call, 'b');
  await call(INGEST, { token: ta, body: { date: D01, active_kcal: 111, resting_kcal: 1000 } });
  await call(INGEST, { token: tb, body: { date: D01, active_kcal: 222, resting_kcal: 2000 } });
  assert.equal(store.read('ua').health.days[D01].active, 111);
  assert.equal(store.read('ub').health.days[D01].active, 222);
  assert.equal((await call('GET /api/nutrition/day', { as: 'a', url: `/api/nutrition/day?date=${D01}` })).out.health.active_kcal, 111);
  assert.equal((await call('GET /api/nutrition/day', { as: 'b', url: `/api/nutrition/day?date=${D01}` })).out.health.active_kcal, 222);
  // revoking A leaves B working
  await call('DELETE /api/nutrition/health/token', { as: 'a' });
  assert.equal((await call(INGEST, { token: tb, body: { date: D02, active_kcal: 1, resting_kcal: 1 } })).status, 200);
});

test('a gone or disabled profile’s token is dead', async () => {
  const { call } = setup();
  const t = await mk(call, 'a');
  assert.equal((await call(INGEST, { token: t, body: GOOD })).status, 200);
  active = uid => uid !== 'ua';
  try {
    assert.equal((await call(INGEST, { token: t, body: GOOD })).status, 401);
    active = () => true;
    assert.equal((await call(INGEST, { token: t, body: GOOD })).status, 401, 'and it stays dead: its index entry was dropped');
  } finally { active = () => true; }
});

test('rate limits: a valid token is limited per hour; wrong tokens lock the address, not other callers', async () => {
  const { call } = setup();
  const t = await mk(call, 'a');
  const codes = [];
  for (let i = 0; i < 62; i++) codes.push((await call(INGEST, { token: t, body: GOOD })).status);
  assert.equal(codes.filter(c => c === 200).length, 60);
  const limited = await call(INGEST, { token: t, body: GOOD });
  assert.equal(limited.status, 429);
  assert.ok(+limited.h['Retry-After'] >= 1);

  const attacker = '203.0.113.9';
  const attempts = [];
  for (let i = 0; i < 12; i++) attempts.push((await call(INGEST, { token: 'ogh_' + 'a'.repeat(16) + '_' + 'b'.repeat(64), body: GOOD, addr: attacker })).status);
  assert.deepEqual(attempts.slice(0, 10), Array(10).fill(401));
  assert.equal(attempts[11], 429, 'locked after ten wrong tokens');
  assert.equal((await call(INGEST, { token: 'ogh_' + 'a'.repeat(16) + '_' + 'b'.repeat(64), body: GOOD, addr: attacker })).h['Retry-After'] > 0, true);
  const t2 = await mk(call, 'b');
  assert.equal((await call(INGEST, { token: t2, body: GOOD, addr: '198.51.100.7' })).status, 200, 'another address is unaffected');
  assert.equal((await call(INGEST, { token: t2, body: GOOD, addr: attacker })).status, 429, 'the locked address is locked even with a good token');
});

test('a locked iPhone reads zeros: that must never overwrite a good day', async () => {
  const { call } = setup();
  const t = await mk(call, 'a');
  await call(INGEST, { token: t, body: { date: D20, active_kcal: 640, resting_kcal: 1670 } });
  const zeros = await call(INGEST, { token: t, body: { date: D20, active_kcal: 0, resting_kcal: 0, steps: 0 } });
  assert.equal(zeros.status, 400);
  assert.match(zeros.out.error, /locked/);
  assert.equal(store.read('ua').health.days[D20].active, 640, 'the earlier reading is still there');
});

test('bad bodies are 400s with the field named, and store nothing', async () => {
  const { call } = setup();
  const t = await mk(call, 'a');
  const before = JSON.stringify(store.read('ua').health.days);
  for (const body of [{ ...GOOD, active_kcal: '512' }, { ...GOOD, date: 'today' }, { ...GOOD, resting_kcal: -5 }, null, [], 'x']) {
    const r = await call(INGEST, { token: t, body });
    assert.equal(r.status, 400);
    assert.ok(typeof r.out.error === 'string' && r.out.error.length > 5);
  }
  assert.equal((await call(INGEST, { token: t, body: { ...GOOD, active_kcal: 'x' } })).out.field, 'active_kcal');
  assert.equal(JSON.stringify(store.read('ua').health.days), before);
});

test('nothing sensitive is logged: no token, no numbers, not even on failure', async () => {
  const { call } = setup();
  const spies = ['log', 'error', 'warn', 'info'].map(m => mock.method(console, m, () => {}));
  try {
    const t = await mk(call, 'a');
    await call(INGEST, { token: t, body: { date: D03, active_kcal: 777, resting_kcal: 1777 } });
    await call(INGEST, { token: t.slice(0, -2) + 'zz', body: GOOD, addr: '1.2.3.4' });
    await call(INGEST, { token: t, body: { ...GOOD, active_kcal: 'bad' } });
    assert.equal(spies.reduce((n, s) => n + s.mock.calls.length, 0), 0, spies.flatMap(s => s.mock.calls.map(c => c.arguments.join(' '))).join('|'));
  } finally { spies.forEach(s => s.mock.restore()); }
});

test('an admin switching Nutrition off switches the ingest off too', async () => {
  const { call } = setup();
  const t = await mk(call, 'a');
  cfg.save({ enabled: false });
  try { assert.equal((await call(INGEST, { token: t, body: GOOD })).status, 503); } finally { cfg.save({ enabled: true }); }
  assert.equal((await call(INGEST, { token: t, body: GOOD })).status, 200);
});

test('a damaged token index is never overwritten: tokens simply fail, creating one reports the problem', async () => {
  const { call } = setup();
  const t = await mk(call, 'a');
  const file = path.join(DIR, 'nutrition', 'health-tokens.json');
  const good = fs.readFileSync(file);
  fs.writeFileSync(file, '{"broken');
  try {
    assert.equal((await call(INGEST, { token: t, body: GOOD, addr: '5.5.5.5' })).status, 401);
    const made = await call('POST /api/nutrition/health/token', { as: 'a' });
    assert.equal(made.status, 500);
    assert.match(made.out.error, /damaged/);
    assert.equal(fs.readFileSync(file, 'utf8'), '{"broken', 'left exactly as it was');
  } finally { fs.writeFileSync(file, good); }
  assert.equal((await call(INGEST, { token: t, body: GOOD })).status, 200);
});

/* ------------------------------ eat-back setting ------------------------------ */

test('eat-back: off by default, validated, saved', async () => {
  const { call } = setup();
  for (const bad of [{}, { eatBack: null }, { eatBack: { enabled: 'yes', percent: 50 } }, { eatBack: { enabled: true, percent: 101 } }, { eatBack: { enabled: true, percent: -1 } }, { eatBack: { enabled: true, percent: 50.5 } }, { eatBack: { enabled: true, percent: '50' } }, { eatBack: { enabled: true } }]) {
    assert.equal((await call('PUT /api/nutrition/health/settings', { as: 'a', body: bad })).status, 400, JSON.stringify(bad));
  }
  const ok = await call('PUT /api/nutrition/health/settings', { as: 'a', body: { eatBack: { enabled: true, percent: 30 } } });
  assert.deepEqual(ok.out.eatBack, { enabled: true, percent: 30 });
  assert.deepEqual((await call('GET /api/nutrition/day', { as: 'a', url: '/api/nutrition/day?date=2026-10-12' })).out.eatBack, { enabled: true, percent: 30 });
  assert.deepEqual((await call('GET /api/nutrition/day', { as: 'b', url: '/api/nutrition/day?date=2026-10-12' })).out.eatBack, { enabled: false, percent: 50 }, 'per profile');
});

test('the file stays bounded: only the newest days are kept', async () => {
  const { call } = setup();
  const t = await mk(call, 'a');
  await store.mutate('ua', d => {
    for (let i = 0; i < 405; i++) { const x = new Date('2024-01-01T12:00:00Z'); x.setUTCDate(x.getUTCDate() + i); d.health.days[x.toISOString().slice(0, 10)] = { active: 1, resting: 1, steps: null, updatedAt: 1, history: [] }; }
  });
  assert.equal((await call(INGEST, { token: t, body: { date: today, active_kcal: 5, resting_kcal: 5 } })).status, 200);
  const days = Object.keys(store.read('ua').health.days).sort();
  assert.equal(days.length, health.LIMITS.days);
  assert.equal(days.at(-1), today, 'the day just posted is kept');
  assert.ok(!days.includes('2024-01-01'), 'the oldest went');
});

test('the guide in docs/ matches the server: its example is accepted, its address and header are the real ones', async () => {
  const doc = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'docs', 'NUTRITION_APPLE_HEALTH.md'), 'utf8');
  const blocks = [...doc.matchAll(/```json\n([\s\S]*?)\n```/g)].map(m => JSON.parse(m[1]));
  assert.ok(blocks.length >= 1);
  for (const example of blocks) {
    assert.deepEqual(Object.keys(example).sort(), ['active_kcal', 'date', 'resting_kcal', 'steps']);
    assert.equal(health.validateIngest({ ...example, date: today }).ok, true, 'the documented example passes the real validation');
  }
  assert.match(doc, /POST https:\/\/YOUR-SERVER\/api\/nutrition\/health/);
  assert.match(doc, /Authorization: Bearer ogh_/);
  assert.match(doc, /yyyy-MM-dd/);
  for (const limit of ['10 000', '6 000', '200 000']) assert.ok(doc.includes(limit), limit);
  assert.ok(doc.includes('60 posts an hour'), 'the documented hourly limit is the real one (60, see the rate-limit test)');
  assert.ok(doc.includes(`${health.LIMITS.pastDays} days ago`), 'and the documented date window');
});
