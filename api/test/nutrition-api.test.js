/* Nutrition data layer and routes, against a throwaway DATA_DIR and a fake server.js. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nutrition-test-'));
process.env.DATA_DIR = DIR;
fs.writeFileSync(path.join(DIR, 'secret'), 'b'.repeat(64), { mode: 0o600 });   // what server.js creates at boot; the USDA key is encrypted with it
const store = await import('../nutrition/store.js');
const cfg = await import('../nutrition/config.js');
const v = await import('../nutrition/validate.js');
const { nutritionRoutes } = await import('../nutrition/routes.js');

after(() => fs.rmSync(DIR, { recursive: true, force: true }));

/* A minimal stand-in for server.js's helpers: sessions by a header, JSON bodies as given. */
const USERS = { a: { id: 'ua', admin: false }, b: { id: 'ub', admin: false }, admin: { id: 'uadm', admin: true } };
function call(routes, key, { as = 'a', body, url, lookup } = {}) {
  const [method, p] = key.split(' ');
  const req = { method, url: url || p, user: USERS[as], body };
  return new Promise((resolve, reject) => {
    const res = { status: 0, out: null };
    const jsonFn = (r, code, obj) => { res.status = code; res.out = obj; resolve(res); };
    const r2 = nutritionRoutes({
      json: jsonFn,
      readBody: async q => q.body ?? {},
      readSession: q => q.user || null,
      requireAdmin: (q, r) => { if (!q.user) { jsonFn(r, 401, {}); return null; } if (!q.user.admin) { jsonFn(r, 403, {}); return null; } return q.user; },
      ...(lookup ? { lookup } : {})
    });
    Promise.resolve(r2[key](req, res)).then(() => { if (!res.status) resolve(res); }, reject);
  });
}
const R = nutritionRoutes({ json() {}, readBody() {}, readSession() {}, requireAdmin() {} });

const QUICK = { date: '2026-10-12', meal: 'lunch', name: 'Sandwich', source: 'quick', calories: 450, protein_g: 20, carbs_g: 50, fat_g: 15 };

test('every route needs a session', async () => {
  for (const key of Object.keys(R).filter(k => !k.includes('/admin/'))) {
    const r = await call(R, key, { as: 'nobody' });
    assert.equal(r.status, 401, key);
  }
  assert.equal((await call(R, 'GET /api/admin/nutrition', { as: 'nobody' })).status, 401);
  assert.equal((await call(R, 'GET /api/admin/nutrition', { as: 'a' })).status, 403);
});

test('add, read back, edit, move and delete an entry', async () => {
  const add = await call(R, 'POST /api/nutrition/entries', { body: QUICK });
  assert.equal(add.status, 201);
  const id = add.out.entries[0].id;
  assert.equal(add.out.day.totals.calories, 450);
  assert.equal(add.out.day.byMeal.lunch.protein_g, 20);

  const day = await call(R, 'GET /api/nutrition/day', { url: '/api/nutrition/day?date=2026-10-12' });
  assert.equal(day.out.entries.length, 1);

  const put = await call(R, 'PUT /api/nutrition/entries', { url: `/api/nutrition/entries?date=2026-10-12&id=${id}`, body: { calories: 500, meal: 'dinner' } });
  assert.equal(put.out.entry.calories, 500);
  assert.equal(put.out.entry.protein_g, 20, 'untouched fields stay');
  assert.equal(put.out.entry.meal, 'dinner');

  const mv = await call(R, 'PUT /api/nutrition/entries', { url: `/api/nutrition/entries?date=2026-10-12&id=${id}`, body: { newDate: '2026-10-13' } });
  assert.equal(mv.out.day.date, '2026-10-13');
  assert.equal((await call(R, 'GET /api/nutrition/day', { url: '/api/nutrition/day?date=2026-10-12' })).out.entries.length, 0);

  const del = await call(R, 'DELETE /api/nutrition/entries', { url: `/api/nutrition/entries?date=2026-10-13&id=${id}` });
  assert.equal(del.out.day.entries.length, 0);
  assert.equal((await call(R, 'DELETE /api/nutrition/entries', { url: `/api/nutrition/entries?date=2026-10-13&id=${id}` })).status, 404);
});

