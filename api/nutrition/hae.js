/* Health Auto Export (the iPhone app by Lybron Sobers) → one day's Active Energy, Resting Energy
 * and Steps.
 *
 * The app's Automations → REST API option POSTs a JSON document; this reads the part of it that
 * matters and ignores the rest. What is relied on, and how sure we are of it:
 *
 *   SHAPE   { "data": { "metrics": [ { "name", "units", "data": [ { "date", "qty", "source" } ] } ],
 *                       "workouts": [ … ] } }
 *           Confirmed by the code of two open-source receivers (irvinlim/apple-health-ingester,
 *           anym001/healthlog). `{ "metrics": [...] }` without the `data` wrapper is accepted too.
 *   NAMES   active_energy · basal_energy_burned · step_count (snake_case). Confirmed in a bug report
 *           against v10.0.4 (Lybron/health-auto-export #78) and healthlog. Spellings the app's
 *           display names suggest (active_energy_burned, basal_energy, resting_energy, steps) are
 *           also accepted; those are NOT confirmed.
 *   UNITS   the metric's `units` string, overridable per point (healthlog does the same): "kcal",
 *           "kJ" (the app can deliver energy in kJ, depending on its unit settings), "count" for
 *           steps. Anything else is refused by name, not guessed at.
 *   DATES   "2026-10-13 14:05:00 +0100" (also accepted: ISO "2026-10-13T14:05:00+01:00", and the
 *           12-hour form "2026-10-13 2:05:00 PM +0100", with ordinary or narrow no-break spaces).
 *           The day a point belongs to is the date AS WRITTEN — the wall-clock date at the offset the
 *           app attached — i.e. the phone's own local day, which is what the diary uses.
 *   MANY POINTS   If the app summarises (Summarize Data on, grouping Days) there is one point per day
 *           and it is the day's total. If it groups by hour or minute, or sends raw samples, there are
 *           many, and the day's number is their sum. Both work the same way here.
 *
 * ALSO READ (display only, never part of Burned or Net):
 *   WORKOUTS  data.workouts[] = { name, start, end, duration (seconds), activeEnergyBurned:{qty,units},
 *             distance:{qty,units} } — the shape documented for the app's Workouts export and used by the
 *             open-source receivers. `activeEnergy` is accepted as an alternative to activeEnergyBurned.
 *             A workout whose energy can't be read is kept without calories; its day is the date of `start`.
 *   EXERCISE  metric apple_exercise_time, "min" — the day's total.
 *   WEIGHT    metric weight_body_mass, "kg" or "lb" (converted to kg, stored as kg; the app shows the
 *             user's own unit). The latest reading of a day stands for that day.
 * Everything else (stand hours, flights, nutrition, symptoms, …) is ignored by name and never stored.
 * A problem in one of these extras is a warning; it never stops the energy numbers from being stored.
 *
 * NOT verified (no sample from the real app was available): whether zero-valued intervals are
 * sent; whether raw, unsummarised samples from several sources (iPhone + Watch) are already
 * de-duplicated — a warning is returned when several sources contribute to one day; the exact text
 * of every unit string. The admin debug capture (hae-debug.js) exists to settle these from a real
 * payload.
 */
import { round } from './validate.js';

export const NAMES = {
  active: ['active_energy', 'active_energy_burned'],
  resting: ['basal_energy_burned', 'basal_energy', 'resting_energy', 'resting_energy_burned'],
  steps: ['step_count', 'steps'],
  exercise: ['apple_exercise_time', 'exercise_time', 'exercise_minutes'],
  weight: ['weight_body_mass', 'body_mass', 'body_weight', 'weight']
};
const KIND_OF = Object.fromEntries(Object.entries(NAMES).flatMap(([kind, list]) => list.map(n => [n, kind])));
export const canonicalName = n => String(n ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');

export const LIMITS = { metrics: 500, points: 200000, sources: 20, workouts: 500, workoutsPerDay: 20, exerciseMin: 1440, workoutSec: 86400, workoutKcal: 10000, workoutKm: 1000, weightKg: [20, 500] };

/* ------------------------------ dates ------------------------------ */

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:[.,]\d+)?)?)?\s?([AaPp]\.?[Mm]\.?)?\s?(Z|[+-]\d{2}(?::?\d{2})?)?$/;

