/* Text from outside (the AI runtime's error output, a service's message) made safe to write to the server log: control
 * characters and runs of white space become one space, anything that looks like a credential, an address, an email or a
 * URL is replaced, and the result is cut to a short length. It errs on the side of hiding too much: a log line is for
 * telling what kind of thing failed, not for reconstructing the text.
 */
const RULES = [
  [/\bBearer\s+\S+/gi, 'Bearer [hidden]'],
  [/\b(api[-_ ]?key|x-api-key|token|secret|password|passwd|authorization|credential)s?\s*["']?\s*[:=]\s*["']?[^\s"',;]+/gi, '$1=[hidden]'],
  [/\b(?:sk|ogh|ghp|gho|github_pat|xox[a-z])[-_][A-Za-z0-9_-]{6,}/g, '[hidden]'],
  [/https?:\/\/\S+/gi, '[url]'],
  [/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '[email]'],
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[address]'],
  [/\b[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){3,7}\b/gi, '[address]'],
  [/[A-Za-z0-9_+/=-]{24,}/g, '[hidden]']
];

export function redact(text, max = 160) {
  let s = String(text ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  for (const [re, to] of RULES) s = s.replace(re, to);
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}