test('profiles cannot see or touch each other', async () => {
  const mine = await call(R, 'POST /api/nutrition/entries', { as: 'a', body: { ...QUICK, date: '2026-11-01' } });
  const id = mine.out.entries[0].id;
  assert.equal((await call(R, 'GET /api/nutrition/day', { as: 'b', url: '/api/nutrition/day?date=2026-11-01' })).out.entries.length, 0);
  assert.equal((await call(R, 'DELETE /api/nutrition/entries', { as: 'b', url: `/api/nutrition/entries?date=2026-11-01&id=${id}` })).status, 404);
  assert.equal((await call(R, 'GET /api/nutrition/day', { as: 'a', url: '/api/nutrition/day?date=2026-11-01' })).out.entries.length, 1);
});

test('a batch (the AI review result) saves several entries under one meal', async () => {
  const r = await call(R, 'POST /api/nutrition/entries', { body: { date: '2026-10-14', meal: 'breakfast', entries: [
    { name: 'Egg', source: 'ai', confidence: 'medium', calories: 90, protein_g: 6, carbs_g: 0.5, fat_g: 7 },
    { name: 'Toast', source: 'ai', confidence: 'medium', calories: 80, protein_g: 3, carbs_g: 14, fat_g: 1 }
  ] } });
  assert.equal(r.status, 201);
  assert.equal(r.out.entries.length, 2);
  assert.ok(r.out.entries.every(e => e.meal === 'breakfast' && e.source === 'ai' && e.confidence === 'medium'));
  assert.equal(r.out.day.totals.calories, 170);
});

test('validation: bad dates, meals, numbers and unknown keys', async () => {
  const bad = async body => (await call(R, 'POST /api/nutrition/entries', { body })).status;
  assert.equal(await bad({ ...QUICK, date: '2026-02-30' }), 400);
  assert.equal(await bad({ ...QUICK, date: 'yesterday' }), 400);
  assert.equal(await bad({ ...QUICK, meal: 'brunch' }), 400);
  assert.equal(await bad({ ...QUICK, calories: -1 }), 400);
  assert.equal(await bad({ ...QUICK, calories: '450' }), 400);
  assert.equal(await bad({ ...QUICK, calories: 1e9 }), 400);
  assert.equal(await bad({ ...QUICK, calories: NaN }), 400);
  assert.equal(await bad({ ...QUICK, name: '   ' }), 400);
  assert.equal(await bad({ ...QUICK, protein_g: undefined }), 400);
  assert.equal(await bad({ ...QUICK, source: 'hacker' }), 400);
  assert.equal(await bad({ ...QUICK, entries: [] }), 400);
  const ok = await call(R, 'POST /api/nutrition/entries', { body: { ...QUICK, date: '2026-12-01', ts: 5, id: 'x', __proto__: { a: 1 }, name: '  Tab\tbed\n ' } });
  assert.equal(ok.out.entries[0].name, 'Tab bed');
  assert.notEqual(ok.out.entries[0].id, 'x');
  assert.notEqual(ok.out.entries[0].ts, 5);
});

