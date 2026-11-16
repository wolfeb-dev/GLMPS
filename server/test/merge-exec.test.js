import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  prMergeViewRecipe, prMergeRecipe, runMerge, applyMergeOutcome, mergeRecordText, closeEvidence, closeDecision, closeGate,
} from '../lib/orchestration/merge-exec.js';
import { createMergeRequest, transition } from '../lib/orchestration/merge-queue.js';
import { uncitedAC } from '../lib/orchestration/backlog-store.js';

const T = '2026-10-17T10:00:00.000Z';
const HEAD = 'a'.repeat(40);
const MERGE = 'm'.repeat(40);

function approved(over = {}) {
  let m = createMergeRequest({ prUrl: 'https://github.com/acme/widgets/pull/7', repo: 'acme/widgets', number: 7, base: 'main', head: 'feat/x', headSha: HEAD, filedBy: 'w' }, { now: T });
  for (const to of ['testing', 'merging']) m = transition(m, to, { now: T, queue: [], id: 'c1' }).mergeRequest;
  return { ...m, tests: { status: 'pass', headSha: HEAD, mergedBaseSha: 'b'.repeat(40) }, ...over };
}

const view = (o = {}) => JSON.stringify({ state: 'OPEN', headRefOid: HEAD, mergeable: 'MERGEABLE', baseRefName: 'main', mergeCommit: null, ...o });
// A scripted gh: answers by subcommand, records every call.
function gh(script) {
  const calls = [];
  const fn = async (file, args) => {
    calls.push({ file, args });
    const key = args[1];
    const next = script[key];
    const r = typeof next === 'function' ? next(calls.filter((c) => c.args[1] === key).length) : next;
    return r ?? { status: 0, stdout: '', stderr: '' };
  };
  fn.calls = calls;
  return fn;
}
const ok = (stdout) => ({ status: 0, stdout, stderr: '' });

test('recipes are gh argv with no shell, plain --merge and a head match, never admin/auto/delete-branch', () => {
  assert.deepEqual(prMergeViewRecipe({ repo: 'acme/widgets', number: 7 }), {
    file: 'gh', args: ['pr', 'view', '7', '-R', 'acme/widgets', '--json', 'state,headRefOid,mergeable,baseRefName,mergeCommit'],
  });
  const r = prMergeRecipe({ repo: 'acme/widgets', number: 7, headSha: HEAD });
  assert.deepEqual(r, { file: 'gh', args: ['pr', 'merge', '7', '-R', 'acme/widgets', '--merge', '--match-head-commit', HEAD] });
  for (const bad of ['--admin', '--auto', '--delete-branch', '--squash', '--rebase']) assert.ok(!r.args.includes(bad));
});

test('a clean approved request is merged with the head pinned, and the merge SHA is read back', async () => {
  const g = gh({ view: (n) => ok(n === 1 ? view() : view({ state: 'MERGED', mergeCommit: { oid: MERGE } })), merge: ok('') });
  const out = await runMerge({ mr: approved(), gh: g });
  assert.deepEqual(out, { kind: 'merged', mergeSha: MERGE });
  const merge = g.calls.find((c) => c.args[1] === 'merge');
  assert.equal(merge.args.at(-1), HEAD);
  assert.deepEqual(g.calls.map((c) => c.args[1]), ['view', 'merge', 'view']);
});

test('an already merged PR is recorded, not merged again', async () => {
  const g = gh({ view: ok(view({ state: 'MERGED', mergeCommit: { oid: MERGE } })) });
  assert.deepEqual(await runMerge({ mr: approved(), gh: g }), { kind: 'merged', mergeSha: MERGE, already: true });
  assert.ok(!g.calls.some((c) => c.args[1] === 'merge'));
});

test('a closed PR bounces with the reason', async () => {
  const out = await runMerge({ mr: approved(), gh: gh({ view: ok(view({ state: 'CLOSED' })) }) });
  assert.equal(out.kind, 'bounce');
  assert.match(out.reason, /closed/i);
});

test('a PR head that moved since testing goes back to testing without merging', async () => {
  const moved = 'f'.repeat(40);
  const g = gh({ view: ok(view({ headRefOid: moved })) });
  const out = await runMerge({ mr: approved(), gh: g });
  assert.equal(out.kind, 'testing');
  assert.match(out.reason, /head moved/);
  assert.ok(!g.calls.some((c) => c.args[1] === 'merge'));
});

test('a request with no test run on record goes to testing, never merged untested (glmps-2-0-runtime-125)', async () => {
  const g = gh({ view: ok(view()) });
  const out = await runMerge({ mr: approved({ tests: null }), gh: g });
  assert.equal(out.kind, 'testing');
  assert.match(out.reason, /not tested/);
  assert.ok(!g.calls.some((c) => c.args[1] === 'merge'));
});

test('a merge needs no reviewer verdict: a tested head merges with review null (glmps-2-0-runtime-125)', async () => {
  const g = gh({ view: (n) => ok(view(n > 1 ? { state: 'MERGED', mergeCommit: { oid: MERGE } } : {})) });
  assert.equal((await runMerge({ mr: approved({ review: null }), gh: g })).kind, 'merged');
});