/**
 * @returns {{ date:string, minutes:number, offset:string|null } | null}  the local calendar day and
 *          minute of day as written, plus the offset text if there was one.
 */
export function parseDate(s) {
  if (typeof s !== 'string') return null;
  const m = DATE_RE.exec(s.replace(/[\s  ]+/g, ' ').trim());
  if (!m) return null;
  const [, y, mo, d, hh, mm, , ap, off] = m;
  const date = `${y}-${mo}-${d}`;
  const check = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(check.getTime()) || check.toISOString().slice(0, 10) !== date) return null;
  let h = hh === undefined ? 0 : +hh;
  const min = mm === undefined ? 0 : +mm;
  if (ap) {
    if (h < 1 || h > 12) return null;
    const pm = /^p/i.test(ap);
    h = h % 12 + (pm ? 12 : 0);
  }
  if (h > 23 || min > 59) return null;
  return { date, minutes: h * 60 + min, offset: off || null };
}

/* ------------------------------ units ------------------------------ */

const KCAL_PER_KJ = 1 / 4.184;
/** A factor to kilocalories for an energy unit string, or null if it is not one we know. */
export function energyFactor(u) {
  const raw = String(u ?? '').trim();
  if (raw === 'Cal') return 1;                                  // the "large" calorie, i.e. the kcal on a food label
  const x = raw.toLowerCase();
  if (['kcal', 'kcals', 'kilocalorie', 'kilocalories'].includes(x)) return 1;
  if (x === 'cal' || x === 'calorie' || x === 'calories') return 0.001;       // the small calorie
  if (['kj', 'kilojoule', 'kilojoules'].includes(x)) return KCAL_PER_KJ;
  return null;
}
export const stepsUnitOk = u => ['', 'count', 'counts', 'step', 'steps'].includes(String(u ?? '').trim().toLowerCase());

/** Factor to minutes, or null. */
export function minutesFactor(u) {
  const x = String(u ?? '').trim().toLowerCase();
  if (['', 'min', 'mins', 'minute', 'minutes'].includes(x)) return 1;
  if (['s', 'sec', 'secs', 'second', 'seconds'].includes(x)) return 1 / 60;
  if (['h', 'hr', 'hrs', 'hour', 'hours'].includes(x)) return 60;
  return null;
}
/** Factor to kilograms, or null. */
export function massFactor(u) {
  const x = String(u ?? '').trim().toLowerCase();
  if (['kg', 'kgs', 'kilogram', 'kilograms'].includes(x)) return 1;
  if (['lb', 'lbs', 'pound', 'pounds'].includes(x)) return 0.45359237;
  if (['st', 'stone', 'stones'].includes(x)) return 6.35029318;
  if (['g', 'gram', 'grams'].includes(x)) return 0.001;
  return null;
}
/** Factor to kilometres, or null. */
export function distanceFactor(u) {
  const x = String(u ?? '').trim().toLowerCase();
  if (['km', 'kilometer', 'kilometers', 'kilometre', 'kilometres'].includes(x)) return 1;
  if (['m', 'meter', 'meters', 'metre', 'metres'].includes(x)) return 0.001;
  if (['mi', 'mile', 'miles'].includes(x)) return 1.609344;
  if (['yd', 'yard', 'yards'].includes(x)) return 0.0009144;
  return null;
}
const isQty = o => o && typeof o === 'object' && typeof o.qty === 'number' && Number.isFinite(o.qty);