test('foods: custom CRUD, favourite, entry from foodId fills the macros', async () => {
  const mk = await call(R, 'POST /api/nutrition/foods', { body: { name: 'Protein shake', brand: 'Home', serving: '1 scoop', grams: 30, per: { calories: 120, protein_g: 24, carbs_g: 3, fat_g: 1.5 }, source: 'off' } });
  assert.equal(mk.status, 201);
  assert.equal(mk.out.food.source, 'custom', 'a client cannot mint a non-custom food');
  const id = mk.out.food.id;

  const fav = await call(R, 'PUT /api/nutrition/foods', { url: `/api/nutrition/foods?id=${id}`, body: { favorite: true } });
  assert.equal(fav.out.food.favorite, true);
  assert.equal(fav.out.food.name, 'Protein shake');
  assert.equal((await call(R, 'GET /api/nutrition/foods', { url: '/api/nutrition/foods?scope=favorite' })).out.foods.length, 1);
  assert.equal((await call(R, 'GET /api/nutrition/foods', { url: '/api/nutrition/foods?q=shak' })).out.foods.length, 1);
  assert.equal((await call(R, 'GET /api/nutrition/foods', { url: '/api/nutrition/foods?scope=bogus' })).status, 400);

  const e = await call(R, 'POST /api/nutrition/entries', { body: { date: '2026-10-20', meal: 'snack', source: 'food', foodId: id, qty: 2 } });
  assert.equal(e.status, 201);
  assert.deepEqual([e.out.entries[0].calories, e.out.entries[0].protein_g, e.out.entries[0].fat_g, e.out.entries[0].grams], [240, 48, 3, 60]);
  assert.equal(e.out.entries[0].serving, '1 scoop');
  assert.equal(e.out.entries[0].brand, 'Home');
  assert.equal(e.out.entries[0].name, 'Protein shake');
  assert.equal((await call(R, 'GET /api/nutrition/foods', { url: '/api/nutrition/foods?scope=recent' })).out.foods[0].useCount, 1);

  assert.equal((await call(R, 'POST /api/nutrition/entries', { body: { date: '2026-10-20', meal: 'snack', foodId: 'nope' } })).status, 400);
  assert.equal((await call(R, 'DELETE /api/nutrition/foods', { url: `/api/nutrition/foods?id=${id}` })).status, 200);
  assert.equal((await call(R, 'DELETE /api/nutrition/foods', { url: `/api/nutrition/foods?id=${id}` })).status, 404);
  assert.equal((await call(R, 'GET /api/nutrition/day', { url: '/api/nutrition/day?date=2026-10-20' })).out.entries.length, 1, 'logged entries keep their numbers');
});

test('goals: set, partial, clear, and bad values', async () => {
  assert.equal((await call(R, 'GET /api/nutrition/goals')).out.goals, null);
  const set = await call(R, 'PUT /api/nutrition/goals', { body: { calories: 2400, protein_g: 160, carbs_g: null, fat_g: 70 } });
  assert.deepEqual(set.out.goals, { calories: 2400, protein_g: 160, carbs_g: null, fat_g: 70 });
  assert.equal((await call(R, 'GET /api/nutrition/day', { url: '/api/nutrition/day?date=2026-10-12' })).out.goals.calories, 2400);
  assert.equal((await call(R, 'PUT /api/nutrition/goals', { body: { calories: -5 } })).status, 400);
  assert.equal((await call(R, 'PUT /api/nutrition/goals', { body: { calories: '2000' } })).status, 400);
  assert.equal((await call(R, 'PUT /api/nutrition/goals', { body: {} })).out.goals, null);
});

test('range returns per-day totals and refuses silly spans', async () => {
  const r = await call(R, 'GET /api/nutrition/range', { url: '/api/nutrition/range?from=2026-10-01&to=2026-10-31' });
  assert.equal(r.status, 200);
  assert.ok(r.out.days.length >= 2);
  assert.ok(r.out.days.every((d, i, a) => i === 0 || a[i - 1].date < d.date));
  assert.equal((await call(R, 'GET /api/nutrition/range', { url: '/api/nutrition/range?from=2026-10-31&to=2026-10-01' })).status, 400);
  assert.equal((await call(R, 'GET /api/nutrition/range', { url: '/api/nutrition/range?from=2020-01-01&to=2026-10-01' })).status, 400);
});

test('concurrent writes to one profile are not lost', async () => {
  const before = (await call(R, 'GET /api/nutrition/day', { as: 'b', url: '/api/nutrition/day?date=2027-01-01' })).out.entries.length;
  await Promise.all(Array.from({ length: 25 }, (_, i) => call(R, 'POST /api/nutrition/entries', { as: 'b', body: { ...QUICK, date: '2027-01-01', name: 'n' + i } })));
  const after = (await call(R, 'GET /api/nutrition/day', { as: 'b', url: '/api/nutrition/day?date=2027-01-01' })).out.entries;
  assert.equal(after.length, before + 25);
  assert.equal(new Set(after.map(e => e.id)).size, after.length);
});

