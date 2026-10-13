/* A look at what Health Auto Export really sends — for an admin, when they ask, for an hour.
 *
 * Off by default (config.healthDebug). When on, the SHAPE of the last payload received is kept IN
 * MEMORY ONLY (never written to disk, gone at a restart) for one hour: key names, and one example
 * item per metric, with long strings cut. Tokens cannot get in: request headers are never passed to
 * this module, any key that looks like a credential has its value replaced, and anything shaped like
 * an openGym token or a Bearer header is blanked wherever it appears. Turning the option off wipes it.
 */
export const TTL_MS = 60 * 60 * 1000;
const SECRET_KEY = /token|auth|secret|password|bearer|api[-_]?key|cookie|session/i;
const SECRET_VALUE = /ogh_[0-9a-f]{16}_[0-9a-f]{64}|bearer\s+\S+/gi;
const MAX_JSON = 30000;

let last = null;

const text = s => String(s).replace(SECRET_VALUE, '[redacted]').slice(0, 40);
const cleanKey = k => String(k).replace(/[^\w .-]/g, '').slice(0, 30);

/** Any value, reduced to its shape with short examples. Secrets never survive this. */
function summarise(v, depth = 0) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return text(v);
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  if (depth > 5) return '…';
  if (Array.isArray(v)) return v.length ? { _length: v.length, _example: summarise(v[0], depth + 1) } : { _length: 0 };
  if (typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).slice(0, 40)) out[cleanKey(k)] = SECRET_KEY.test(k) ? '[redacted]' : summarise(v[k], depth + 1);
    return out;
  }
  return typeof v;
}

/** The payload as an admin may see it: the wrapper keys, and for every metric its name, units, how many points, and one of them. */
export function shapeOf(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { notAnObject: Array.isArray(payload) ? 'an array' : typeof payload };
  const root = payload.data && typeof payload.data === 'object' && !Array.isArray(payload.data) ? payload.data : payload;
  const metrics = Array.isArray(root.metrics) ? root.metrics : null;
  const rest = Object.fromEntries(Object.entries(root).filter(([k]) => k !== 'metrics'));
  return {
    topLevelKeys: Object.keys(payload).slice(0, 20).map(cleanKey),
    dataKeys: root === payload ? '(no "data" wrapper)' : Object.keys(root).slice(0, 20).map(cleanKey),
    other: summarise(rest),
    metricCount: metrics ? metrics.length : null,
    metrics: metrics ? metrics.slice(0, 60).map(m => {
      if (!m || typeof m !== 'object') return summarise(m);
      const pts = Array.isArray(m.data) ? m.data : [];
      return {
        name: typeof m.name === 'string' ? text(m.name) : null,
        units: typeof m.units === 'string' ? text(m.units) : null,
        metricKeys: Object.keys(m).slice(0, 12).map(cleanKey),
        points: pts.length,
        pointKeys: [...new Set(pts.slice(0, 50).flatMap(p => (p && typeof p === 'object' ? Object.keys(p) : [])))].slice(0, 12).map(cleanKey),
        example: summarise(pts[0], 2)
      };
    }) : null
  };
}

/** Keep this payload's shape and what the parser made of it. Call only when the option is on. */
export function capture(payload, outcome, now = Date.now()) {
  let shape = shapeOf(payload);
  let json = JSON.stringify(shape);
  if (json.length > MAX_JSON && Array.isArray(shape.metrics)) { shape = { ...shape, metrics: shape.metrics.slice(0, 10), truncated: true }; json = JSON.stringify(shape); }
  last = { at: now, expiresAt: now + TTL_MS, shape, outcome: JSON.parse(JSON.stringify(outcome ?? null, (k, v) => (typeof v === 'string' ? text(v).slice(0, 300) : v))) };
}

/** The kept capture, or null when there is none or it is more than an hour old. */
export function read(now = Date.now()) {
  if (last && last.expiresAt <= now) last = null;
  return last;
}
export function clear() { last = null; }
