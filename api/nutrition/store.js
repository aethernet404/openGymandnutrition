/* One profile's nutrition data: data/nutrition/<uid>.json.
 *
 *   { v:1, goals, foods:{id:Food}, days:{'YYYY-MM-DD':{entries:[Entry]}}, ai:{date,count} }
 *
 * Why a file of its own, as the Coach keeps data/coach/<uid>.json: the synced state blob is
 * last-writer-wins by timestamp, so a diary row written there could be erased by a device that
 * synced an older copy. This file is only ever written by this server.
 *
 * Concurrency. Node runs one handler at a time between awaits, and every mutation below is a
 * synchronous read → change → write, so two requests cannot interleave inside one. `withLock`
 * is the belt to those braces: it queues a profile's mutations end to end, so a future `await`
 * added inside one cannot open a lost-update window. It guards ONE process. The API keeps its
 * state in JSON files and must run as a single replica; two pods sharing ./data would break
 * every file it has, not only this one.
 *
 * A file that exists but does not parse is never treated as empty: the next write would replace
 * the diary with a blank one. It is reported (NutritionDataError) and left exactly as it is.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { atomicWrite } from '../durable.js';
import { dataDir } from './config.js';
import { MACROS, LIMITS, round } from './validate.js';

export class NutritionDataError extends Error {}
export class NutritionLimitError extends Error {}

const safeUid = uid => String(uid ?? '').replace(/[^a-zA-Z0-9_-]/g, '');
const fileFor = uid => {
  const s = safeUid(uid);
  if (!s) throw new Error('no user id');
  return path.join(dataDir(), s + '.json');
};
const EMPTY = () => ({ v: 1, goals: null, foods: {}, days: {}, ai: null });
const newId = () => crypto.randomBytes(9).toString('base64url');
const todayUTC = () => new Date().toISOString().slice(0, 10);

/* ---------- locking ---------- */

const tails = new Map();
/** Run `fn` after every earlier `withLock` for the same profile has finished. */
export function withLock(uid, fn) {
  const key = safeUid(uid);
  const prev = tails.get(key) || Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => {});
  tails.set(key, tail);
  tail.then(() => { if (tails.get(key) === tail) tails.delete(key); });
  return run;
}

/* ---------- read / write ---------- */

export function read(uid) {
  const file = fileFor(uid);
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return EMPTY(); throw new NutritionDataError('your nutrition data file could not be read'); }
  let d;
  try { d = JSON.parse(raw); } catch { throw new NutritionDataError('your nutrition data file is damaged; it has been left untouched'); }
  if (!d || typeof d !== 'object' || Array.isArray(d)) throw new NutritionDataError('your nutrition data file is damaged; it has been left untouched');
  return { ...EMPTY(), ...d, foods: d.foods && typeof d.foods === 'object' ? d.foods : {}, days: d.days && typeof d.days === 'object' ? d.days : {} };
}

function write(uid, d) {
  fs.mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
  atomicWrite(fileFor(uid), JSON.stringify(d), 0o600);
}

/** Read, let `fn` change the data, write it back. `fn` may return a value, which is returned. */
export function mutate(uid, fn) {
  return withLock(uid, () => {
    const d = read(uid);
    const out = fn(d);
    write(uid, d);
    return out;
  });
}

/** Account deleted: nothing of theirs stays behind. */
export function removeUser(uid) {
  try { fs.unlinkSync(fileFor(uid)); } catch { /* none */ }
}

/* ---------- totals ---------- */

export function totalsOf(entries) {
  const t = { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 };
  for (const e of entries) for (const k of MACROS) t[k] += e[k] || 0;
  t.calories = Math.round(t.calories);
  for (const k of ['protein_g', 'carbs_g', 'fat_g']) t[k] = round(t[k], 1);
  return t;
}

export function dayView(d, date) {
  const entries = d.days[date]?.entries || [];
  const byMeal = {};
  for (const m of ['breakfast', 'lunch', 'dinner', 'snack']) byMeal[m] = totalsOf(entries.filter(e => e.meal === m));
  return { date, entries, totals: totalsOf(entries), byMeal, goals: d.goals };
}

/** Days with at least one entry in [from, to], oldest first. */
export function range(d, from, to) {
  return Object.keys(d.days).filter(k => k >= from && k <= to && d.days[k].entries?.length).sort()
    .map(date => ({ date, count: d.days[date].entries.length, totals: totalsOf(d.days[date].entries) }));
}

/* ---------- foods ---------- */

const norm = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
const foodKey = f => f.ext ? `${f.source}|${f.ext}` : `${f.source}|${norm(f.name)}|${norm(f.brand)}|${f.per.calories}|${f.per.protein_g}|${f.per.carbs_g}|${f.per.fat_g}`;

