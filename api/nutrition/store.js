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
import { relevance } from './rank.js';
import { sumMicros } from './micros.js';

export class NutritionDataError extends Error {}
export class NutritionLimitError extends Error {}

const safeUid = uid => String(uid ?? '').replace(/[^a-zA-Z0-9_-]/g, '');
const fileFor = uid => {
  const s = safeUid(uid);
  if (!s) throw new Error('no user id');
  return path.join(dataDir(), s + '.json');
};
const EMPTY = () => ({ v: 1, goals: null, foods: {}, days: {}, ai: null, coachShare: false, health: null });
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

/* Apple Health numbers a Shortcut posted (health.js writes them). Read-side helpers live here so
   dayView can include them without a cycle. */
export const EAT_BACK_DEFAULT = Object.freeze({ enabled: false, percent: 50 });
export function eatBackOf(d) {
  const e = d.health?.eatBack;
  return { enabled: e?.enabled === true, percent: Number.isInteger(e?.percent) && e.percent >= 0 && e.percent <= 100 ? e.percent : EAT_BACK_DEFAULT.percent };
}
export function healthDay(d, date) {
  const h = d.health?.days?.[date];
  if (!h) return null;
  return { active_kcal: h.active, resting_kcal: h.resting, steps: h.steps ?? null, burned_kcal: round(h.active + h.resting, 1), updatedAt: h.updatedAt };
}

/** Exercise minutes and the day's workouts: for display only. Deliberately NOT part of healthDay, so nothing that
    computes Burned or Net can reach workout calories. */
export function activityDay(d, date) {
  const a = d.health?.activity?.[date];
  if (!a || (a.exerciseMin == null && !a.workouts?.length)) return null;
  return { exercise_min: a.exerciseMin ?? null, workouts: a.workouts || [], updatedAt: a.updatedAt };
}
/** Latest weight (kg) and the last `days` days of readings, oldest first. */
export function weightView(d, today, days = 30) {
  const all = d.health?.weights || [];
  const from = new Date(today + 'T12:00:00Z'); from.setUTCDate(from.getUTCDate() - days + 1);
  const since = from.toISOString().slice(0, 10);
  const latest = all.length ? all[all.length - 1] : null;
  return { latest: latest ? { date: latest.date, kg: latest.kg } : null, readings: all.filter(w => w.date >= since).map(w => ({ date: w.date, kg: w.kg })), count: all.length };
}

/**
 * The Apple Health numbers for the `days` days ending at `to` (oldest first), for the stats page and the Home
 * card. Every day in the range is present; a figure Health never sent for that day is null, not 0, so the page
 * can tell "no data" from "a real zero". Burned is active + resting only — workout calories are display.
 * Also: recent workouts (newest first), the weight view, the newest update time, and whether any data exists.
 */
export function healthHistory(d, to, days = 30, maxWorkouts = 30) {
  const h = d.health || {};
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const dt = new Date(to + 'T12:00:00Z'); dt.setUTCDate(dt.getUTCDate() - i);
    const date = dt.toISOString().slice(0, 10);
    const e = h.days?.[date], a = h.activity?.[date];
    out.push({
      date,
      active_kcal: e ? e.active : null, resting_kcal: e ? e.resting : null,
      burned_kcal: e ? round(e.active + e.resting, 1) : null,
      steps: e?.steps ?? null,
      exercise_min: a?.exerciseMin ?? null,
      workouts: a?.workouts?.length ? a.workouts : [],
      updatedAt: Math.max(e?.updatedAt || 0, a?.updatedAt || 0) || null
    });
  }
  const workouts = [];
  for (const day of [...out].reverse()) for (const w of [...day.workouts].sort((x, y) => (x.time < y.time ? 1 : -1))) if (workouts.length < maxWorkouts) workouts.push({ date: day.date, ...w });
  const weight = weightView(d, to, 30);
  const stamps = [...Object.values(h.days || {}), ...Object.values(h.activity || {}), ...(h.weights || [])].map(x => x.updatedAt || x.at || 0);
  const updatedAt = stamps.length ? Math.max(...stamps) : null;
  return { from: out[0].date, to, days: out, workouts, weight, updatedAt, hasData: stamps.length > 0, token: !!h.token };
}

/**
 * The day's micronutrients, in two buckets so the app can show food alone or food plus supplements. Each is
 * { totals, withData, entries }: the known amounts added up (a nutrient nobody knows is absent, not 0), how many entries
 * had any micronutrient data, and how many entries there were. Entries with no data stay visible in `entries`.
 */
