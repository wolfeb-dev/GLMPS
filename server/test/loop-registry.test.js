// affected-tests: always
// server/test/loop-registry.test.js
// Build-failing enforcement of the loop contract (program section 0): every
// setInterval( in server/**/*.js is either inside the registry or allowlisted
// with a reason. A new background job must go through registerLoop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { LOOP_ALLOWLIST } from '../lib/loops/allowlist.js';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
function jsFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'test' && e.name !== 'node_modules') out.push(...jsFiles(p)); }
    else if (e.name.endsWith('.js') || e.name.endsWith('.mjs')) out.push(p);
  }
  return out;
}

test('every setInterval in server/ and plugins/ is the registry or allowlisted with a reason', () => {
  const hits = [];
  const PLUGINS = path.resolve(ROOT, '..', 'plugins');
  const files = [...jsFiles(ROOT), ...(fs.existsSync(PLUGINS) ? jsFiles(PLUGINS).filter((f) => !/[\\/]vendor[\\/]/.test(f)) : [])];
  for (const f of files) {
    const rel = path.relative(ROOT, f).replace(/\\/g, '/');
    // The registry itself, and the allowlist's own data file: LOOP_ALLOWLIST's
    // match strings are literal fragments of other files' setInterval( calls,
    // so its own source text necessarily contains that same substring without
    // ever calling setInterval itself. Scanning it would be a self-referential
    // false positive, not a real background job hiding from the registry.
    if (rel === 'lib/loops/registry.js' || rel === 'lib/loops/allowlist.js') continue;
    fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      if (/\bsetInterval\s*\(/.test(line) && !/^\s*\/\//.test(line)) hits.push({ file: rel, line: i + 1, text: line.trim() });
    });
  }
  const unlisted = hits.filter((h) => !LOOP_ALLOWLIST.some((a) => a.file === h.file && h.text.includes(a.match)));
  assert.deepEqual(unlisted, [], 'register these through registerLoop, or allowlist them with a reason');
  const stale = LOOP_ALLOWLIST.filter((a) => !hits.some((h) => h.file === a.file && h.text.includes(a.match)));
  assert.deepEqual(stale, [], 'allowlist rows that no longer match code must be removed');
  // A row that matches more than one real line is not naming a specific
  // interval, it is naming a shape: it would silently cover a future,
  // different setInterval( that happens to share the same fragment (a new
  // ternary-guarded arrow-function tick, say), never failing the scan for it.
  // Every row must resolve to exactly the one line it claims to allowlist.
  const ambiguous = LOOP_ALLOWLIST
    .map((a) => ({ a, matches: hits.filter((h) => h.file === a.file && h.text.includes(a.match)) }))
    .filter(({ matches }) => matches.length > 1);
  assert.deepEqual(
    ambiguous.map(({ a, matches }) => ({ file: a.file, match: a.match, lines: matches.map((m) => m.line) })),
    [],
    'each allowlist row must match exactly one setInterval( line, not several',
  );
  for (const a of LOOP_ALLOWLIST) assert.ok(a.reason && a.reason.length > 10, `reason for ${a.match}`);
});