function pruneRecents(d) {
  const recents = Object.values(d.foods).filter(f => f.source !== 'custom' && !f.favorite);
  if (recents.length <= LIMITS.recentFoods) return;
  recents.sort((a, b) => (a.lastUsed || 0) - (b.lastUsed || 0));
  for (const f of recents.slice(0, recents.length - LIMITS.recentFoods)) delete d.foods[f.id];
}

/** Create a food. Returns the stored food. Throws NutritionLimitError at the cap. */
export function addFood(d, input) {
  if (Object.keys(d.foods).length >= LIMITS.foods) throw new NutritionLimitError(`you can keep at most ${LIMITS.foods} foods`);
  const now = Date.now();
  const f = { id: newId(), source: 'custom', ext: null, favorite: false, useCount: 0, lastUsed: null, createdAt: now, ...input };
  d.foods[f.id] = f;
  return f;
}

/** Remember a food that came from search or the AI, as a recent. Same food again → same row. */
export function noteRecent(d, input) {
  const candidate = { source: 'custom', ext: null, ...input };
  const key = foodKey(candidate);
  const existing = Object.values(d.foods).find(f => foodKey(f) === key);
  const now = Date.now();
  if (existing) { existing.useCount = (existing.useCount || 0) + 1; existing.lastUsed = now; return existing; }
  const f = { id: newId(), favorite: false, useCount: 1, lastUsed: now, createdAt: now, ...candidate };
  d.foods[f.id] = f;
  pruneRecents(d);
  return f;
}

export function listFoods(d, { scope = 'all', q = '' } = {}) {
  let list = Object.values(d.foods);
  if (scope === 'custom') list = list.filter(f => f.source === 'custom');
  else if (scope === 'favorite') list = list.filter(f => f.favorite);
  else if (scope === 'recent') list = list.filter(f => f.lastUsed);
  const needle = norm(q);
  if (needle) list = list.filter(f => norm(f.name + ' ' + f.brand).includes(needle));
  const byUse = (a, b) => (b.lastUsed || 0) - (a.lastUsed || 0) || a.name.localeCompare(b.name);
  return list.sort(scope === 'custom' || scope === 'all' ? (a, b) => (b.favorite - a.favorite) || byUse(a, b) : byUse).slice(0, 200);
}

/* ---------- entries ---------- */

export function addEntries(d, date, list) {
  const day = (d.days[date] ||= { entries: [] });
  if (day.entries.length + list.length > LIMITS.entriesPerDay) throw new NutritionLimitError(`a day can hold at most ${LIMITS.entriesPerDay} entries`);
  const now = Date.now();
  const made = list.map(e => ({ id: newId(), ...e, ts: now }));
  day.entries.push(...made);
  return made;
}

export function findEntry(d, date, id) {
  const i = (d.days[date]?.entries || []).findIndex(e => e.id === id);
  return i < 0 ? null : { day: d.days[date], i, entry: d.days[date].entries[i] };
}

/** Change an entry; `newDate` moves it to another day. Returns the entry, or null if not found. */
export function updateEntry(d, date, id, patch, newDate) {
  const hit = findEntry(d, date, id);
  if (!hit) return null;
  const next = { ...hit.entry, ...patch, updated: Date.now() };
  if (next.confidence === null) delete next.confidence;
  if (newDate && newDate !== date) {
    const target = (d.days[newDate] ||= { entries: [] });
    if (target.entries.length >= LIMITS.entriesPerDay) throw new NutritionLimitError(`a day can hold at most ${LIMITS.entriesPerDay} entries`);
    hit.day.entries.splice(hit.i, 1);
    if (!hit.day.entries.length) delete d.days[date];
    target.entries.push(next);
  } else hit.day.entries[hit.i] = next;
  return next;
}

export function deleteEntry(d, date, id) {
  const hit = findEntry(d, date, id);
  if (!hit) return false;
  hit.day.entries.splice(hit.i, 1);
  if (!hit.day.entries.length) delete d.days[date];
  return true;
}

/* ---------- AI usage (the nutrition cap; the Coach's own cap is a different counter) ---------- */

export function aiUsed(d) { return d.ai?.date === todayUTC() ? d.ai.count : 0; }

/** Spend one analysis, or refuse. Counted when the call starts, as the Coach counts a job. */
export function spendAi(d, limit) {
  const used = aiUsed(d);
  if (used >= limit) return false;
  d.ai = { date: todayUTC(), count: used + 1 };
  return true;
}

/** The reservation the AI routes make before they call the model: { ok, used, limit, remaining }. */
export async function reserveAi(uid, limit) {
  return mutate(uid, d => {
    const ok = spendAi(d, limit);
    const used = aiUsed(d);
    return { ok, used, limit, remaining: Math.max(0, limit - used) };
  }).then(r => r);
}

/** Give a reservation back when the call never reached the model (cap check passed, then the
 *  runtime was missing or the credential refused). A call that ran and failed stays counted. */
export function refundAi(uid) {
  return mutate(uid, d => { if (d.ai?.date === todayUTC() && d.ai.count > 0) d.ai.count -= 1; });
}
