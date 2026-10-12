/* Nutrition data layer and routes, against a throwaway DATA_DIR and a fake server.js. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nutrition-test-'));
process.env.DATA_DIR = DIR;
const store = await import('../nutrition/store.js');
const cfg = await import('../nutrition/config.js');
const v = await import('../nutrition/validate.js');
const { nutritionRoutes } = await import('../nutrition/routes.js');

after(() => fs.rmSync(DIR, { recursive: true, force: true }));

/* A minimal stand-in for server.js's helpers: sessions by a header, JSON bodies as given. */
const USERS = { a: { id: 'ua', admin: false }, b: { id: 'ub', admin: false }, admin: { id: 'uadm', admin: true } };
function call(routes, key, { as = 'a', body, url } = {}) {
  const [method, p] = key.split(' ');
  const req = { method, url: url || p, user: USERS[as], body };
  return new Promise((resolve, reject) => {
    const res = { status: 0, out: null };
    const jsonFn = (r, code, obj) => { res.status = code; res.out = obj; resolve(res); };
    const r2 = nutritionRoutes({
      json: jsonFn,
      readBody: async q => q.body ?? {},
      readSession: q => q.user || null,
      requireAdmin: (q, r) => { if (!q.user) { jsonFn(r, 401, {}); return null; } if (!q.user.admin) { jsonFn(r, 403, {}); return null; } return q.user; }
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