test('a failing mutation writes nothing', async () => {
  await assert.rejects(store.mutate('ufail', d => { d.goals = { calories: 1 }; throw new Error('boom'); }), /boom/);
  assert.equal(store.read('ufail').goals, null);
  // and the lock queue survives the failure
  await store.mutate('ufail', d => { d.goals = { calories: 2 }; });
  assert.equal(store.read('ufail').goals.calories, 2);
});

test('a day holds a bounded number of entries', async () => {
  await store.mutate('ucap', d => { store.addEntries(d, '2027-02-01', Array.from({ length: v.LIMITS.entriesPerDay }, () => ({ name: 'x' }))); });
  await assert.rejects(store.mutate('ucap', d => store.addEntries(d, '2027-02-01', [{ name: 'one more' }])), store.NutritionLimitError);
  assert.equal(store.read('ucap').days['2027-02-01'].entries.length, v.LIMITS.entriesPerDay);
});

test('a damaged data file is reported and never overwritten', async () => {
  const file = path.join(DIR, 'nutrition', 'ubroken.json');
  fs.writeFileSync(file, '{"days": {oops');
  const r = await call(R, 'POST /api/nutrition/entries', { as: 'a', body: QUICK }).catch(e => e);   // other profile is fine
  assert.equal(r.status, 201);
  USERS.broken = { id: 'ubroken' };
  const bad = await call(R, 'GET /api/nutrition/day', { as: 'broken', url: '/api/nutrition/day?date=2026-10-12' });
  assert.equal(bad.status, 500);
  await assert.rejects(call(R, 'POST /api/nutrition/entries', { as: 'broken', body: QUICK }).then(x => { if (x.status !== 500) throw new Error('wrote'); return x; }).then(x => { throw new Error('expected 500, got ' + x.status); }), /expected 500/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{"days": {oops', 'bytes untouched');
});

test('data files are private to the server user', () => {
  const mode = fs.statSync(path.join(DIR, 'nutrition', 'ua.json')).mode & 0o777;
  assert.equal(mode, 0o600);
  assert.equal(fs.statSync(path.join(DIR, 'nutrition')).mode & 0o777, 0o700);
});

test('uids cannot walk out of the data directory', () => {
  assert.throws(() => store.read('../../etc/passwd'.replace(/[a-z/.]/g, '')), /no user id/);
  store.removeUser('../ua');   // sanitised to "ua", still inside nutrition/
  assert.ok(!fs.existsSync(path.join(DIR, 'nutrition', 'ua.json')));
});

test('AI cap: default 30, counted per profile per day, admin can change it, 0 turns it off', async () => {
  assert.equal(cfg.load().aiDailyCap, 30);
  assert.equal((await call(R, 'GET /api/nutrition/config', { as: 'admin' })).out.ai.remaining, 30);

  for (let i = 0; i < 3; i++) assert.equal((await store.reserveAi('ucap2', 3)).ok, true);
  const over = await store.reserveAi('ucap2', 3);
  assert.deepEqual([over.ok, over.used, over.remaining], [false, 3, 0]);
  assert.equal((await store.reserveAi('ucap3', 3)).ok, true, 'another profile has its own allowance');

  await store.refundAi('ucap2');
  assert.equal((await store.reserveAi('ucap2', 3)).ok, true, 'a refunded call frees a slot');

  assert.equal((await store.reserveAi('uoff', 0)).ok, false, '0 = AI off');

  const set = await call(R, 'PUT /api/admin/nutrition', { as: 'admin', body: { aiDailyCap: 12 } });
  assert.equal(set.out.aiDailyCap, 12);
  assert.equal((await call(R, 'GET /api/nutrition/config', { as: 'a' })).out.ai.limit, 12);
  for (const bad of [-1, 501, 1.5, '30', null]) assert.equal((await call(R, 'PUT /api/admin/nutrition', { as: 'admin', body: { aiDailyCap: bad } })).status, 400, String(bad));
  assert.equal((await call(R, 'PUT /api/admin/nutrition', { as: 'a', body: { aiDailyCap: 5 } })).status, 403);
});

test('the AI allowance resets on a new day', async () => {
  await store.mutate('uday', d => { d.ai = { date: '2000-01-01', count: 99 }; });
  assert.equal(store.aiUsed(store.read('uday')), 0);
  assert.equal((await store.reserveAi('uday', 1)).ok, true);
});

test('admin can switch nutrition off for everyone', async () => {
  await call(R, 'PUT /api/admin/nutrition', { as: 'admin', body: { enabled: false } });
  const r = await call(R, 'GET /api/nutrition/goals');
  assert.equal(r.status, 503);
  assert.equal(r.out.code, 'off');
  await call(R, 'PUT /api/admin/nutrition', { as: 'admin', body: { enabled: true } });
  assert.equal((await call(R, 'GET /api/nutrition/goals')).status, 200);
});

test('recents are deduplicated and pruned to a bound', async () => {
  await store.mutate('urec', d => {
    const f = { source: 'off', ext: '123', name: 'Yogurt', brand: 'X', serving: { label: '1 pot', grams: 150 }, per: { calories: 90, protein_g: 5, carbs_g: 12, fat_g: 2 } };
    const a = store.noteRecent(d, f), b = store.noteRecent(d, { ...f, name: 'Yogurt (renamed upstream)' });
    assert.equal(a.id, b.id);
    assert.equal(a.useCount, 2);
    for (let i = 0; i < v.LIMITS.recentFoods + 20; i++) store.noteRecent(d, { ...f, ext: 'x' + i, name: 'n' + i });
    store.addFood(d, { name: 'mine', brand: '', serving: { label: '1', grams: null }, per: f.per });
    store.pruneForTest?.(d);
  });
  const d = store.read('urec');
  const recents = Object.values(d.foods).filter(x => x.source !== 'custom');
  assert.ok(recents.length <= v.LIMITS.recentFoods);
  assert.ok(Object.values(d.foods).some(x => x.name === 'mine'), 'custom foods are never pruned');
});


/* ------------------------------ 2c: lookups ------------------------------ */

const NUTELLA = { source: 'off', ext: '3017620422003', name: 'Nutella', brand: 'Ferrero', bases: [{ label: '15 g', grams: 15, per: { calories: 81, protein_g: 0.9, carbs_g: 8.6, fat_g: 4.6 } }, { label: '100 g', grams: 100, per: { calories: 539, protein_g: 6.3, carbs_g: 57.5, fat_g: 30.9 } }] };
const fakeLookup = (over = {}) => {
  const calls = { search: [], barcode: [] };
  return {
    calls,
    search: async (q, o) => { calls.search.push([q, o]); return { results: [NUTELLA], sources: { off: { ok: true, count: 1 }, usda: o.usdaKey ? { ok: true, count: 0 } : { ok: false, skipped: 'no-key' } } }; },
    barcode: async code => { calls.barcode.push(code); return code === '3017620422003' ? { found: true, product: NUTELLA } : { found: false, reason: 'unknown' }; },
    ...over
  };
};

test('search and barcode need a session and sane input', async () => {
  const lk = fakeLookup();
  const R2 = nutritionRoutes({ json() {}, readBody() {}, readSession() {}, requireAdmin() {}, lookup: lk });
  assert.equal((await call(R2, 'GET /api/nutrition/search', { as: 'nobody', url: '/api/nutrition/search?q=nutella', lookup: lk })).status, 401);
  assert.equal((await call(R2, 'GET /api/nutrition/search', { url: '/api/nutrition/search?q=n', lookup: lk })).status, 400);
  assert.equal((await call(R2, 'GET /api/nutrition/search', { url: '/api/nutrition/search?q=nutella&source=evil', lookup: lk })).status, 400);
  assert.equal((await call(R2, 'GET /api/nutrition/barcode', { url: '/api/nutrition/barcode?code=abc', lookup: lk })).status, 400);
  assert.equal((await call(R2, 'GET /api/nutrition/barcode', { url: '/api/nutrition/barcode?code=../../x', lookup: lk })).status, 400);
  assert.deepEqual(lk.calls, { search: [], barcode: [] }, 'bad input never reaches the outside world');
});

test('search passes the stored USDA key only when one is set, and says USDA is off otherwise', async () => {
  const lk = fakeLookup();
  const none = await call(R, 'GET /api/nutrition/search', { url: '/api/nutrition/search?q=nutella', lookup: lk });
  assert.equal(none.out.sources.usda.skipped, 'no-key');
  assert.equal(lk.calls.search[0][1].usdaKey, null);
  assert.equal((await call(R, 'GET /api/nutrition/config', { as: 'a' })).out.lookup.usda, false);

  const set = await call(R, 'PUT /api/admin/nutrition', { as: 'admin', body: { usdaKey: 'abcd1234EFGH5678' } });
  assert.equal(set.status, 200);
  assert.equal(set.out.usdaKeySet, true);
  assert.equal(set.out.usdaKeyHint, '…5678');
  assert.ok(!JSON.stringify(set.out).includes('abcd1234'), 'the key is never echoed');
  const onDisk = fs.readFileSync(path.join(DIR, 'nutrition', 'config.json'), 'utf8');
  assert.ok(!onDisk.includes('abcd1234EFGH5678'), 'the key is encrypted at rest');
  assert.equal((await call(R, 'GET /api/admin/nutrition', { as: 'admin' })).out.usdaKeyHint, '…5678');
  assert.ok(!JSON.stringify((await call(R, 'GET /api/nutrition/config', { as: 'a' })).out).includes('5678'), 'users learn only that lookup exists');

  const lk2 = fakeLookup();
  await call(R, 'GET /api/nutrition/search', { url: '/api/nutrition/search?q=nutella&source=usda', lookup: lk2 });
  assert.deepEqual(lk2.calls.search[0], ['nutella', { usdaKey: 'abcd1234EFGH5678', fatsecret: null, uid: 'ua', sources: 'usda' }]);
  assert.equal((await call(R, 'GET /api/nutrition/config', { as: 'a' })).out.lookup.usda, true);
});

test('the USDA key is validated, admin-only, and can be cleared', async () => {
  assert.equal((await call(R, 'PUT /api/admin/nutrition', { as: 'a', body: { usdaKey: 'abcd1234EFGH5678' } })).status, 403);
  for (const bad of ['short', 'has space in it 12345', 'a'.repeat(200), '<script>alert(1)</script>', 12345678, {}]) {
    assert.equal((await call(R, 'PUT /api/admin/nutrition', { as: 'admin', body: { usdaKey: bad } })).status, 400, JSON.stringify(bad));
  }
  assert.equal(cfg.load().usdaKeySet, true, 'a rejected key leaves the stored one alone');
  const cleared = await call(R, 'PUT /api/admin/nutrition', { as: 'admin', body: { usdaKey: '' } });
  assert.equal(cleared.out.usdaKeySet, false);
  assert.equal((await call(R, 'POST /api/admin/nutrition/test-usda', { as: 'admin' })).status, 400, 'nothing to test');
  // other settings survive a key change
  await call(R, 'PUT /api/admin/nutrition', { as: 'admin', body: { aiDailyCap: 21 } });
  await call(R, 'PUT /api/admin/nutrition', { as: 'admin', body: { usdaKey: 'abcd1234EFGH5678' } });
  assert.equal(cfg.load().aiDailyCap, 21);
  assert.equal(cfg.load().usdaKeySet, true);
});

test('test-usda reports a good key and a bad one in words', async () => {
  const ok = fakeLookup({ search: async () => ({ results: [], sources: { usda: { ok: true, count: 9 } } }) });
  const r1 = await call(R, 'POST /api/admin/nutrition/test-usda', { as: 'admin', lookup: ok });
  assert.deepEqual([r1.out.ok, r1.out.count], [true, 9]);
  const bad = fakeLookup({ search: async () => ({ results: [], sources: { usda: { ok: false, kind: 'auth', error: 'USDA FoodData Central rejected the API key' } } }) });
  const r2 = await call(R, 'POST /api/admin/nutrition/test-usda', { as: 'admin', lookup: bad });
  assert.deepEqual([r2.out.ok, r2.out.kind], [false, 'auth']);
  assert.match(r2.out.error, /rejected/);
});

test('lookups are budgeted per profile: 40 a minute, then 429 with Retry-After', async () => {
  const lk = fakeLookup();
  const R2 = nutritionRoutes({ json: (res, code, obj, h) => { res.status = code; res.out = obj; res.h = h; }, readBody: async () => ({}), readSession: q => q.user, requireAdmin() {}, lookup: lk });
  const hit = async user => { const res = {}; await R2['GET /api/nutrition/search']({ method: 'GET', url: '/api/nutrition/search?q=nutella', user }, res); return res; };
  const codes = [];
  for (let i = 0; i < 45; i++) codes.push((await hit(USERS.a)).status);
  assert.equal(codes.filter(c => c === 200).length, 40);
  assert.equal(codes.filter(c => c === 429).length, 5);
  const limited = await hit(USERS.a);
  assert.equal(limited.out.code, 'rate');
  assert.ok(+limited.h['Retry-After'] >= 1);
  assert.equal((await hit(USERS.b)).status, 200, 'another profile has its own budget');
  assert.equal(lk.calls.search.length, 41, 'refused requests never reach the outside world');
});

test('logging a looked-up food keeps it as a recent, priced from the chosen portion', async () => {
  const snapshot = (base, over = {}) => ({ name: NUTELLA.name, brand: NUTELLA.brand, source: 'off', ext: NUTELLA.ext, serving: base.label, grams: base.grams, per: base.per, ...over });
  const add = await call(R, 'POST /api/nutrition/entries', { body: { date: '2026-10-30', meal: 'breakfast', source: 'food', qty: 2, food: snapshot(NUTELLA.bases[0]) } });
  assert.equal(add.status, 201);
  const e = add.out.entries[0];
  assert.deepEqual([e.name, e.brand, e.serving, e.calories, e.protein_g, e.grams, e.qty], ['Nutella', 'Ferrero', '15 g', 162, 1.8, 30, 2]);
  assert.ok(e.foodId);

  // The same product logged again, same portion → the same recent, counted twice.
  await call(R, 'POST /api/nutrition/entries', { body: { date: '2026-10-30', meal: 'snack', source: 'food', qty: 1, food: snapshot(NUTELLA.bases[0]) } });
  // A different portion of it → a second recent (the stored numbers are per portion).
  await call(R, 'POST /api/nutrition/entries', { body: { date: '2026-10-30', meal: 'snack', source: 'food', qty: 0.5, food: snapshot(NUTELLA.bases[1]) } });
  const recents = (await call(R, 'GET /api/nutrition/foods', { url: '/api/nutrition/foods?scope=recent' })).out.foods.filter(f => f.ext === NUTELLA.ext);
  assert.equal(recents.length, 2);
  assert.equal(recents.find(f => f.serving.label === '15 g').useCount, 2);
  assert.equal(recents[0].source, 'off');
  const day = (await call(R, 'GET /api/nutrition/day', { url: '/api/nutrition/day?date=2026-10-30' })).out;
  assert.equal(day.totals.calories, 162 + 81 + 270);   // 2×15 g + 1×15 g + ½×100 g (rounded 269.5 → 270)
});

test('a food snapshot cannot pose as custom, be unnamed, or arrive without an id', async () => {
  const bad = async food => (await call(R, 'POST /api/nutrition/entries', { body: { date: '2026-10-30', meal: 'lunch', qty: 1, food } })).status;
  const per = { calories: 10, protein_g: 1, carbs_g: 1, fat_g: 1 };
  assert.equal(await bad({ name: 'x', source: 'custom', ext: '1', serving: '1', per }), 400);
  assert.equal(await bad({ name: 'x', source: 'off', serving: '1', per }), 400);
  assert.equal(await bad({ name: '', source: 'off', ext: '1', serving: '1', per }), 400);
  assert.equal(await bad({ name: 'x', source: 'off', ext: '1', serving: '1', per: { calories: -1, protein_g: 0, carbs_g: 0, fat_g: 0 } }), 400);
  assert.equal(await bad('nope'), 400);
});