/** One workout object → { ok, workout:{date,time,name,duration_min,kcal,km,key}, reason }. */
function parseWorkout(w) {
  if (!w || typeof w !== 'object' || Array.isArray(w)) return { reason: 'not an object' };
  const when = parseDate(w.start ?? w.date);
  if (!when) return { reason: 'no readable start time' };
  const name = typeof w.name === 'string' ? w.name.replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 60) : '';
  if (!name) return { reason: 'no name' };
  let sec = typeof w.duration === 'number' && Number.isFinite(w.duration) ? w.duration : null;
  if (sec == null && w.end) {                                           // end − start, when both carry the same offset
    const end = parseDate(w.end);
    if (end && end.date === when.date && end.minutes >= when.minutes) sec = (end.minutes - when.minutes) * 60;
  }
  if (sec == null || sec <= 0 || sec > LIMITS.workoutSec) return { reason: 'no plausible duration' };
  const e = w.activeEnergyBurned ?? w.activeEnergy;
  let kcal = null;
  if (isQty(e)) {
    const f = energyFactor(e.units);
    if (f != null && e.qty >= 0 && e.qty * f <= LIMITS.workoutKcal) kcal = round(e.qty * f, 0);
  }
  let km = null;
  if (isQty(w.distance)) {
    const f = distanceFactor(w.distance.units);
    if (f != null && w.distance.qty > 0 && w.distance.qty * f <= LIMITS.workoutKm) km = round(w.distance.qty * f, 2);
  }
  const hh = String(Math.floor(when.minutes / 60)).padStart(2, '0'), mm = String(when.minutes % 60).padStart(2, '0');
  return { workout: { date: when.date, time: `${hh}:${mm}`, name, duration_min: Math.max(1, Math.round(sec / 60)), kcal, km, key: `${w.id ?? ''}|${w.start}|${name}` } };
}

/* ------------------------------ the payload ------------------------------ */

const keysOf = o => (o && typeof o === 'object' && !Array.isArray(o) ? Object.keys(o).slice(0, 12).map(k => String(k).replace(/[^\w .-]/g, '').slice(0, 30)).join(', ') || '(none)' : Array.isArray(o) ? '(an array)' : '(' + typeof o + ')');
const EXPECTED = '{"data":{"metrics":[{"name":"active_energy","units":"kcal","data":[{"date":"2026-10-13 00:00:00 +0100","qty":512}]}, …]}}';

const fail = (code, error) => ({ ok: false, code, error });

/**
 * @returns {{ ok:true, activity:{date:string, exercise_min:number|null, exercise_covers:boolean, workouts:object[]|null}[], weights:{date:string, kg:number}[], days:{date:string, active_kcal:number, resting_kcal:number, steps:number|null, covers:boolean, warnings:string[]}[],
 *             ignoredMetrics:string[], warnings:string[], stats:{metrics:number, points:number, duplicates:number, badPoints:number} }
 *         | { ok:false, code:'shape'|'wrong-type'|'metrics'|'units'|'dates'|'too-large', error:string }}
 */