test('a tests record with no head cannot be verified, so it holds', async () => {
  const g1 = gh({ view: ok(view()) });
  assert.equal((await runMerge({ mr: approved({ tests: { status: 'pass' } }), gh: g1 })).kind, 'hold');
  assert.ok(!g1.calls.some((c) => c.args[1] === 'merge'));
});

const BASE_OLD = 'b'.repeat(40);
const BASE_NEW = 'c'.repeat(40);

test('a base that moved since the tests ran goes back to testing, base moved, without merging', async () => {
  const g = gh({ view: ok(view()) });
  const out = await runMerge({ mr: approved(), gh: g, currentBaseSha: async () => `${BASE_NEW}
` });
  assert.equal(out.kind, 'testing');
  assert.match(out.reason, /base moved/);
  assert.match(out.reason, /bbbbbbb/);
  assert.match(out.reason, /ccccccc/);
  assert.ok(!g.calls.some((c) => c.args[1] === 'merge'));
});

test('an unchanged base merges; an unreadable base holds; a test record without a base sha skips the check', async () => {
  const merged = () => gh({ view: (n) => ok(n === 1 ? view() : view({ state: 'MERGED', mergeCommit: { oid: MERGE } })), merge: ok('') });
  assert.equal((await runMerge({ mr: approved(), gh: merged(), currentBaseSha: async () => BASE_OLD })).kind, 'merged');
  for (const bad of [async () => '', async () => { throw new Error('fetch failed'); }]) {
    const g = gh({ view: ok(view()) });
    const held = await runMerge({ mr: approved(), gh: g, currentBaseSha: bad });
    assert.equal(held.kind, 'hold');
    assert.match(held.reason, /current base/);
    assert.ok(!g.calls.some((c) => c.args[1] === 'merge'));
  }
  let asked = false;
  const legacy = await runMerge({ mr: approved({ tests: { status: 'pass', headSha: HEAD } }), gh: merged(), currentBaseSha: async () => { asked = true; return BASE_NEW; } });
  assert.equal(legacy.kind, 'merged');
  assert.equal(asked, false, 'nothing to compare, so no lookup');
});

test('a CONFLICTING PR goes back to testing so the test stage re-merges base', async () => {
  const g = gh({ view: ok(view({ mergeable: 'CONFLICTING' })) });
  const out = await runMerge({ mr: approved(), gh: g });
  assert.equal(out.kind, 'testing');
  assert.match(out.reason, /conflict/i);
  assert.ok(!g.calls.some((c) => c.args[1] === 'merge'));
});

test('a PR retargeted to another base holds', async () => {
  assert.equal((await runMerge({ mr: approved(), gh: gh({ view: ok(view({ baseRefName: 'develop' })) }) })).kind, 'hold');
});

test('gh failures hold with the error text: unreadable view, unparsable view, failed merge', async () => {
  const a = await runMerge({ mr: approved(), gh: gh({ view: { status: 1, stdout: '', stderr: 'HTTP 502 bad gateway' } }) });
  assert.equal(a.kind, 'hold');
  assert.match(a.reason, /502/);
  assert.equal((await runMerge({ mr: approved(), gh: gh({ view: ok('not json') }) })).kind, 'hold');
  const g = gh({ view: ok(view()), merge: { status: 1, stdout: '', stderr: 'Head branch was modified. Review and try the merge again.' } });
  const c = await runMerge({ mr: approved(), gh: g });
  assert.equal(c.kind, 'hold');
  assert.match(c.reason, /Head branch was modified/);
  assert.equal(g.calls.filter((x) => x.args[1] === 'merge').length, 1, 'no retry');
});

test('a throwing gh executor holds instead of throwing', async () => {
  const out = await runMerge({ mr: approved(), gh: async () => { throw new Error('spawn gh ENOENT'); } });
  assert.equal(out.kind, 'hold');
  assert.match(out.reason, /ENOENT/);
});

test('a merge that succeeded but whose read-back failed is still merged, with no SHA', async () => {
  const g = gh({ view: (n) => (n === 1 ? ok(view()) : { status: 1, stdout: '', stderr: 'rate limited' }), merge: ok('') });
  assert.deepEqual(await runMerge({ mr: approved(), gh: g }), { kind: 'merged', mergeSha: null, readbackError: 'rate limited' });
});

