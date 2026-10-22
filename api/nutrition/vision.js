/* One model call about a meal, over the Coach's Claude Agent SDK path.
 *
 * Nothing here is a second AI integration: it imports the SDK the Coach imports, takes the
 * credential through the Coach's own config (credentialFor → jobEnv, so the profile binding is
 * honoured and untouched), spawns the runtime as the same unprivileged `coach` user, and starts
 * from the Coach's exported LOCKDOWN.
 *
 * Modes:
 *   'inline' — path A. The image travels in the prompt as a base64 image block, via the SDK's
 *              streaming-input form. LOCKDOWN is used unchanged: no tools, no filesystem.
 *   'read'   — path B, spike fallback only. The image is a file in the job dir and the model
 *              gets exactly one tool, Read, gated to that directory. Not used by anything else.
 *   'text'   — no image; a described meal. The fallback if neither image path works.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { LOCKDOWN } from '../coach/adapters/claude.js';
import { unprivilegedIds } from '../coach/adapters/spawn.js';
import { SYSTEM_PROMPT, photoPrompt, textPrompt, repairSuffix } from './prompt.js';

const PKG = '@anthropic-ai/claude-agent-sdk';
const OUTPUT_CAP = 4 * 1024 * 1024;

/** The type from the bytes, never from a filename or a client's claim. */
export function sniffImageType(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length > 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.length > 6 && /^GIF8[79]a$/.test(buf.toString('latin1', 0, 6))) return 'image/gif';
  return null;
}

const spawnAsCoach = ({ command, args, cwd, env, signal }) =>
  spawn(command, args, { cwd, env, signal, stdio: ['pipe', 'pipe', 'pipe'], ...(unprivilegedIds() || {}) });

/** The prompt the SDK takes: a string, or (for an image) a one-message stream. */
export function buildPrompt({ mode, image, images, imageFile, note, description, repair, promptText }) {
  const tail = repair ? repairSuffix(repair.previous, repair.errors) : '';
  // A whole prompt written elsewhere (the USDA stand-in picker, the label reader). With images it travels with them.
  if (promptText && !(images?.length)) return promptText + tail;
  if (mode === 'text') return textPrompt(description) + tail;
  if (mode === 'read') return photoPrompt(note) + `\n\nThe photo is the file ${imageFile} in the working directory. Read it with the Read tool, then answer.` + tail;
  // inline: one user message, image blocks first, as the vision docs recommend.
  const list = images?.length ? images : [image];
  const content = [
    ...list.map(img => ({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data.toString('base64') } })),
    { type: 'text', text: (promptText || photoPrompt(note)) + tail }
  ];
  return (async function* () {
    yield { type: 'user', parent_tool_use_id: null, message: { role: 'user', content } };
  })();
}

/**
 * @param {object} o
 * @param {'inline'|'read'|'text'} o.mode
 * @param {{mediaType:string, data:Buffer}} [o.image]
 * @param {string} [o.imageFile]   file name inside jobDir (read mode)
 * @returns adapter-shaped { code, text, stderr, timedOut, spawnError }
 */
export async function invokeMeal({ mode, image, images, imageFile, note, description, repair, promptText, systemPrompt, jobDir, env, model, timeoutMs, sdk }) {
  const m = sdk || await import(PKG).catch(() => null);
  if (!m) return { code: -1, text: '', stderr: `${PKG} is not installed`, timedOut: false, spawnError: true };

  let text = '', stderr = '', failure = '', timedOut = false;
  const abortController = new AbortController();
  const timer = setTimeout(() => { timedOut = true; abortController.abort(); }, timeoutMs);

  const jobRoot = jobDir ? fs.realpathSync(jobDir) : null;
  const readOnlyHere = mode === 'read' ? {
    tools: ['Read'],
    permissionMode: 'default',
    maxTurns: 4,
    // Read may name any path the `coach` user can open; only this job's directory is allowed.
    canUseTool: async (name, input) => {
      const target = typeof input.file_path === 'string' ? path.resolve(jobRoot, input.file_path) : '';
      if (name === 'Read' && (target === jobRoot || target.startsWith(jobRoot + path.sep))) return { behavior: 'allow', updatedInput: input };
      return { behavior: 'deny', message: 'only the photo in the working directory may be read' };
    }
  } : null;

  try {
    for await (const message of m.query({
      prompt: buildPrompt({ mode, image, images, imageFile, note, description, repair, promptText }),
      options: {
        ...LOCKDOWN,
        ...(readOnlyHere || {}),
        abortController,
        cwd: jobDir,
        env: { ...env, CLAUDE_AGENT_SDK_CLIENT_APP: 'opengym-nutrition' },
        model: model || undefined,
        systemPrompt: systemPrompt || SYSTEM_PROMPT,
        stderr: data => { if (stderr.length < OUTPUT_CAP) stderr += data; },
        spawnClaudeCodeProcess: spawnAsCoach
      }
    })) {
      if (message.type !== 'result') continue;
      if (message.subtype === 'success') text = message.result;
      else failure = `the Agent SDK stopped: ${message.subtype}${message.stop_reason ? ` (${message.stop_reason})` : ''}`;
    }
  } catch (e) {
    if (timedOut) return { code: -1, text: '', stderr: 'the Agent SDK timed out', timedOut: true, spawnError: false };
    return { code: -1, text: '', stderr: stderr || (e instanceof Error ? e.message : String(e)), timedOut: false, spawnError: true };
  } finally {
    clearTimeout(timer);
  }
  if (timedOut) return { code: -1, text: '', stderr: 'the Agent SDK timed out', timedOut: true, spawnError: false };
  if (failure) return { code: 1, text: '', stderr: failure, timedOut: false, spawnError: false };
  if (!text) return { code: 1, text: '', stderr: stderr || 'the Agent SDK returned no result', timedOut: false, spawnError: false };
  return { code: 0, text, stderr, timedOut: false, spawnError: false };
}
