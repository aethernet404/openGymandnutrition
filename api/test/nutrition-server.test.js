/* The nutrition routes through the REAL server.js, over HTTP, with a real signed session cookie.
   The other nutrition tests call the handlers with a fake server; this is the one that proves
   they are wired into the running server: the route table, the session check, the body reader,
   the CSRF guard, the file under DATA_DIR, and the cleanup when an admin deletes a profile. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { boundPort } from './helpers.mjs';

const API = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SECRET = crypto.randomBytes(32).toString('hex');
const ORIGIN = 'http://localhost:8080';
const mint = uid => {
  const payload = `${uid}:${Date.now() + 86400000}:0`;
  return payload + '.' + crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
};
const ADMIN = 'u_adm_1', USER = 'u_user_1', OTHER = 'u_other_1';
const as = uid => ({ Cookie: `gymsid=${mint(uid)}`, 'Content-Type': 'application/json', Origin: ORIGIN });

async function boot(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-nutri-'));
  fs.writeFileSync(path.join(dataDir, 'secret'), SECRET, { mode: 0o600 });
  const now = new Date().toISOString();
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({
    users: [{ id: ADMIN, name: 'Adminna', created: now, admin: true }, { id: USER, name: 'Me', created: now }, { id: OTHER, name: 'Other', created: now }],
    creds: [], subs: [], invites: []
  }));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: API, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: '0', DATA_DIR: dataDir, ORIGIN, RP_ID: 'localhost' }
  });
  const h = { dataDir, log: '' };
  child.stdout.on('data', d => h.log += d);
  child.stderr.on('data', d => h.log += d);
  t.after(() => { child.kill('SIGKILL'); fs.rmSync(dataDir, { recursive: true, force: true }); });
  h.api = `http://127.0.0.1:${await boundPort(child, () => h.log)}`;
  h.call = async (method, p, uid, body) => {
    const r = await fetch(h.api + p, { method, headers: uid ? as(uid) : { 'Content-Type': 'application/json', Origin: ORIGIN }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  return h;
}

test('nutrition is served by the real server, behind the session, per profile', async t => {
  const h = await boot(t);

  // Reachable and guarded: the route exists (not 404) and wants a session.
  for (const [m, p] of [['GET', '/api/nutrition/config'], ['GET', '/api/nutrition/day?date=2026-10-12'], ['GET', '/api/nutrition/goals'], ['GET', '/api/nutrition/foods'], ['POST', '/api/nutrition/entries']]) {
    assert.equal((await h.call(m, p, null, m === 'POST' ? {} : undefined)).status, 401, `${m} ${p}`);
  }
  assert.equal((await h.call('GET', '/api/admin/nutrition', null)).status, 401);
  assert.equal((await h.call('GET', '/api/admin/nutrition', USER)).status, 403);

  // Config: the default AI allowance.
  const cfg = await h.call('GET', '/api/nutrition/config', USER);
  assert.equal(cfg.status, 200);
  assert.equal(cfg.body.ai.limit, 30);

  // A full round trip over HTTP.
  const add = await h.call('POST', '/api/nutrition/entries', USER, { date: '2026-10-12', meal: 'lunch', name: 'Wrap', source: 'quick', calories: 500, protein_g: 30, carbs_g: 50, fat_g: 18 });
  assert.equal(add.status, 201, h.log);
  const id = add.body.entries[0].id;
  const day = await h.call('GET', '/api/nutrition/day?date=2026-10-12', USER);
  assert.equal(day.body.totals.calories, 500);
  const put = await h.call('PUT', `/api/nutrition/entries?date=2026-10-12&id=${id}`, USER, { calories: 520 });
  assert.equal(put.body.day.totals.calories, 520);

  // The data is where it should be, private, and another profile cannot see it.
  const file = path.join(h.dataDir, 'nutrition', `${USER}.json`);
  assert.ok(fs.existsSync(file));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal((await h.call('GET', '/api/nutrition/day?date=2026-10-12', OTHER)).body.entries.length, 0);

  // Goals and a custom food.
  assert.equal((await h.call('PUT', '/api/nutrition/goals', USER, { calories: 2400, protein_g: 160, carbs_g: null, fat_g: 70 })).status, 200);
  const food = await h.call('POST', '/api/nutrition/foods', USER, { name: 'Shake', per: { calories: 120, protein_g: 24, carbs_g: 3, fat_g: 1.5 }, serving: '1 scoop' });
  assert.equal(food.status, 201);
  assert.equal((await h.call('GET', '/api/nutrition/foods?q=shak', USER)).body.foods.length, 1);

  // Bad input is a clean 400 from the real body reader, not a crash.
  assert.equal((await h.call('POST', '/api/nutrition/entries', USER, { date: 'nope' })).status, 400);
  const raw = await fetch(h.api + '/api/nutrition/entries', { method: 'POST', headers: as(USER), body: '{not json' });
  assert.ok([400, 413].includes(raw.status), 'malformed JSON is refused, status ' + raw.status);
  assert.equal(h.log.split('\n').filter(l => /^\s+at /.test(l)).length, 0, 'no stack traces in the server log');

  // Admin: change the cap, and the user sees it.
  assert.equal((await h.call('PUT', '/api/admin/nutrition', ADMIN, { aiDailyCap: 7 })).body.aiDailyCap, 7);
  assert.equal((await h.call('GET', '/api/nutrition/config', USER)).body.ai.limit, 7);
  assert.ok(fs.existsSync(path.join(h.dataDir, 'nutrition', 'config.json')));

  // Switching it off answers 503 {code:'off'} (what the app's "switched off" message keys on).
  await h.call('PUT', '/api/admin/nutrition', ADMIN, { enabled: false });
  const off = await h.call('GET', '/api/nutrition/day?date=2026-10-12', USER);
  assert.deepEqual([off.status, off.body.code], [503, 'off']);
  await h.call('PUT', '/api/admin/nutrition', ADMIN, { enabled: true });

  // Deleting a profile removes their nutrition file with the rest of their data.
  const del = await h.call('POST', '/api/admin/user/delete', ADMIN, { id: USER });
  assert.equal(del.status, 200);
  assert.ok(!fs.existsSync(file), 'the deleted profile\'s nutrition file is gone');
});

test('a browser request from another origin cannot write to the diary (CSRF guard covers it)', async t => {
  const h = await boot(t);
  const r = await fetch(h.api + '/api/nutrition/entries', {
    method: 'POST', headers: { ...as(USER), Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' },
    body: JSON.stringify({ date: '2026-10-12', meal: 'lunch', name: 'x', calories: 1, protein_g: 0, carbs_g: 0, fat_g: 0 })
  });
  assert.equal(r.status, 403);
  assert.ok(!fs.existsSync(path.join(h.dataDir, 'nutrition', `${USER}.json`)));
});
