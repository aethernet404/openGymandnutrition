/* A scratch directory for the model runtime, handed to the unprivileged `coach` user.
 *
 * Same handover as coach/jobs.js (shareJobDir / removeJobDir, which are not exported); see the
 * comments there for why the directory stays owned by this process and `coach` reaches it through
 * the group, and why cleanup has to run as `coach` first. The inline-image path writes nothing
 * into it — the photo travels in the prompt — so it exists only because the runtime needs a HOME
 * and a cwd, and it is removed when the call ends.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { unprivilegedIds } from '../coach/adapters/spawn.js';

export function makeJobDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nutrition-'));
  const ids = unprivilegedIds();
  if (ids) {
    fs.chmodSync(dir, 0o770);
    fs.chownSync(dir, process.getuid ? process.getuid() : 0, ids.gid);
  }
  return dir;
}

export function removeJobDir(dir) {
  const ids = unprivilegedIds();
  if (ids) {
    try {
      const mine = fs.readdirSync(dir).map(n => path.join(dir, n));
      if (mine.length) spawnSync('/bin/rm', ['-rf', ...mine], { uid: ids.uid, gid: ids.gid, stdio: 'ignore' });
    } catch { /* fall through to the removal below */ }
  }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* leaked, not fatal */ }
}
