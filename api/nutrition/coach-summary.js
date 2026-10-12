/* What the Coach is allowed to know about food — and the only way it learns it.
 *
 * READ-ONLY by construction. This module imports `read` from the store and nothing that writes;
 * the Coach runs on a model with no tools, whose answer passes a validator with a closed list of
 * change types (none of them touch food), and its payload is built by jobs.js calling the single
 * function exported here. There is no route, tool or change type through which the Coach could
 * add, edit or delete a diary entry, a food or a goal. api/test/nutrition-coach.test.js pins each
 * of those facts.
 *
 * OPT-IN. Nothing leaves unless the person turned on "Share a nutrition summary with the Coach"
 * (stored with their nutrition data, default off). The existing Coach consent screen lists what
 * leaves for training; this is a separate, explicit switch for food, with its own wording.
 *
 * SMALL. Numbers only — calories and macros per logged day, their averages, and the targets the
 * person set. No food names, no brands, no photos, no notes: names can say a great deal about a
 * person (allergies, religion, health) and the Coach does not need them to put a calorie trend
 * next to a body-weight trend.
 */
import { read } from './store.js';
import { MACROS, round } from './validate.js';

export const WINDOW_DAYS = 14;

const dayShift = (iso, n) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const sum = list => { const t = Object.fromEntries(MACROS.map(k => [k, 0])); for (const e of list) for (const k of MACROS) t[k] += e[k] || 0; return t; };
const tidy = t => ({ calories: Math.round(t.calories), protein_g: round(t.protein_g, 1), carbs_g: round(t.carbs_g, 1), fat_g: round(t.fat_g, 1) });

/** Whether this profile has chosen to share. */
export function isSharing(uid) {
  try { return read(uid).coachShare === true; } catch { return false; }
}

/**
 * @param {string} uid
 * @param {{ today?: string }} o   YYYY-MM-DD; the window ends the day after it so a profile that is
 *                                 ahead of the server's UTC date still has its "today" inside it.
 * @returns {object|null}  null unless shared and at least one day is logged in the window
 */
export function nutritionForCoach(uid, { today = new Date().toISOString().slice(0, 10) } = {}) {
  let d;
  try { d = read(uid); } catch { return null; }
  if (d.coachShare !== true) return null;

  const to = dayShift(today, 1);
  const from = dayShift(to, -(WINDOW_DAYS - 1));
  const logged = Object.keys(d.days).filter(k => k >= from && k <= to && d.days[k].entries?.length).sort();
  if (!logged.length) return null;

  const perDay = logged.map(date => ({ date, ...tidy(sum(d.days[date].entries)) }));
  const avg = sum(perDay);
  const n = perDay.length;
  const average = tidy(Object.fromEntries(MACROS.map(k => [k, avg[k] / n])));

  const goals = d.goals ? Object.fromEntries(MACROS.map(k => [k, d.goals[k] ?? null])) : null;
  // Average against target, as a whole-percent difference: +8 means eight percent above the goal.
  const vsGoal = goals ? Object.fromEntries(MACROS.filter(k => goals[k] > 0).map(k => [k, Math.round((average[k] / goals[k] - 1) * 100)])) : null;

  return {
    about: 'Self-logged food, numbers only. Averages cover only the days something was logged; a day with nothing logged is unknown, not zero.',
    window: { from, to, days: WINDOW_DAYS, loggedDays: n },
    average,
    goals,
    ...(vsGoal && Object.keys(vsGoal).length ? { averageVsGoalPercent: vsGoal } : {}),
    perDay: perDay.map(x => ({ d: x.date, kcal: x.calories, p: x.protein_g, c: x.carbs_g, f: x.fat_g }))
  };
}
