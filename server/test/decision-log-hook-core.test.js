// server/test/decision-log-hook-core.test.js
// glmps-143 Task 5. The Stop hook's pure core: decide which commits are thin
// enough to deserve a transcript-derived why, and turn a settings.json change
// into exactly one config row.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { THIN_BODY_CHARS, selectThinCommits, buildConfigRow } from '../lib/observability/decision-log-hook-core.js';
import { summarize } from '../lib/observability/decision-log-config.js';

test('THIN_BODY_CHARS default matches the spec', () => {
  assert.equal(THIN_BODY_CHARS, 80);
});

test('selectThinCommits: only bodies under the floor are selected', () => {
  const commits = [
    { commit: 'fat', why: 'x'.repeat(200) },
    { commit: 'thin', why: 'typo' },
    { commit: 'empty', why: '' },
  ];
  assert.deepEqual(selectThinCommits(commits).map(c => c.commit), ['thin', 'empty']);
});

test('selectThinCommits: whitespace-only bodies count as thin', () => {
  assert.deepEqual(selectThinCommits([{ commit: 'ws', why: '   \n\n  ' }]).map(c => c.commit), ['ws']);
});

test('selectThinCommits: the real glmps-147 merge body is NOT thin', () => {
  // 251 chars, measured from the actual commit. A hand-written explanation must
  // never be overwritten by an inferred one.
  const why = 'Fixes a live false positive found immediately after the first cross-agent memory push: attestation reported critical:5 on a clean tree because git rewrote LF to CRLF on checkout. Covers both the memory and guardrail attestation paths. 2766/2766 green.';
  assert.deepEqual(selectThinCommits([{ commit: '864ff6e', why }]), []);
});

test('selectThinCommits: honours an override floor', () => {
  const commits = [{ commit: 'a', why: 'x'.repeat(100) }];
  assert.equal(selectThinCommits(commits, { thinChars: 200 }).length, 1);
  assert.equal(selectThinCommits(commits, { thinChars: 50 }).length, 0);
});

test('selectThinCommits: non-array input yields empty, never throws', () => {
  assert.deepEqual(selectThinCommits(null), []);
});

test('buildConfigRow: the FIRST run is a silent baseline, not a giant "everything added" row', () => {
  // Observed when first exercising the hook: with prev=null every hook,
  // permission and env key diffs as "added", writing one enormous meaningless
  // entry on a fresh install.
  const next = summarize({
    hooks: { Stop: [{ hooks: [{ command: 'node a.js' }] }] },
    permissions: { deny: ['Read(**/.env)'] },
    env: { X: '1' },
  });
  assert.equal(buildConfigRow({ prev: null, next, ts: 1 }), null);
});

test('buildConfigRow: no change yields null, so no empty row is written', () => {
  const s = summarize({ hooks: { Stop: [{ hooks: [{ command: 'node a.js' }] }] }, env: {} });
  assert.equal(buildConfigRow({ prev: s, next: s, ts: 1 }), null);
});

test('buildConfigRow: a change yields exactly one config row carrying the diff', () => {
  const prev = summarize({ hooks: { Stop: [{ hooks: [{ command: 'node a.js' }] }] }, env: {} });
  const next = summarize({ hooks: { Stop: [{ hooks: [{ command: 'node a.js' }, { command: 'node b.js' }] }] }, env: {} });
  const row = buildConfigRow({ prev, next, ts: 1753220000000 });
  assert.equal(row.source, 'config');
  assert.equal(row.ts, 1753220000000);
  assert.deepEqual(row.sections['hooks.Stop'].added, ['b.js']);
  assert.equal(row.sha256, next.sha256);
  assert.match(row.what, /settings\.json/);
});

test('buildConfigRow: carries no raw env value', () => {
  const SECRET = 'sk-live-must-not-appear';
  const prev = summarize({ env: {} });
  const next = summarize({ env: { TOKEN: SECRET } });
  const row = buildConfigRow({ prev, next, ts: 1 });
  assert.ok(!JSON.stringify(row).includes(SECRET));
  assert.ok(JSON.stringify(row).includes('TOKEN'));
});
