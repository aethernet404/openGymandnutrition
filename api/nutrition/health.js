/* Apple Health calories, delivered by an iOS Shortcut.
 *
 * A web page cannot read Apple Health, so a Shortcut on the phone reads the day's Active Energy and
 * Resting Energy and POSTs them here. This module is everything about that, and is built so that
 * the credential it introduces can do very little:
 *
 *   · The token is accepted by ONE route (POST /api/nutrition/health) and nothing else. It is not a
 *     session: the server's session reader verifies a signed `uid:expiry:version` and a token of this
 *     shape never passes it, so on every other route it is simply "not signed in". (A test sends it
 *     to a dozen routes to keep that true.)
 *   · It can WRITE four numbers for a day and read nothing: the answer to a post echoes only what
 *     was just posted.
 *   · It is shown once, when it is made. Only a SHA-256 of its secret half is kept (the secret is 256
 *     random bits, so a plain hash is enough — nothing to brute-force), in an index file that holds
 *     nothing else. One token per profile; making another replaces it; revoking removes it.
 *   · A wrong token counts against the caller's address (a backoff that locks for minutes, then
 *     longer), a right one is limited per token. Neither the token nor the numbers are logged.
 *
 *   token = ogh_<16 hex: id>_<64 hex: secret>
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { atomicWrite } from '../durable.js';
import { dataDir } from './config.js';
import { mutate, read, withLock, NutritionDataError } from './store.js';
import { round } from './validate.js';

export const LIMITS = { active: 10000, resting: 6000, total: 15000, steps: 200000, historyPerDay: 5, days: 400, pastDays: 60 };
const TOKEN_RE = /^ogh_([0-9a-f]{16})_([0-9a-f]{64})$/;
const INDEX_LOCK = '__health_index__';

const indexFile = () => path.join(dataDir(), 'health-tokens.json');
const sha = secret => crypto.createHash('sha256').update(secret).digest();

/* ------------------------------ validation ------------------------------ */

const isNum = v => typeof v === 'number' && Number.isFinite(v);
const dayShift = (iso, n) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

/**
 * What a Shortcut may send: { date, active_kcal, resting_kcal, steps? }. Numbers must be numbers
 * (not "512"), finite, non-negative and plausible; the date a real day from two months ago to
 * tomorrow (a phone can be a day ahead of this server's UTC date, or behind it).
 * @returns {{ok:true, value:{date:string, active_kcal:number, resting_kcal:number, steps:number|null}} | {ok:false, error:string, field?:string}}
 */
export function validateIngest(body, today = new Date().toISOString().slice(0, 10)) {
  const bad = (error, field) => ({ ok: false, error, field });
  if (!body || typeof body !== 'object' || Array.isArray(body)) return bad('send a JSON object');
  const { date } = body;
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date + 'T00:00:00Z')) || new Date(date + 'T00:00:00Z').toISOString().slice(0, 10) !== date) {
    return bad('date must be a real day written YYYY-MM-DD', 'date');
  }
  if (date > dayShift(today, 1)) return bad('date is in the future', 'date');
  if (date < dayShift(today, -LIMITS.pastDays)) return bad(`date is more than ${LIMITS.pastDays} days ago`, 'date');
  const num = (field, max) => {
    const v = body[field];
    if (v === undefined || v === null) return { error: `${field} is required` };
    if (typeof v === 'string') return { error: `${field} must be a number, not text (in the Shortcut, set the field type to Number)` };
    if (!isNum(v)) return { error: `${field} must be a number` };
    if (v < 0) return { error: `${field} cannot be negative` };
    if (v > max) return { error: `${field} is not plausible (over ${max})` };
    return { v };
  };
  const a = num('active_kcal', LIMITS.active); if (a.error) return bad(a.error, 'active_kcal');
  const r = num('resting_kcal', LIMITS.resting); if (r.error) return bad(r.error, 'resting_kcal');
  if (a.v + r.v > LIMITS.total) return bad('active_kcal and resting_kcal together are not plausible', 'active_kcal');
  // Both zero is not a day, it is Health returning nothing (a locked iPhone does that). Storing it would
  // overwrite a good reading with zeros, because a repost replaces the day.
  if (a.v === 0 && r.v === 0) return bad('active_kcal and resting_kcal are both 0, which means Health returned no data (is the iPhone locked?). Nothing was stored.', 'active_kcal');
  let steps = null;
  if (body.steps !== undefined && body.steps !== null) {
    const st = body.steps;
    if (typeof st === 'string') return bad('steps must be a number, not text', 'steps');
    if (!isNum(st) || !Number.isInteger(st)) return bad('steps must be a whole number', 'steps');
    if (st < 0 || st > LIMITS.steps) return bad(`steps is not plausible (0 to ${LIMITS.steps})`, 'steps');
    steps = st;
  }
  return { ok: true, value: { date, active_kcal: round(a.v, 1), resting_kcal: round(r.v, 1), steps } };
}

/* ------------------------------ the token index ------------------------------ */

