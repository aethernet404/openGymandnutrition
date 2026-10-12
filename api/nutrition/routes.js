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

const URL_BASE = 'http://x';
const query = req => new URL(req.url, URL_BASE).searchParams;

export function nutritionRoutes({ json, readBody, readSession, requireAdmin }) {
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
      json(res, 200, { ai: { limit: c.aiDailyCap, used, remaining: Math.max(0, c.aiDailyCap - used) }, meals: v.MEALS });
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
        // A batch inherits the day's meal unless an entry names its own.
        const checked = v.entry({ ...(Array.isArray(body.entries) && body.meal ? { meal: body.meal } : {}), ...r });
        if (!checked.ok) return invalid(res, checked);
        list.push(checked.value);
      }
      const out = await store.mutate(user.id, d => {
        for (const e of list) {
          const problem = resolveFood(d, e);
          if (problem) return { error: problem };
          if (e.foodId && d.foods[e.foodId]) { const f = d.foods[e.foodId]; f.useCount = (f.useCount || 0) + 1; f.lastUsed = Date.now(); }
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
      json(res, 200, { ...cfg.load(), aiCapMax: cfg.AI_CAP_MAX, aiCapDefault: cfg.AI_CAP_DEFAULT });
    },

    'PUT /api/admin/nutrition': async (req, res) => {
      if (!requireAdmin(req, res)) return;
      const r = cfg.save(await readBody(req));
      if (!r.ok) return fail(res, 400, r.error);
      json(res, 200, r.config);
    }
  };
}
