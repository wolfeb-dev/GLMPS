import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  outcomeRecord, removalVerdict, gatherWorktreeFacts, sameOutcome, outcomeRecordedFor,
} from '../lib/orchestration/worktree-outcome.js';

const facts = (over = {}) => ({ branch: 'glmps-runner/p/c-1', head: 'a'.repeat(40), pushed: false, merged: false, dirty: 0, ...over });

test('removalVerdict: nothing leaves before its outcome record is written', () => {
  const v = removalVerdict({ facts: facts({ merged: true }), written: false });
  assert.equal(v.remove, false);
  assert.equal(v.reason, 'no-record');
});

test('removalVerdict: a clean tree whose head is pushed or merged may go once recorded', () => {
  assert.deepEqual(removalVerdict({ facts: facts({ pushed: true }), written: true }), { remove: true, reason: 'clean-pushed' });
  assert.deepEqual(removalVerdict({ facts: facts({ merged: true }), written: true }), { remove: true, reason: 'clean-merged' });
});

test('removalVerdict: uncommitted changes keep it, even when the head is pushed', () => {
  const v = removalVerdict({ facts: facts({ pushed: true, merged: true, dirty: 3 }), written: true });
  assert.equal(v.remove, false);
  assert.equal(v.reason, 'dirty');
});

test('removalVerdict: a head that is neither pushed nor merged is kept', () => {
  const v = removalVerdict({ facts: facts(), written: true });
  assert.equal(v.remove, false);
  assert.equal(v.reason, 'unpushed');
});

test('removalVerdict: facts that could not be read keep it rather than guess', () => {
  assert.equal(removalVerdict({ facts: facts({ dirty: null, merged: true }), written: true }).reason, 'unreadable');
  assert.equal(removalVerdict({ facts: facts({ head: null, merged: true }), written: true }).reason, 'unreadable');
  assert.equal(removalVerdict({ facts: null, written: true }).reason, 'unreadable');
});

test('outcomeRecord carries branch, head, pushed, merged, dirty count, PR, merge-request stage and gate', () => {
  const card = {
    mergeRequest: { prUrl: 'https://github.com/o/r/pull/9', stage: 'merged' },
    gate: { status: 'PASS' },
  };
  assert.deepEqual(outcomeRecord(facts({ pushed: true, dirty: 2 }), card), {
    branch: 'glmps-runner/p/c-1', head: 'a'.repeat(40), pushed: true, merged: false, dirty: 2,
    prUrl: 'https://github.com/o/r/pull/9', mergeStage: 'merged', gate: 'PASS',
  });
});

test('outcomeRecord leaves PR, stage and gate null on a card that has none', () => {
  const r = outcomeRecord(facts(), {});
  assert.equal(r.prUrl, null);
  assert.equal(r.mergeStage, null);
  assert.equal(r.gate, null);
});

test('sameOutcome ignores nothing that matters: any changed fact is a new record', () => {
  const a = outcomeRecord(facts({ pushed: true }), {});
  assert.equal(sameOutcome(a, { ...a }), true);
  assert.equal(sameOutcome(a, { ...a, pushed: false }), false);
  assert.equal(sameOutcome(a, { ...a, dirty: 1 }), false);
  assert.equal(sameOutcome(a, null), false);
});

test('outcomeRecordedFor: the stored record must belong to this worktree', () => {
  const card = { runSession: { worktree: { dir: '/w/a' }, outcome: { branch: 'b', head: 'h', dir: '/w/a' } } };
  assert.equal(outcomeRecordedFor(card, '/w/a'), true);
  assert.equal(outcomeRecordedFor(card, '/w/other'), false);
  assert.equal(outcomeRecordedFor({ runSession: {} }, '/w/a'), false);
  assert.equal(outcomeRecordedFor(null, '/w/a'), false);
});

// A scripted git: key is the subcommand joined, value is { status, stdout }.
function fakeGit(script) {
  const calls = [];
  const git = (args) => {
    calls.push(args.join(' '));
    for (const [prefix, res] of script) if (args.join(' ').startsWith(prefix)) return res;
    return { status: 128, stdout: '' };
  };
  return { git, calls };
}

test('gatherWorktreeFacts reads head, dirty count, pushed and merged', () => {
  const { git } = fakeGit([
    ['rev-parse HEAD', { status: 0, stdout: 'abc123\n' }],
    ['status --porcelain', { status: 0, stdout: ' M a.js\n?? b.js\n' }],
    ['for-each-ref', { status: 0, stdout: 'refs/remotes/origin/glmps-runner/p/c-1\n' }],
    ['merge-base --is-ancestor abc123 origin/main', { status: 0, stdout: '' }],
  ]);
  const f = gatherWorktreeFacts({ dir: '/w', branch: 'glmps-runner/p/c-1', git, integrationRefs: ['origin/main'] });
  assert.deepEqual(f, { branch: 'glmps-runner/p/c-1', head: 'abc123', pushed: true, merged: true, dirty: 2 });
});

test('gatherWorktreeFacts: not pushed, not an ancestor of any integration ref', () => {
  const { git } = fakeGit([
    ['rev-parse HEAD', { status: 0, stdout: 'abc123\n' }],
    ['status --porcelain', { status: 0, stdout: '' }],
    ['for-each-ref', { status: 0, stdout: '\n' }],
    ['merge-base', { status: 1, stdout: '' }],
  ]);
  const f = gatherWorktreeFacts({ dir: '/w', branch: 'b', git, integrationRefs: ['origin/main', 'main'] });
  assert.equal(f.pushed, false);
  assert.equal(f.merged, false);
  assert.equal(f.dirty, 0);
});

test('gatherWorktreeFacts: an unreadable head or status comes back null, never a guess', () => {
  const { git } = fakeGit([]);
  const f = gatherWorktreeFacts({ dir: '/w', branch: 'b', git, integrationRefs: [] });
  assert.equal(f.head, null);
  assert.equal(f.dirty, null);
});
