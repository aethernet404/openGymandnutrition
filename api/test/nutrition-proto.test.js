/* Ids and keys that arrive in a request are never allowed to reach Object.prototype: a crafted id is refused, and
   nothing is left on Object.prototype afterwards. (An earlier version let foodId "__proto__" set favorite, useCount and
   lastUsed on every object in the process.) */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { tempData } from './helpers.mjs';

tempData();
const { nutritionRoutes } = await import('../nutrition/routes.js');
const v = await import('../nutrition/validate.js');
const M = await import('../nutrition/micros.js');
const { parseHae } = await import('../nutrition/hae.js');
const { normaliseUsda } = await import('../nutrition/lookup.js');
const store = await import('../nutrition/store.js');

const BEFORE = Object.getOwnPropertyNames(Object.prototype).sort();
const clean = () => {
  assert.deepEqual(Object.getOwnPropertyNames(Object.prototype).sort(), BEFORE, 'Object.prototype gained a property');
  for (const k of ['favorite', 'useCount', 'lastUsed', 'type', 'name', 'per', 'micros', 'qty']) assert.equal(({})[k], undefined, k);
};
const routes = nutritionRoutes({
  json: (res, code, obj) => { res.status = code; res.out = obj; }, readBody: async q => q.body ?? {}, readSession: q => ({ id: 'pp1' }),
  requireAdmin: () => null, lookup: {}, analyzer: {}
});
const call = async (key, { body, url } = {}) => { const res = {}; await routes[key]({ method: key.split(' ')[0], url: url || key.split(' ')[1], headers: {}, body }, res); return res; };
const CRAFTED = ['__proto__', 'constructor', 'prototype', '__PROTO__', 'Constructor', '__proto__ ', 'a/b', '', 'x'.repeat(41)];
const DATE = '2026-10-12';
const ENTRY = { name: 'x', meal: 'snack', calories: 10, protein_g: 1, carbs_g: 1, fat_g: 1 };

beforeEach(() => store.removeUser('pp1'));

test('the id check: strict pattern, the three reserved names refused in any case, own-property lookups only', () => {
  for (const ok of ['abcDEF123_-x', 'A', 'x'.repeat(40)]) assert.equal(v.validId(ok), true, ok);
  for (const bad of CRAFTED.concat([null, undefined, 5, {}, ['a']])) assert.equal(v.validId(bad), false, String(bad));
  assert.equal(v.own({}, '__proto__'), undefined);
  assert.equal(v.own({}, 'constructor'), undefined);
  assert.equal(v.own({ a: 1 }, 'a'), 1);
  assert.equal(v.own(null, 'a'), undefined);
});

test('POST /entries: a crafted foodId is refused, with or without macros', async () => {
  for (const id of CRAFTED.filter(Boolean)) {
    for (const extra of [{}, { calories: undefined, protein_g: undefined, carbs_g: undefined, fat_g: undefined }]) {
      const r = await call('POST /api/nutrition/entries', { body: { date: DATE, entries: [{ ...ENTRY, ...extra, foodId: id }] } });
      assert.equal(r.status, 400, id + ' ' + JSON.stringify(r.out));
    }
  }
  assert.equal(Object.keys(store.read('pp1').days).length, 0, 'nothing was written');
  clean();
});

test('PUT /entries and DELETE /entries: a crafted id (query) or foodId (body) is refused', async () => {
  const made = (await call('POST /api/nutrition/entries', { body: { date: DATE, entries: [ENTRY] } })).out.entries[0];
  for (const id of CRAFTED) {
    assert.equal((await call('PUT /api/nutrition/entries', { url: `/api/nutrition/entries?date=${DATE}&id=${encodeURIComponent(id)}`, body: { name: 'y' } })).status, 400, 'PUT ' + id);
    assert.equal((await call('DELETE /api/nutrition/entries', { url: `/api/nutrition/entries?date=${DATE}&id=${encodeURIComponent(id)}` })).status, 400, 'DELETE ' + id);
  }
  for (const id of CRAFTED.filter(Boolean)) assert.equal((await call('PUT /api/nutrition/entries', { url: `/api/nutrition/entries?date=${DATE}&id=${made.id}`, body: { foodId: id } })).status, 400, 'body ' + id);
  assert.equal((await call('PUT /api/nutrition/entries', { url: `/api/nutrition/entries?date=${DATE}&id=${made.id}`, body: { name: 'y' } })).status, 200, 'a real id still works');
  clean();
});

