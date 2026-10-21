/* Micronutrients: validation, unit conversions, reading each source, and the rule that unknown is never zero. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'micros-test-'));
process.env.DATA_DIR = DIR;
fs.writeFileSync(path.join(DIR, 'secret'), 'e'.repeat(64), { mode: 0o600 });
const M = await import('../nutrition/micros.js');
const S = await import('../nutrition/micros-sources.js');
const { normaliseOff, normaliseUsda } = await import('../nutrition/lookup.js');
const { normaliseFood } = await import('../nutrition/fatsecret.js');
const store = await import('../nutrition/store.js');
const { nutritionRoutes } = await import('../nutrition/routes.js');

/* ------------------------------ validation ------------------------------ */

test('microsOf: known nutrients with sensible numbers; null is unknown; 0 is a real 0; empty is fine', () => {
  assert.deepEqual(M.microsOf({ iron_mg: 0, vit_d_mcg: 2.5, calcium_mg: null, zinc_mg: undefined }).value, { iron_mg: 0, vit_d_mcg: 2.5 });
  assert.deepEqual(M.microsOf(undefined).value, {});
  assert.deepEqual(M.microsOf({}).value, {});
});

test('microsOf: strings, NaN, Infinity, negatives, absurd values, unknown keys, arrays are refused in words', () => {
  for (const [bad, re] of [
    [{ iron_mg: '5' }, /Iron must be a number/], [{ iron_mg: NaN }, /number/], [{ iron_mg: Infinity }, /number/], [{ iron_mg: -1 }, /cannot be negative/],
    [{ iron_mg: 1e9 }, /not plausible/], [{ vit_d_mcg: 1e6 }, /check the unit/], [{ ironn_mg: 1 }, /unknown nutrient "ironn_mg"/], [[1], /must be an object/], ['x', /must be an object/],
    [{ sodium_mg: {} }, /number/], [{ fiber_g: true }, /number/]
  ]) { const r = M.microsOf(bad); assert.equal(r.ok, false, JSON.stringify(bad)); assert.match(r.error, re); }
});

test('the table: 29 nutrients, canonical units in the key suffix, Daily Values and upper limits where they exist', () => {
  assert.equal(M.NUTRIENTS.length, 29);
  for (const n of M.NUTRIENTS) { assert.ok(n.key.endsWith('_' + n.unit), n.key); assert.ok(['vitamins', 'minerals', 'other'].includes(n.group)); assert.ok(n.max > 0); if (n.dv != null) assert.ok(n.dv > 0); }
  assert.equal(M.BY_KEY.sugar_g.dv, null, 'total sugars have no Daily Value');
  assert.deepEqual([M.BY_KEY.vit_d_mcg.dv, M.BY_KEY.calcium_mg.dv, M.BY_KEY.iron_mg.dv, M.BY_KEY.potassium_mg.dv, M.BY_KEY.sodium_mg.dv, M.BY_KEY.vit_k_mcg.dv, M.BY_KEY.choline_mg.dv], [20, 1300, 18, 4700, 2300, 120, 550]);
  assert.deepEqual([M.BY_KEY.vit_d_mcg.ul.value, M.BY_KEY.zinc_mg.ul.value, M.BY_KEY.iron_mg.ul.value, M.BY_KEY.magnesium_mg.ul, M.BY_KEY.b6_mg.ul.value], [100, 40, 45, { value: 350, scope: 'supplement', what: 'magnesium from supplements' }, 100]);
  assert.equal(M.BY_KEY.vit_k_mcg.ul, undefined, 'no upper limit is established for vitamin K');
});

/* ------------------------------ arithmetic: missing is not zero ------------------------------ */

test('scaleMicros keeps only what is known; sumMicros never turns unknown into 0 and counts entries with data', () => {
  assert.deepEqual(M.scaleMicros({ iron_mg: 2, vit_d_mcg: 1.25 }, 1.5), { iron_mg: 3, vit_d_mcg: 1.875 });
  assert.equal(M.scaleMicros({}, 2), undefined);
  assert.equal(M.scaleMicros(undefined, 2), undefined);
  assert.equal(M.scaleMicros({ iron_mg: 1 }, -1), undefined);
  const s = M.sumMicros([{ micros: { iron_mg: 2, zinc_mg: 0 } }, { name: 'quick add, no data' }, { micros: { iron_mg: 1 } }, { micros: {} }]);
  assert.deepEqual(s, { totals: { iron_mg: 3, zinc_mg: 0 }, withData: 2, entries: 4, est: { totals: {} }, groups: { labels: 2, estimated: 0, none: 2 } });
  assert.ok(!('calcium_mg' in s.totals), 'nobody knows calcium: absent, not 0');
  assert.deepEqual(M.sumMicros([]), { totals: {}, withData: 0, entries: 0, est: { totals: {} }, groups: { labels: 0, estimated: 0, none: 0 } });
});

