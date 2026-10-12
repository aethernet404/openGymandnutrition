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
import { createLookup, cleanBarcode } from './lookup.js';
import { createWindow } from '../rate-limit.js';
import { createAnalyzer, availability, checkInput, FAILURES } from './analyze.js';

const URL_BASE = 'http://x';
const query = req => new URL(req.url, URL_BASE).searchParams;

export function nutritionRoutes({ json, readBody, readSession, requireAdmin, lookup = createLookup(), analyzer = createAnalyzer() }) {
  // Lookups go out to third parties from this server's address, so they are budgeted per profile.
  const lookups = createWindow({ max: 40, windowMs: 60000 });
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

  const dateOf = (res, s) => { const r = v.dateParam(s); if (!r.ok) { invalid(res, r); return null; } return r.value; };

  /** Fill macros from a food × qty when the client sent a foodId and no numbers. */
  function resolveFood(d, e) {
    if (!e.needsFood) return null;
    const f = d.foods[e.foodId];
    if (!f) return 'that food no longer exists';
    const q = e.qty ?? 1;
    e.calories = Math.round(f.per.calories * q);
    for (const k of ['protein_g', 'carbs_g', 'fat_g']) e[k] = v.round(f.per[k] * q, 1);
    e.name ||= f.name; e.brand ||= f.brand; e.serving ||= f.serving.label;
    if (e.grams === undefined && f.serving.grams) e.grams = v.round(f.serving.grams * q, 1);
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
        lookup: { off: true, usda: c.usdaKeySet }, meals: v.MEALS,
        // Whether there is a Coach to share with at all, and whether this profile has chosen to.
        coach: { available: coachCfg.isEnabled() && coachCfg.isConnected(), share: d.coachShare === true }
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
      const body = await readBody(req);
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
          if (!['off', 'usda', 'ai'].includes(f.value.source) || (f.value.source !== 'ai' && !f.value.ext)) return fail(res, 400, 'a looked-up food needs its source and id');
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
          if (!counted && e.foodId && d.foods[e.foodId]) { const f = d.foods[e.foodId]; f.useCount = (f.useCount || 0) + 1; f.lastUsed = Date.now(); }
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
      const id = String(q.get('id') || '').slice(0, 40); if (!id) return fail(res, 400, 'id is required');
      const body = await readBody(req);
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
      const id = String(q.get('id') || '').slice(0, 40); if (!id) return fail(res, 400, 'id is required');
      const out = await store.mutate(user.id, d => store.deleteEntry(d, date, id) ? { day: store.dayView(d, date) } : null);
      if (!out) return fail(res, 404, 'no such entry');
      json(res, 200, out);
    }),

    // Query: scope = all | custom | favorite | recent, q = text filter.
    'GET /api/nutrition/foods': guarded(async (req, res, user) => {
      const q = query(req);
      const scope = q.get('scope') || 'all';
      if (!['all', 'custom', 'favorite', 'recent'].includes(scope)) return fail(res, 400, 'scope must be all, custom, favorite or recent');
      json(res, 200, { foods: store.listFoods(store.read(user.id), { scope, q: String(q.get('q') || '').slice(0, 80) }) });
    }),

    'POST /api/nutrition/foods': guarded(async (req, res, user) => {
      const body = await readBody(req);
      const checked = v.food(body);
      if (!checked.ok) return invalid(res, checked);
      const food = await store.mutate(user.id, d => store.addFood(d, { ...checked.value, source: 'custom' }));
      json(res, 201, { food });
    }),

    // Edit a food (any of its fields), or just favourite it. Entries already logged keep their numbers.
    'PUT /api/nutrition/foods': guarded(async (req, res, user) => {
      const id = String(query(req).get('id') || '').slice(0, 40); if (!id) return fail(res, 400, 'id is required');
      const body = await readBody(req);
      const checked = v.food(body, { partial: true });
      if (!checked.ok) return invalid(res, checked);
      const food = await store.mutate(user.id, d => {
        const f = d.foods[id];
        if (!f) return null;
        // A search result or AI recent is a snapshot of someone else's data: only its favourite
        // flag is the user's to change. Editing it means saving it as their own custom food.
        const patch = f.source === 'custom' ? checked.value : { favorite: checked.value.favorite ?? f.favorite };
        delete patch.source;
        return Object.assign(f, patch);
      });
      if (!food) return fail(res, 404, 'no such food');
      json(res, 200, { food });
    }),

    'DELETE /api/nutrition/foods': guarded(async (req, res, user) => {
      const id = String(query(req).get('id') || '').slice(0, 40); if (!id) return fail(res, 400, 'id is required');
      const ok = await store.mutate(user.id, d => (d.foods[id] ? (delete d.foods[id], true) : false));
      if (!ok) return fail(res, 404, 'no such food');
      json(res, 200, { ok: true });
    }),

    /* ----- lookups: Open Food Facts always; USDA once an admin has set a key ----- */

    'GET /api/nutrition/search': guarded(async (req, res, user) => {
      const q = v.clean(query(req).get('q'), 80);
      if (q.length < 2) return fail(res, 400, 'type at least two letters to search');
      const source = query(req).get('source') || 'all';
      if (!['all', 'off', 'usda'].includes(source)) return fail(res, 400, 'source must be all, off or usda');
      if (throttled(res, user)) return;
      json(res, 200, { q, ...(await lookup.search(q, { usdaKey: cfg.usdaKey(), sources: source })) });
    }),

    'GET /api/nutrition/barcode': guarded(async (req, res, user) => {
      const code = cleanBarcode(query(req).get('code'));
      if (!code) return fail(res, 400, 'a barcode is 8 to 14 digits');
      if (throttled(res, user)) return;
      json(res, 200, { code, ...(await lookup.barcode(code)) });
    }),

    /* ----- AI logging: a draft only. Nothing is saved until the person confirms it (POST /entries) ----- */

    'POST /api/nutrition/analyze': guarded(async (req, res, user) => {
      const input = checkInput(await readBody(req));
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

    // Opt in or out of letting the Coach read a numbers-only summary (never writes anything).
    'PUT /api/nutrition/coach-share': guarded(async (req, res, user) => {
      const body = await readBody(req);
      if (typeof body?.share !== 'boolean') return fail(res, 400, 'share must be true or false');
      await store.mutate(user.id, d => { d.coachShare = body.share; });
      json(res, 200, { share: body.share });
    }),

    'GET /api/nutrition/goals': guarded(async (req, res, user) => {
      json(res, 200, { goals: store.read(user.id).goals });
    }),

    'PUT /api/nutrition/goals': guarded(async (req, res, user) => {
      const checked = v.goals(await readBody(req));
      if (!checked.ok) return invalid(res, checked);
      const goals = await store.mutate(user.id, d => (d.goals = Object.values(checked.value).some(x => x != null) ? checked.value : null));
      json(res, 200, { goals });
    }),

    /* ------------------------------ admin ------------------------------ */

    'GET /api/admin/nutrition': async (req, res) => {
      if (!requireAdmin(req, res)) return;
      json(res, 200, { ...cfg.load(), usdaKeyHint: cfg.usdaKeyHint(), aiCapMax: cfg.AI_CAP_MAX, aiCapDefault: cfg.AI_CAP_DEFAULT });
    },

    'PUT /api/admin/nutrition': async (req, res) => {
      if (!requireAdmin(req, res)) return;
      const r = cfg.save(await readBody(req));
      if (!r.ok) return fail(res, 400, r.error);
      json(res, 200, { ...r.config, usdaKeyHint: cfg.usdaKeyHint(), aiCapMax: cfg.AI_CAP_MAX, aiCapDefault: cfg.AI_CAP_DEFAULT });
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
