/* The meal-estimate loop, offline: a fake provider stands in for the Agent SDK. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateMeal } from '../nutrition/meal.js';
import { runMealPipeline } from '../nutrition/pipeline.js';
import { invokeMeal, sniffImageType, buildPrompt } from '../nutrition/vision.js';
import { LOCKDOWN } from '../coach/adapters/claude.js';

const GOOD = {
  meal_name: 'Eggs on toast', confidence: 'medium',
  items: [
    { name: 'Fried egg', portion: '2 large', grams: 100, calories: 180, protein_g: 12.5, carbs_g: 1, fat_g: 14 },
    { name: 'Toast', portion: '1 slice', grams: 30, calories: 80, protein_g: 3, carbs_g: 14, fat_g: 1 }
  ],
  notes: 'cooking oil is a guess'
};
const ok = text => ({ code: 0, text, stderr: '', timedOut: false, spawnError: false });
const scripted = (...replies) => { const calls = []; const send = async o => { calls.push(o); return replies[calls.length - 1]; }; send.calls = calls; return send; };

test('validateMeal accepts a good answer and recomputes the totals itself', () => {
  const r = validateMeal({ ...GOOD, totals: { calories: 99999 } });
  assert.equal(r.ok, true);
  assert.deepEqual(r.meal.totals, { calories: 260, protein_g: 15.5, carbs_g: 15, fat_g: 15 });
});

test('validateMeal lists every problem in plain words', () => {
  const r = validateMeal({ confidence: 'sure', items: [{ name: '', calories: '180', protein_g: -1, carbs_g: 1, fat_g: 1, grams: 99999 }] });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => /confidence/.test(e)));
  assert.ok(r.errors.some(e => /items\[0\]\.name/.test(e)));
  assert.ok(r.errors.some(e => /items\[0\]\.calories/.test(e)));
  assert.ok(r.errors.some(e => /items\[0\]\.protein_g/.test(e)));
  assert.ok(r.errors.some(e => /items\[0\]\.grams/.test(e)));
});

test('validateMeal: not_food is an answer, an empty item list is not', () => {
  assert.equal(validateMeal({ not_food: true, notes: 'a cat' }).meal.notFood, true);
  assert.equal(validateMeal({ confidence: 'low', items: [] }).ok, false);
  assert.equal(validateMeal([]).ok, false);
});

test('validateMeal warns, without rejecting, when the macros do not add up to the calories', () => {
  const r = validateMeal({ confidence: 'low', items: [{ name: 'Mystery', calories: 900, protein_g: 1, carbs_g: 1, fat_g: 1 }] });
  assert.equal(r.ok, true);
  assert.equal(r.meal.warnings.length, 1);
});

test('pipeline: a fenced answer parses on the first call', async () => {
  const send = scripted(ok('Here you go:\n```json\n' + JSON.stringify(GOOD) + '\n```'));
  const r = await runMealPipeline(send);
  assert.equal(r.ok, true);
  assert.equal(r.attempts, 1);
  assert.equal(send.calls[0].repair, null);
});

test('pipeline: one repair round, carrying the previous answer and the errors', async () => {
  const bad = JSON.stringify({ ...GOOD, confidence: 'certain' });
  const send = scripted(ok(bad), ok(JSON.stringify(GOOD)));
  const r = await runMealPipeline(send);
  assert.equal(r.ok, true);
  assert.equal(r.attempts, 2);
  assert.equal(send.calls[1].repair.previous, bad);
  assert.match(send.calls[1].repair.errors[0], /confidence/);
});

test('pipeline: two bad answers is a failure, not a loop', async () => {
  const send = scripted(ok('no json here'), ok('{"items": []}'), ok(JSON.stringify(GOOD)));
  const r = await runMealPipeline(send);
  assert.equal(r.ok, false);
  assert.equal(r.errorClass, 'unusable');
  assert.equal(send.calls.length, 2);
});

test('pipeline: transport failures are classified and never repaired', async () => {
  for (const [reply, cls] of [
    [{ code: -1, text: '', stderr: '', timedOut: true }, 'timeout'],
    [{ code: -1, text: '', stderr: 'not installed', spawnError: true }, 'missing'],
    [{ code: 1, text: '', stderr: 'Invalid API key · 401' }, 'auth'],
    [{ code: 1, text: '', stderr: 'overloaded' }, 'provider']
  ]) {
    const send = scripted(reply);
    const r = await runMealPipeline(send);
    assert.equal(r.errorClass, cls);
    assert.equal(send.calls.length, 1);
  }
});

test('sniffImageType trusts bytes, not names', () => {
  assert.equal(sniffImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0])), 'image/jpeg');
  assert.equal(sniffImageType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])), 'image/png');
  assert.equal(sniffImageType(Buffer.from('<svg xmlns=...>')), null);
});

/* A fake SDK that records what query() was given and answers with a canned result. */
function fakeSdk(answer) {
  const seen = {};
  return {
    seen,
    query: ({ prompt, options }) => {
      seen.prompt = prompt; seen.options = options;
      return (async function* () {
        if (typeof prompt !== 'string') for await (const m of prompt) seen.message = m;
        yield { type: 'result', subtype: 'success', result: answer };
      })();
    }
  };
}
const IMG = { mediaType: 'image/jpeg', data: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]) };