/* ------------------------------ conversions ------------------------------ */

test('conversions: grams to mg and mcg, vitamin D IU, vitamin A IU, vitamin E IU, salt to sodium', () => {
  assert.equal(M.convert.gToMg(0.12), 120);
  assert.equal(M.convert.gToMcg(0.0000025), 2.5);
  assert.equal(M.convert.vitDIuToMcg(800), 20);
  assert.equal(M.convert.vitAIuToMcgRae(3000), 900);
  assert.equal(Math.round(M.convert.vitEIuToMg(22.4) * 100) / 100, 15.01);
  assert.equal(M.convert.saltGToSodiumMg(2.5), 1000);
});

/* ------------------------------ Open Food Facts ------------------------------ */

const OFF_PRODUCT = { code: '1', product_name: 'Fortified cereal', brands: 'Acme', serving_size: '40 g', serving_quantity: 40,
  nutriments: { 'energy-kcal_100g': 380, proteins_100g: 8, carbohydrates_100g: 80, fat_100g: 2,
    fiber_100g: 6, sugars_100g: 22, salt_100g: 1.25, 'saturated-fat_100g': 0.5, calcium_100g: 0.8, iron_100g: 0.0135, 'vitamin-d_100g': 0.0000075, 'vitamin-b12_100g': '0.0000025', zinc_100g: 0, 'vitamin-a_100g': -1, potassium_100g: 'x' } };

test('Open Food Facts: grams per 100 g become mg / mcg; salt stands in for sodium; zero is kept; negatives, text and missing are unknown', () => {
  const m = S.microsFromOff(OFF_PRODUCT.nutriments);
  assert.deepEqual(m, { fiber_g: 6, sugar_g: 22, sodium_mg: 500, satfat_g: 0.5, calcium_mg: 800, iron_mg: 13.5, vit_d_mcg: 7.5, b12_mcg: 2.5, zinc_mg: 0 });
  assert.ok(!('vit_a_mcg' in m) && !('potassium_mg' in m), 'a negative or unreadable value is unknown, not 0');
  assert.deepEqual(S.microsFromOff({ 'energy-kcal_100g': 100 }), {});
  assert.deepEqual(S.microsFromOff(null), {});
  // sodium wins over salt when both are given
  assert.equal(S.microsFromOff({ sodium_100g: 0.2, salt_100g: 9 }).sodium_mg, 200);
});

test('Open Food Facts bases carry micros per serving (scaled from per 100 g like the macros) and per 100 g; none given → no micros key at all', () => {
  const hit = normaliseOff(OFF_PRODUCT);
  assert.deepEqual(hit.bases.map(b => b.label), ['40 g', '100 g']);
  assert.deepEqual([hit.bases[0].micros.calcium_mg, hit.bases[0].micros.vit_d_mcg, hit.bases[0].micros.zinc_mg], [320, 3, 0]);
  assert.equal(hit.bases[1].micros.calcium_mg, 800);
  const plain = normaliseOff({ code: '2', product_name: 'Plain', nutriments: { 'energy-kcal_100g': 100 } });
  assert.ok(plain.bases.every(b => !('micros' in b)));
});

/* ------------------------------ USDA ------------------------------ */

const row = (id, value, unitName) => ({ nutrientId: id, value, unitName });
const SR_APPLE = [row(1008, 52, 'KCAL'), row(1079, 2.4, 'G'), row(2000, 10.4, 'G'), row(1093, 1, 'MG'), row(1092, 107, 'MG'), row(1087, 6, 'MG'), row(1089, 0.12, 'MG'),
  row(1103, 0, 'UG'), row(1106, 3, 'UG'), row(1162, 4.6, 'MG'), row(1185, 2.2, 'UG'), row(1190, 3, 'UG'), row(1253, 0, 'MG'), row(1258, 0.05, 'G')];

