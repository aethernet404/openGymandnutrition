/* Changing the amount of a diary entry: the server keeps the per-serving `base` the entry was made from, so
   later edits are base × amount, and validates all of it with the same bounds as everything else. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'entry-amount-'));
process.env.DATA_DIR = DIR;
fs.writeFileSync(path.join(DIR, 'secret'), 'f'.repeat(64), { mode: 0o600 });
const store = await import('../nutrition/store.js');
const { nutritionRoutes } = await import('../nutrition/routes.js');
const v = await import('../nutrition/validate.js');

const USER = { id: 'ena' };
const day = '2026-10-12';
function setup() {
  store.removeUser(USER.id);
  const R = nutritionRoutes({
    json: (res, code, obj) => { res.status = code; res.out = obj; },
    readBody: async q => q.body, readSession: q => q.user || null, requireAdmin: () => null, lookup: {}, analyzer: {},
    limitAddress: () => '10.0.0.9', userActive: () => true
  });
  return async (key, { body, url } = {}) => {
    const res = {};
    await R[key]({ method: key.split(' ')[0], url: url || key.split(' ')[1], user: USER, body, headers: {} }, res);
    return res;
  };
}
const put = (call, id, body) => call('PUT /api/nutrition/entries', { url: `/api/nutrition/entries?date=${day}&id=${id}`, body });

test('a food entry stores the food’s per-serving values as its base', async () => {
  const call = setup();
  const food = await call('POST /api/nutrition/foods', { body: { name: 'Cottage cheese', serving: '100 g', grams: 100, calories: 98.5, protein_g: 11.1, carbs_g: 3.4, fat_g: 4.3 } });
  const added = await call('POST /api/nutrition/entries', { body: { date: day, meal: 'lunch', source: 'food', foodId: food.out.food.id, qty: 0.5 } });
  assert.equal(added.status, 201, JSON.stringify(added.out));
  const e = added.out.entries[0];
  assert.deepEqual(e.base, { calories: 99, protein_g: 11.1, carbs_g: 3.4, fat_g: 4.3, grams: 100 });
  assert.deepEqual([e.qty, e.grams, e.calories], [0.5, 50, 50]);
});

test('an amount edit saves qty, grams, the totals and the base; repeated edits from the base do not drift', async () => {
  const call = setup();
  const base = { calories: 98.5, protein_g: 11.1, carbs_g: 3.4, fat_g: 4.3, grams: 100 };
  const id = (await call('POST /api/nutrition/entries', { body: { date: day, meal: 'lunch', name: 'Cheese', source: 'quick', calories: 49, protein_g: 5.6, carbs_g: 1.7, fat_g: 2.2 } })).out.entries[0].id;
  for (const [qty, calories] of [[3, 296], [0.07, 7], [1, 99]]) {
    const r = await put(call, id, { qty, grams: qty * 100, calories, base });
    assert.equal(r.status, 200, JSON.stringify(r.out));
    assert.deepEqual(r.out.entry.base, base, 'the base is stored exactly as it was sent');
    assert.equal(r.out.entry.qty, qty);
  }
  assert.equal(store.read(USER.id).days[day].entries[0].base.protein_g, 11.1);
});

test('an old entry (no qty, no base) can still be edited, and gets no base unless one is sent', async () => {
  const call = setup();
  const id = (await call('POST /api/nutrition/entries', { body: { date: day, meal: 'snack', name: 'Apple', source: 'manual', calories: 80, protein_g: 0, carbs_g: 20, fat_g: 0 } })).out.entries[0].id;
  const r = await put(call, id, { name: 'Apple', calories: 90, protein_g: 0, carbs_g: 22, fat_g: 0 });
  assert.equal(r.status, 200);
  assert.equal(r.out.entry.base, undefined);
  assert.equal(r.out.entry.calories, 90);
});

test('validation: the base and the amount keep the same bounds as everything else', async () => {
  const call = setup();
  const id = (await call('POST /api/nutrition/entries', { body: { date: day, meal: 'snack', name: 'X', source: 'quick', calories: 10, protein_g: 0, carbs_g: 0, fat_g: 0 } })).out.entries[0].id;
  const good = { calories: 10, protein_g: 1, carbs_g: 1, fat_g: 1, grams: null };
  for (const bad of [
    { base: 'x' }, { base: [] }, { base: { ...good, calories: -1 } }, { base: { ...good, calories: 1e9 } }, { base: { ...good, protein_g: '5' } },
    { base: { ...good, fat_g: NaN } }, { base: { calories: 1 } }, { base: { ...good, grams: 1e9 } },
    { qty: 0 }, { qty: 1001 }, { qty: 'two' }, { qty: -3 }, { grams: -1 }, { calories: 20001 }
  ]) {
    const r = await put(call, id, { calories: 10, ...bad });
    assert.equal(r.status, 400, JSON.stringify(bad));
  }
  assert.equal(store.read(USER.id).days[day].entries[0].calories, 10, 'a refused edit changes nothing');
  const ok = await put(call, id, { qty: 1000, base: { ...good, calories: 20 } });
  assert.equal(ok.status, 200);
  assert.deepEqual(v.entry({ base: null }, { partial: true }).value, { base: null });
});

test('editing amounts does not touch the per-day entry limit, and unknown keys inside base are dropped', async () => {
  const call = setup();
  const id = (await call('POST /api/nutrition/entries', { body: { date: day, meal: 'snack', name: 'X', source: 'quick', calories: 10, protein_g: 0, carbs_g: 0, fat_g: 0 } })).out.entries[0].id;
  const r = await put(call, id, { qty: 2, base: { calories: 5, protein_g: 0, carbs_g: 0, fat_g: 0, grams: null, evil: 'x' } });
  assert.deepEqual(Object.keys(r.out.entry.base).sort(), ['calories', 'carbs_g', 'fat_g', 'grams', 'protein_g']);
  assert.equal(store.read(USER.id).days[day].entries.length, 1);
});
