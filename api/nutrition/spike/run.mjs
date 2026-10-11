#!/usr/bin/env node
/* Phase 1 spike: can the Coach's Claude Agent SDK path read a food photo?
 *
 *   node nutrition/spike/run.mjs <photo.jpg> [--uid <uid>] [--note "text"]
 *   node nutrition/spike/run.mjs --text "two eggs and buttered toast" [--uid <uid>]
 *
 * Flags
 *   --mode auto|inline|read   auto (default) = path A (inline image), and path B (Read tool,
 *                             confined to the job dir) only if A fails. 'inline' never tries B.
 *   --uid <uid>               whose credential to use. Default: the profile the Coach's setup
 *                             token is bound to (instance mode), as "Test the Coach" does.
 *   --timeout <seconds>       per model call, default 120.
 *   --keep                    leave the temp job dir in place.
 *
 * Throwaway: read-only apart from a temp dir, writes nothing under DATA_DIR, adds no routes.
 * Run it inside the api container, which must be the `coach` image target (see the bottom).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as cfgStore from '../../coach/config.js';
import { canDropPrivileges, unprivilegedIds } from '../../coach/adapters/spawn.js';
import { invokeMeal, sniffImageType } from '../vision.js';
import { runMealPipeline } from '../pipeline.js';

const args = process.argv.slice(2);
const flag = (name, dflt) => { const i = args.indexOf(name); if (i < 0) return dflt; const v = args[i + 1]; args.splice(i, 2); return v; };
const has = name => { const i = args.indexOf(name); if (i < 0) return false; args.splice(i, 1); return true; };

const keep = has('--keep');
const text = flag('--text');
const note = flag('--note');
const modeArg = flag('--mode', 'auto');
const timeoutS = +flag('--timeout', 120);
let uid = flag('--uid');
const file = args[0];

const die = msg => { console.error('spike: ' + msg); process.exit(2); };
if (!text && !file) die('give a photo path, or --text "description"');
if (!['auto', 'inline', 'read'].includes(modeArg)) die('--mode must be auto, inline or read');

const cfg = cfgStore.load();
if (cfg.provider !== 'claude') die(`the Coach provider is "${cfg.provider}"; this spike exercises the Claude Agent SDK, so set the Coach to Claude (Admin → Coach) first`);
uid = uid || cfgStore.boundUidFor(cfg);
if (!uid) die('no profile to borrow the credential from — pass --uid <uid> (the Coach token is not bound to anyone yet)');
const cred = cfgStore.credentialFor(uid);
if (!cred.ok) die(`no usable credential for ${uid}: ${cred.reason}${cred.message ? ' — ' + cred.message : ''}`);
const priv = canDropPrivileges();
if (!priv.ok) die('cannot drop privileges: ' + priv.why);

let image = null;
if (!text) {
  const data = fs.readFileSync(file);
  const mediaType = sniffImageType(data);
  if (!mediaType) die('that file is not a JPEG, PNG, WebP or GIF');
  image = { mediaType, data };
}

const jobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nutrition-spike-'));
const ids = unprivilegedIds();
if (ids) { fs.chmodSync(jobDir, 0o770); fs.chownSync(jobDir, process.getuid(), ids.gid); }   // as coach/jobs.js shareJobDir
const env = cfgStore.jobEnv(jobDir, cred);
const model = cfgStore.modelFor(cfg);

async function tryMode(mode) {
  let imageFile;
  if (mode === 'read') {
    imageFile = 'meal.' + ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' })[image.mediaType];
    fs.writeFileSync(path.join(jobDir, imageFile), image.data, { mode: 0o640 });
    if (ids) fs.chownSync(path.join(jobDir, imageFile), process.getuid(), ids.gid);
  }
  const t0 = Date.now();
  const r = await runMealPipeline(({ repair }) =>
    invokeMeal({ mode, image, imageFile, note, description: text, repair, jobDir, env, model, timeoutMs: timeoutS * 1000 }));
  return { mode, totalMs: Date.now() - t0, ...r };
}

const report = { provider: 'claude', model: model || '(sdk default)', uid, imageBytes: image ? image.data.length : 0, imageType: image?.mediaType || null, tried: [] };
try {
  const order = text ? ['text'] : modeArg === 'auto' ? ['inline', 'read'] : [modeArg];
  for (const mode of order) {
    const r = await tryMode(mode);
    report.tried.push(r);
    if (r.ok) break;
    if (modeArg === 'auto' && mode === 'inline' && !['unusable', 'provider'].includes(r.errorClass)) {
      // Auth, timeout, or a missing runtime would fail path B identically; saying so beats
      // spending a second call to learn it.
      break;
    }
  }
} finally {
  if (!keep) {
    if (ids) spawnSync('/bin/rm', ['-rf', ...fs.readdirSync(jobDir).map(n => path.join(jobDir, n))], { uid: ids.uid, gid: ids.gid, stdio: 'ignore' });
    fs.rmSync(jobDir, { recursive: true, force: true });
  }
}

const win = report.tried.find(t => t.ok);
console.log('\n=== nutrition photo spike ===');
console.log(`model:        ${report.model}`);
console.log(`input:        ${text ? 'text only' : `${report.imageType}, ${report.imageBytes} bytes (${(report.imageBytes / 1024).toFixed(0)} KiB), sent as ${win ? win.mode : report.tried.at(-1).mode}`}`);
for (const t of report.tried) {
  console.log(`path ${t.mode.padEnd(6)} ${t.ok ? 'WORKED' : 'FAILED (' + t.errorClass + ')'}  latency ${(t.totalMs / 1000).toFixed(1)}s  calls ${t.attempts} [${t.ms.map(m => (m / 1000).toFixed(1) + 's').join(', ')}]`);
  if (!t.ok) console.log(`             ${t.detail || (t.errors || []).join('; ')}`);
}
if (win) {
  console.log('\nparsed + validated:');
  console.log(JSON.stringify(win.meal, null, 2));
  console.log(`\nverdict: ${win.mode === 'text' ? 'text path works' : win.mode === 'inline' ? 'path A (inline image, lockdown intact) works' : 'path A FAILED, path B (Read tool) works — needs your decision before use'}`);
} else {
  console.log('\nverdict: no image path worked. Fallback: text-only logging (re-run with --text "…") and manual entry.');
}
process.exit(win ? 0 : 1);