test('USDA: nutrient ids become our keys; units are converted from the unit USDA states; IU only fills in vitamin A and D when RAE / mcg are absent; a zero is kept', () => {
  const m = S.microsFromUsda(SR_APPLE);
  assert.deepEqual(m, { fiber_g: 2.4, sugar_g: 10.4, sodium_mg: 1, potassium_mg: 107, calcium_mg: 6, iron_mg: 0.12, selenium_mcg: 0, vit_a_mcg: 3, vit_c_mg: 4.6, vit_k_mcg: 2.2, folate_mcg: 3, cholesterol_mg: 0, satfat_g: 0.05 });
  const iu = S.microsFromUsda([row(1104, 3000, 'IU'), row(1110, 800, 'IU')]);
  assert.deepEqual(iu, { vit_a_mcg: 900, vit_d_mcg: 20 });
  const both = S.microsFromUsda([row(1104, 3000, 'IU'), row(1106, 100, 'UG')]);
  assert.equal(both.vit_a_mcg, 100, 'RAE wins over IU');
  // a different unit than the usual one is converted, not misread
  assert.equal(S.microsFromUsda([row(1087, 0.2, 'G')]).calcium_mg, 200);
  assert.equal(S.microsFromUsda([row(1103, 0.055, 'MG')]).selenium_mcg, 55);
  // the nested format of a food detail answer
  assert.equal(S.microsFromUsda([{ nutrient: { id: 1089, unitName: 'mg' }, amount: 2 }]).iron_mg, 2);
});

test('USDA: a Branded food with a thin label has only what is on it; nothing else is made up; folate falls back to total when DFE is absent', () => {
  const thin = S.microsFromUsda([row(1008, 150, 'KCAL'), row(1093, 230, 'MG'), row(2000, 12, 'G'), row(1087, 130, 'MG'), row(1089, 1.8, 'MG')]);
  assert.deepEqual(thin, { sodium_mg: 230, sugar_g: 12, calcium_mg: 130, iron_mg: 1.8 });
  assert.equal(S.microsFromUsda([row(1177, 50, 'UG')]).folate_mcg, 50);
  assert.deepEqual(S.microsFromUsda(undefined), {});
  assert.deepEqual(S.microsFromUsda([row(1087, 'abc', 'MG'), row(1089, -3, 'MG')]), {});
});

test('USDA bases carry micros per 100 g and per label serving', () => {
  const hit = normaliseUsda({ fdcId: 1, description: 'Cereal', dataType: 'Branded', servingSize: 40, servingSizeUnit: 'g', householdServingFullText: '1 cup', foodNutrients: [row(1008, 380, 'KCAL'), row(1003, 8, 'G'), row(1004, 2, 'G'), row(1005, 80, 'G'), row(1087, 800, 'MG'), row(1093, 500, 'MG')] });
  assert.deepEqual(hit.bases.map(b => [b.label, b.micros.calcium_mg, b.micros.sodium_mg]), [['1 cup (40 g)', 320, 200], ['100 g', 800, 500]]);
});

/* ------------------------------ FatSecret ------------------------------ */

test('FatSecret: plain-unit fields are read; vitamin A/C/D, calcium and iron are amounts; a Brand food’s 0 for those five is unknown, a Generic food’s 0 is real', () => {
  const serving = { serving_id: '1', serving_description: '1 taquito', metric_serving_amount: '76', metric_serving_unit: 'g', calories: '190', carbohydrate: '20', protein: '7', fat: '9',
    fiber: '1', sugar: '2', saturated_fat: '3.5', sodium: '420', cholesterol: '15', potassium: '110', vitamin_a: '10', vitamin_c: '2', vitamin_d: '0', calcium: '0', iron: '0' };
  const plain = { fiber_g: 1, sugar_g: 2, satfat_g: 3.5, sodium_mg: 420, cholesterol_mg: 15, potassium_mg: 110 };
  assert.deepEqual(S.microsFromFatSecret(serving, { brand: true }), { ...plain, vit_a_mcg: 10, vit_c_mg: 2 });
  assert.deepEqual(S.microsFromFatSecret(serving, { brand: false }), { ...plain, vit_a_mcg: 10, vit_c_mg: 2, vit_d_mcg: 0, calcium_mg: 0, iron_mg: 0 });
  assert.deepEqual(S.microsFromFatSecret({ calories: '100', calcium: '8' }, { brand: true }), { calcium_mg: 8 });
  assert.deepEqual(S.microsFromFatSecret({ calories: '100', calcium: '0' }, { brand: true }), {});
  const hit = normaliseFood({ food_id: '9', food_name: 'Taquito', food_type: 'Brand', brand_name: '7-Eleven', servings: { serving: serving } });
  assert.equal(hit.bases[0].micros.sodium_mg, 420);
  assert.ok(!('iron_mg' in hit.bases[0].micros));
  const bare = normaliseFood({ food_id: '9', food_name: 'Taquito', servings: { serving: { serving_id: '1', serving_description: '1', metric_serving_amount: '50', metric_serving_unit: 'g', calories: '100', carbohydrate: '1', protein: '1', fat: '1' } } });
  assert.ok(!('micros' in bare.bases[0]));
});

