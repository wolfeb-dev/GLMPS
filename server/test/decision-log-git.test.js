// server/test/decision-log-git.test.js
// glmps-143 Task 1. Pure parsing of `git log --merges --first-parent` output.
// Bodies are multi-line and subjects contain colons, so the format uses \x1f
// between fields and \x1e between records rather than newline delimiting.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FORMAT,
  parseMergeLog,
  selectEntries,
  resolveDefaultBranch,
} from '../lib/observability/decision-log-git.js';

// Build a record the way git actually emits it, so the test exercises the real
// separator handling rather than a convenient approximation.
const rec = (sha, ts, subject, body) => `${sha}\x1f${ts}\x1f${subject}\x1f${body}\x1e`;

test('FORMAT uses unit/record separators, not newlines', () => {
  assert.equal(FORMAT, '%H%x1f%ct%x1f%s%x1f%b%x1e');
});

test('parseMergeLog: parses multiple records with multi-line bodies', () => {
  const stdout =
    rec('864ff6e', '1753220000', 'merge: line-ending-independent attestation hashing (glmps-147)',
      'Fixes a live false positive.\n\nCovers both paths.\n') +
    '\n' +
    rec('fe36d75', '1753210000', 'merge: cross-agent memory first feed', 'Two threads.\n');

  const out = parseMergeLog(stdout);
  assert.equal(out.length, 2);
  assert.equal(out[0].commit, '864ff6e');
  assert.equal(out[0].ts, 1753220000 * 1000, 'ts is epoch ms');
  assert.equal(out[0].what, 'merge: line-ending-independent attestation hashing (glmps-147)');
  assert.match(out[0].why, /Covers both paths/);
  assert.equal(out[1].commit, 'fe36d75');
});

test('parseMergeLog: a subject containing a colon is not split', () => {
  const out = parseMergeLog(rec('abc1234', '1753220000', 'merge(evolution): Capability Registry view (Task 6)', ''));
  assert.equal(out.length, 1);
  assert.equal(out[0].what, 'merge(evolution): Capability Registry view (Task 6)');
});

test('parseMergeLog: empty body yields an empty why, not undefined', () => {
  const out = parseMergeLog(rec('abc1234', '1753220000', 'merge: no body here', ''));
  assert.equal(out[0].why, '');
});

test('parseMergeLog: malformed records are skipped, never thrown', () => {
  const stdout = 'garbage-with-no-separators\x1e' + rec('good123', '1753220000', 'merge: fine', 'body');
  const out = parseMergeLog(stdout);
  assert.equal(out.length, 1);
  assert.equal(out[0].commit, 'good123');
});

test('parseMergeLog: a non-numeric timestamp drops that record', () => {
  const out = parseMergeLog(rec('bad', 'not-a-number', 'merge: x', 'y'));
  assert.deepEqual(out, []);
});

test('parseMergeLog: empty or non-string input yields an empty array', () => {
  assert.deepEqual(parseMergeLog(''), []);
  assert.deepEqual(parseMergeLog(null), []);
});

test('selectEntries: prefers merges when the repo has any', () => {
  const merges = [{ commit: 'm1', ts: 2, what: 'merge: a', why: '' }];
  const commits = [{ commit: 'c1', ts: 1, what: 'fix: b', why: '' }];
  const out = selectEntries({ merges, commits });
  assert.deepEqual(out.map(e => e.commit), ['m1']);
});

test('selectEntries: falls back to commits so a no-merge repo is not silently empty', () => {
  const commits = [{ commit: 'c1', ts: 1, what: 'fix: b', why: '' }];
  const out = selectEntries({ merges: [], commits });
  assert.deepEqual(out.map(e => e.commit), ['c1']);
});

test('selectEntries: no merges and no commits yields an empty array', () => {
  assert.deepEqual(selectEntries({ merges: [], commits: [] }), []);
});

test('resolveDefaultBranch: prefers origin/HEAD when that branch exists locally', () => {
  assert.equal(resolveDefaultBranch('origin/develop\n', ['main', 'develop']), 'develop');
});

test('resolveDefaultBranch: ignores an origin/HEAD that does not exist locally', () => {
  // Real case: the glmps_prod export mirror has origin/HEAD -> origin/main but
  // only a local `master`. Trusting the remote produced `git log ... main`,
  // which cannot resolve, and the repo was skipped.
  assert.equal(resolveDefaultBranch('origin/main\n', ['master']), 'master');
});

test('resolveDefaultBranch: falls back to main, then master', () => {
  assert.equal(resolveDefaultBranch('', ['main', 'feature/x']), 'main');
  assert.equal(resolveDefaultBranch('', ['master', 'feature/x']), 'master');
});

test('resolveDefaultBranch: null when neither exists, so the caller can skip and log', () => {
  assert.equal(resolveDefaultBranch('', ['feature/x']), null);
  assert.equal(resolveDefaultBranch('', []), null);
});
