import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRefIntent, evaluateLease } from '../lib/governance/push-lease.js';

const P = { currentBranch: 'feat/x', protectedRef: 'main' };


test('detects an explicit push to the protected ref', () => {
  const r = parseRefIntent({ command: 'git push origin main', ...P });
  assert.equal(r.advances, true);
  assert.equal(r.kind, 'push');
  assert.equal(r.target, 'main');
});

test('detects push origin HEAD:main (the form used in the 2026-07-22 collision)', () => {
  const r = parseRefIntent({ command: 'git push origin HEAD:main', ...P });
  assert.equal(r.advances, true);
  assert.equal(r.kind, 'push');
});

test('detects a branch:main refspec push', () => {
  const r = parseRefIntent({ command: 'git push origin feat/vitals-trends-ui:main', ...P });
  assert.equal(r.advances, true);
  assert.equal(r.kind, 'push');
});

test('detects push -u origin main', () => {
  assert.equal(parseRefIntent({ command: 'git push -u origin main', ...P }).advances, true);
});

test('detects a bare push whose upstream is the protected ref', () => {
  const r = parseRefIntent({ command: 'git push', ...P, upstreamRef: 'main' });
  assert.equal(r.advances, true);
  assert.equal(r.kind, 'push');
});

test('a bare push with a non-protected upstream does not advance', () => {
  assert.equal(parseRefIntent({ command: 'git push', ...P, upstreamRef: 'feat/x' }).advances, false);
});

test('pushing a feature branch to its own name does not advance', () => {
  assert.equal(parseRefIntent({ command: 'git push origin feat/x', ...P }).advances, false);
});


test('detects a merge while checked out on the protected ref', () => {
  const r = parseRefIntent({ command: 'git merge --no-ff feat/x', currentBranch: 'main', protectedRef: 'main' });
  assert.equal(r.advances, true);
  assert.equal(r.kind, 'merge');
});

test('detects a commit while checked out on the protected ref', () => {
  const r = parseRefIntent({ command: 'git commit -m "x"', currentBranch: 'main', protectedRef: 'main' });
  assert.equal(r.advances, true);
  assert.equal(r.kind, 'commit');
});

test('a commit on a feature branch does not advance', () => {
  assert.equal(parseRefIntent({ command: 'git commit -m "x"', ...P }).advances, false);
});


test('read-only git commands do not advance', () => {
  for (const c of ['git fetch -q origin', 'git log --oneline -5', 'git status --short', 'git diff main']) {
    assert.equal(parseRefIntent({ command: c, currentBranch: 'main', protectedRef: 'main' }).advances, false, c);
  }
});

test('a non-git command mentioning the push text does not advance', () => {
  const r = parseRefIntent({ command: 'echo "remember to git push origin main"', ...P });
  assert.equal(r.advances, false);
});

test('a different protected ref is not matched', () => {
  assert.equal(parseRefIntent({ command: 'git push origin main', currentBranch: 'x', protectedRef: 'master' }).advances, false);
});


test('splits compound commands and catches a push in any segment', () => {
  const cmd = 'cd "D:/repo" && git add -A && git commit -q -m "wip" && git push origin HEAD:main';
  const r = parseRefIntent({ command: cmd, ...P });
  assert.equal(r.advances, true);
  assert.equal(r.kind, 'push');
});

test('a cd into a path named main does not advance', () => {
  assert.equal(parseRefIntent({ command: 'cd "D:/repo/main" && npm test', ...P }).advances, false);
});


const NOW = 1_000_000;
const TTL = 15 * 60 * 1000;
const intent = { advances: true, kind: 'push', target: 'main' };
const base = { intent, selfId: 'me', nowMs: NOW, ttlMs: TTL, liveSessionIds: ['me', 'other'] };

test('a command that does not advance is always allowed', () => {
  const r = evaluateLease({ ...base, intent: { advances: false }, lease: { ref: 'main', sessionId: 'other', renewedAt: NOW } });
  assert.equal(r.action, 'allow');
});

test('no lease on file => acquire', () => {
  assert.equal(evaluateLease({ ...base, lease: null }).action, 'acquire');
});

test('own lease => renew', () => {
  assert.equal(evaluateLease({ ...base, lease: { ref: 'main', sessionId: 'me', renewedAt: NOW - 1000 } }).action, 'renew');
});

test('another live session holding a fresh lease => block', () => {
  const r = evaluateLease({ ...base, lease: { ref: 'main', sessionId: 'other', renewedAt: NOW - 1000 } });
  assert.equal(r.action, 'block');
  assert.match(r.reason, /other/);
});

test('an expired lease is reclaimable', () => {
  const r = evaluateLease({ ...base, lease: { ref: 'main', sessionId: 'other', renewedAt: NOW - TTL - 1 } });
  assert.equal(r.action, 'acquire');
  assert.match(r.reason, /expired|stale/i);
});

test('a lease held by a dead session is reclaimable', () => {
  const r = evaluateLease({ ...base, liveSessionIds: ['me'], lease: { ref: 'main', sessionId: 'ghost', renewedAt: NOW - 1000 } });
  assert.equal(r.action, 'acquire');
  assert.match(r.reason, /not live|dead/i);
});

test('unknown liveness (null) must not be read as "holder is dead"', () => {
  const r = evaluateLease({ ...base, liveSessionIds: null, lease: { ref: 'main', sessionId: 'other', renewedAt: NOW - 1000 } });
  assert.equal(r.action, 'block');
});

test('a lease for a different ref does not block this ref', () => {
  const r = evaluateLease({ ...base, lease: { ref: 'release', sessionId: 'other', renewedAt: NOW - 1000 } });
  assert.equal(r.action, 'acquire');
});

test('acquiredAt is used when renewedAt is absent', () => {
  const r = evaluateLease({ ...base, lease: { ref: 'main', sessionId: 'other', acquiredAt: NOW - TTL - 1 } });
  assert.equal(r.action, 'acquire');
});

// Review P4 follow-up: wrapped or chained pushes were invisible to the lease.
test('wrapped and chained pushes to the leased ref are still recognised', () => {
  const cases = [
    'bash -c "git push origin main"',
    "sh -c 'git add . && git push origin HEAD:main'",
    'cmd /c git push origin main',
    'powershell -Command "git push origin main"',
    'FOO=1 git push origin main',
    '(git push origin main)',
    'env git push origin main',
    'command git push origin main',
    'exec git push origin main',
    'true; git push origin main',
    'false || git push origin main',
    'echo hi | git push origin main',
    'git -C D:/repo push origin main',
    '/usr/bin/git push origin main',
  ];
  for (const command of cases) {
    const r = parseRefIntent({ command, ...P });
    assert.equal(r.advances, true, command);
    assert.equal(r.kind, 'push', command);
  }
});

test('wrapped commands that do not push to the leased ref do not advance it', () => {
  const cases = [
    'bash -c "git push origin feat/x"',
    'FOO=1 git push origin feat/x',
    'bash -c "echo git push origin main"',
    'echo "a && git push origin main"',
    '(git log main)',
  ];
  for (const command of cases) assert.equal(parseRefIntent({ command, ...P }).advances, false, command);
});