/* ------------------------------ through the routes ------------------------------ */

const USER = { id: 'mca' };
function setup() {
  store.removeUser(USER.id);
  const R = nutritionRoutes({ json: (res, code, obj) => { res.status = code; res.out = obj; }, readBody: async q => q.body, readSession: q => q.user || null, requireAdmin: () => null, lookup: {}, analyzer: {}, limitAddress: () => '10.0.0.1', userActive: () => true });
  return async (key, { body, url } = {}) => { const res = {}; await R[key]({ method: key.split(' ')[0], url: url || key.split(' ')[1], user: USER, body, headers: {} }, res); return res; };
}
const DAY = '2026-10-12';
const snapshot = (over = {}) => ({ name: 'Fortified cereal', brand: 'Acme', source: 'off', ext: '1', serving: '40 g', grams: 40, per: { calories: 152, protein_g: 3.2, carbs_g: 32, fat_g: 0.8 }, micros: { calcium_mg: 320, vit_d_mcg: 3, zinc_mg: 0 }, ...over });

test('logging a looked-up food copies its micros onto the entry, scaled by the amount; the entry keeps them if the food changes later', async () => {
  const call = setup();
  const add = await call('POST /api/nutrition/entries', { body: { date: DAY, meal: 'breakfast', source: 'food', qty: 1.5, food: snapshot() } });
  assert.equal(add.status, 201, JSON.stringify(add.out));
  const e = add.out.entries[0];
  assert.deepEqual(e.micros, { calcium_mg: 480, vit_d_mcg: 4.5, zinc_mg: 0 });
  assert.deepEqual(e.base.micros, { calcium_mg: 320, vit_d_mcg: 3, zinc_mg: 0 });
  assert.ok(!('iron_mg' in e.micros), 'unknown iron is absent, not 0');
  // the food is edited later: the old entry does not move
  const food = Object.values(store.read('mca').foods)[0];
  await call('PUT /api/nutrition/foods', { url: `/api/nutrition/foods?id=${food.id}`, body: { micros: { calcium_mg: 1 } } });
  assert.equal(store.read('mca').days[DAY].entries[0].micros.calcium_mg, 480);
});

test('a saved (custom) food with micros: logged by id, scaled; a food without any adds no micros key; clearing them removes the key', async () => {
  const call = setup();
  const withM = (await call('POST /api/nutrition/foods', { body: { name: 'Multi', serving: '1 tablet', per: { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 }, micros: { iron_mg: 18, vit_c_mg: 90, b12_mcg: null } } })).out.food;
  assert.deepEqual(withM.micros, { iron_mg: 18, vit_c_mg: 90 });
  const plain = (await call('POST /api/nutrition/foods', { body: { name: 'Plain', serving: '1', per: { calories: 100, protein_g: 1, carbs_g: 1, fat_g: 1 }, micros: {} } })).out.food;
  assert.ok(!('micros' in plain), 'an empty micros object is stored as nothing');
  const log = await call('POST /api/nutrition/entries', { body: { date: DAY, meal: 'snack', entries: [{ source: 'food', foodId: withM.id, qty: 2 }, { source: 'food', foodId: plain.id, qty: 1 }] } });
  const [a, b] = log.out.entries;
  assert.deepEqual(a.micros, { iron_mg: 36, vit_c_mg: 180 });
  assert.ok(!('micros' in b));
  const cleared = await call('PUT /api/nutrition/foods', { url: `/api/nutrition/foods?id=${withM.id}`, body: { micros: {} } });
  assert.ok(!('micros' in cleared.out.food));
});

test('Quick add and AI estimates have no micronutrient data and never get any; typed values are kept as typed', async () => {
  const call = setup();
  const q = await call('POST /api/nutrition/entries', { body: { date: DAY, meal: 'snack', source: 'quick', name: 'Q', calories: 200, protein_g: 5, carbs_g: 20, fat_g: 8 } });
  const ai = await call('POST /api/nutrition/entries', { body: { date: DAY, meal: 'lunch', entries: [{ source: 'ai', name: 'AI meal', calories: 500, protein_g: 20, carbs_g: 50, fat_g: 20, confidence: 'low' }] } });
  assert.ok(!('micros' in q.out.entries[0]) && !('micros' in ai.out.entries[0]));
  const typed = await call('POST /api/nutrition/entries', { body: { date: DAY, meal: 'snack', source: 'quick', name: 'Label', calories: 100, protein_g: 1, carbs_g: 1, fat_g: 1, micros: { sodium_mg: 140, iron_mg: 0 } } });
  assert.deepEqual(typed.out.entries[0].micros, { sodium_mg: 140, iron_mg: 0 });
  const edit = await call('PUT /api/nutrition/entries', { url: `/api/nutrition/entries?date=${DAY}&id=${q.out.entries[0].id}`, body: { micros: { fiber_g: 3 } } });
  assert.deepEqual(edit.out.entry.micros, { fiber_g: 3 });
  const clear = await call('PUT /api/nutrition/entries', { url: `/api/nutrition/entries?date=${DAY}&id=${q.out.entries[0].id}`, body: { micros: {} } });
  assert.ok(!('micros' in clear.out.entry));
});

