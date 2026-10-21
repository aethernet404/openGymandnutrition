/* Vitamins & supplements: a section of the day, saved supplements (a type of saved food, listed apart), the usual stack,
   and their nutrients counting in the day's micronutrients. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'supps-test-'));
process.env.DATA_DIR = DIR;
fs.writeFileSync(path.join(DIR, 'secret'), 'f'.repeat(64), { mode: 0o600 });
const store = await import('../nutrition/store.js');
const v = await import('../nutrition/validate.js');
const { nutritionRoutes } = await import('../nutrition/routes.js');

const USERS = { a: { id: 'spa' }, b: { id: 'spb' } };
const DAY = '2026-10-12';
function setup() {
  for (const u of Object.values(USERS)) store.removeUser(u.id);
  const R = nutritionRoutes({ json: (res, code, obj) => { res.status = code; res.out = obj; }, readBody: async q => q.body, readSession: q => q.user || null, requireAdmin: () => null, lookup: { search: async () => ({ results: [], sources: {} }) }, analyzer: {}, limitAddress: () => '10.0.0.1', userActive: () => true });
  return async (key, { as = 'a', body, url } = {}) => { const res = {}; await R[key]({ method: key.split(' ')[0], url: url || key.split(' ')[1], user: USERS[as], body, headers: {} }, res); return res; };
}
const MULTI = { name: 'Daily multi', brand: 'Acme', serving: '1 tablet', type: 'supplement', per: { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 }, micros: { vit_d_mcg: 25, iron_mg: 18, zinc_mg: 15, b12_mcg: 6 } };
const MAG = { name: 'Magnesium glycinate', serving: '2 capsules', type: 'supplement', per: { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 }, micros: { magnesium_mg: 200 } };
const save = (call, body, as) => call('POST /api/nutrition/foods', { as, body });
const list = (call, qs, as) => call('GET /api/nutrition/foods', { as, url: '/api/nutrition/foods?' + qs });

test('a supplement is saved as a food with type "supplement"; foods and supplements are listed apart, in every scope', async () => {
  const call = setup();
  const m = (await save(call, MULTI)).out.food;
  const f = (await save(call, { name: 'Oats', serving: '1 bowl', per: { calories: 150, protein_g: 5, carbs_g: 27, fat_g: 3 } })).out.food;
  assert.equal(m.type, 'supplement'); assert.ok(!('type' in f));
  assert.deepEqual((await list(call, 'scope=all')).out.foods.map(x => x.id), [f.id], 'My foods stays food only');
  assert.deepEqual((await list(call, 'scope=all&type=supplement')).out.foods.map(x => x.id), [m.id]);
  await call('PUT /api/nutrition/foods', { url: `/api/nutrition/foods?id=${m.id}`, body: { favorite: true } });
  assert.deepEqual((await list(call, 'scope=favorite&type=supplement')).out.foods.map(x => x.id), [m.id]);
  assert.deepEqual((await list(call, 'scope=favorite')).out.foods, []);
  assert.deepEqual((await list(call, 'scope=all&type=supplement&q=multi')).out.foods.map(x => x.id), [m.id]);
  // Add → Search "My food" results never include supplements
  assert.deepEqual((await call('GET /api/nutrition/search', { url: '/api/nutrition/search?q=daily+multi&source=mine' })).out.results, []);
  // old data: a food saved before any of this has no type and is a food
  await store.mutate('spa', d => { d.foods.old = { id: 'old', source: 'custom', name: 'Granola', serving: { label: '1 bar' }, per: { calories: 190, protein_g: 4, carbs_g: 29, fat_g: 7 } }; });
  assert.ok((await list(call, 'scope=all')).out.foods.some(x => x.id === 'old'));
  assert.ok(!(await list(call, 'scope=all&type=supplement')).out.foods.some(x => x.id === 'old'));
});

test('validation: type is "supplement" or nothing; a food cannot become a supplement (or back) by editing', async () => {
  const call = setup();
  assert.equal((await save(call, { ...MULTI, type: 'vitamin' })).status, 400);
  assert.equal((await save(call, { ...MULTI, type: 5 })).status, 400);
  const m = (await save(call, MULTI)).out.food;
  const edit = await call('PUT /api/nutrition/foods', { url: `/api/nutrition/foods?id=${m.id}`, body: { type: null, name: 'Renamed', serving: '1 tablet', calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 } });
  assert.equal(edit.status, 200); assert.equal(edit.out.food.type, 'supplement'); assert.equal(edit.out.food.name, 'Renamed');
  assert.equal(v.food({ type: 'supplement' }, { partial: true }).value.type, 'supplement');
});

test('duplicates are per type: a supplement and a food may share a name; two supplements may not (without asking)', async () => {
  const call = setup();
  await save(call, { name: 'Zinc', serving: '1', per: { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 } });
  const first = await save(call, { ...MAG, name: 'Zinc', checkDuplicate: true });
  assert.equal(first.status, 201, 'a food named Zinc is not a duplicate of a supplement named Zinc');
  const dup = await save(call, { ...MAG, name: 'zinc', checkDuplicate: true });
  assert.equal(dup.status, 409);
  assert.equal(dup.out.existing.type, 'supplement');
  assert.equal((await save(call, { ...MAG, name: 'zinc', checkDuplicate: true, onDuplicate: 'update', micros: { zinc_mg: 30 } })).out.food.micros.zinc_mg, 30);
});

test('limits: at most 40 supplement entries a day and 200 saved supplements', async () => {
  const call = setup();
  const m = (await save(call, MULTI)).out.food;
  const ok = await call('POST /api/nutrition/entries', { body: { date: DAY, meal: 'supplements', entries: Array.from({ length: 30 }, () => ({ source: 'food', foodId: m.id, qty: 1 })) } });
  assert.equal(ok.status, 201);
  await call('POST /api/nutrition/entries', { body: { date: DAY, meal: 'supplements', entries: Array.from({ length: 10 }, () => ({ source: 'food', foodId: m.id, qty: 1 })) } });
  const over = await call('POST /api/nutrition/entries', { body: { date: DAY, meal: 'supplements', source: 'food', foodId: m.id, qty: 1 } });
  assert.equal(over.status, 409);
  assert.match(over.out.error, /at most 40 supplements/);
  assert.equal(store.read('spa').days[DAY].entries.length, 40);
  // food entries are not counted against it
  assert.equal((await call('POST /api/nutrition/entries', { body: { date: DAY, meal: 'lunch', source: 'quick', name: 'x', calories: 1, protein_g: 0, carbs_g: 0, fat_g: 0 } })).status, 201);
  const call2 = setup();
  await store.mutate('spa', d => { for (let i = 0; i < 200; i++) d.foods['s' + i] = { id: 's' + i, source: 'custom', type: 'supplement', name: 'S' + i, serving: { label: '1' }, per: { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 } }; });
  const full = await save(call2, MULTI);
  assert.equal(full.status, 409); assert.match(full.out.error, /at most 200 saved supplements/);
});

test('logging a supplement: meal "supplements", servings scale its micros, calories default to 0 and the day’s calories do not move', async () => {
  const call = setup();
  const m = (await save(call, MULTI)).out.food;
  await call('POST /api/nutrition/entries', { body: { date: DAY, meal: 'lunch', source: 'quick', name: 'Lunch', calories: 600, protein_g: 30, carbs_g: 60, fat_g: 20 } });
  const add = await call('POST /api/nutrition/entries', { body: { date: DAY, meal: 'supplements', source: 'food', foodId: m.id, qty: 2 } });
  assert.equal(add.status, 201, JSON.stringify(add.out));
  const e = add.out.entries[0];
  assert.deepEqual([e.meal, e.name, e.qty, e.calories, e.serving], ['supplements', 'Daily multi', 2, 0, '1 tablet']);
  assert.deepEqual(e.micros, { vit_d_mcg: 50, iron_mg: 36, zinc_mg: 30, b12_mcg: 12 });
  const day = add.out.day;
  assert.equal(day.totals.calories, 600, 'a 0 kcal supplement changes no calorie total');
  assert.equal(day.byMeal.supplements.calories, 0);
  assert.deepEqual(day.micros.supplements, { totals: { vit_d_mcg: 50, iron_mg: 36, zinc_mg: 30, b12_mcg: 12 }, withData: 1, entries: 1, est: { totals: {} }, groups: { labels: 1, estimated: 0, none: 0 } });
  assert.deepEqual(day.micros.food, { totals: {}, withData: 0, entries: 1, est: { totals: {} }, groups: { labels: 0, estimated: 0, none: 1 } }, 'food has one entry with no data: visible as such');
});

test('a gummy with calories counts them; a supplement typed in once (not saved) logs with its own numbers', async () => {
  const call = setup();
  const g = (await save(call, { name: 'Gummies', serving: '2 gummies', type: 'supplement', per: { calories: 15, protein_g: 0, carbs_g: 4, fat_g: 0 }, micros: { vit_c_mg: 60 } })).out.food;
  const a = await call('POST /api/nutrition/entries', { body: { date: DAY, meal: 'supplements', source: 'food', foodId: g.id, qty: 2 } });
  assert.deepEqual([a.out.entries[0].calories, a.out.entries[0].carbs_g], [30, 8]);
  assert.equal(a.out.day.totals.calories, 30);
  const typed = await call('POST /api/nutrition/entries', { body: { date: DAY, meal: 'supplements', source: 'supplement', name: 'Fish oil', serving: '1 softgel', qty: 2, calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0, micros: { vit_d_mcg: 10 } } });
  assert.equal(typed.status, 201, JSON.stringify(typed.out));
  assert.deepEqual([typed.out.entries[0].source, typed.out.entries[0].micros], ['supplement', { vit_d_mcg: 10 }]);
  assert.equal((await call('POST /api/nutrition/entries', { body: { date: DAY, meal: 'nope', source: 'quick', name: 'x', calories: 1, protein_g: 0, carbs_g: 0, fat_g: 0 } })).status, 400);
});

test('the usual stack: save a selection, log it with one request; deleted supplements drop out; only saved supplements; bounds; per profile', async () => {
  const call = setup();
  const m = (await save(call, MULTI)).out.food, g = (await save(call, MAG)).out.food;
  const food = (await save(call, { name: 'Oats', serving: '1', per: { calories: 100, protein_g: 1, carbs_g: 1, fat_g: 1 } })).out.food;
  assert.deepEqual((await call('GET /api/nutrition/stack')).out.items, []);
  const put = await call('PUT /api/nutrition/stack', { body: { items: [{ foodId: m.id, qty: 1 }, { foodId: g.id, qty: 2 }] } });
  assert.equal(put.status, 200); assert.deepEqual(put.out.items, [{ foodId: m.id, qty: 1 }, { foodId: g.id, qty: 2 }]);
  assert.deepEqual((await call('GET /api/nutrition/stack')).out.items.map(i => i.qty), [1, 2]);
  assert.deepEqual((await call('GET /api/nutrition/stack', { as: 'b' })).out.items, [], 'another profile has its own');
  for (const bad of [{ items: 'x' }, { items: [{ foodId: m.id, qty: 0 }] }, { items: [{ foodId: m.id, qty: 5000 }] }, { items: [{ foodId: m.id, qty: '2' }] }, { items: [{ foodId: m.id, qty: NaN }] },
    { items: [{ foodId: food.id, qty: 1 }] }, { items: [{ foodId: 'nope', qty: 1 }] }, { items: [{ foodId: m.id, qty: 1 }, { foodId: m.id, qty: 1 }] }, { items: Array.from({ length: 31 }, (_, i) => ({ foodId: 'x' + i, qty: 1 })) }, {}]) {
    assert.equal((await call('PUT /api/nutrition/stack', { body: bad })).status, 400, JSON.stringify(bad).slice(0, 80));
  }
  assert.equal((await call('GET /api/nutrition/stack')).out.items.length, 2, 'refused changes change nothing');
  // log it all with one POST
  const items = (await call('GET /api/nutrition/stack')).out.items;
  const log = await call('POST /api/nutrition/entries', { body: { date: DAY, meal: 'supplements', entries: items.map(i => ({ source: 'food', foodId: i.foodId, qty: i.qty })) } });
  assert.equal(log.status, 201);
  assert.deepEqual(log.out.entries.map(e => [e.name, e.qty]), [['Daily multi', 1], ['Magnesium glycinate', 2]]);
  assert.deepEqual(log.out.day.micros.supplements.totals, { vit_d_mcg: 25, iron_mg: 18, zinc_mg: 15, b12_mcg: 6, magnesium_mg: 400 });
  await call('DELETE /api/nutrition/foods', { url: `/api/nutrition/foods?id=${g.id}` });
  assert.deepEqual((await call('GET /api/nutrition/stack')).out.items.map(i => i.foodId), [m.id], 'a deleted supplement leaves the stack');
});

test('old data: a profile file with no stack, no types and no micros loads and answers everything', async () => {
  const call = setup();
  await store.mutate('spa', d => { d.days[DAY] = { entries: [{ id: 'o', meal: 'lunch', name: 'Old', calories: 100, protein_g: 1, carbs_g: 1, fat_g: 1, source: 'manual', qty: 1 }] }; });
  assert.deepEqual((await call('GET /api/nutrition/stack')).out.items, []);
  const day = (await call('GET /api/nutrition/day', { url: `/api/nutrition/day?date=${DAY}` })).out;
  assert.equal(day.entries.length, 1);
  assert.deepEqual(day.micros.supplements, { totals: {}, withData: 0, entries: 0, est: { totals: {} }, groups: { labels: 0, estimated: 0, none: 0 } });
  assert.equal(day.byMeal.supplements.calories, 0);
});