test('PUT /foods and DELETE /foods: a crafted id is refused and ({}).favorite stays undefined', async () => {
  for (const id of CRAFTED) {
    const put = await call('PUT /api/nutrition/foods', { url: `/api/nutrition/foods?id=${encodeURIComponent(id)}`, body: { favorite: true, name: 'Polluted' } });
    assert.equal(put.status, 400, 'PUT ' + id);
    assert.equal((await call('DELETE /api/nutrition/foods', { url: `/api/nutrition/foods?id=${encodeURIComponent(id)}` })).status, 400, 'DELETE ' + id);
    clean();
  }
  // A well-formed id that does not exist is a plain 404, and the same for a name that merely looks inherited.
  assert.equal((await call('PUT /api/nutrition/foods', { url: '/api/nutrition/foods?id=toString', body: { favorite: true } })).status, 404);
  assert.equal((await call('PUT /api/nutrition/foods', { url: '/api/nutrition/foods?id=hasOwnProperty', body: { favorite: true } })).status, 404);
  clean();
});

test('PUT /stack: crafted foodIds are refused', async () => {
  for (const id of CRAFTED) assert.equal((await call('PUT /api/nutrition/stack', { body: { items: [{ foodId: id, qty: 1 }] } })).status, 400, id);
  clean();
});

test('micros routes: crafted ids are refused before anything is looked up', async () => {
  for (const id of CRAFTED.filter(Boolean)) {
    assert.equal((await call('POST /api/nutrition/micros/match', { body: { date: DATE, ids: [id] } })).status, 400, 'match ' + id);
    assert.equal((await call('POST /api/nutrition/micros/preview', { body: { date: DATE, id, fdcId: 1 } })).status, 400, 'preview ' + id);
    assert.equal((await call('POST /api/nutrition/micros/apply', { body: { date: DATE, id, fdcId: 1 } })).status, 400, 'apply ' + id);
    assert.equal((await call('POST /api/nutrition/micros/apply', { body: { date: DATE, id, remove: true } })).status, 400, 'remove ' + id);
  }
  assert.equal((await call('POST /api/nutrition/micros/match', { body: { date: DATE, ids: ['ok', 123] } })).status, 400);
  clean();
});

test('nutrient keys: "constructor" and "__proto__" are unknown nutrients, not Object', () => {
  assert.equal(M.BY_KEY.constructor, undefined);
  assert.equal(M.BY_KEY.__proto__, undefined);
  for (const k of ['constructor', 'toString', 'hasOwnProperty']) assert.equal(M.microsOf({ [k]: 5 }).ok, false, k);
  assert.equal(M.microsOf(JSON.parse('{"__proto__": 5}')).ok, false);
  assert.deepEqual(M.microsFrom(JSON.parse('{"__proto__": 5, "constructor": 6, "iron_mg": 1}')), { iron_mg: 1 });
  clean();
});

test('data from outside: a Health Auto Export metric named "constructor" and a USDA data type of "constructor" are just unknown', () => {
  const r = parseHae({ data: { metrics: [{ name: 'constructor', units: 'x', data: [{ date: '2026-10-12 08:00:00 +0000', qty: 5 }] }, { name: '__proto__', data: [] }, { name: 'toString', data: [] }] } });
  assert.equal(r.ok, false);
  const hit = normaliseUsda({ fdcId: 1, description: 'Thing', dataType: 'constructor', foodNutrients: [{ nutrientId: 1008, value: 100 }] });
  assert.equal(hit.kind, 'other');
  clean();
});
