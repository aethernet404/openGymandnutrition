// Pure helpers for the Apple Health stats page and the Home card. Everything here is about telling "no data"
// from "a real zero": a figure Health never sent is null and is shown as a dash, never as 0, and averages
// count only the days that have a value.

/** Which card the Home screen shows: the setup prompt, a waiting note, or today's numbers. */
export function cardState(h) {
  if (!h || !Array.isArray(h.days)) return { kind: 'none' }
  if (!h.token && !h.hasData) return { kind: 'setup' }
  const today = h.days.at(-1) || {}
  const t = {
    burned: Number.isFinite(today.burned_kcal) ? Math.round(today.burned_kcal) : null,
    steps: Number.isFinite(today.steps) ? today.steps : null,
    exercise_min: Number.isFinite(today.exercise_min) ? today.exercise_min : null,
    weightKg: Number.isFinite(h.weight?.latest?.kg) ? h.weight.latest.kg : null,
    updatedAt: Number.isFinite(h.updatedAt) ? h.updatedAt : null
  }
  if (!h.hasData) return { kind: 'waiting', ...t }
  return { kind: 'data', ...t, anyToday: t.burned != null || t.steps != null || t.exercise_min != null }
}

/** A series for a chart: the last `n` days of one figure, with the days that have no value kept as gaps. */
export function rangeSeries(days, key, n) {
  const pts = (days || []).slice(-n).map(d => ({ date: d.date, v: Number.isFinite(d[key]) ? d[key] : null }))
  const vals = pts.map(p => p.v).filter(v => v != null)
  return {
    points: pts, have: vals.length,
    avg: vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : null,
    max: vals.length ? Math.max(...vals) : null,
    min: vals.length ? Math.min(...vals) : null
  }
}

/** Bar height as a percentage of the tallest bar, with a visible minimum for a real but tiny value; gaps are 0. */
export const barPct = (v, max) => (v == null || !(max > 0) ? 0 : Math.max(4, Math.round(v / max * 100)))

/** Recent workouts grouped for display: newest first, as given. Never invents calories or distance. */
export const hasWorkouts = h => Array.isArray(h?.workouts) && h.workouts.length > 0

