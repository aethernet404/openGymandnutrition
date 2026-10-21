/* HTTP surface for Nutrition. A factory taking server.js's helpers, as coachRoutes does, so this
 * module imports nothing from server.js and tests can hand it fakes.
 *
 * Every route needs a signed-in session. There is no guest mode: guests never reach the server.
 * Routes are keyed 'METHOD /path'; ids ride in the query string because the table matches the
 * path exactly.
 */
import * as cfg from './config.js';
import * as store from './store.js';
import * as v from './validate.js';
import * as coachCfg from '../coach/config.js';
import { createLookup, cleanBarcode, describe as describeFailure, LookupError } from './lookup.js';
import { createFatSecret, createUsage, SERVER_DAILY_CAP, USER_DAILY_CAP } from './fatsecret.js';
import path from 'node:path';
import * as health from './health.js';
import * as hae from './hae.js';
import * as haeDebug from './hae-debug.js';
import { scaleMicros, microsOf } from './micros.js';
import * as standin from './standin.js';
import { createUsdaBudget } from './usda-budget.js';
import { createWindow, createBackoff } from '../rate-limit.js';
import { createAnalyzer, availability, checkInput, FAILURES } from './analyze.js';

/** Run `fn` over `list` with at most `n` in flight. */
async function mapLimit(list, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, list.length) }, async () => { while (i < list.length) await fn(list[i++]); }));
}

// How much JSON each kind of route may be sent (server.js's own ceiling is 5 MB for everything). A photo analysis is the
// one large one: 3 MB of image is 4 MB as base64. Health Auto Export keeps the full ceiling: its payload grows with
// the metrics the person chose and is only accepted behind a valid token.
const BODY = { tiny: 4 * 1024, small: 32 * 1024, entries: 256 * 1024, photo: 4.5 * 1024 * 1024, hae: 5 * 1024 * 1024 };
// Changes a profile may make per minute (a normal screen makes a handful; a batch of entries is one request).
const WRITES_PER_MIN = () => { const n = Number(process.env.NUTRITION_WRITES_PER_MINUTE); return Number.isInteger(n) && n >= 1 ? n : 120; };

const URL_BASE = 'http://x';
const query = req => new URL(req.url, URL_BASE).searchParams;