export function parseHae(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return fail('shape', `The body is not a JSON object. Health Auto Export's REST API sends ${EXPECTED}. Check the automation's Export Format is JSON.`);
  }
  const root = body.data !== undefined ? body.data : body;
  if (!root || typeof root !== 'object' || Array.isArray(root)) {
    return fail('shape', `"data" is not an object (the payload has these top-level keys: ${keysOf(body)}). Expected ${EXPECTED}. Choose Export Version v2 and Data Type Health Metrics.`);
  }
  const workoutsIn = Array.isArray(root.workouts) ? root.workouts : [];
  if (!Array.isArray(root.metrics)) {
    if (workoutsIn.length) {
      const anyReadable = workoutsIn.slice(0, 50).some(w => parseWorkout(w).workout);
      if (!anyReadable) return fail('wrong-type', 'This is a Workouts export. In the automation set Data Type to Health Metrics (and pick Active Energy, Resting Energy and Step Count).');
    } else return fail('shape', `No "metrics" list found (keys under the payload: ${keysOf(root)}). Expected ${EXPECTED}. Set Data Type to Health Metrics.`);
  }
  const metricsIn = Array.isArray(root.metrics) ? root.metrics : [];
  if (metricsIn.length > LIMITS.metrics) return fail('too-large', `The export has ${metricsIn.length} metrics; choose only Active Energy, Resting Energy, Step Count, Exercise Minutes and Weight.`);
  if (workoutsIn.length > LIMITS.workouts) return fail('too-large', `The export has ${workoutsIn.length} workouts; set the Date Range to Today.`);

  const found = { active: false, resting: false, steps: false, exercise: false, weight: false };
  const exercise = new Map();                     // date → { min, first }
  const weightsByDay = new Map();                 // date → { minutes, kg }
  const perDay = new Map();                       // date → { active, resting, steps, first, sources:{kind:Set}, points:{kind:n} }
  const ignored = new Set();
  const seen = new Set();
  const warnings = [];
  const stats = { metrics: metricsIn.length, points: 0, duplicates: 0, badPoints: 0 };
  let totalPoints = 0;

  for (const metric of metricsIn) {
    if (!metric || typeof metric !== 'object' || typeof metric.name !== 'string') continue;
    const kind = KIND_OF[canonicalName(metric.name)];
    if (!kind) { if (ignored.size < 20) ignored.add(String(metric.name).replace(/[^\w .\-()]/g, '').slice(0, 40)); continue; }
    found[kind] = true;
    const points = Array.isArray(metric.data) ? metric.data : [];
    totalPoints += points.length;
    if (totalPoints > LIMITS.points) return fail('too-large', 'The export has too many data points. Use Time Grouping by Hours or Days, and a date range of Today.');
    if (kind === 'exercise' || kind === 'weight') {
      // Extras: a problem here is a warning, never a reason to drop the energy numbers.
      let skippedPts = 0;
      for (const p of points) {
        const when = p && typeof p === 'object' ? parseDate(p.date) : null;
        const unit = (p && p.units) ?? metric.units;
        const f = kind === 'exercise' ? minutesFactor(unit) : massFactor(unit);
        if (f == null) { warnings.push(`${metric.name}: units "${String(unit ?? '').slice(0, 20)}" are not understood, so ${kind === 'exercise' ? 'exercise minutes' : 'weight'} was skipped.`); break; }
        if (!when || typeof p.qty !== 'number' || !Number.isFinite(p.qty) || p.qty < 0) { skippedPts++; continue; }
        const v = p.qty * f;
        if (kind === 'exercise') {
          if (v > LIMITS.exerciseMin) { skippedPts++; continue; }
          const d = exercise.get(when.date) || { min: 0, first: Infinity };
          d.min += v; d.first = Math.min(d.first, when.minutes); exercise.set(when.date, d);
        } else {
          if (v < LIMITS.weightKg[0] || v > LIMITS.weightKg[1]) { skippedPts++; continue; }
          const w = weightsByDay.get(when.date);
          if (!w || when.minutes >= w.minutes) weightsByDay.set(when.date, { minutes: when.minutes, kg: round(v, 2) });
        }
      }
      if (skippedPts) warnings.push(`${skippedPts} ${kind === 'exercise' ? 'exercise-minute' : 'weight'} point(s) were unreadable or not plausible and were skipped.`);
      continue;
    }
    for (const p of points) {
      if (!p || typeof p !== 'object') { stats.badPoints++; continue; }
      const when = parseDate(p.date);
      const q = p.qty;
      if (!when || typeof q !== 'number' || !Number.isFinite(q)) { stats.badPoints++; continue; }
      const unit = p.units ?? metric.units;
      let value;
      if (kind === 'steps') {
        if (!stepsUnitOk(unit)) return fail('units', `${metric.name} has units "${String(unit).slice(0, 20)}", but steps should be "count".`);
        value = q;
      } else {
        const f = energyFactor(unit);
        if (f == null) return fail('units', `${metric.name} has units "${String(unit ?? '').slice(0, 20)}", which cannot be converted. Expected kcal or kJ.`);
        value = q * f;
      }
      if (value < 0) { stats.badPoints++; continue; }
      const source = typeof p.source === 'string' ? p.source.slice(0, 60) : '';
      const key = `${kind}|${p.date}|${source}|${q}`;
      if (seen.has(key)) { stats.duplicates++; continue; }          // the same sample twice in one payload
      seen.add(key);
      stats.points++;
      let day = perDay.get(when.date);
      if (!day) { day = { active: 0, resting: 0, steps: 0, first: Infinity, sources: { active: new Set(), resting: new Set(), steps: new Set() }, n: { active: 0, resting: 0, steps: 0 } }; perDay.set(when.date, day); }
      day[kind] += value;
      day.n[kind]++;
      day.first = Math.min(day.first, when.minutes);
      if (source && day.sources[kind].size < LIMITS.sources) day.sources[kind].add(source);
    }
  }

  // Workouts
  const workoutsByDay = new Map();
  let workoutsSkipped = 0;
  const seenW = new Set();
  for (const w of workoutsIn) {
    const r = parseWorkout(w);
    if (!r.workout) { workoutsSkipped++; continue; }
    if (seenW.has(r.workout.key)) { stats.duplicates++; continue; }
    seenW.add(r.workout.key);
    const list = workoutsByDay.get(r.workout.date) || [];
    list.push(r.workout); workoutsByDay.set(r.workout.date, list);
  }
  if (workoutsSkipped) warnings.push(`${workoutsSkipped} workout(s) had no readable name, start time or duration and were skipped.`);
  const extras = exercise.size > 0 || weightsByDay.size > 0 || workoutsByDay.size > 0;

  const missing = [!found.active && 'active_energy (Active Energy)', !found.resting && 'basal_energy_burned (Resting Energy)'].filter(Boolean);
  if (missing.length && extras) {
    warnings.push(`No ${missing.join(' and no ')} in this export, so calories were not updated (workouts, exercise minutes and weight were).`);
    perDay.clear();
  } else if (missing.length) {
    const have = metricsIn.map(m => m && m.name).filter(n => typeof n === 'string').slice(0, 12).map(n => n.replace(/[^\w .\-()]/g, '').slice(0, 40)).join(', ');
    return fail('metrics', `The export has no ${missing.join(' and no ')}. Add them to the automation's metrics. Metrics received: ${have || '(none)'}.`);
  }
  if (!perDay.size && !extras) {
    return fail('dates', `The export has no usable data points (${stats.badPoints} unreadable). Each point needs a "date" like "2026-10-13 14:05:00 +0100" and a numeric "qty".`);
  }

  const days = [...perDay.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([date, d]) => {
    const w = [];
    for (const kind of ['active', 'resting', 'steps']) {
      if (d.n[kind] > 1 && d.sources[kind].size > 1) {
        w.push(`${date}: ${kind === 'active' ? 'active energy' : kind === 'resting' ? 'resting energy' : 'steps'} came from ${d.sources[kind].size} sources in ${d.n[kind]} separate points; if Summarize Data is off those can add up to more than the real total. Turn Summarize Data on and group by Days.`);
      }
    }
    return {
      date,
      active_kcal: round(d.active, 1),
      resting_kcal: round(d.resting, 1),
      steps: found.steps ? Math.round(d.steps) : null,
      covers: d.first < 60,                         // the data starts in the day's first hour: this is the whole day so far
      warnings: w
    };
  });
  for (const d of days) warnings.push(...d.warnings);
  const actDates = [...new Set([...exercise.keys(), ...workoutsByDay.keys()])].sort();
  const activity = actDates.map(date => {
    const ex = exercise.get(date), list = workoutsByDay.get(date);
    if (list && list.length > LIMITS.workoutsPerDay) warnings.push(`${date}: ${list.length} workouts; only the first ${LIMITS.workoutsPerDay} are kept (the rest are not plausible for one day and were skipped).`);
    return {
      date,
      exercise_min: ex ? Math.round(ex.min) : null,
      exercise_covers: ex ? ex.first < 60 : true,
      workouts: list ? list.sort((a, b) => (a.time < b.time ? -1 : 1)).slice(0, LIMITS.workoutsPerDay).map(({ key, date: _d, ...rest }) => rest) : null
    };
  });
  const weights = [...weightsByDay.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([date, w]) => ({ date, kg: w.kg }));
  if (stats.badPoints) warnings.push(`${stats.badPoints} data point(s) could not be read and were skipped.`);
  if (stats.duplicates) warnings.push(`${stats.duplicates} repeated data point(s) in this payload were counted once.`);
  return { ok: true, days, activity, weights, ignoredMetrics: [...ignored], warnings, stats };
}
