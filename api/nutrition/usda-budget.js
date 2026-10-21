/* A budget for the requests this server sends to USDA FoodData Central, which every profile shares one key for.
 *
 * Counted per hour and per day for the whole server, and per hour for each profile, and kept in
 * data/nutrition/usda-usage.json so a restart does not reset it (the same idea as FatSecret's budget in fatsecret.js).
 * Every request that leaves the server counts once; an answer served from the memory cache costs nothing.
 *
 * The defaults are chosen to stay under what USDA allows a key. I believe that is 1,000 requests an hour (UNVERIFIED:
 * USDA's pages could not be opened when this was written), so the server stops at 800 an hour and, as a second line,
 * 6,000 a day; one profile gets 200 an hour so that one person cannot use up everyone's share. One normal search is
 * three requests (reference foods, branded foods, mixed dishes). Environment variables change them:
 * NUTRITION_USDA_HOURLY_CAP (at most 1000), NUTRITION_USDA_DAILY_CAP, NUTRITION_USDA_USER_HOURLY_CAP.
 */
import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite } from '../durable.js';

const int = (v, fallback) => { const n = Number(v); return Number.isInteger(n) && n >= 1 ? n : fallback; };
export const HOUR_CAP = () => Math.min(1000, int(process.env.NUTRITION_USDA_HOURLY_CAP, 800));
export const DAY_CAP = () => int(process.env.NUTRITION_USDA_DAILY_CAP, 6000);
export const USER_HOUR_CAP = () => int(process.env.NUTRITION_USDA_USER_HOURLY_CAP, 200);

/** What the person is told for each budget that can run out. */
export const TEXT = {
  'server-hour': () => `This server has used its USDA lookups for this hour (${HOUR_CAP()}). They come back at the top of the hour.`,
  'server-day': () => `This server has used its USDA lookups for today (${DAY_CAP()}). They come back at midnight UTC.`,
  'user-hour': () => `You have used your share of USDA lookups for this hour (${USER_HOUR_CAP()}). They come back at the top of the hour.`
};

const hourOf = t => Math.floor(t / 3600000);
const dayOf = t => new Date(t).toISOString().slice(0, 10);

/** Read a small counter file. One that exists but cannot be read is moved aside (kept, not deleted) and counting starts over. */
export function readCounter(file, log = console.error) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') log(`nutrition: ${path.basename(file)} could not be read; counting starts again`); return null; }
  try {
    const j = JSON.parse(raw);
    if (j && typeof j === 'object' && !Array.isArray(j)) return j;
    throw new Error('shape');
  } catch {
    try { fs.renameSync(file, file + '.damaged'); } catch { /* left where it is */ }
    log(`nutrition: ${path.basename(file)} was damaged; it was kept as ${path.basename(file)}.damaged and counting starts again`);
    return null;
  }
}

export function createUsdaBudget({ file, now = Date.now, log = console.error } = {}) {
  let state = null;
  const fresh = t => ({ day: dayOf(t), dayTotal: 0, hour: hourOf(t), hourTotal: 0, users: {} });
  const load = () => {
    const t = now();
    if (!state) {
      const j = file ? readCounter(file, log) : null;
      state = j && Number.isInteger(j.dayTotal) && Number.isInteger(j.hourTotal) ? { ...fresh(t), ...j, users: Object.assign(Object.create(null), j.users && typeof j.users === 'object' ? j.users : {}) } : fresh(t);
    }
    if (state.day !== dayOf(t)) { state.day = dayOf(t); state.dayTotal = 0; }
    if (state.hour !== hourOf(t)) { state.hour = hourOf(t); state.hourTotal = 0; state.users = Object.create(null); }
    return state;
  };
  const save = () => { if (file) try { fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); atomicWrite(file, JSON.stringify(state), 0o600); } catch { /* counting must never break a search */ } };
  return {
    /** Spend one request. Returns null when allowed, else which budget is used up ('server-hour', 'server-day' or 'user-hour'). */
    take(uid) {
      const s = load();
      if (s.hourTotal >= HOUR_CAP()) return 'server-hour';
      if (s.dayTotal >= DAY_CAP()) return 'server-day';
      const mine = typeof uid === 'string' && uid ? (Object.hasOwn(s.users, uid) ? s.users[uid] : 0) : 0;
      if (uid && mine >= USER_HOUR_CAP()) return 'user-hour';
      s.hourTotal++; s.dayTotal++;
      if (uid) s.users[uid] = mine + 1;
      save();
      return null;
    },
    snapshot() { const s = load(); return { hour: { used: s.hourTotal, cap: HOUR_CAP() }, day: { used: s.dayTotal, cap: DAY_CAP() }, userHourCap: USER_HOUR_CAP() }; }
  };
}
