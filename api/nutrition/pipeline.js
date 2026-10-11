/* invoke → parse → validate → one repair round, for a meal estimate.
 *
 * The same loop coach/core/pipeline.js runs, with the Coach-specific parts (the contract
 * field, plan/review validators) swapped for validateMeal. The parser is the Coach's own
 * extractJSON, so "what counts as JSON in a model's answer" has a single definition.
 *
 * `send({ repair })` is whatever performs the model call and answers in the adapter shape
 * ({ code, text, stderr, timedOut, spawnError }). It is injected so the loop is testable
 * against a fake, and so the image / text / read-tool variants share it.
 */
import { extractJSON } from '../coach/core/parse.js';
import { validateMeal } from './meal.js';

async function attempt(send, repair) {
  const t0 = Date.now();
  const r = await send({ repair });
  const ms = Date.now() - t0;
  const base = { ms };

  if (r.timedOut) return { ...base, ok: false, errorClass: 'timeout' };
  if (r.spawnError) return { ...base, ok: false, errorClass: 'missing', detail: String(r.stderr || '').slice(0, 300) };
  if (r.code !== 0) {
    const err = String(r.stderr || r.text || '');
    const authish = /auth|unauthor|api key|credential|token|401|403|login/i.test(err);
    return { ...base, ok: false, errorClass: authish ? 'auth' : 'provider', detail: err.slice(0, 300) };
  }
  const parsed = extractJSON(r.text);
  if (parsed.error) return { ...base, ok: false, repairable: !repair, errors: [parsed.error], raw: r.text, errorClass: 'unusable' };
  const checked = validateMeal(parsed.value);
  if (!checked.ok) return { ...base, ok: false, repairable: !repair, errors: checked.errors, raw: r.text, errorClass: 'unusable', parsed: parsed.value };
  return { ...base, ok: true, meal: checked.meal, parsed: parsed.value };
}

/** @returns {Promise<{ok:true, meal, attempts:number, ms:number[]} | {ok:false, errorClass, detail?, errors?, attempts:number, ms:number[]}>} */
export async function runMealPipeline(send) {
  const ms = [];
  let a = await attempt(send, null);
  ms.push(a.ms);
  let attempts = 1;
  if (!a.ok && a.repairable) {
    a = await attempt(send, { previous: a.raw, errors: a.errors });
    ms.push(a.ms); attempts = 2;
  }
  const { ms: _drop, repairable: _r, raw: _raw, ...rest } = a;
  return { ...rest, attempts, ms };
}
