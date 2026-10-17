/* Saving an AI estimate (or any entry) as a reusable food: the saved food is an ordinary custom food with an
   `origin: 'ai'` mark. Logging it again is a plain food entry: no AI call, no allowance used. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'saved-foods-'));
process.env.DATA_DIR = DIR;
fs.writeFileSync(path.join(DIR, 'secret'), 'd'.repeat(64), { mode: 0o600 });
const store = await import('../nutrition/store.js');
const v = await import('../nutrition/validate.js');
const { nutritionRoutes } = await import('../nutrition/routes.js');

const USERS = { a: { id: 'sfa' }, b: { id: 'sfb' } };
const external = [
  { source: 'off', kind: 'off', ext: '1', name: 'Pliny the Elder', brand: 'Russian River', rank: 1180, bases: [{ label: '100 ml', grams: 100, per: { calories: 45, protein_g: 0.4, carbs_g: 3, fat_g: 0 } }] },
  { source: 'usda', kind: 'foundation', ext: '2', name: 'Beer, regular', brand: '', rank: 2100, bases: [{ label: '100 g', grams: 100, per: { calories: 43, protein_g: 0.5, carbs_g: 3.6, fat_g: 0 } }] }
];
function setup() {
  for (const u of Object.values(USERS)) store.removeUser(u.id);
  const calls = { search: 0, analyze: 0 };
  const lookup = { search: async () => { calls.search++; return { results: external, sources: { off: { ok: true, count: 1 }, usda: { ok: true, count: 1 } } }; } };
  const analyzer = { analyze: async () => { calls.analyze++; throw new Error('the AI must not be called'); } };
  const R = nutritionRoutes({
    json: (res, code, obj) => { res.status = code; res.out = obj; }, readBody: async q => q.body, readSession: q => q.user || null,
    requireAdmin: () => null, lookup, analyzer, limitAddress: () => '10.0.0.1', userActive: () => true
  });
  const call = async (key, { as = 'a', body, url } = {}) => { const res = {}; await R[key]({ method: key.split(' ')[0], url: url || key.split(' ')[1], user: as ? USERS[as] : null, body, headers: {} }, res); return res; };
  return { call, calls };
}
const PLINY = { name: 'Pliny the Elder, 12 oz can', brand: 'Russian River', serving: '1 can (12 oz)', grams: 355, calories: 210, protein_g: 2, carbs_g: 13, fat_g: 0, origin: 'ai' };
const post = (call, body, as) => call('POST /api/nutrition/foods', { as, body });

test('an AI-estimate food is saved as a custom food with its origin, and is fully editable like any other', async () => {
  const { call } = setup();
  const r = await post(call, PLINY);
  assert.equal(r.status, 201, JSON.stringify(r.out));
  const f = r.out.food;
  assert.deepEqual([f.source, f.origin, f.name, f.brand, f.serving, f.per], ['custom', 'ai', 'Pliny the Elder, 12 oz can', 'Russian River', { label: '1 can (12 oz)', grams: 355 }, { calories: 210, protein_g: 2, carbs_g: 13, fat_g: 0 }]);
  const edit = await call('PUT /api/nutrition/foods', { url: `/api/nutrition/foods?id=${f.id}`, body: { name: 'Pliny the Elder (can)', calories: 215, protein_g: 2, carbs_g: 13, fat_g: 0, serving: '1 can', grams: 355 } });
  assert.equal(edit.status, 200, JSON.stringify(edit.out));
  assert.deepEqual([edit.out.food.name, edit.out.food.per.calories, edit.out.food.serving.label, edit.out.food.origin], ['Pliny the Elder (can)', 215, '1 can', 'ai'], 'edited, and still marked as an AI estimate');
  const list = (await call('GET /api/nutrition/foods', { url: '/api/nutrition/foods?scope=custom' })).out.foods;
  assert.equal(list[0].origin, 'ai');
});

test('validation: origin is "ai" or nothing; numbers keep the usual bounds; the photo has nowhere to go', async () => {
  const { call } = setup();
  for (const bad of [{ origin: 'photo' }, { origin: 5 }, { calories: -1 }, { calories: 1e9 }, { name: '' }, { protein_g: '3' }]) assert.equal((await post(call, { ...PLINY, ...bad })).status, 400, JSON.stringify(bad));
  const ok = await post(call, { ...PLINY, image: 'data:image/jpeg;base64,AAAA', photo: 'x'.repeat(1000), note: 'y' });
  assert.equal(ok.status, 201);
  const stored = JSON.stringify(store.read('sfa'));
  assert.ok(!stored.includes('base64') && !stored.includes('xxxxxxxx'), 'only the confirmed name and numbers are stored');
  assert.deepEqual(Object.keys(ok.out.food).sort(), ['brand', 'createdAt', 'ext', 'favorite', 'id', 'lastUsed', 'name', 'origin', 'per', 'serving', 'source', 'useCount']);
});

test('duplicates: same name and brand (any case, extra spaces) is not doubled without asking; update changes the saved food; new saves another', async () => {
  const { call } = setup();
  const first = (await post(call, PLINY)).out.food;
  await call('PUT /api/nutrition/foods', { url: `/api/nutrition/foods?id=${first.id}`, body: { favorite: true } });
  const dup = await post(call, { ...PLINY, name: '  pliny THE elder, 12 OZ can ', brand: 'russian river', calories: 230, checkDuplicate: true });
  assert.equal(dup.status, 409);
  assert.equal(dup.out.code, 'duplicate');
  assert.equal(dup.out.existing.id, first.id);
  assert.equal(Object.keys(store.read('sfa').foods).length, 1, 'nothing was saved while it was being asked');
  const upd = await post(call, { ...PLINY, serving: '1 pint', grams: 473, calories: 280, checkDuplicate: true, onDuplicate: 'update' });
  assert.equal(upd.status, 200);
  assert.deepEqual([upd.out.food.id, upd.out.food.serving.label, upd.out.food.per.calories, upd.out.food.favorite, upd.out.updated], [first.id, '1 pint', 280, true, true]);
  assert.equal(Object.keys(store.read('sfa').foods).length, 1);
  const another = await post(call, { ...PLINY, checkDuplicate: true, onDuplicate: 'new' });
  assert.equal(another.status, 201);
  assert.notEqual(another.out.food.id, first.id);
  assert.equal(Object.keys(store.read('sfa').foods).length, 2);
  // A different brand, or no check requested (the old behaviour of the New food form), is not a duplicate.
  assert.equal((await post(call, { ...PLINY, brand: 'Other', checkDuplicate: true })).status, 201);
  assert.equal((await post(call, PLINY)).status, 201);
  // Another profile's foods are never compared.
  assert.equal((await post(call, { ...PLINY, checkDuplicate: true }, 'b')).status, 201);
});

test('logging a saved food again is a plain food entry: priced from its numbers, no AI call, no allowance used', async () => {
  const { call, calls } = setup();
  const f = (await post(call, PLINY)).out.food;
  const before = store.aiUsed(store.read('sfa'));
  const add = await call('POST /api/nutrition/entries', { body: { date: '2026-10-12', meal: 'snack', source: 'food', foodId: f.id, qty: 2 } });
  assert.equal(add.status, 201, JSON.stringify(add.out));
  const e = add.out.entries[0];
  assert.deepEqual([e.name, e.serving, e.qty, e.calories, e.protein_g, e.carbs_g, e.source], ['Pliny the Elder, 12 oz can', '1 can (12 oz)', 2, 420, 4, 26, 'food']);
  assert.equal(e.base.calories, 210);
  assert.equal(calls.analyze, 0);
  assert.equal(store.aiUsed(store.read('sfa')), before, 'no AI allowance was used');
  const used = store.read('sfa').foods[f.id];
  assert.equal(used.useCount, 1); assert.ok(used.lastUsed);
  assert.equal((await call('GET /api/nutrition/foods', { url: '/api/nutrition/foods?scope=recent' })).out.foods[0].id, f.id);
});

test('search: saved foods come first, labelled by source "mine"; every typed word must match; only your own; instant and not rate-limited', async () => {
  const { call, calls } = setup();
  const f = (await post(call, PLINY)).out.food;
  await post(call, { name: 'House salad', serving: '1 bowl', calories: 120, protein_g: 3, carbs_g: 10, fat_g: 7 });
  await post(call, { name: 'Pliny the Elder', brand: 'Other Taproom', serving: '1 pint', calories: 260, protein_g: 2, carbs_g: 16, fat_g: 0, origin: 'ai' }, 'b');
  const all = (await call('GET /api/nutrition/search', { url: '/api/nutrition/search?q=pliny+elder' })).out;
  assert.deepEqual(all.results.map(h => h.source), ['mine', 'off', 'usda'], 'saved first, then the outside sources');
  assert.equal(all.results[0].ext, f.id);
  assert.equal(all.results[0].origin, 'ai');
  assert.deepEqual(all.results[0].bases, [{ label: '1 can (12 oz)', grams: 355, per: { calories: 210, protein_g: 2, carbs_g: 13, fat_g: 0 } }]);
  assert.deepEqual(all.sources.mine, { ok: true, count: 1 });
  assert.ok(all.results[0].rank > Math.max(...external.map(h => h.rank)), 'above even the reference foods');
  // A word that is not in the name or brand: not shown.
  assert.deepEqual((await call('GET /api/nutrition/search', { url: '/api/nutrition/search?q=pliny+stout&source=mine' })).out.results, []);
  // Brand words count too; a saved food that does not match is not shown.
  assert.equal((await call('GET /api/nutrition/search', { url: '/api/nutrition/search?q=russian+river&source=mine' })).out.results.length, 1);
  assert.equal((await call('GET /api/nutrition/search', { url: '/api/nutrition/search?q=salad&source=mine' })).out.results[0].name, 'House salad');
  // source=mine never leaves the server and is not counted as an outside lookup: well past 40 a minute.
  const before = calls.search;
  for (let i = 0; i < 60; i++) assert.equal((await call('GET /api/nutrition/search', { url: '/api/nutrition/search?q=pliny&source=mine' })).status, 200);
  assert.equal(calls.search, before);
  assert.equal((await call('GET /api/nutrition/search', { url: '/api/nutrition/search?q=pliny&source=nope' })).status, 400);
});

test('search: a favourite or well-used saved food edges an equal match; closer names lead', async () => {
  const { call } = setup();
  const a = (await post(call, { name: 'Pale ale', serving: '1 can', calories: 150, protein_g: 1, carbs_g: 12, fat_g: 0 })).out.food;
  const b = (await post(call, { name: 'Pale ale', brand: 'Local', serving: '1 pint', calories: 180, protein_g: 1, carbs_g: 14, fat_g: 0 })).out.food;
  await post(call, { name: 'Pale ale with lime and extra hops', serving: '1 can', calories: 160, protein_g: 1, carbs_g: 13, fat_g: 0 });
  await call('PUT /api/nutrition/foods', { url: `/api/nutrition/foods?id=${b.id}`, body: { favorite: true } });
  const hits = (await call('GET /api/nutrition/search', { url: '/api/nutrition/search?q=pale+ale&source=mine' })).out.results;
  assert.deepEqual(hits.map(h => h.ext).slice(0, 2), [b.id, a.id]);
  assert.equal(hits.at(-1).name, 'Pale ale with lime and extra hops');
});

test('old data: foods saved before this (no origin, no grams, odd serving) load, list, search, log and edit without errors', async () => {
  const { call } = setup();
  await store.mutate('sfa', d => { d.foods.old1 = { id: 'old1', source: 'custom', ext: null, name: 'Granola bar', brand: '', serving: { label: '1 bar', grams: null }, per: { calories: 190, protein_g: 4, carbs_g: 29, fat_g: 7 }, favorite: false, useCount: 0, lastUsed: null, createdAt: 1 }; d.foods.old2 = { id: 'old2', source: 'custom', name: 'Weird', per: { calories: 5, protein_g: 0, carbs_g: 0, fat_g: 0 } }; });
  const list = (await call('GET /api/nutrition/foods', { url: '/api/nutrition/foods?scope=all' })).out.foods;
  assert.ok(list.some(f => f.id === 'old1' && f.origin === undefined));
  const hit = (await call('GET /api/nutrition/search', { url: '/api/nutrition/search?q=granola&source=mine' })).out.results[0];
  assert.deepEqual([hit.origin, hit.kind, hit.bases[0].label], [null, 'mine', '1 bar']);
  const weird = (await call('GET /api/nutrition/search', { url: '/api/nutrition/search?q=weird&source=mine' })).out.results[0];
  assert.equal(weird.bases[0].label, '1 serving');
  const add = await call('POST /api/nutrition/entries', { body: { date: '2026-10-12', meal: 'snack', source: 'food', foodId: 'old1', qty: 1.5 } });
  assert.equal(add.out.entries[0].calories, 285);
  assert.equal((await call('PUT /api/nutrition/foods', { url: '/api/nutrition/foods?id=old1', body: { calories: 200, protein_g: 4, carbs_g: 29, fat_g: 7 } })).status, 200);
});

test('v.food: the origin field alone', () => {
  assert.deepEqual(v.food({ ...PLINY }).value.origin, 'ai');
  assert.equal(v.food({ ...PLINY, origin: undefined }).value.origin, undefined);
  assert.equal(v.food({ origin: null }, { partial: true }).value.origin, null);
  assert.equal(v.food({ origin: 'x' }, { partial: true }).ok, false);
});
