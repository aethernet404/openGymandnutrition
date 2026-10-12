/* The admin's switches for Nutrition, in data/nutrition/config.json.
 *
 * Deliberately not in the Coach's coach.json: the Coach config is upstream's file with its own
 * schema and migration, and nothing here should have to merge with it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite } from '../durable.js';

export const AI_CAP_DEFAULT = 30;
export const AI_CAP_MAX = 500;

export const dataDir = () => path.join(process.env.DATA_DIR || '/data', 'nutrition');
const file = () => path.join(dataDir(), 'config.json');

const DEFAULTS = { enabled: true, aiDailyCap: AI_CAP_DEFAULT };

export function load() {
  let stored = {};
  try { stored = JSON.parse(fs.readFileSync(file(), 'utf8')); } catch { /* absent = defaults */ }
  const cap = Number.isInteger(stored.aiDailyCap) && stored.aiDailyCap >= 0 && stored.aiDailyCap <= AI_CAP_MAX ? stored.aiDailyCap : DEFAULTS.aiDailyCap;
  return { enabled: stored.enabled !== false, aiDailyCap: cap };
}

/** @returns {{ok:true, config}|{ok:false, error}} */
export function save(patch) {
  if (patch == null || typeof patch !== 'object' || Array.isArray(patch)) return { ok: false, error: 'send the settings as an object' };
  const next = { ...load() };
  if (patch.enabled !== undefined) {
    if (typeof patch.enabled !== 'boolean') return { ok: false, error: 'enabled must be true or false' };
    next.enabled = patch.enabled;
  }
  if (patch.aiDailyCap !== undefined) {
    if (!Number.isInteger(patch.aiDailyCap) || patch.aiDailyCap < 0 || patch.aiDailyCap > AI_CAP_MAX) {
      return { ok: false, error: `aiDailyCap must be a whole number from 0 (AI off) to ${AI_CAP_MAX}` };
    }
    next.aiDailyCap = patch.aiDailyCap;
  }
  fs.mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
  atomicWrite(file(), JSON.stringify(next, null, 2), 0o600);
  return { ok: true, config: next };
}