test('applyMergeOutcome: merged stamps mergeSha and mergedAt; testing keeps the round and clears the stale review', () => {
  const m = approved();
  const r = applyMergeOutcome(m, { kind: 'merged', mergeSha: MERGE }, { now: T, queue: [], id: 'c1' });
  assert.equal(r.mergeRequest.stage, 'merged');
  assert.equal(r.mergeRequest.mergeSha, MERGE);
  assert.equal(r.mergeRequest.mergedAt, T);
  const t = applyMergeOutcome(m, { kind: 'testing', reason: 'head moved abc -> def' }, { now: T, queue: [], id: 'c1' });
  assert.equal(t.mergeRequest.stage, 'testing');
  assert.equal(t.mergeRequest.round, m.round);
  assert.equal(t.mergeRequest.review, null);
  assert.match(t.text, /back to testing/);
  const h = applyMergeOutcome(m, { kind: 'hold', reason: 'gh failed' }, { now: T, queue: [], id: 'c1' });
  assert.equal(h.mergeRequest.stage, 'held');
  const b = applyMergeOutcome(m, { kind: 'bounce', reason: 'PR closed' }, { now: T, queue: [], id: 'c1' });
  assert.equal(b.mergeRequest.stage, 'bounced');
});

test('the merge record names the PR, head, merge SHA and test status; a reviewer line only for a legacy reviewed record', () => {
  const m = { ...approved(), mergeSha: MERGE };
  const t = mergeRecordText(m);
  for (const part of ['https://github.com/acme/widgets/pull/7', HEAD, MERGE, 'tests: pass']) assert.ok(t.includes(part), part);
  assert.doesNotMatch(t, /reviewer/);
  const legacy = mergeRecordText({ ...m, review: { verdict: 'APPROVE', model: 'sonnet', headSha: HEAD, findings: [] } });
  for (const part of ['APPROVE', 'sonnet']) assert.ok(legacy.includes(part), part);
});

// glmps-2-0-66: a criterion only checkable once the change runs is approved,
// not bounced, and stays visible on the card as an open check.
test('the merge record lists the reviewer findings marked AFTER MERGE as open checks', () => {
  const base = approved();
  const m = { ...base, mergeSha: MERGE, review: { ...base.review, findings: ['AC-1 met', 'AFTER MERGE: AC-2 one live runner launch is claimed and opened'] } };
  const t = mergeRecordText(m);
  assert.match(t, /open checks after merge:\n- AC-2 one live runner launch is claimed and opened/);
  assert.doesNotMatch(t, /AC-1 met/);
  assert.doesNotMatch(mergeRecordText({ ...approved(), mergeSha: MERGE }), /open checks/);
});

test('the close evidence cites every acceptance criterion, so the gate stays PASS', () => {
  const acs = [{ text: 'a' }, { text: 'b' }, { text: 'c' }, { text: 'd' }, { text: 'e' }, { text: 'f' }, { text: 'g' }, { text: 'h' }, { text: 'i' }, { text: 'j' }, { text: 'k' }];
  const ev = closeEvidence(acs, { ...approved(), mergeSha: MERGE });
  assert.deepEqual(uncitedAC(acs, ev), []);
  assert.deepEqual(closeEvidence([], approved()).length > 0, true, 'a card with no ACs still gets evidence');
});

test('closeDecision: an interim request never closes, even when covers is complete or final is set', () => {
  const acs = [{ text: 'a' }, { text: 'b' }];
  const full = { 1: true, 2: true };
  assert.equal(closeDecision({ acceptanceCriteria: acs, coverage: full, mr: { interim: true, covers: [1, 2] } }).close, false);
  assert.equal(closeDecision({ acceptanceCriteria: acs, coverage: full, mr: { interim: true, final: true } }).close, false);
  assert.equal(closeDecision({ acceptanceCriteria: acs, coverage: full, mr: { covers: [1, 2] } }).close, true);
  assert.equal(closeDecision({ acceptanceCriteria: acs, coverage: {}, mr: { final: true } }).close, true);
});

test('closeGate: a reconciled hand merge is WAIVED with queue-did-not-test evidence, a queue merge is PASS', () => {
  const acs = [{ text: 'a' }];
  const hand = closeGate(acs, { ...approved(), mergeSha: MERGE, reconciled: true });
  assert.equal(hand.status, 'WAIVED');
  assert.deepEqual(hand.evidence, ['merged outside the queue; not tested by the queue']);
  const queued = closeGate(acs, { ...approved(), mergeSha: MERGE });
  assert.equal(queued.status, 'PASS');
  assert.deepEqual(queued.evidence, closeEvidence(acs, { ...approved(), mergeSha: MERGE }));
});

test('closeDecision: a card with open hosted cards does not close, and names them (glmps-2-0-171 D2)', () => {
  const acs = ['a', 'b'];
  const d = closeDecision({ acceptanceCriteria: acs, coverage: {}, mr: { final: true }, hosting: ['k-1', 'k-2'] });
  assert.equal(d.close, false);
  assert.deepEqual(d.hosting, ['k-1', 'k-2']);
  assert.equal(closeDecision({ acceptanceCriteria: acs, coverage: {}, mr: { final: true }, hosting: [] }).close, true);
  assert.equal(closeDecision({ acceptanceCriteria: acs, coverage: {}, mr: { final: true } }).close, true);
  assert.equal(closeDecision({ acceptanceCriteria: acs, coverage: { 1: 1 }, mr: { covers: [1] }, hosting: ['k-1'] }).hosting, undefined, 'a card that was staying open anyway reports no hosting');
});