test('validation through the routes: strings, negatives, absurd values and unknown nutrients are refused everywhere micros are accepted', async () => {
  const call = setup();
  for (const bad of [{ iron_mg: '5' }, { iron_mg: -1 }, { iron_mg: 1e9 }, { nope_mg: 1 }, { iron_mg: NaN }]) {
    const e = await call('POST /api/nutrition/entries', { body: { date: DAY, meal: 'snack', source: 'quick', name: 'x', calories: 1, protein_g: 0, carbs_g: 0, fat_g: 0, micros: bad } });
    assert.equal(e.status, 400, JSON.stringify(bad));
    const f = await call('POST /api/nutrition/foods', { body: { name: 'x', serving: '1', per: { calories: 1, protein_g: 0, carbs_g: 0, fat_g: 0 }, micros: bad } });
    assert.equal(f.status, 400, JSON.stringify(bad));
  }
  const badBase = await call('POST /api/nutrition/entries', { body: { date: DAY, meal: 'snack', source: 'quick', name: 'x', calories: 1, protein_g: 0, carbs_g: 0, fat_g: 0, base: { calories: 1, protein_g: 0, carbs_g: 0, fat_g: 0, grams: null, micros: { iron_mg: 'x' } } } });
  assert.equal(badBase.status, 400);
  assert.equal(Object.keys(store.read('mca').days).length, 0, 'nothing was stored');
});

test('the day view: food and supplements are summed separately; coverage counts entries with data; old entries (no micros) still load', async () => {
  const call = setup();
  await store.mutate('mca', d => { d.days[DAY] = { entries: [{ id: 'old', meal: 'lunch', name: 'Old entry', calories: 300, protein_g: 10, carbs_g: 30, fat_g: 10, source: 'manual', qty: 1 }] }; });
  await call('POST /api/nutrition/entries', { body: { date: DAY, meal: 'breakfast', source: 'food', qty: 1, food: snapshot() } });
  await call('POST /api/nutrition/entries', { body: { date: DAY, meal: 'snack', source: 'food', qty: 2, food: snapshot({ ext: '2', name: 'Other', micros: { calcium_mg: 100, iron_mg: 2 } }) } });
  const v = (await call('GET /api/nutrition/day', { url: `/api/nutrition/day?date=${DAY}` })).out;
  assert.equal(v.entries.length, 3);
  assert.deepEqual(v.micros.food, { totals: { calcium_mg: 520, vit_d_mcg: 3, zinc_mg: 0, iron_mg: 4 }, withData: 2, entries: 3, est: { totals: {} }, groups: { labels: 2, estimated: 0, none: 1 } });
  assert.deepEqual(v.micros.supplements, { totals: {}, withData: 0, entries: 0, est: { totals: {} }, groups: { labels: 0, estimated: 0, none: 0 } });
  const empty = (await call('GET /api/nutrition/day', { url: '/api/nutrition/day?date=2026-01-01' })).out;
  assert.deepEqual(empty.micros.food, { totals: {}, withData: 0, entries: 0, est: { totals: {} }, groups: { labels: 0, estimated: 0, none: 0 } });
});

test('amount editing keeps micros per unit in the base (base.micros) and accepts the scaled micros', async () => {
  const call = setup();
  const e = (await call('POST /api/nutrition/entries', { body: { date: DAY, meal: 'breakfast', source: 'food', qty: 1, food: snapshot() } })).out.entries[0];
  const r = await call('PUT /api/nutrition/entries', { url: `/api/nutrition/entries?date=${DAY}&id=${e.id}`, body: { qty: 2, calories: 304, micros: { calcium_mg: 640, vit_d_mcg: 6, zinc_mg: 0 }, base: { ...e.base } } });
  assert.equal(r.status, 200, JSON.stringify(r.out));
  assert.deepEqual([r.out.entry.qty, r.out.entry.micros.calcium_mg, r.out.entry.base.micros.calcium_mg], [2, 640, 320]);
});