test('inline mode: image rides as a base64 block and the Coach lockdown is passed through untouched', async () => {
  const sdk = fakeSdk(JSON.stringify(GOOD));
  const r = await invokeMeal({ mode: 'inline', image: IMG, jobDir: null, env: {}, timeoutMs: 5000, sdk });
  assert.equal(r.code, 0);
  const block = sdk.seen.message.message.content[0];
  assert.deepEqual(block, { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: IMG.data.toString('base64') } });
  for (const [k, v] of Object.entries(LOCKDOWN)) assert.deepEqual(sdk.seen.options[k], v, `LOCKDOWN.${k} must be unchanged`);
  assert.equal(sdk.seen.options.canUseTool, undefined);
});

test('text mode sends a plain string with the same lockdown', async () => {
  const sdk = fakeSdk(JSON.stringify(GOOD));
  await invokeMeal({ mode: 'text', description: '2 eggs', jobDir: null, env: {}, timeoutMs: 5000, sdk });
  assert.equal(typeof sdk.seen.prompt, 'string');
  assert.deepEqual(sdk.seen.options.tools, []);
});

test('read mode: Read only, and only inside the job dir', async () => {
  const dir = fs.mkdtempSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'tmp-nutri-'));
  try {
    const sdk = fakeSdk(JSON.stringify(GOOD));
    await invokeMeal({ mode: 'read', image: IMG, imageFile: 'meal.jpg', jobDir: dir, env: {}, timeoutMs: 5000, sdk });
    const o = sdk.seen.options;
    assert.deepEqual(o.tools, ['Read']);
    assert.equal(o.settingSources.length, 0);
    assert.equal(o.strictMcpConfig, true);
    assert.equal((await o.canUseTool('Read', { file_path: 'meal.jpg' })).behavior, 'allow');
    assert.equal((await o.canUseTool('Read', { file_path: path.join(dir, 'meal.jpg') })).behavior, 'allow');
    assert.equal((await o.canUseTool('Read', { file_path: '/data/db.json' })).behavior, 'deny');
    assert.equal((await o.canUseTool('Read', { file_path: '../../etc/passwd' })).behavior, 'deny');
    assert.equal((await o.canUseTool('Bash', { command: 'ls' })).behavior, 'deny');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a non-success SDK result becomes a provider failure', async () => {
  const sdk = { query: () => (async function* () { yield { type: 'result', subtype: 'error_max_turns' }; })() };
  const r = await invokeMeal({ mode: 'text', description: 'x', jobDir: null, env: {}, timeoutMs: 5000, sdk });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /error_max_turns/);
});

test('the repair text reaches the prompt', () => {
  const p = buildPrompt({ mode: 'text', description: 'toast', repair: { previous: 'PREV', errors: ['ERR1'] } });
  assert.match(p, /PREV/);
  assert.match(p, /- ERR1/);
});

test('the image is copied by the Dockerfile', () => {
  const df = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'Dockerfile'), 'utf8');
  assert.match(df, /^COPY nutrition \.\/nutrition$/m);
});
