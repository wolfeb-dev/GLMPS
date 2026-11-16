import test from 'node:test';
import assert from 'node:assert/strict';
import { compareVersions, auditSurface, auditRebuild, auditRebuildWithFailures, planVersionTick } from '../lib/observability/graphify-version.js';

test('compareVersions orders numerically, not lexically', () => {
  assert.equal(compareVersions('0.8.39', '0.9.51'), -1);
  assert.equal(compareVersions('0.9.51', '0.8.39'), 1);
  assert.equal(compareVersions('0.9.51', '0.9.51'), 0);
  // the lexical trap: '0.9.9' > '0.9.51' as strings, but not as versions
  assert.equal(compareVersions('0.9.9', '0.9.51'), -1);
});

test('auditSurface passes when every required command is present', () => {
  const help = '  query "<q>"\n  explain "X"\n  update <path>\n  watch <path>\n';
  assert.deepEqual(auditSurface(help, ['query', 'explain', 'update', 'watch']), { ok: true, missing: [] });
});

test('auditSurface fails and names the missing commands', () => {
  const help = '  query "<q>"\n  update <path>\n';
  const r = auditSurface(help, ['query', 'explain', 'update', 'watch']);
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing.sort(), ['explain', 'watch']);
});

test('auditRebuild passes when graphs grow or hold', () => {
  const r = auditRebuild({ 'D:/a': 100, 'D:/b': 50 }, { 'D:/a': 120, 'D:/b': 50 }, { minRatio: 0.8 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.regressions, []);
});

test('auditRebuild fails a collapse and names the root', () => {
  // the real July shape: 6140 nodes down to 55
  const r = auditRebuild({ 'D:/mc': 6140 }, { 'D:/mc': 55 }, { minRatio: 0.8 });
  assert.equal(r.ok, false);
  assert.equal(r.regressions[0].root, 'D:/mc');
  assert.equal(r.regressions[0].before, 6140);
  assert.equal(r.regressions[0].after, 55);
});

test('auditRebuild tolerates a small honest shrink above the ratio', () => {
  const r = auditRebuild({ 'D:/a': 4479 }, { 'D:/a': 4478 }, { minRatio: 0.8 });
  assert.equal(r.ok, true);
});

test('auditRebuild treats a root missing from the after-set as a regression', () => {
  const r = auditRebuild({ 'D:/a': 100 }, {}, { minRatio: 0.8 });
  assert.equal(r.ok, false);
});

// a root whose update could not even be
// VERIFIED (still busy past the bounded wait, or any other per-root
// failure) must not be treated as a pass just because its UNCHANGED node
// count happens to clear auditRebuild's own ratio check -- that is exactly
// how a root skipped for being busy would otherwise look identical to one
// genuinely verified against the candidate version.
test('auditRebuildWithFailures: an unchanged (unverified) root still forces a rollback decision, not a silent pass', () => {
  const before = { 'D:/a': 100, 'D:/b': 50 };
  const after = { 'D:/a': 120, 'D:/b': 50 }; // b is UNCHANGED: auditRebuild alone would call this a pass
  const r = auditRebuildWithFailures(before, after, [{ root: 'D:/b', reason: 'graphify-busy: an update for D:/b is already running' }], { minRatio: 0.8 });
  assert.equal(r.ok, false);
  const bRegression = r.regressions.find((x) => x.root === 'D:/b');
  assert.ok(bRegression, `expected D:/b to be folded in as a regression, got: ${JSON.stringify(r.regressions)}`);
  assert.equal(bRegression.before, 50);
  assert.match(bRegression.after, /unverified.*graphify-busy/);
});

test('auditRebuildWithFailures: a genuine regression AND an unverified root are both reported', () => {
  // D:/x is UNCHANGED (10 -> 10): auditRebuild alone would call it a pass;
  // only the failures list flags it, so this proves the two sources merge
  // rather than one masking the other.
  const r = auditRebuildWithFailures({ 'D:/mc': 6140, 'D:/x': 10 }, { 'D:/mc': 55, 'D:/x': 10 }, [{ root: 'D:/x', reason: 'graphify-busy' }], { minRatio: 0.8 });
  assert.equal(r.ok, false);
  assert.equal(r.regressions.length, 2);
  assert.ok(r.regressions.some((x) => x.root === 'D:/mc' && x.before === 6140 && x.after === 55));
  assert.ok(r.regressions.some((x) => x.root === 'D:/x' && /unverified/.test(x.after)));
});

test('auditRebuildWithFailures with no failures behaves exactly like auditRebuild', () => {
  const r = auditRebuildWithFailures({ 'D:/a': 100 }, { 'D:/a': 120 }, [], { minRatio: 0.8 });
  assert.deepEqual(r, auditRebuild({ 'D:/a': 100 }, { 'D:/a': 120 }, { minRatio: 0.8 }));
});

test('planVersionTick honours enabled, single-flight and the interval', () => {
  const base = { enabled: true, running: false, lastRunAt: null, now: 1_000_000, minIntervalMs: 1000 };
  assert.equal(planVersionTick(base), true);
  assert.equal(planVersionTick({ ...base, enabled: false }), false);
  assert.equal(planVersionTick({ ...base, running: true }), false);
  assert.equal(planVersionTick({ ...base, lastRunAt: 999_999 }), false);
  assert.equal(planVersionTick({ ...base, lastRunAt: 998_000 }), true);
});
