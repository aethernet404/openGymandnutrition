/* A damaged settings (or counter) file is never read as an empty one and never overwritten: the next save must not
   wipe the stored encrypted keys. */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempData } from './helpers.mjs';

const DIR = tempData();
const cfg = await import('../nutrition/config.js');
const store = await import('../nutrition/store.js');
const { nutritionRoutes } = await import('../nutrition/routes.js');
const { createUsage } = await import('../nutrition/fatsecret.js');

const FILE = path.join(DIR, 'nutrition', 'config.json');
const read = f => fs.readFileSync(f, 'utf8');
const routes = nutritionRoutes({ json: (res, code, obj) => { res.status = code; res.out = obj; }, readBody: async q => q.body ?? {}, readSession: q => q.user || null, requireAdmin: (q, r) => (q.user?.admin ? q.user : null), lookup: {}, analyzer: {} });
const ADMIN = { id: 'cfgadm', admin: true };
const call = async (key, body) => { const res = {}; await routes[key]({ method: key.split(' ')[0], url: key.split(' ')[1], user: ADMIN, body, headers: {} }, res); return res; };

beforeEach(() => { for (const f of [FILE, FILE + '.bak', FILE + '.damaged']) fs.rmSync(f, { force: true }); });

const GOOD = () => { assert.equal(cfg.save({ usdaKey: 'USDAKEY0123456789', aiDailyCap: 12 }).ok, true); assert.equal(cfg.save({ aiDailyCap: 13 }).ok, true); };

test('a missing settings file is a fresh server (defaults), not a damaged one', () => {
  const c = cfg.load();
  assert.deepEqual([c.damaged, c.enabled, c.aiDailyCap, c.usdaKeySet], [false, true, 30, false]);
});

test('every save keeps the previous good settings as config.json.bak', () => {
  GOOD();
  assert.equal(JSON.parse(read(FILE + '.bak')).aiDailyCap, 12, 'the .bak is the state before the last save');
  assert.equal(JSON.parse(read(FILE)).aiDailyCap, 13);
  assert.equal(cfg.save({ aiDailyCap: 14 }).ok, true);
  assert.equal(JSON.parse(read(FILE + '.bak')).aiDailyCap, 13);
  assert.equal((fs.statSync(FILE + '.bak').mode & 0o777), 0o600, 'as private as the file itself');
  assert.equal(cfg.usdaKey(), 'USDAKEY0123456789', 'saving one setting leaves the encrypted key alone');
});

test('damaged settings with no backup: reads fail closed, saving is refused with the plain message, the file is not touched, the keys are not wiped', () => {
  GOOD(); fs.rmSync(FILE + '.bak');
  fs.writeFileSync(FILE, '{"enabled": true, "usdaKey": "abc');           // cut off mid-write
  const bytes = read(FILE);
  const c = cfg.load();
  assert.deepEqual([c.damaged, c.backupUsable, c.usdaKeySet, c.aiDailyCap], [true, false, false, 0], 'no keys, AI off');
  assert.equal(cfg.usdaKey(), null);
  const r = cfg.save({ aiDailyCap: 5 });
  assert.deepEqual([r.ok, r.damaged], [false, true]);
  assert.match(r.error, /The settings file is damaged; your keys were not changed\./);
  for (const patch of [{ usdaKey: 'NEWKEY0123456789' }, { fatsecret: null }, { usdaKey: null }, { enabled: false }]) assert.equal(cfg.save(patch).ok, false, JSON.stringify(patch));
  assert.equal(read(FILE), bytes, 'byte for byte as it was');
  assert.equal(fs.existsSync(FILE + '.bak'), false, 'a damaged file is never copied over the good backup');
});

test('damaged settings with a good backup: reads use the backup (keys still work), saving is refused until it is restored', () => {
  GOOD();                                                                  // .bak = aiDailyCap 12 with the key, file = 13
  fs.writeFileSync(FILE, 'garbage');
  const c = cfg.load();
  assert.deepEqual([c.damaged, c.backupUsable, c.usdaKeySet, c.aiDailyCap], [true, true, true, 12]);
  assert.equal(cfg.usdaKey(), 'USDAKEY0123456789');
  assert.equal(cfg.save({ aiDailyCap: 5 }).ok, false);
  assert.equal(read(FILE), 'garbage');
  const back = cfg.restoreBackup();
  assert.equal(back.ok, true);
  assert.equal(read(FILE + '.damaged'), 'garbage', 'the damaged file is kept');
  assert.deepEqual([cfg.load().damaged, cfg.load().aiDailyCap, cfg.usdaKey()], [false, 12, 'USDAKEY0123456789']);
  assert.equal(cfg.save({ aiDailyCap: 20 }).ok, true, 'saving works again');
  assert.equal(cfg.restoreBackup().ok, false, 'nothing to restore when it is not damaged');
});

test('a settings file that parses but is not an object is damaged too', () => {
  for (const text of ['[]', '"x"', '5', 'null', '']) {
    fs.writeFileSync(FILE, text);
    assert.equal(cfg.load().damaged, true, JSON.stringify(text));
    assert.equal(cfg.save({ aiDailyCap: 1 }).ok, false);
    assert.equal(read(FILE), text);
  }
});

test('through the admin routes: GET says damaged, PUT answers 409 with the message and writes nothing, restore works', async () => {
  GOOD();
  fs.writeFileSync(FILE, '{oops');
  const get = await call('GET /api/admin/nutrition');
  assert.deepEqual([get.status, get.out.damaged, get.out.backupUsable], [200, true, true]);
  const put = await call('PUT /api/admin/nutrition', { aiDailyCap: 1 });
  assert.deepEqual([put.status, put.out.code], [409, 'config-damaged']);
  assert.match(put.out.error, /your keys were not changed/);
  assert.equal(read(FILE), '{oops');
  assert.ok(!JSON.stringify(put.out).includes('USDAKEY'));
  const fixed = await call('POST /api/admin/nutrition/restore-config');
  assert.equal(fixed.status, 200);
  assert.equal((await call('GET /api/admin/nutrition')).out.damaged, false);
  assert.equal((await call('POST /api/admin/nutrition/restore-config')).status, 409);
  const plain = await routes['POST /api/admin/nutrition/restore-config']({ method: 'POST', url: '/', user: { id: 'u' }, headers: {} }, {});
  assert.equal(plain, undefined, 'not an admin: nothing happens');
});

test('counter files (FatSecret usage) that cannot be read are kept aside as .damaged and counting starts again; their contents are not logged', () => {
  const file = path.join(DIR, 'nutrition', 'fs-usage-damaged.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{"day": "2026-10-12", "total": 99, "us');
  const logs = [];
  const u = createUsage({ file, log: m => logs.push(m) });
  assert.equal(u.take('x'), null);
  assert.equal(u.snapshot().used, 1);
  assert.ok(fs.existsSync(file + '.damaged'));
  assert.ok(logs.some(l => /damaged/.test(l)) && !logs.join('').includes('"total"'));
});

test('a damaged profile file stays exactly as it is: reads and changes both refuse', async () => {
  const f = path.join(DIR, 'nutrition', 'dmgprofile.json');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, '{"v":1,"days":{"2026-10-12":{"entries":[{"id":"a"');
  const bytes = read(f);
  assert.throws(() => store.read('dmgprofile'), store.NutritionDataError);
  await assert.rejects(store.mutate('dmgprofile', d => { d.goals = { calories: 1 }; }), store.NutritionDataError);
  assert.equal(read(f), bytes);
});
