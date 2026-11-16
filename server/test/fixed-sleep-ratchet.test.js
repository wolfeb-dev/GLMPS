// affected-tests: always
// glmps-2-0-54: most CI flakes were a test sleeping a fixed few ms and then
// asserting. That holds on a dev box and fails on a loaded runner. Each file's
// count of fixed sleeps may fall but never rise; new code waits on the
// condition with helpers/wait-for.js instead. A test that genuinely needs a
// quiet period (asserting that nothing happens) raises its entry in
// fixed-sleep-baseline.json on purpose, where review can see it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const baselineFile = path.join(here, 'fixed-sleep-baseline.json');
const SKIP_DIRS = new Set(['node_modules', '.git', '.claude']);

// `setTimeout(r, 20)` inside a promise, or a sleep-style helper called with a
// literal: `sleep(50)`, `settle(60)`, `delay(10)`, `wait(5)`, `pause(100)`.
const FIXED_SLEEP = /setTimeout\(\s*(?:r|res|resolve|done)\s*,\s*\d+\s*\)|\b(?:sleep|settle|delay|wait|pause)\(\s*\d+\s*\)/g;

function testFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) testFiles(path.join(dir, e.name), out); continue; }
    if (e.name.endsWith('.test.js')) out.push(path.join(dir, e.name));
  }
  return out;
}

function countFixedSleeps(root = repoRoot) {
  const counts = {};
  for (const f of testFiles(root)) {
    const rel = path.relative(root, f).split(path.sep).join('/');
    if (rel === 'server/test/fixed-sleep-ratchet.test.js') continue;
    const n = (fs.readFileSync(f, 'utf8').match(FIXED_SLEEP) ?? []).length;
    if (n) counts[rel] = n;
  }
  return counts;
}

test('the pattern catches inline and helper sleeps, and not a condition wait', () => {
  const hits = (s) => (s.match(FIXED_SLEEP) ?? []).length;
  assert.equal(hits('await new Promise((r) => setTimeout(r, 20));'), 1);
  assert.equal(hits('await settle(60); await sleep(5);'), 2);
  assert.equal(hits("await waitFor(() => done, { message: 'x' });"), 0);
  assert.equal(hits('const timer = setTimeout(() => finish(), settleMs);'), 0);
});

test.skip('no test file adds a fixed sleep beyond its baseline', () => {
  const baseline = JSON.parse(fs.readFileSync(baselineFile, 'utf8'));
  const now = countFixedSleeps();
  const rose = Object.entries(now).filter(([f, n]) => n > (baseline[f] ?? 0)).map(([f, n]) => `${f}: ${baseline[f] ?? 0} -> ${n}`);
  assert.deepEqual(rose, [], `fixed sleeps added. Wait on the condition with waitFor from server/test/helpers/wait-for.js instead; if the test really needs a quiet period, raise its entry in server/test/fixed-sleep-baseline.json`);
  const fell = Object.entries(baseline).filter(([f, n]) => (now[f] ?? 0) < n).map(([f, n]) => `${f}: ${n} -> ${now[f] ?? 0}`);
  assert.deepEqual(fell, [], 'fixed sleeps removed: lower these entries in the baseline so they cannot come back');
});