export function nutritionRoutes({
  json, readBody, readSession, requireAdmin, analyzer = createAnalyzer(),
  // FatSecret's calls are budgeted per profile and per day for the whole server (fatsecret.js); the count survives restarts.
  fatsecret = createFatSecret({ usage: createUsage({ file: path.join(cfg.dataDir(), 'fatsecret-usage.json') }) }),
  // USDA is one key for everyone: every request to it is counted per hour and per day (usda-budget.js).
  usdaBudget = createUsdaBudget({ file: path.join(cfg.dataDir(), 'usda-usage.json') }),
  lookup = createLookup({ fatsecret, usdaBudget }),
  // server.js supplies the address its sign-in throttle counts (proxy headers handled there) and whether a
  // profile still exists and is enabled; the defaults suit tests and a bare node run.
  limitAddress = req => String(req.socket?.remoteAddress || 'unknown'), userActive = () => true
}) {
  // The Apple Health token: wrong tokens count against the caller's address (ten free, then locks of a
  // minute doubling up to an hour); right ones are limited per token.
  const badTokens = createBackoff({ free: 10, baseMs: 60000, maxMs: 3600000 });
  const perToken = createWindow({ max: 60, windowMs: 3600000 });
  // Lookups go out to third parties from this server's address, so they are budgeted per profile.
  const lookups = createWindow({ max: 40, windowMs: 60000 });
  // Every change (POST, PUT, DELETE) is counted per profile: each one reads and rewrites the profile's whole file.
  const writes = createWindow({ max: WRITES_PER_MIN(), windowMs: 60000 });
  const throttled = (res, user) => {
    const wait = lookups.take(user.id);
    if (wait) { json(res, 429, { error: 'too many lookups; wait a moment', code: 'rate' }, { 'Retry-After': String(wait) }); return true; }
    return false;
  };

  /** Signed in, feature on. Returns the user, or answers and returns null. */
  const guard = (req, res) => {
    const user = readSession(req);
    if (!user) { json(res, 401, { error: 'not signed in' }); return null; }
    if (!cfg.load().enabled) { json(res, 503, { error: 'nutrition is switched off on this instance', code: 'off' }); return null; }
    return user;
  };
  const fail = (res, code, error) => json(res, code, { error });
  const invalid = (res, r) => fail(res, 400, r.error);

  /** Run a handler body; turn the store's own errors into answers. */
  const guarded = fn => async (req, res) => {
    const user = guard(req, res); if (!user) return;
    if (req.method !== 'GET') {
      const wait = writes.take(user.id);
      if (wait) return json(res, 429, { error: 'too many changes; wait a moment', code: 'rate', retryAfter: wait }, { 'Retry-After': String(wait) });
    }
    try { await fn(req, res, user); }
    catch (e) {
      if (e instanceof store.NutritionDataError) return fail(res, 500, e.message);
      if (e instanceof store.NutritionLimitError) return fail(res, 409, e.message);
      throw e;   // server.js answers HttpError (bad body, 413) and logs anything else
    }
  };

  /** Today's allowance for a profile, as the app shows it. */
  const allowance = uid => {
    const limit = cfg.load().aiDailyCap;
    const used = store.aiUsed(store.read(uid));
    return { limit, used, remaining: Math.max(0, limit - used) };
  };
  const aiFail = (res, code, uid, detail) => {
    const f = FAILURES[code] || FAILURES.provider;
    if (detail && code !== 'cap') console.error('nutrition: AI analysis failed:', code, String(detail).slice(0, 200));
    json(res, f.status, { error: f.text, code, ai: allowance(uid) });
  };

  /** Everything an Apple Health post must pass before its body is even read: Nutrition on, the address not
   *  locked, a valid Bearer token of a live profile, and the per-token limit. Answers and returns null if not. */
  const ingestGate = (req, res) => {
    if (!cfg.load().enabled) { json(res, 503, { error: 'nutrition is switched off on this instance', code: 'off' }); return null; }
    const addr = limitAddress(req);
    const wait = badTokens.retryAfter(addr);
    if (wait) { json(res, 429, { error: 'too many attempts, try again later', code: 'locked', retryAfter: wait }, { 'Retry-After': String(wait) }); return null; }
    const auth = health.authenticate(req.headers?.authorization);
    // A token for a profile that is gone or disabled is dead; its index entry goes with it.
    if (auth && !userActive(auth.uid)) { health.forget(auth.id).catch(() => {}); badTokens.fail(addr); json(res, 401, { error: 'invalid token' }); return null; }
    if (!auth) { badTokens.fail(addr); json(res, 401, { error: 'invalid token' }); return null; }
    const slow = perToken.take(auth.id);
    if (slow) { json(res, 429, { error: 'too many updates; wait a bit', code: 'rate', retryAfter: slow }, { 'Retry-After': String(slow) }); return null; }
    return auth;
  };

  /** An entry or food id from a request, or an answer and null. */
  const idOf = (res, s) => { const r = v.idParam(s); if (!r.ok) { invalid(res, r); return null; } return r.value; };
  const dateOf = (res, s) => { const r = v.dateParam(s); if (!r.ok) { invalid(res, r); return null; } return r.value; };

  /** Fill macros from a food × qty when the client sent a foodId and no numbers. */
  function resolveFood(d, e) {
    if (!e.needsFood) return null;
    const f = v.own(d.foods, e.foodId);
    if (!f) return 'that food no longer exists';
    const q = e.qty ?? 1;
    e.calories = Math.round(f.per.calories * q);
    for (const k of ['protein_g', 'carbs_g', 'fat_g']) e[k] = v.round(f.per[k] * q, 1);
    e.name ||= f.name; e.brand ||= f.brand; e.serving ||= f.serving.label;
    if (e.grams === undefined && f.serving.grams) e.grams = v.round(f.serving.grams * q, 1);
    // Micronutrients are copied onto the entry, scaled by what was eaten (unknown stays unknown: no key, never 0).
    if (e.micros === undefined) { const m = scaleMicros(f.micros, q); if (m) e.micros = m; }
    if (!e.base) e.base = { calories: f.per.calories, protein_g: f.per.protein_g, carbs_g: f.per.carbs_g, fat_g: f.per.fat_g, grams: f.serving.grams || null, ...(f.micros ? { micros: f.micros } : {}) };
    delete e.needsFood;
    return null;
  }

  return {
    /* ------------------------------ user ------------------------------ */

    // What the screen needs before it draws: the AI allowance for today, and which sources exist.
    'GET /api/nutrition/config': guarded(async (req, res, user) => {
      const c = cfg.load();
      const d = store.read(user.id);
      const used = store.aiUsed(d);
      const avail = availability(user.id);
      json(res, 200, {
        ai: { limit: c.aiDailyCap, used, remaining: Math.max(0, c.aiDailyCap - used), available: avail.ok && c.aiDailyCap > 0, reason: c.aiDailyCap === 0 ? 'off' : avail.ok ? null : avail.code },
        lookup: { off: true, usda: c.usdaKeySet, fatsecret: c.fatsecretSet }, meals: v.MEALS,
        // Whether there is a Coach to share with at all, and whether this profile has chosen to.
        coach: { available: coachCfg.isEnabled() && coachCfg.isConnected(), share: d.coachShare === true },
        health: { ...health.tokenStatus(user.id), eatBack: store.eatBackOf(d) }
      });
    }),

    'GET /api/nutrition/day': guarded(async (req, res, user) => {
      const date = dateOf(res, query(req).get('date')); if (!date) return;
      json(res, 200, store.dayView(store.read(user.id), date));
    }),

    // Per-day totals over a span, for the week strip and (later) the Coach summary.
    'GET /api/nutrition/range': guarded(async (req, res, user) => {
      const q = query(req);
      const from = dateOf(res, q.get('from')); if (!from) return;
      const to = dateOf(res, q.get('to')); if (!to) return;
      if (to < from) return fail(res, 400, 'to must not be before from');
      if ((Date.parse(to) - Date.parse(from)) / 864e5 > v.LIMITS.rangeDays) return fail(res, 400, `ask for at most ${v.LIMITS.rangeDays} days at a time`);
      const d = store.read(user.id);
      json(res, 200, { from, to, goals: d.goals, days: store.range(d, from, to) });
    }),

    // Add one or several entries to a day. Body: { date, entries:[…] } or { date, …one entry }.
    'POST /api/nutrition/entries': guarded(async (req, res, user) => {
      const body = await readBody(req, BODY.entries);
      const date = dateOf(res, body?.date); if (!date) return;
      const raw = Array.isArray(body.entries) ? body.entries : [body];
      if (!raw.length || raw.length > v.LIMITS.entriesPerRequest) return fail(res, 400, `send between 1 and ${v.LIMITS.entriesPerRequest} entries`);
      const list = [];
      for (const r of raw) {
        // An entry may carry the food it was priced from — a search hit, a scan — as a snapshot,
        // which is kept as a recent so the same thing is one tap next time.
        let snapshot = null;
        if (r && r.food !== undefined) {
          const f = v.food(r.food);
          if (!f.ok) return invalid(res, f);
          if (!['off', 'usda', 'fatsecret', 'ai'].includes(f.value.source) || (f.value.source !== 'ai' && !f.value.ext)) return fail(res, 400, 'a looked-up food needs its source and id');
          snapshot = f.value;
        }
        // A batch inherits the day's meal unless an entry names its own.
        const checked = v.entry({ ...(Array.isArray(body.entries) && body.meal ? { meal: body.meal } : {}), ...r }, { foodGiven: !!snapshot });
        if (!checked.ok) return invalid(res, checked);
        list.push(snapshot ? { ...checked.value, _snapshot: snapshot } : checked.value);
      }
      const out = await store.mutate(user.id, d => {
        for (const e of list) {
          let counted = false;
          if (e._snapshot) {
            const f = store.noteRecent(d, e._snapshot);
            e.foodId = f.id; counted = true;
            delete e._snapshot;
          }
          const problem = resolveFood(d, e);
          if (problem) return { error: problem };
          if (!counted && e.foodId && v.own(d.foods, e.foodId)) { const f = d.foods[e.foodId]; f.useCount = (f.useCount || 0) + 1; f.lastUsed = Date.now(); }
        }
        return { entries: store.addEntries(d, date, list), day: store.dayView(d, date) };
      });
      if (out.error) return fail(res, 400, out.error);
      json(res, 201, out);
    }),

    // Edit an entry in place; `newDate` moves it to another day. Query: date, id.
    'PUT /api/nutrition/entries': guarded(async (req, res, user) => {
      const q = query(req);
      const date = dateOf(res, q.get('date')); if (!date) return;
      const id = idOf(res, q.get('id')); if (!id) return;
      const body = await readBody(req, BODY.small);
      const checked = v.entry(body, { partial: true });
      if (!checked.ok) return invalid(res, checked);
      let newDate = null;
      if (body.newDate !== undefined) { newDate = dateOf(res, body.newDate); if (!newDate) return; }
      const out = await store.mutate(user.id, d => {
        const patch = checked.value;
        delete patch.needsFood;
        const e = store.updateEntry(d, date, id, patch, newDate);
        return e ? { entry: e, day: store.dayView(d, newDate || date) } : null;
      });
      if (!out) return fail(res, 404, 'no such entry');
      json(res, 200, out);
    }),

    'DELETE /api/nutrition/entries': guarded(async (req, res, user) => {
      const q = query(req);
      const date = dateOf(res, q.get('date')); if (!date) return;
      const id = idOf(res, q.get('id')); if (!id) return;
      const out = await store.mutate(user.id, d => store.deleteEntry(d, date, id) ? { day: store.dayView(d, date) } : null);
      if (!out) return fail(res, 404, 'no such entry');
      json(res, 200, out);
    }),

    // Query: scope = all | custom | favorite | recent, q = text filter.
    'GET /api/nutrition/foods': guarded(async (req, res, user) => {
      const q = query(req);
      const scope = q.get('scope') || 'all';
      const type = q.get('type') === 'supplement' ? 'supplement' : null;
      if (!['all', 'custom', 'favorite', 'recent'].includes(scope)) return fail(res, 400, 'scope must be all, custom, favorite or recent');
      json(res, 200, { foods: store.listFoods(store.read(user.id), { scope, q: String(q.get('q') || '').slice(0, 80), type }) });
    }),

    'POST /api/nutrition/foods': guarded(async (req, res, user) => {
      const body = await readBody(req, BODY.small);
      const checked = v.food(body);
      if (!checked.ok) return invalid(res, checked);
      // Saving something that may already be saved (an AI estimate turned into a food): with checkDuplicate the same
      // name and brand (any case) is not silently doubled. 409 + the existing food asks the person; onDuplicate
      // 'update' changes that food's serving and numbers, 'new' saves another beside it.
      const check = body.checkDuplicate === true;
      const choice = body.onDuplicate === 'update' || body.onDuplicate === 'new' ? body.onDuplicate : null;
      const out = await store.mutate(user.id, d => {
        const existing = check ? store.findSavedFood(d, checked.value.name, checked.value.brand, checked.value.type) : null;
        if (existing && !choice) return { duplicate: existing };
        if (existing && choice === 'update') {
          const { serving, per, origin, micros } = checked.value;
          Object.assign(existing, { serving, per }, origin ? { origin } : {}, micros !== undefined ? { micros } : {});
          if (existing.micros == null) delete existing.micros;
          return { food: existing, updated: true };
        }
        return { food: store.addFood(d, { ...checked.value, source: 'custom' }) };
      });
      if (out.duplicate) return json(res, 409, { error: 'You already have a saved food with that name and brand.', code: 'duplicate', existing: out.duplicate });
      json(res, out.updated ? 200 : 201, { food: out.food, ...(out.updated ? { updated: true } : {}) });
    }),

    // The usual supplement stack: which saved supplements, how many servings of each. Logging it is one ordinary POST of
    // entries (meal 'supplements', each by foodId); this only remembers the selection.
    'GET /api/nutrition/stack': guarded(async (req, res, user) => { json(res, 200, { items: store.stackOf(store.read(user.id)) }); }),
    'PUT /api/nutrition/stack': guarded(async (req, res, user) => {
      const body = await readBody(req, BODY.small);
      const raw = body?.items;
      if (!Array.isArray(raw) || raw.length > v.LIMITS.stack) return fail(res, 400, `send a list of at most ${v.LIMITS.stack} supplements`);
      const items = [];
      const seen = new Set();
      for (const i of raw) {
        const qty = typeof i?.qty === 'number' && Number.isFinite(i.qty) ? i.qty : NaN;
        if (!v.validId(i?.foodId) || !(qty >= 0.01 && qty <= v.LIMITS.qty)) return fail(res, 400, 'each item needs a foodId and a number of servings from 0.01 to ' + v.LIMITS.qty);
        if (seen.has(i.foodId)) return fail(res, 400, 'a supplement can be in the stack once');
        seen.add(i.foodId);
        items.push({ foodId: i.foodId, qty: v.round(qty, 2) });
      }
      const out = await store.mutate(user.id, d => {
        if (items.some(i => v.own(d.foods, i.foodId)?.type !== 'supplement')) return null;
        d.stack = items;
        return items;
      });
      if (!out) return fail(res, 400, 'the stack can only hold your saved supplements');
      json(res, 200, { items: out });
    }),

    // Edit a food (any of its fields), or just favourite it. Entries already logged keep their numbers.
    'PUT /api/nutrition/foods': guarded(async (req, res, user) => {
      const id = idOf(res, query(req).get('id')); if (!id) return;
      const body = await readBody(req, BODY.small);
      const checked = v.food(body, { partial: true });
      if (!checked.ok) return invalid(res, checked);
      const food = await store.mutate(user.id, d => {
        const f = v.own(d.foods, id);
        if (!f) return null;
        // A search result or AI recent is a snapshot of someone else's data: only its favourite
        // flag is the user's to change. Editing it means saving it as their own custom food.
        // FatSecret's terms do not let their data be kept, so a food from there cannot be starred (it is a recent for 24 hours).
        if (f.source === 'fatsecret' && checked.value.favorite) return { refused: 'fatsecret' };
        const patch = f.source === 'custom' ? checked.value : { favorite: checked.value.favorite ?? f.favorite };
        delete patch.source;
        delete patch.type;                                   // a food does not become a supplement or back
        Object.assign(f, patch);
        if (f.micros == null) delete f.micros;
        return f;
      });
      if (food?.refused) return fail(res, 400, 'FatSecret’s terms do not allow keeping their foods. Use “Add it as my food” on the barcode result, or create it under My foods, to keep a copy.');
      if (!food) return fail(res, 404, 'no such food');
      json(res, 200, { food });
    }),

    'DELETE /api/nutrition/foods': guarded(async (req, res, user) => {
      const id = idOf(res, query(req).get('id')); if (!id) return;
      const ok = await store.mutate(user.id, d => (v.own(d.foods, id) ? (delete d.foods[id], true) : false));
      if (!ok) return fail(res, 404, 'no such food');
      json(res, 200, { ok: true });
    }),

    /* ----- lookups: Open Food Facts always; USDA once an admin has set a key ----- */

    'GET /api/nutrition/search': guarded(async (req, res, user) => {
      const q = v.clean(query(req).get('q'), 80);
      if (q.length < 2) return fail(res, 400, 'type at least two letters to search');
      const source = query(req).get('source') || 'all';
      if (!['all', 'mine', 'off', 'usda', 'fatsecret'].includes(source)) return fail(res, 400, 'source must be all, mine, off, usda or fatsecret');
      // The person's own saved foods first: local, instant, no outside call and not counted against the lookup limit.
      const mine = source === 'all' || source === 'mine' ? store.searchSaved(store.read(user.id), q) : null;
      if (source === 'mine') return json(res, 200, { q, results: mine, sources: { mine: { ok: true, count: mine.length } } });
      if (throttled(res, user)) return;
      const out = await lookup.search(q, { usdaKey: cfg.usdaKey(), fatsecret: cfg.fatsecretCreds(), uid: user.id, sources: source });
      if (!mine) return json(res, 200, { q, ...out });
      json(res, 200, { q, results: [...mine, ...out.results], sources: { mine: { ok: true, count: mine.length }, ...out.sources } });
    }),

    // The full servings of a FatSecret search result (food.get v5), asked when it is tapped. Same limits as a search.
    'GET /api/nutrition/fatsecret/food': guarded(async (req, res, user) => {
      const id = String(query(req).get('id') || '');
      if (!/^\d{1,15}$/.test(id)) return fail(res, 400, 'a FatSecret food id is digits');
      const creds = cfg.fatsecretCreds();
      if (!creds) return fail(res, 400, 'FatSecret search is off');
      if (throttled(res, user)) return;
      try { json(res, 200, { food: await fatsecret.food(id, creds, { uid: user.id }) }); }
      catch (e) { json(res, 502, { error: e?.text || 'FatSecret did not answer.', kind: e?.kind || 'down' }); }
    }),

    'GET /api/nutrition/barcode': guarded(async (req, res, user) => {
      const code = cleanBarcode(query(req).get('code'));
      if (!code) return fail(res, 400, 'a barcode is 8 to 14 digits');
      if (throttled(res, user)) return;
      json(res, 200, { code, ...(await lookup.barcode(code)) });
    }),

    /* ----- Apple Health, via a Shortcut ----- */

    // THE ONLY ROUTE THAT TAKES THE APPLE HEALTH TOKEN. No session, no cookie: a Bearer token made in
    // the app's settings. It can write one day's numbers and read nothing.
    'POST /api/nutrition/health': async (req, res) => {
      const auth = ingestGate(req, res); if (!auth) return;
      const checked = health.validateIngest(await readBody(req, BODY.small));
      if (!checked.ok) return json(res, 400, { error: checked.error, ...(checked.field ? { field: checked.field } : {}) });
      let out;
      try { out = await health.record(auth.uid, auth.id, checked.value); }
      catch (e) { if (e instanceof store.NutritionDataError) return fail(res, 500, 'could not store the numbers'); throw e; }
      if (!out) return json(res, 401, { error: 'invalid token' });        // the token was replaced while this request ran
      json(res, 200, { ok: true, ...out });
    },

    // The same token, for the iPhone app Health Auto Export (Automations → REST API → JSON, Health
    // Metrics, v2). Reads its payload (hae.js), checks each day with the very same validation and
    // bounds as the route above, and replaces that day's numbers. Never adds to them.
    'POST /api/nutrition/health/hae': async (req, res) => {
      const auth = ingestGate(req, res); if (!auth) return;
      const payload = await readBody(req, BODY.hae);
      const parsed = hae.parseHae(payload);
      const debugOn = cfg.load().healthDebug;
      if (!parsed.ok) {
        if (debugOn) haeDebug.capture(payload, { ok: false, code: parsed.code, error: parsed.error });
        return json(res, 400, { error: parsed.error, code: parsed.code });
      }
      const energy = [], skipped = [];
      for (const day of parsed.days) {
        const v = health.validateIngest({ date: day.date, active_kcal: day.active_kcal, resting_kcal: day.resting_kcal, steps: day.steps });
        if (v.ok) energy.push({ ...v.value, covers: day.covers });
        else skipped.push({ date: day.date, kind: 'energy', reason: v.error, ...(v.field ? { field: v.field } : {}) });
      }
      // Workouts, exercise minutes and weight are independent of the energy numbers: one failing never blocks another.
      const activity = [], weights = [];
      let dropped = 0;
      for (const a of parsed.activity) {
        const v = health.validateActivity(a);
        if (v.ok) { activity.push({ ...v.value, exercise_covers: a.exercise_covers }); dropped += v.dropped; }
        else skipped.push({ date: a.date, kind: 'activity', reason: v.error });
      }
      for (const w of parsed.weights) {
        const v = health.validateWeight(w);
        if (v.ok) weights.push(v.value);
        else skipped.push({ date: w.date, kind: 'weight', reason: v.error });
      }
      const summary = { ok: energy.length + activity.length + weights.length > 0, days: parsed.days.map(d => ({ date: d.date, active_kcal: d.active_kcal, resting_kcal: d.resting_kcal, steps: d.steps, covers: d.covers })), activity: parsed.activity.map(a => ({ date: a.date, exercise_min: a.exercise_min, workouts: a.workouts ? a.workouts.length : null })), weights: parsed.weights, skipped, ignoredMetrics: parsed.ignoredMetrics, warnings: parsed.warnings, stats: parsed.stats };
      if (debugOn) haeDebug.capture(payload, summary);
      if (!energy.length && !activity.length && !weights.length) {
        return json(res, 400, { error: `Nothing was stored. ${skipped[0].date}: ${skipped[0].reason}`, code: 'invalid', skipped });
      }
      let stored;
      try { stored = await health.recordHae(auth.uid, auth.id, { energy, activity, weights }); }
      catch (e) { if (e instanceof store.NutritionDataError) return fail(res, 500, 'could not store the numbers'); throw e; }
      if (!stored) return json(res, 401, { error: 'invalid token' });
      const warnings = [...parsed.warnings];
      if (dropped) warnings.push(`${dropped} workout(s) were not plausible and were skipped.`);
      for (const d of stored.days) if (d.action === 'kept') warnings.push(`${d.date}: this export starts partway through the day and would lower the numbers already stored, so they were kept. Set the automation's Date Range to Today.`);
      json(res, 200, { ok: true, days: stored.days, activity: stored.activity, weights: stored.weights, skipped, ignored_metrics: parsed.ignoredMetrics, warnings });
    },

    // Everything the Apple Health stats page and the Home card show, for the signed-in profile only. Query:
    // date (the viewer's local day, default today UTC) and days (1–60, default 30).
    'GET /api/nutrition/health/history': guarded(async (req, res, user) => {
      const q = query(req);
      const d = q.get('date');
      const to = /^\d{4}-\d{2}-\d{2}$/.test(d || '') && v.validDate(d) ? d : new Date().toISOString().slice(0, 10);
      const n = q.get('days') == null ? 30 : Number(q.get('days'));
      if (!Number.isInteger(n) || n < 1 || n > 60) return fail(res, 400, 'days must be a whole number from 1 to 60');
      json(res, 200, store.healthHistory(store.read(user.id), to, n));
    }),

    // Latest body weight (kg, always) and the last 30 days of readings, for the diary's small trend.
    'GET /api/nutrition/weight': guarded(async (req, res, user) => {
      const d = query(req).get('date');
      const today = /^\d{4}-\d{2}-\d{2}$/.test(d || '') ? d : new Date().toISOString().slice(0, 10);
      json(res, 200, store.weightView(store.read(user.id), today));
    }),

    // Admin only: the shape of the last Health Auto Export payload, if the debug option is on.
    'GET /api/admin/nutrition/health-debug': async (req, res) => {
      if (!requireAdmin(req, res)) return;
      const on = cfg.load().healthDebug;
      json(res, 200, { enabled: on, capture: on ? haeDebug.read() : null, ttlMinutes: haeDebug.TTL_MS / 60000 });
    },
    'DELETE /api/admin/nutrition/health-debug': async (req, res) => {
      if (!requireAdmin(req, res)) return;
      haeDebug.clear();
      json(res, 200, { ok: true });
    },

    'GET /api/nutrition/health/token': guarded(async (req, res, user) => { json(res, 200, health.tokenStatus(user.id)); }),

    // Make (or replace) the token. The only response that ever contains it.
    'POST /api/nutrition/health/token': guarded(async (req, res, user) => {
      const t = await health.createToken(user.id);
      json(res, 201, { token: t.token, createdAt: t.createdAt, rotated: t.rotated, hint: '…' + t.id.slice(-4) });
    }),

    'DELETE /api/nutrition/health/token': guarded(async (req, res, user) => { json(res, 200, { revoked: await health.revokeToken(user.id) }); }),

    // "Eat back": off by default; adds a share of the day's active calories to the calorie goal.
    'PUT /api/nutrition/health/settings': guarded(async (req, res, user) => {
      const eb = (await readBody(req, BODY.tiny))?.eatBack;
      if (!eb || typeof eb.enabled !== 'boolean' || !Number.isInteger(eb.percent) || eb.percent < 0 || eb.percent > 100) return fail(res, 400, 'eatBack must be { enabled: true|false, percent: a whole number from 0 to 100 }');
      json(res, 200, { eatBack: await health.setEatBack(user.id, eb) });
    }),

    /* ----- AI logging: a draft only. Nothing is saved until the person confirms it (POST /entries) ----- */

    'POST /api/nutrition/analyze': guarded(async (req, res, user) => {
      const input = checkInput(await readBody(req, BODY.photo));
      if (!input.ok) return fail(res, 400, input.error);
      const limit = cfg.load().aiDailyCap;
      if (limit === 0) return json(res, 403, { error: 'AI logging is switched off by an admin.', code: 'ai-off', ai: allowance(user.id) });
      const avail = availability(user.id);
      if (!avail.ok) return aiFail(res, avail.code, user.id);
      const slot = await store.reserveAi(user.id, limit);
      if (!slot.ok) return aiFail(res, 'cap', user.id);
      let result;
      try { result = await analyzer.analyze(user.id, input); }
      catch (e) { await store.refundAi(user.id); throw e; }
      if (!result.ok) {
        if (result.refund) await store.refundAi(user.id);
        return aiFail(res, result.code, user.id, result.detail);
      }
      json(res, 200, { draft: result.draft, ms: result.ms, calls: result.calls, ai: allowance(user.id) });
    }),

    /* ----- Fill in micronutrients from USDA stand-ins. Nothing is saved until the person accepts (apply). -----
       match: one AI call for the whole batch, only to pick which USDA food is the closest; every number comes from USDA. */

    'POST /api/nutrition/micros/match': guarded(async (req, res, user) => {
      const body = await readBody(req, BODY.small);
      const date = dateOf(res, body?.date); if (!date) return;
      const ids = Array.isArray(body?.ids) && body.ids.every(v.validId) ? [...new Set(body.ids)] : null;
      if (!ids || !ids.length || ids.length > standin.MAX_BATCH) return fail(res, 400, `ids must list 1 to ${standin.MAX_BATCH} entries`);
      const usdaKey = cfg.usdaKey();
      if (!usdaKey) return json(res, 409, { error: 'Filling in micronutrients needs the USDA key (an admin adds it under Goals → Admin).', code: 'no-usda', ai: allowance(user.id) });
      const limit = cfg.load().aiDailyCap;
      if (limit === 0) return json(res, 403, { error: 'AI logging is switched off by an admin.', code: 'ai-off', ai: allowance(user.id) });
      const avail = availability(user.id);
      if (!avail.ok) return aiFail(res, avail.code, user.id);
      if (throttled(res, user)) return;

      const entries = store.read(user.id).days[date]?.entries || [];
      const results = new Map();
      const work = [];
      for (const id of ids) {
        const e = entries.find(x => x.id === id);
        const why = standin.skipReason(e, { replace: body.replace === true });
        if (why) results.set(id, { id, status: 'skipped', why });
        else work.push({ key: 'e' + (work.length + 1), id, entry: e });
      }
      if (!work.length) return json(res, 200, { results: ids.map(id => results.get(id)), ms: 0, ai: allowance(user.id) });

      // The allowance is reserved BEFORE USDA is asked, so a caller cannot use the shared USDA key for free by never
      // reaching the model. It is given back when nothing was asked of the model (USDA found nothing, or could not be
      // searched) and when the model never ran; it stays spent once the model has run.
      const slot = await store.reserveAi(user.id, limit);
      if (!slot.ok) return aiFail(res, 'cap', user.id);
      let reserved = true;
      const giveBack = async () => { if (reserved) { reserved = false; await store.refundAi(user.id); } };
      let picks = new Map();
      let ms = 0;
      let asked = [];
      try {
        // The candidates for each food. A food with none, or whose search failed, never reaches the model.
        const usdaProblems = [];
        await mapLimit(work, 3, async w => {
          try { w.candidates = await lookup.usdaCandidates(w.entry.name, w.entry.brand, usdaKey, { uid: user.id }); }
          catch (e) { w.candidates = []; usdaProblems.push(e instanceof LookupError ? describeFailure('USDA FoodData Central', e) : 'USDA FoodData Central could not be reached.'); }
        });
        asked = work.filter(w => w.candidates.length);
        for (const w of work) if (!w.candidates.length) results.set(w.id, { id: w.id, status: 'none', reason: usdaProblems.length ? 'USDA could not be searched for this food.' : 'USDA has nothing like this food.', candidates: [] });
        if (!asked.length) {
          await giveBack();
          if (usdaProblems.length === work.length) return fail(res, 502, usdaProblems[0]);
        } else {
          const allowed = new Map(asked.map(w => [w.key, new Set(w.candidates.map(c => c.fdcId))]));
          const r = await analyzer.ask(user.id, { prompt: standin.buildPrompt(asked), systemPrompt: standin.SYSTEM, validate: standin.validateMatches(allowed) });
          if (!r.ok) {
            if (r.refund) await giveBack();                     // the model never ran: nothing was spent
            else reserved = false;                              // it ran (timeout, unreadable answer): spent
            return aiFail(res, r.code, user.id, r.detail);
          }
          reserved = false;
          picks = r.result; ms = r.ms;
        }
      } catch (e) { await giveBack(); throw e; }
      // Then the numbers, from USDA, for each pick.
      await mapLimit(asked, 3, async w => {
        const pick = picks.get(w.key);
        const base = { id: w.id, candidates: w.candidates, reason: pick.reason };
        if (pick.fdcId == null) { results.set(w.id, { ...base, status: 'none' }); return; }
        try {
          const food = await lookup.usdaFood(pick.fdcId, usdaKey, { uid: user.id });
          results.set(w.id, food ? { ...base, status: 'match', confidence: pick.confidence, preview: standin.preview(w.entry, food) } : { ...base, status: 'none', reason: 'USDA no longer has that food.' });
        } catch (e) { results.set(w.id, { ...base, status: 'none', reason: e instanceof LookupError ? describeFailure('USDA FoodData Central', e) : 'USDA could not be reached.' }); }
      });
      json(res, 200, { results: ids.map(id => results.get(id)), ms, ai: allowance(user.id) });
    }),

    // The numbers for one USDA food the person picked from the candidates (no AI, no allowance).
    'POST /api/nutrition/micros/preview': guarded(async (req, res, user) => {
      const body = await readBody(req, BODY.tiny);
      const date = dateOf(res, body?.date); if (!date) return;
      const id = idOf(res, body?.id); if (!id) return;
      const usdaKey = cfg.usdaKey();
      if (!usdaKey) return json(res, 409, { error: 'Filling in micronutrients needs the USDA key.', code: 'no-usda' });
      if (throttled(res, user)) return;
      const e = (store.read(user.id).days[date]?.entries || []).find(x => x.id === id);
      if (!e) return fail(res, 404, 'no such entry');
      if (!Number.isInteger(body?.fdcId) || body.fdcId < 1) return fail(res, 400, 'fdcId must be a whole number');
      try {
        const food = await lookup.usdaFood(body.fdcId, usdaKey, { uid: user.id });
        if (!food) return fail(res, 404, 'USDA has no such food');
        json(res, 200, { preview: standin.preview(e, food) });
      } catch (err) { fail(res, 502, err instanceof LookupError ? describeFailure('USDA FoodData Central', err) : 'USDA could not be reached.'); }
    }),

    // Accept (fdcId) or remove (remove: true) a stand-in. The numbers are fetched from USDA and scaled here, never taken from the client.
    'POST /api/nutrition/micros/apply': guarded(async (req, res, user) => {
      const body = await readBody(req, BODY.tiny);
      const date = dateOf(res, body?.date); if (!date) return;
      const id = idOf(res, body?.id); if (!id) return;
      if (body?.remove === true) {
        const out = await store.mutate(user.id, d => {
          const hit = store.findEntry(d, date, id);
          if (!hit) return null;
          delete hit.entry.microsEst;
          return { entry: hit.entry, day: store.dayView(d, date) };
        });
        return out ? json(res, 200, out) : fail(res, 404, 'no such entry');
      }
      if (!Number.isInteger(body?.fdcId) || body.fdcId < 1) return fail(res, 400, 'fdcId must be a whole number');
      const usdaKey = cfg.usdaKey();
      if (!usdaKey) return json(res, 409, { error: 'Filling in micronutrients needs the USDA key.', code: 'no-usda' });
      if (throttled(res, user)) return;
      const e = (store.read(user.id).days[date]?.entries || []).find(x => x.id === id);
      if (!e) return fail(res, 404, 'no such entry');
      const why = standin.skipReason(e, { replace: true });
      if (why === 'supplement' || why === 'has-data') return fail(res, 409, why === 'supplement' ? 'supplements are not estimated' : 'this entry already has its own vitamins and minerals');
      let food;
      try { food = await lookup.usdaFood(body.fdcId, usdaKey); }
      catch (err) { return fail(res, 502, err instanceof LookupError ? describeFailure('USDA FoodData Central', err) : 'USDA could not be reached.'); }
      if (!food) return fail(res, 404, 'USDA has no such food');
      const p = standin.preview(e, food);
      if (!p.ok) return fail(res, 422, p.why);
      if (p.empty) return fail(res, 422, 'that USDA food has no vitamins or minerals to add');
      const rec = standin.estimateRecord(e, p, body.confidence);
      const checked = microsOf(rec.micros);
      if (!checked.ok) return fail(res, 422, checked.error);
      rec.micros = checked.value;
      const out = await store.mutate(user.id, d => {
        const hit = store.findEntry(d, date, id);
        if (!hit) return null;
        hit.entry.microsEst = rec;
        return { entry: hit.entry, day: store.dayView(d, date) };
      });
      out ? json(res, 200, out) : fail(res, 404, 'no such entry');
    }),

    // Opt in or out of letting the Coach read a numbers-only summary (never writes anything).
    'PUT /api/nutrition/coach-share': guarded(async (req, res, user) => {
      const body = await readBody(req, BODY.tiny);
      if (typeof body?.share !== 'boolean') return fail(res, 400, 'share must be true or false');
      await store.mutate(user.id, d => { d.coachShare = body.share; });
      json(res, 200, { share: body.share });
    }),

    'GET /api/nutrition/goals': guarded(async (req, res, user) => {
      json(res, 200, { goals: store.read(user.id).goals });
    }),

    'PUT /api/nutrition/goals': guarded(async (req, res, user) => {
      const checked = v.goals(await readBody(req, BODY.tiny));
      if (!checked.ok) return invalid(res, checked);
      const goals = await store.mutate(user.id, d => (d.goals = Object.values(checked.value).some(x => x != null) ? checked.value : null));
      json(res, 200, { goals });
    }),

    /* ------------------------------ admin ------------------------------ */

    'GET /api/admin/nutrition': async (req, res) => {
      if (!requireAdmin(req, res)) return;
      json(res, 200, { ...cfg.load(), usdaKeyHint: cfg.usdaKeyHint(), fatsecretIdHint: cfg.fatsecretIdHint(), fatsecretUsage: fatsecret.usage?.snapshot?.() ?? null, usdaUsage: usdaBudget.snapshot(), fatsecretLast: fatsecret.status?.().lastError ?? null, aiCapMax: cfg.AI_CAP_MAX, aiCapDefault: cfg.AI_CAP_DEFAULT });
    },

    'PUT /api/admin/nutrition': async (req, res) => {
      if (!requireAdmin(req, res)) return;
      const body = await readBody(req, BODY.small);
      const r = cfg.save(body);
      if (!r.ok) return r.damaged ? json(res, 409, { error: r.error, code: 'config-damaged' }) : fail(res, 400, r.error);
      if (body && typeof body === 'object' && body.fatsecret !== undefined) fatsecret.forget();     // a new pair starts with no cached token or results
      if (!r.config.healthDebug) haeDebug.clear();
      json(res, 200, { ...r.config, usdaKeyHint: cfg.usdaKeyHint(), fatsecretIdHint: cfg.fatsecretIdHint(), fatsecretUsage: fatsecret.usage?.snapshot?.() ?? null, usdaUsage: usdaBudget.snapshot(), fatsecretLast: fatsecret.status?.().lastError ?? null, aiCapMax: cfg.AI_CAP_MAX, aiCapDefault: cfg.AI_CAP_DEFAULT });
    },

    // A damaged settings file: put the backup (made before the last save) back. Only valid while the file is damaged.
    'POST /api/admin/nutrition/restore-config': async (req, res) => {
      if (!requireAdmin(req, res)) return;
      const r = cfg.restoreBackup();
      if (!r.ok) return fail(res, 409, r.error);
      json(res, 200, { ...r.config, usdaKeyHint: cfg.usdaKeyHint(), fatsecretIdHint: cfg.fatsecretIdHint() });
    },

    // Checks the stored FatSecret keys: a token (and the scopes it grants), then one tiny search. Not counted against the daily
    // budget. The answer is a verdict with FatSecret's code and message (sanitised); neither the keys nor the token are in it.
    'POST /api/admin/nutrition/test-fatsecret': async (req, res) => {
      if (!requireAdmin(req, res)) return;
      const creds = cfg.fatsecretCreds();
      if (!creds) return fail(res, 400, 'no FatSecret keys are set');
      const t0 = Date.now();
      const r = await fatsecret.test(creds);
      json(res, 200, { ok: !!(r.token.ok && r.search?.ok), token: r.token, search: r.search, ms: Date.now() - t0 });
    },

    // Checks the stored USDA key with a real search, so the admin knows before anyone else finds out.
    'POST /api/admin/nutrition/test-usda': async (req, res) => {
      if (!requireAdmin(req, res)) return;
      const key = cfg.usdaKey();
      if (!key) return fail(res, 400, 'no USDA key is set');
      const t0 = Date.now();
      const r = await lookup.search('apple', { usdaKey: key, sources: 'usda', fresh: true });
      const s = r.sources.usda;
      json(res, 200, { ok: !!s?.ok, error: s?.error || null, kind: s?.kind || null, ms: Date.now() - t0, count: s?.count ?? 0 });
    }
  };
}