function readIndex() {
  let raw;
  try { raw = fs.readFileSync(indexFile(), 'utf8'); } catch (e) { if (e.code === 'ENOENT') return {}; throw new NutritionDataError('the token index could not be read'); }
  try {
    const j = JSON.parse(raw);
    if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('shape');
    return j;
  } catch { throw new NutritionDataError('the token index is damaged; it has been left untouched'); }
}
function writeIndex(ix) {
  fs.mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
  atomicWrite(indexFile(), JSON.stringify(ix), 0o600);
}

/** Make this profile's token (replacing any it had). The full token is returned here and nowhere else, ever. */
export function createToken(uid, now = Date.now()) {
  return withLock(INDEX_LOCK, async () => {
    const id = crypto.randomBytes(8).toString('hex');
    const secret = crypto.randomBytes(32).toString('hex');
    const ix = readIndex();
    const replaced = Object.entries(ix).filter(([, v]) => v.uid === uid).map(([k]) => k);
    for (const k of replaced) delete ix[k];
    ix[id] = { uid, hash: sha(secret).toString('hex') };
    writeIndex(ix);
    try {
      await mutate(uid, d => { (d.health ||= { days: {}, token: null }).token = { id, createdAt: now, lastUsedAt: null }; });
    } catch (e) {
      // The profile's record could not take the note; do not leave a working token nobody can see.
      const again = readIndex(); delete again[id]; writeIndex(again);
      throw e;
    }
    return { token: `ogh_${id}_${secret}`, id, createdAt: now, rotated: replaced.length > 0 };
  });
}

/** Remove this profile's token. Returns whether there was one. */
export function revokeToken(uid) {
  return withLock(INDEX_LOCK, async () => {
    const ix = readIndex();
    const mine = Object.entries(ix).filter(([, v]) => v.uid === uid).map(([k]) => k);
    for (const k of mine) delete ix[k];
    if (mine.length) writeIndex(ix);
    const had = await mutate(uid, d => { const t = d.health?.token; if (d.health) d.health.token = null; return !!t; }).catch(() => false);
    return mine.length > 0 || had;
  });
}

/** What the settings screen may show about the token: never any part of the secret. */
export function tokenStatus(uid) {
  const t = read(uid).health?.token;
  return t ? { set: true, createdAt: t.createdAt, lastUsedAt: t.lastUsedAt ?? null, hint: '…' + String(t.id).slice(-4) } : { set: false, createdAt: null, lastUsedAt: null, hint: null };
}

/** Bearer header → { uid, id } or null. Constant-time on the secret; no distinction between "no such token" and "wrong secret". */
export function authenticate(header) {
  const m = /^Bearer\s+(\S+)\s*$/.exec(String(header || ''));
  const t = m && TOKEN_RE.exec(m[1]);
  let ix;
  try { ix = readIndex(); } catch { return null; }
  const entry = t ? ix[t[1]] : null;
  const expected = entry ? Buffer.from(entry.hash, 'hex') : Buffer.alloc(32);
  const given = sha(t ? t[2] : '');
  const same = crypto.timingSafeEqual(given, expected.length === 32 ? expected : Buffer.alloc(32));
  return t && entry && same ? { uid: entry.uid, id: t[1] } : null;
}

/** Drop an index entry whose profile has gone (deleted or disabled), so its token stays dead. */
export function forget(id) {
  return withLock(INDEX_LOCK, () => { const ix = readIndex(); if (ix[id]) { delete ix[id]; writeIndex(ix); } });
}

/* ------------------------------ writing the numbers ------------------------------ */

/**
 * Store a day's numbers. The same date again REPLACES the earlier values (the Shortcut always sends
 * the whole day so far); the value it replaced is kept in a short history. Returns what is stored.
 */
export function record(uid, tokenId, v, now = Date.now()) {
  return mutate(uid, d => {
    const h = (d.health ||= { days: {}, token: null });
    // The token that authenticated must still be the profile's current one (a rotate raced it).
    if (!h.token || h.token.id !== tokenId) return null;
    h.days ||= {};
    const prev = h.days[v.date];
    const day = { active: v.active_kcal, resting: v.resting_kcal, steps: v.steps, updatedAt: now, history: prev ? [...(prev.history || [])] : [] };
    if (prev && (prev.active !== v.active_kcal || prev.resting !== v.resting_kcal || prev.steps !== v.steps)) {
      day.history.push({ at: prev.updatedAt, active: prev.active, resting: prev.resting, steps: prev.steps ?? null });
    }
    day.history = day.history.slice(-LIMITS.historyPerDay);
    h.days[v.date] = day;
    // A bounded file: the oldest days go first.
    const keys = Object.keys(h.days).sort();
    for (const k of keys.slice(0, Math.max(0, keys.length - LIMITS.days))) delete h.days[k];
    h.token.lastUsedAt = now;
    return { date: v.date, active_kcal: day.active, resting_kcal: day.resting, steps: day.steps, burned_kcal: round(day.active + day.resting, 1), replaced: !!prev, updatedAt: now };
  });
}

/** The eat-back switch and percentage (off by default). */
export function setEatBack(uid, eb) {
  return mutate(uid, d => { (d.health ||= { days: {}, token: null }).eatBack = { enabled: eb.enabled === true, percent: eb.percent }; return d.health.eatBack; });
}
