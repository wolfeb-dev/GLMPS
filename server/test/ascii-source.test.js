// affected-tests: always
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const EXT_RE = /\.(js|mjs|cjs|ts|css|html|json|py|ps1|cmd|yml|yaml)$/;

// [prefix, infix]: a path is excluded when it starts with prefix and contains infix.
const EXCLUDE_TREES = [
  // Upstream code kept byte-identical to a pinned release (D24).
  ['plugins/', '/vendor/'],
  // Vendored or minified bundles served as-is.
  ['web/vendor/', ''],
  // Huddle voice and speech-model bundles, vendored with their LICENSES.md.
  ['web/huddle-assets/', ''],
  // Generated wiki asset bundles.
  ['server/lib/observability/wiki-assets/', ''],
];
// Exact paths whose purpose is to hold non-ASCII input. Empty on purpose: add a
// row only with a reason a reviewer accepts.
const EXCLUDE_FILES = new Set([]);

// Docs, assets and agent skill folders carry prose and are not source or config.
const SCOPE_RE = /^(server|hooks|scripts|taps|web|apps|plugins|companion)\//;

function excluded(rel) {
  if (rel.includes('/') && !SCOPE_RE.test(rel)) return true;
  if (EXCLUDE_FILES.has(rel)) return true;
  // Lockfiles are tool-generated; minified bundles are not hand-written source.
  if (rel.endsWith('package-lock.json') || /\.min\.(js|css)$/.test(rel)) return true;
  return EXCLUDE_TREES.some(([prefix, infix]) => rel.startsWith(prefix) && rel.includes(infix));
}

export function findNonAscii(text) {
  const hits = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /[^\x00-\x7f]/.exec(lines[i]);
    if (m) hits.push({ line: i + 1, col: m.index + 1, ch: 'U+' + lines[i].codePointAt(m.index).toString(16).toUpperCase().padStart(4, '0') });
  }
  return hits;
}

test('findNonAscii reports line, column and code point', () => {
  const dash = String.fromCharCode(0x2014);
  assert.deepEqual(findNonAscii('ok\nab' + dash + 'c'), [{ line: 2, col: 3, ch: 'U+2014' }]);
  assert.deepEqual(findNonAscii('plain'), []);
});

test('tracked source and config files are ASCII only', () => {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 }).toString('utf8');
  const files = out.split('\0').filter((f) => f && EXT_RE.test(f) && !excluded(f));
  const bad = [];
  for (const rel of files) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) continue;
    for (const h of findNonAscii(fs.readFileSync(abs, 'utf8'))) bad.push(`${rel}:${h.line}:${h.col} ${h.ch}`);
  }
  assert.equal(bad.length, 0, `non-ASCII bytes in tracked source (${bad.length}):\n${bad.slice(0, 200).join('\n')}`);
});
