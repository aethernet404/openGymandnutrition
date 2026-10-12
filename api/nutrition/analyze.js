/* Photo / text → a draft meal, through the Coach's Claude Agent SDK path and nothing else.
 *
 * What this module decides, in order:
 *   1. Can the AI run at all? Only when the Coach is switched on and connected to the Claude
 *      provider — the same switch, the same setup-token, the same privilege drop. No other
 *      provider and no API key of its own: a Coach on any other provider means "unavailable".
 *   2. Whose account pays. credentialFor() is the Coach's own check, including its refusal when
 *      the personal token belongs to another profile, and a call that spends the token binds it
 *      exactly as a Coach job does (bindInstanceCredential). The binding rules are untouched.
 *   3. The nutrition allowance (a counter of its own). Reserved before the call, given back when
 *      the model never produced anything: no runtime, a rejected credential, a provider error.
 *      A call that timed out or answered unusably stays counted — it spent a model turn.
 *   4. The call: invoke → parse → validate → one repair round (pipeline.js), inside one time
 *      budget so that a slow first answer does not earn a second full wait.
 *
 * Nothing is written here. The photo lives in memory for the length of the call; the result is a
 * draft that the person reviews, and only their confirmation (POST /entries) saves anything.
 */
import * as coachCfg from '../coach/config.js';
import { canDropPrivileges } from '../coach/adapters/spawn.js';
import { TIMEOUT_MS as COACH_TIMEOUT_MS } from '../coach/jobs.js';
import { runMealPipeline } from './pipeline.js';
import { invokeMeal, sniffImageType } from './vision.js';
import { makeJobDir, removeJobDir } from './jobdir.js';

export const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
export const MAX_NOTE = 300;
export const MAX_TEXT = 500;
const BUDGET_MS = Math.min(COACH_TIMEOUT_MS, 90000);       // never longer than the Coach's own limit
const MIN_REPAIR_MS = 10000;                                // not worth a second call with less than this left
const MAX_CONCURRENT = 2;

/** How each failure is shown, and whether the person gets their allowance back. */
export const FAILURES = {
  unavailable: { status: 503, refund: true,  text: 'AI logging is not available on this server. The Coach must be switched on and connected to Claude (Admin → Coach).' },
  unprivileged:{ status: 503, refund: true,  text: 'AI logging is switched off on this server for safety reasons.' },
  shared:      { status: 409, refund: true,  text: coachCfg.SHARED_ACCOUNT_REFUSAL },
  busy:        { status: 409, refund: true,  text: 'Another analysis is still running. Try again in a moment.' },
  cap:         { status: 429, refund: false, text: 'You have used all of today’s AI analyses. Log by hand, or try again tomorrow (UTC).' },
  timeout:     { status: 504, refund: false, text: 'The AI took too long. Try again, or log by hand.' },
  auth:        { status: 502, refund: true,  text: 'The AI account on this server needs reconnecting (Admin → Coach).' },
  missing:     { status: 503, refund: true,  text: 'The AI runtime is not installed in this server image.' },
  provider:    { status: 502, refund: true,  text: 'The AI could not answer right now. Try again, or log by hand.' },
  unusable:    { status: 502, refund: false, text: 'The AI’s answer could not be read. Try again, or log by hand.' }
};

/** Can the AI run for this profile? Pure read: no binding, no spending. */
export function availability(uid) {
  const cfg = coachCfg.load();
  if (coachCfg.COACH_DISABLED || !coachCfg.isEnabled() || !coachCfg.isConnected() || cfg.provider !== 'claude') return { ok: false, code: 'unavailable' };
  const cred = coachCfg.credentialFor(uid);
  if (!cred.ok) return cred.reason === 'shared-account' ? { ok: false, code: 'shared' } : { ok: false, code: 'unavailable' };
  const priv = canDropPrivileges();
  if (!priv.ok) return { ok: false, code: 'unprivileged' };
  return { ok: true, cred };
}

/** The input, checked. Returns { ok, mode, image?, description?, note? } or { ok:false, error }. */
export function checkInput(body) {
  if (!body || typeof body !== 'object') return { ok: false, error: 'send a photo or a description' };
  if (body.kind === 'text') {
    const text = String(body.text ?? '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
    if (text.length < 2) return { ok: false, error: 'describe the meal in a few words' };
    return { ok: true, mode: 'text', description: text.slice(0, MAX_TEXT) };
  }
  if (body.kind === 'photo') {
    const b64 = typeof body.image === 'string' ? body.image.replace(/^data:[^,]*,/, '') : '';
    if (!b64 || b64.length > Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 8 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return { ok: false, error: 'the photo is missing, too large, or not valid base64' };
    const data = Buffer.from(b64, 'base64');
    if (!data.length || data.length > MAX_IMAGE_BYTES) return { ok: false, error: 'the photo is too large' };
    const mediaType = sniffImageType(data);
    if (!mediaType) return { ok: false, error: 'the photo must be a JPEG, PNG, WebP or GIF' };
    const note = String(body.note ?? '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_NOTE);
    return { ok: true, mode: 'inline', image: { mediaType, data }, note };
  }
  return { ok: false, error: 'kind must be photo or text' };
}

export function createAnalyzer({ invoke = invokeMeal, now = Date.now, budgetMs = BUDGET_MS } = {}) {
  const busy = new Set();
  let running = 0;

  /**
   * @returns {Promise<{ok:true, draft:object, ms:number, calls:number} | {ok:false, code:string, refund:boolean, detail?:string}>}
   * The caller has already reserved the allowance; `refund` says whether to give it back.
   */
  async function analyze(uid, input) {
    const a = availability(uid);
    if (!a.ok) return { ok: false, code: a.code, refund: true };
    if (busy.has(uid) || running >= MAX_CONCURRENT) return { ok: false, code: 'busy', refund: true };
    busy.add(uid); running++;
    // Spending is what binds, as for a Coach job. After the checks above, so a refused call binds nothing.
    coachCfg.bindInstanceCredential(uid);

    const jobDir = makeJobDir();
    const t0 = now();
    const deadline = t0 + budgetMs;
    try {
      const cfg = coachCfg.load();
      const env = coachCfg.jobEnv(jobDir, a.cred);
      const model = coachCfg.modelFor(cfg);
      const r = await runMealPipeline(({ repair }) => {
        const left = deadline - now();
        if (repair && left < MIN_REPAIR_MS) return { code: -1, text: '', stderr: '', timedOut: true, spawnError: false };
        return invoke({ ...input, repair, jobDir, env, model, timeoutMs: left });
      });
      if (!r.ok) return { ok: false, code: r.errorClass, refund: FAILURES[r.errorClass]?.refund ?? false, detail: r.detail };
      return { ok: true, draft: r.meal, ms: now() - t0, calls: r.attempts };
    } finally {
      busy.delete(uid); running--;
      removeJobDir(jobDir);
    }
  }
  return { analyze, _busy: busy };
}
