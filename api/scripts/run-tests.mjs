// `npm test`: every test file, with the clock pinned for the five that depend on fixed July 2026 dates.
// Remove DATED when upstream's fixtures are made relative to the current date.
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATED = ['jobs', 'coach-limits', 'payload-bounds', 'payload', 'routes'].map(n => `test/${n}.test.js`);
const all = readdirSync(path.join(root, 'test')).filter(f => f.endsWith('.test.js')).map(f => `test/${f}`).sort();
const run = (files, env = {}) => spawnSync(process.execPath, ['--test', ...files], { cwd: root, stdio: 'inherit', env: { ...process.env, ...env } }).status ?? 1;

const pin = `--import ${path.join(root, 'test/clock-pin.mjs')}`;
const a = run(all.filter(f => !DATED.includes(f)));
const b = run(DATED, { NODE_OPTIONS: [process.env.NODE_OPTIONS, pin].filter(Boolean).join(' ') });
process.exit(a || b);
