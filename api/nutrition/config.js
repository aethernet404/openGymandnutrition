/* The admin's switches for Nutrition, in data/nutrition/config.json.
 *
 * Deliberately not in the Coach's coach.json: the Coach config is upstream's file with its own
 * schema and migration, and nothing here should have to merge with it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite } from '../durable.js';
import { encrypt, decrypt } from '../coach/config.js';   // the Coach's at-rest scheme (AES-GCM keyed from DATA_DIR/secret)

export const AI_CAP_DEFAULT = 30;
export const AI_CAP_MAX = 500;

export const dataDir = () => path.join(process.env.DATA_DIR || '/data', 'nutrition');
const file = () => path.join(dataDir(), 'config.json');

const DEFAULTS = { enabled: true, aiDailyCap: AI_CAP_DEFAULT };

function readStored() {
  try { return JSON.parse(fs.readFileSync(file(), 'utf8')) || {}; } catch { return {}; /* absent = defaults */ }
}

/** The settings the app may see. The USDA key itself never leaves the server: only whether one is set. */
export function load() {
  const stored = readStored();
  const cap = Number.isInteger(stored.aiDailyCap) && stored.aiDailyCap >= 0 && stored.aiDailyCap <= AI_CAP_MAX ? stored.aiDailyCap : DEFAULTS.aiDailyCap;
  return { enabled: stored.enabled !== false, aiDailyCap: cap, usdaKeySet: !!usdaKey(), fatsecretSet: !!fatsecretCreds(), healthDebug: stored.healthDebug === true };
}

/** The decrypted USDA FoodData Central key, or null. Server-side use only. */
export function usdaKey() {
  const blob = readStored().usdaKey;
  if (!blob) return null;
  const k = decrypt(blob);
  return k && typeof k.key === 'string' && k.key ? k.key : null;
}

/** The decrypted FatSecret Client ID and Secret, or null. Server-side use only: the secret is never sent to any client. */
export function fatsecretCreds() {
  const blob = readStored().fatsecret;
  if (!blob) return null;
  const k = decrypt(blob);
  return k && typeof k.id === 'string' && k.id && typeof k.secret === 'string' && k.secret ? { clientId: k.id, clientSecret: k.secret } : null;
}

/** The last four characters of the Client ID (an identifier, not the secret), so an admin can tell which pair is stored. */
export function fatsecretIdHint() {
  const c = fatsecretCreds();
  return c ? '…' + c.clientId.slice(-4) : null;
}

/** "…abcd", so an admin can tell which key is stored without it being shown. */
export function usdaKeyHint() {
  const k = usdaKey();
  return k ? '…' + k.slice(-4) : null;
}

/** @returns {{ok:true, config}|{ok:false, error}} */
export function save(patch) {
  if (patch == null || typeof patch !== 'object' || Array.isArray(patch)) return { ok: false, error: 'send the settings as an object' };
  const stored = readStored();
  const next = { enabled: load().enabled, aiDailyCap: load().aiDailyCap, ...(stored.healthDebug === true ? { healthDebug: true } : {}), ...(stored.usdaKey ? { usdaKey: stored.usdaKey } : {}), ...(stored.fatsecret ? { fatsecret: stored.fatsecret } : {}) };
  if (patch.enabled !== undefined) {
    if (typeof patch.enabled !== 'boolean') return { ok: false, error: 'enabled must be true or false' };
    next.enabled = patch.enabled;
  }
  if (patch.healthDebug !== undefined) {
    if (typeof patch.healthDebug !== 'boolean') return { ok: false, error: 'healthDebug must be true or false' };
    if (patch.healthDebug) next.healthDebug = true; else delete next.healthDebug;
  }
  if (patch.aiDailyCap !== undefined) {
    if (!Number.isInteger(patch.aiDailyCap) || patch.aiDailyCap < 0 || patch.aiDailyCap > AI_CAP_MAX) {
      return { ok: false, error: `aiDailyCap must be a whole number from 0 (AI off) to ${AI_CAP_MAX}` };
    }
    next.aiDailyCap = patch.aiDailyCap;
  }
  if (patch.usdaKey !== undefined) {
    if (patch.usdaKey === null || patch.usdaKey === '') delete next.usdaKey;
    else {
      const k = typeof patch.usdaKey === 'string' ? patch.usdaKey.trim() : '';
      // api.data.gov keys are 40 letters and digits; stay loose enough for DEMO_KEY and future shapes.
      if (!/^[A-Za-z0-9_-]{8,80}$/.test(k)) return { ok: false, error: 'that does not look like a USDA API key (letters and digits, no spaces)' };
      try { next.usdaKey = encrypt({ key: k }); } catch { return { ok: false, error: 'the server has no secret to protect the key with yet; restart the api once and try again' }; }
    }
  }
  if (patch.fatsecret !== undefined) {
    if (patch.fatsecret === null || patch.fatsecret === '') delete next.fatsecret;
    else {
      const o = patch.fatsecret;
      const id = o && typeof o === 'object' && typeof o.clientId === 'string' ? o.clientId.trim() : '';
      const secret = o && typeof o === 'object' && typeof o.clientSecret === 'string' ? o.clientSecret.trim() : '';
      if (!/^[A-Za-z0-9_-]{8,128}$/.test(id)) return { ok: false, error: 'that does not look like a FatSecret Client ID (letters and digits, no spaces)' };
      if (!/^[A-Za-z0-9_-]{8,128}$/.test(secret)) return { ok: false, error: 'that does not look like a FatSecret Client Secret (letters and digits, no spaces)' };
      try { next.fatsecret = encrypt({ id, secret }); } catch { return { ok: false, error: 'the server has no secret to protect the keys with yet; restart the api once and try again' }; }
    }
  }
  fs.mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
  atomicWrite(file(), JSON.stringify(next, null, 2), 0o600);
  return { ok: true, config: load() };
}