export function microsSummary(entries) {
  return { food: sumMicros(entries.filter(e => e.meal !== 'supplements')), supplements: sumMicros(entries.filter(e => e.meal === 'supplements')) };
}

export function dayView(d, date) {
  const entries = d.days[date]?.entries || [];
  const byMeal = {};
  for (const m of ['breakfast', 'lunch', 'dinner', 'snack']) byMeal[m] = totalsOf(entries.filter(e => e.meal === m));
  return { date, entries, totals: totalsOf(entries), byMeal, goals: d.goals, health: healthDay(d, date), activity: activityDay(d, date), eatBack: eatBackOf(d), micros: microsSummary(entries) };
}

/** Days with at least one entry in [from, to], oldest first. */
export function range(d, from, to) {
  return Object.keys(d.days).filter(k => k >= from && k <= to && d.days[k].entries?.length).sort()
    .map(date => ({ date, count: d.days[date].entries.length, totals: totalsOf(d.days[date].entries) }));
}

/* ---------- foods ---------- */

const norm = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
const foodKey = f => f.ext ? `${f.source}|${f.ext}|${norm(f.serving?.label)}|${f.serving?.grams ?? ''}` : `${f.source}|${norm(f.name)}|${norm(f.brand)}|${f.per.calories}|${f.per.protein_g}|${f.per.carbs_g}|${f.per.fat_g}`;

/* FatSecret's terms let only their ids be stored; everything else may be cached for 24 hours. A food from there is
   therefore kept as a recent for 24 hours and then forgotten (the numbers in a diary entry are the person's own record
   of what they ate and stay). */
export const FATSECRET_KEEP_MS = 24 * 3600 * 1000;
const fsExpired = (f, now = Date.now()) => f.source === 'fatsecret' && now - (f.lastUsed || f.createdAt || 0) > FATSECRET_KEEP_MS;

function pruneRecents(d) {
  for (const f of Object.values(d.foods)) if (fsExpired(f)) delete d.foods[f.id];
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
  if (f.micros == null) delete f.micros;
  d.foods[f.id] = f;
  return f;
}

/** The saved (custom) food with this name and brand, ignoring case and extra spaces, or null. */
export function findSavedFood(d, name, brand = '') {
  const n = norm(name), b = norm(brand);
  return Object.values(d.foods).find(f => f.source === 'custom' && norm(f.name) === n && norm(f.brand) === b) || null;
}

/** Remember a food that came from search or the AI, as a recent. Same food again → same row. */
export function noteRecent(d, input) {
  const candidate = { source: 'custom', ext: null, ...input };
  const key = foodKey(candidate);
  const existing = Object.values(d.foods).find(f => foodKey(f) === key);
  const now = Date.now();
  if (existing) { existing.useCount = (existing.useCount || 0) + 1; existing.lastUsed = now; return existing; }
  const f = { id: newId(), favorite: false, useCount: 1, lastUsed: now, createdAt: now, ...candidate };
  if (f.micros == null) delete f.micros;
  d.foods[f.id] = f;
  pruneRecents(d);
  return f;
}

export function listFoods(d, { scope = 'all', q = '' } = {}) {
  let list = Object.values(d.foods).filter(f => !fsExpired(f));
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
  if (next.base == null) delete next.base;
  if (next.micros == null) delete next.micros;
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

/**
 * The person's saved (custom) foods that contain every word typed, shaped like a lookup hit so the app can merge
 * them with the other sources, with a rank above every outside source ("My food" always comes first). A saved food
 * is one serving, so it has one base. Closer names first; favourites and often-used ones break ties.
 */
export function searchSaved(d, q, limit = 10) {
  const out = [];
  for (const f of Object.values(d.foods)) {
    if (f.source !== 'custom') continue;
    const r = relevance(q, f.name, f.brand);
    if (!r.full) continue;
    out.push({
      source: 'mine', kind: f.origin === 'ai' ? 'ai' : 'mine', origin: f.origin || null, ext: f.id, name: f.name, brand: f.brand || '',
      bases: [{ label: f.serving?.label || '1 serving', grams: f.serving?.grams ?? null, per: f.per, ...(f.micros ? { micros: f.micros } : {}) }],
      rank: 5000 + r.score + (f.favorite ? 20 : 0) + Math.min(10, f.useCount || 0)
    });
  }
  return out.sort((a, b) => b.rank - a.rank).slice(0, limit);
}
