// affected-tests: always
// Spec T1 (card glmps-2-0-runtime-150): server/lib/state-dir.js is the only
// runtime module that may spell the old state folder name. Everything else
// asks the seam, so the folder can be renamed (T6) without a code hunt.
// apps/shell is a separately packaged Electron app that must not import core
// (it keeps its own copy of the formula), and companion/ is deleted in Phase S;
// both are outside this scan by design.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCAN_DIRS = ['server', 'scripts', 'hooks', 'taps', 'plugins', 'web'];
const SKIP_DIRS = new Set(['node_modules', 'test', 'vendor', 'graphify-out', 'huddle-assets']);
const EXTS = new Set(['.js', '.mjs', '.cjs', '.ps1', '.cmd', '.sh']);
const SEAM = 'server/lib/state-dir.js';
// Built by concatenation so this file does not itself match.
const OLD_NAME = new RegExp(`[.]${'mission'}-control`);
const isCommentLine = (l) => /^\s*(\/\/|\*|\/\*|#|rem\b|::)/i.test(l);

export function oldNameHits(text) {
  const hits = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (!isCommentLine(line) && OLD_NAME.test(line)) hits.push({ line: i + 1, text: line.trim() });
  });
  return hits;
}

function* walk(dir) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) yield* walk(abs); }
    else if (EXTS.has(path.extname(e.name))) yield abs;
  }
}

test('the scan flags code that spells the old folder and ignores comments', () => {
  const name = `.${'mission'}-control`;
  assert.equal(oldNameHits(`const d = path.join(home, '${name}');`).length, 1);
  assert.equal(oldNameHits(`const d = path.join(home, '${name}-2');`).length, 1);
  assert.equal(oldNameHits(`// default is ~/${name}\n * see ~/${name}`).length, 0);
  assert.equal(oldNameHits(`const repo = 'D:/glmps';`).length, 0);
});

test('no runtime module or script outside the state-dir seam spells the old state folder name', () => {
  const offenders = [];
  for (const d of SCAN_DIRS) {
    for (const abs of walk(path.join(ROOT, d))) {
      const rel = path.relative(ROOT, abs).split(path.sep).join('/');
      if (rel === SEAM) continue;
      for (const h of oldNameHits(fs.readFileSync(abs, 'utf8'))) offenders.push(`${rel}:${h.line}: ${h.text}`);
    }
  }
  assert.deepEqual(offenders, [], `ask server/lib/state-dir.js instead:\n${offenders.join('\n')}`);
});

test.skip('the seam itself still names the old folder, so the scan is not vacuous', () => {
  assert.ok(oldNameHits(fs.readFileSync(path.join(ROOT, SEAM), 'utf8')).length > 0);
});
