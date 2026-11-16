// Tests for the Stop-hook ci-status-surface pure decision functions (glmps-9).
// No network / no gh / no git - the CLI's I/O layer is exercised only indirectly via
// these injected-data pure functions, per the hook's pure-core-plus-CLI split.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideCiWarning, parseGhRunJson, shouldQueryCi, DEFAULT_RECENT_MS } from '../../hooks/ci-status-surface.js';

const NOW = Date.parse('2026-07-14T12:00:00Z');
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();

function run(overrides = {}) {
  return {
    databaseId: 123,
    conclusion: 'failure',
    status: 'completed',
    headSha: 'abc123',
    url: 'https://github.com/wolfeb-dev/glmps/actions/runs/123',
    workflowName: 'CI',
    createdAt: iso(30 * 60 * 1000), // 30 minutes ago
    ...overrides,
  };
}


test('recent completed failure -> warns, names workflow + url', () => {
  const w = decideCiWarning({ run: run(), now: NOW });
  assert.ok(w);
  assert.match(w, /CI is red/i);
  assert.match(w, /"CI" failed/);
  assert.match(w, /https:\/\/github\.com\/wolfeb-dev\/glmps\/actions\/runs\/123/);
});

test('recent completed success -> null', () => {
  const w = decideCiWarning({ run: run({ conclusion: 'success' }), now: NOW });
  assert.equal(w, null);
});

test('in_progress run -> null (nothing final to report yet)', () => {
  const w = decideCiWarning({ run: run({ status: 'in_progress', conclusion: null }), now: NOW });
  assert.equal(w, null);
});

test('queued run -> null', () => {
  const w = decideCiWarning({ run: run({ status: 'queued', conclusion: null }), now: NOW });
  assert.equal(w, null);
});

test('stale failure (older than the recency window) -> null', () => {
  const w = decideCiWarning({ run: run({ createdAt: iso(DEFAULT_RECENT_MS + 60 * 1000) }), now: NOW });
  assert.equal(w, null);
});

test('failure right at the recency boundary still warns; just past it does not', () => {
  const atBoundary = decideCiWarning({ run: run({ createdAt: iso(DEFAULT_RECENT_MS) }), now: NOW });
  assert.ok(atBoundary);
  const pastBoundary = decideCiWarning({ run: run({ createdAt: iso(DEFAULT_RECENT_MS + 1) }), now: NOW });
  assert.equal(pastBoundary, null);
});

test('custom recentMs is honored', () => {
  const w = decideCiWarning({ run: run({ createdAt: iso(90 * 60 * 1000) }), now: NOW, recentMs: 60 * 60 * 1000 });
  assert.equal(w, null); // 90 min old, 60 min window -> stale
  const w2 = decideCiWarning({ run: run({ createdAt: iso(90 * 60 * 1000) }), now: NOW, recentMs: 2 * 60 * 60 * 1000 });
  assert.ok(w2); // 90 min old, 2h window -> still recent
});

for (const conclusion of ['cancelled', 'skipped', 'neutral', 'action_required', 'stale', null, undefined]) {
  test(`completed run with conclusion=${conclusion} -> null (not in the red-state warn set)`, () => {
    const w = decideCiWarning({ run: run({ conclusion }), now: NOW });
    assert.equal(w, null);
  });
}

for (const conclusion of ['failure', 'timed_out', 'startup_failure']) {
  test(`completed run with conclusion=${conclusion} -> warns (red terminal state)`, () => {
    const w = decideCiWarning({ run: run({ conclusion }), now: NOW });
    assert.ok(w);
    assert.match(w, /CI is red/i);
  });
}

test('no run at all (null) -> null', () => {
  assert.equal(decideCiWarning({ run: null, now: NOW }), null);
});

test('missing run entirely (undefined opts field) -> null', () => {
  assert.equal(decideCiWarning({ now: NOW }), null);
});

test('non-object run -> null, never throws', () => {
  assert.equal(decideCiWarning({ run: 'not an object', now: NOW }), null);
  assert.equal(decideCiWarning({ run: 42, now: NOW }), null);
});

test('unparseable createdAt -> null (fail open, never throws)', () => {
  assert.equal(decideCiWarning({ run: run({ createdAt: 'not-a-date' }), now: NOW }), null);
  assert.equal(decideCiWarning({ run: run({ createdAt: undefined }), now: NOW }), null);
});

test('missing workflowName falls back to "CI" in the message', () => {
  const w = decideCiWarning({ run: run({ workflowName: undefined }), now: NOW });
  assert.match(w, /"CI" failed/);
});

test('missing url omits the url segment but still warns', () => {
  const w = decideCiWarning({ run: run({ url: undefined }), now: NOW });
  assert.ok(w);
  assert.doesNotMatch(w, /undefined/);
});

test('default now() is used when omitted (does not throw)', () => {
  // createdAt "now" (Date.now() default) means age ~0 -> should still warn.
  const w = decideCiWarning({ run: run({ createdAt: new Date().toISOString() }) });
  assert.ok(w);
});


test('parseGhRunJson: single-element array -> that element', () => {
  const r = run();
  assert.deepEqual(parseGhRunJson(JSON.stringify([r])), r);
});

test('parseGhRunJson: empty array (no runs yet) -> null', () => {
  assert.equal(parseGhRunJson('[]'), null);
});

test('parseGhRunJson: invalid JSON -> null, never throws', () => {
  assert.equal(parseGhRunJson('not json'), null);
  assert.equal(parseGhRunJson(''), null);
  assert.equal(parseGhRunJson(undefined), null);
});

test('parseGhRunJson: JSON but not an array -> null', () => {
  assert.equal(parseGhRunJson(JSON.stringify({ not: 'an array' })), null);
});

test('parseGhRunJson: takes only the first element (gh -L 1 already bounds it)', () => {
  const r1 = run({ databaseId: 1 });
  const r2 = run({ databaseId: 2 });
  assert.deepEqual(parseGhRunJson(JSON.stringify([r1, r2])), r1);
});


test('shouldQueryCi: all true -> true', () => {
  assert.equal(shouldQueryCi({ isRepo: true, hasGithubRemote: true, hasWorkflowsDir: true }), true);
});

test('shouldQueryCi: not a repo -> false', () => {
  assert.equal(shouldQueryCi({ isRepo: false, hasGithubRemote: true, hasWorkflowsDir: true }), false);
});

test('shouldQueryCi: no GitHub remote -> false', () => {
  assert.equal(shouldQueryCi({ isRepo: true, hasGithubRemote: false, hasWorkflowsDir: true }), false);
});

test('shouldQueryCi: no workflows dir -> false', () => {
  assert.equal(shouldQueryCi({ isRepo: true, hasGithubRemote: true, hasWorkflowsDir: false }), false);
});

test('shouldQueryCi: none true -> false', () => {
  assert.equal(shouldQueryCi({ isRepo: false, hasGithubRemote: false, hasWorkflowsDir: false }), false);
});
