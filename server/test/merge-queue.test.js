import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_ROUNDS, MAX_REPAIRS, parsePrUrl, isPublicRepo, prViewRecipe, parsePrView, prNamesCard, createMergeRequest,
  integrationKey, isActive, isTerminal, transition, nextAction, groupQueue, bounceStreak, bounceDisposition, bounceNote, isBounceExit,
} from '../lib/orchestration/merge-queue.js';

const T0 = '2026-10-17T10:00:00.000Z';
const T1 = '2026-10-17T10:05:00.000Z';

function mr(over = {}) {
  return createMergeRequest({
    prUrl: 'https://github.com/acme/widgets/pull/7', repo: 'acme/widgets', number: 7,
    base: 'main', head: 'feat/x', headSha: 'abc123', filedBy: 'agent',
  }, { now: T0, ...over });
}
const card = (id, m) => ({ id, title: `t-${id}`, mergeRequest: m });

test('parsePrUrl extracts owner/repo/number and rejects other shapes', () => {
  assert.deepEqual(parsePrUrl('https://github.com/Acme/widgets/pull/42'), { repo: 'Acme/widgets', number: 42 });
  assert.equal(parsePrUrl('https://github.com/acme/widgets/issues/42'), null);
  assert.equal(parsePrUrl('https://evil.example/acme/widgets/pull/1'), null);
  assert.equal(parsePrUrl('https://github.com/acme/widgets/pull/1 --admin'), null);
  assert.equal(parsePrUrl(42), null);
});

test('isPublicRepo refuses wolfeb-dev/glmps case-insensitively and nothing else', () => {
  assert.equal(isPublicRepo('wolfeb-dev/glmps'), true);
  assert.equal(isPublicRepo('Wolfeb-Dev/GLMPS'), true);
  assert.equal(isPublicRepo('wolfeb-dev/glmps-2.0'), false);
});

test('prViewRecipe is argv for gh with no shell string', () => {
  assert.deepEqual(prViewRecipe({ repo: 'acme/widgets', number: 7 }), {
    file: 'gh',
    args: ['pr', 'view', '7', '-R', 'acme/widgets', '--json', 'baseRefName,headRefName,headRefOid,state,isCrossRepository,title'],
  });
});

test('parsePrView maps gh json and fails closed on garbage', () => {
  const ok = parsePrView(JSON.stringify({ baseRefName: 'main', headRefName: 'f', headRefOid: 'sha', state: 'OPEN', isCrossRepository: false }));
  assert.deepEqual(ok, { base: 'main', head: 'f', headSha: 'sha', state: 'OPEN', crossRepo: false, title: '' });
  assert.equal(parsePrView('not json'), null);
  assert.equal(parsePrView(JSON.stringify({ baseRefName: 'main' })), null);
});

test('createMergeRequest starts at requested, round 1, with a history entry', () => {
  const m = mr();
  assert.equal(m.stage, 'requested');
  assert.equal(m.round, 1);
  assert.equal(m.filedAt, T0);
  assert.deepEqual([m.tests, m.review, m.mergeSha], [null, null, null]);
  assert.equal(m.history.length, 1);
  assert.deepEqual(m.history[0], { ts: T0, from: null, to: 'requested', reason: 'filed by agent' });
  assert.equal(integrationKey(m), 'acme/widgets@main');
});

test('integrationKey lowercases the repo so case cannot split a branch queue', () => {
  assert.equal(integrationKey({ repo: 'Acme/Widgets', base: 'main' }), 'acme/widgets@main');
});

test('happy path walks requested -> testing -> merging -> merged (glmps-2-0-runtime-125)', () => {
  let m = mr();
  for (const [to, now] of [['testing', T1], ['merging', T1], ['merged', T1]]) {
    const r = transition(m, to, { now, queue: [], reason: `to ${to}` });
    assert.equal(r.error, undefined, `${to}: ${r.error}`);
    m = r.mergeRequest;
    assert.equal(m.stage, to);
  }
  assert.equal(isTerminal(m), true);
  assert.deepEqual(m.history.map((h) => h.to), ['requested', 'testing', 'merging', 'merged']);
  assert.equal(m.history[3].from, 'merging');
  assert.equal(m.history[3].reason, 'to merged');
});

test('transition is pure: input is not mutated', () => {
  const m = mr();
  transition(m, 'testing', { now: T1, queue: [] });
  assert.equal(m.stage, 'requested');
  assert.equal(m.history.length, 1);
});

test('illegal edges are refused with a reason', () => {
  const m = mr();
  assert.match(transition(m, 'reviewing', { now: T1, queue: [] }).error, /requested -> reviewing/);
  assert.match(transition(m, 'merging', { now: T1, queue: [] }).error, /requested -> merging/, 'no request merges untested');
  const t = transition(m, 'testing', { now: T1, queue: [] }).mergeRequest;
  assert.match(transition(t, 'reviewing', { now: T1 }).error, /testing -> reviewing/, 'nothing enters the retired review stage');
  const done = transition(transition(t, 'merging', { now: T1 }).mergeRequest, 'merged', { now: T1 }).mergeRequest;
  assert.match(transition(done, 'testing', { now: T1, queue: [] }).error, /merged -> testing/);
});

test('an unknown stage is refused', () => {
  assert.match(transition(mr(), 'nonsense', { now: T1, queue: [] }).error, /unknown stage/);
});

test('only one active request per integration branch', () => {
  const a = transition(mr(), 'testing', { now: T1, queue: [] }).mergeRequest;
  assert.equal(isActive(a), true);
  const b = mr();
  const blocked = transition(b, 'testing', { now: T1, queue: [card('c-1', a), card('c-2', b)], id: 'c-2' });
  assert.match(blocked.error, /branch busy: c-1/);
  // a different base branch is its own lane
  const other = mr({ prev: null });
  other.base = 'glmps2/main';
  assert.equal(transition(other, 'testing', { now: T1, queue: [card('c-1', a), card('c-3', other)], id: 'c-3' }).error, undefined);
  // a request does not block itself
  assert.equal(transition(a, 'testing', { now: T1, queue: [card('c-1', a)], id: 'c-1' }).error, 'illegal transition: testing -> testing');
});

test('a legacy reviewing record and merging keep the branch slot', () => {
  const a = { ...transition(mr(), 'testing', { now: T1, queue: [] }).mergeRequest, stage: 'reviewing' };
  assert.equal(isActive(a), true);
  const m = transition(a, 'merging', { now: T1 }).mergeRequest;
  assert.equal(isActive(m), true);
  const b = mr();
  assert.match(transition(b, 'testing', { now: T1, queue: [card('c-1', m), card('c-2', b)], id: 'c-2' }).error, /branch busy/);
});

test('bounce records the reason and is terminal', () => {
  const t = transition(mr(), 'testing', { now: T1, queue: [] }).mergeRequest;
  const r = transition(t, 'bounced', { now: T1, reason: 'tests failed: 3 failing' });
  assert.equal(r.mergeRequest.stage, 'bounced');
  assert.equal(r.mergeRequest.history.at(-1).reason, 'tests failed: 3 failing');
  assert.equal(isTerminal(r.mergeRequest), true);
  assert.equal(isActive(r.mergeRequest), false);
});

test('a bounce in the last allowed round holds instead (3-round cap)', () => {
  assert.equal(MAX_ROUNDS, 3);
  const last = { ...transition(mr(), 'testing', { now: T1, queue: [] }).mergeRequest, round: 3 };
  const r = transition(last, 'bounced', { now: T1, reason: 'CHANGES: nit' });
  assert.equal(r.mergeRequest.stage, 'held');
  assert.match(r.mergeRequest.history.at(-1).reason, /round cap \(3\).*CHANGES: nit/);
  const early = { ...last, round: 2 };
  assert.equal(transition(early, 'bounced', { now: T1, reason: 'x' }).mergeRequest.stage, 'bounced');
});

test('any live stage can be held; held is not terminal and not active', () => {
  for (const stage of ['requested', 'testing', 'reviewing', 'merging']) {
    const r = transition({ ...mr(), stage }, 'held', { now: T1, reason: 'operator pause' });
    assert.equal(r.mergeRequest.stage, 'held', stage);
  }
  const h = transition(mr(), 'held', { now: T1 }).mergeRequest;
  assert.equal(isTerminal(h), false);
  assert.equal(isActive(h), false);
});

test('re-filing after a bounce carries history and bumps the round', () => {
  const bounced = transition(transition(mr(), 'testing', { now: T1, queue: [] }).mergeRequest, 'bounced', { now: T1, reason: 'CHANGES' }).mergeRequest;
  const again = createMergeRequest({
    prUrl: bounced.prUrl, repo: bounced.repo, number: 7, base: 'main', head: 'feat/x', headSha: 'def456', filedBy: 'agent',
  }, { now: '2026-10-17T11:00:00.000Z', prev: bounced });
  assert.equal(again.stage, 'requested');
  assert.equal(again.round, 2);
  assert.equal(again.headSha, 'def456');
  assert.deepEqual(again.history.map((h) => h.to), ['requested', 'testing', 'bounced', 'requested']);
});

test('re-filing past the round cap lands held', () => {
  const prev = { ...mr(), stage: 'bounced', round: 3 };
  const again = createMergeRequest({
    prUrl: prev.prUrl, repo: prev.repo, number: 7, base: 'main', head: 'feat/x', headSha: 's', filedBy: 'agent',
  }, { now: T1, prev });
  assert.equal(again.stage, 'held');
  assert.equal(again.round, 4);
  assert.match(again.history.at(-1).reason, /round cap \(3\)/);
});

test('nextAction: requested on a free branch starts testing (glmps-2-0-runtime-125)', () => {
  const m = mr();
  assert.deepEqual(nextAction(m, [card('c-1', m)], { id: 'c-1' }), { action: 'start-testing', reason: 'branch free' });
});

test('nextAction: requested behind an active request waits and names it', () => {
  const active = transition(mr(), 'testing', { now: T1, queue: [] }).mergeRequest;
  const m = mr();
  const a = nextAction(m, [card('c-1', active), card('c-2', m)], { id: 'c-2' });
  assert.equal(a.action, 'wait');
  assert.match(a.reason, /c-1/);
});

test('nextAction: requested requests start FIFO by filedAt then id', () => {
  const older = { ...mr(), filedAt: '2026-10-17T09:00:00.000Z' };
  const newer = mr();
  const q = [card('c-9', newer), card('c-5', older)];
  assert.equal(nextAction(newer, q, { id: 'c-9' }).action, 'wait');
  assert.equal(nextAction(older, q, { id: 'c-5' }).action, 'start-testing');
  const tieA = card('c-1', mr()); const tieB = card('c-2', mr());
  assert.equal(nextAction(tieB.mergeRequest, [tieB, tieA], { id: 'c-2' }).action, 'wait');
  assert.equal(nextAction(tieA.mergeRequest, [tieB, tieA], { id: 'c-1' }).action, 'start-testing');
});

test('nextAction: other lanes do not interfere', () => {
  const active = { ...transition(mr(), 'testing', { now: T1, queue: [] }).mergeRequest, base: 'glmps2/main' };
  const m = mr();
  assert.equal(nextAction(m, [card('c-1', active), card('c-2', m)], { id: 'c-2' }).action, 'start-testing');
});

test('nextAction: a requested request over the round cap holds', () => {
  const m = { ...mr(), round: 4 };
  assert.equal(nextAction(m, [card('c-1', m)], { id: 'c-1' }).action, 'hold');
});

test('nextAction: in-flight stages wait for their executor, terminal and held do nothing', () => {
  for (const stage of ['testing', 'reviewing', 'merging']) {
    assert.equal(nextAction({ ...mr(), stage }, [], { id: 'c-1' }).action, 'wait', stage);
  }
  for (const stage of ['merged', 'bounced', 'held']) {
    assert.equal(nextAction({ ...mr(), stage }, [], { id: 'c-1' }).action, 'none', stage);
  }
  assert.equal(nextAction(null, [], {}).action, 'none');
});

test('groupQueue groups live and finished requests per branch with id, title, stage, round', () => {
  const a = transition(mr(), 'testing', { now: T1, queue: [] }).mergeRequest;
  const b = mr();
  const c = { ...mr(), base: 'glmps2/main' };
  const g = groupQueue([card('c-1', a), card('c-2', b), card('c-3', c), { id: 'c-4', title: 'none' }]);
  assert.deepEqual(g.map((x) => x.branch), ['acme/widgets@glmps2/main', 'acme/widgets@main']);
  const main = g.find((x) => x.branch === 'acme/widgets@main');
  assert.equal(main.repo, 'acme/widgets');
  assert.equal(main.base, 'main');
  assert.deepEqual(main.requests, [
    { id: 'c-1', title: 't-c-1', stage: 'testing', round: 1, prUrl: a.prUrl },
    { id: 'c-2', title: 't-c-2', stage: 'requested', round: 1, prUrl: b.prUrl },
  ]);
});

test('groupQueue omits merged and bounced requests', () => {
  const m = { ...mr(), stage: 'merged' };
  const b = { ...mr(), stage: 'bounced' };
  assert.deepEqual(groupQueue([card('c-1', m), card('c-2', b)]), []);
});

const atMerging = () => {
  let m = mr();
  for (const to of ['testing', 'merging']) m = transition(m, to, { now: T1, queue: [], id: 'a' }).mergeRequest;
  return m;
};

test('restarts to testing are counted and the fourth holds the request with a reason', () => {
  let m = atMerging();
  for (let n = 1; n <= 3; n += 1) {
    const t = transition(m, 'testing', { now: T1, reason: 'head moved', queue: [], id: 'a' });
    assert.equal(t.mergeRequest.stage, 'testing', `restart ${n}`);
    assert.equal(t.mergeRequest.restarts, n);
    m = transition(t.mergeRequest, 'merging', { now: T1 }).mergeRequest;
  }
  const capped = transition(m, 'testing', { now: T1, reason: 'head moved', queue: [], id: 'a' });
  assert.equal(capped.mergeRequest.stage, 'held');
  assert.match(capped.mergeRequest.history.at(-1).reason, /restart cap \(3\).*head moved/);
  assert.equal(capped.mergeRequest.round, 1, 'rounds are untouched');
});

test('a legacy reviewing -> testing restart counts, but a repaired conflict does not', () => {
  const m = { ...transition(mr(), 'testing', { now: T1, queue: [] }).mergeRequest, stage: 'reviewing' };
  const repaired = transition(m, 'testing', { now: T1, queue: [], repair: true }).mergeRequest;
  assert.equal(repaired.restarts ?? 0, 0);
  const moved = transition(m, 'testing', { now: T1, queue: [] }).mergeRequest;
  assert.equal(moved.restarts, 1);
});

test('repaired conflicts on legacy reviewing records are capped too: the fourth repair in a row holds the request', () => {
  let m = { ...transition(mr(), 'testing', { now: T1, queue: [] }).mergeRequest, stage: 'reviewing' };
  for (let i = 1; i <= MAX_REPAIRS; i++) {
    m = transition(m, 'testing', { now: T1, queue: [], repair: true }).mergeRequest;
    assert.equal(m.stage, 'testing');
    assert.equal(m.repairs, i);
    m = { ...m, stage: 'reviewing' };
  }
  const r = transition(m, 'testing', { now: T1, queue: [], repair: true }).mergeRequest;
  assert.equal(r.stage, 'held');
  assert.match(r.history.at(-1).reason, /repair cap \(3\) reached/);
  assert.equal(transition(r, 'requested', { now: T1 }).mergeRequest.repairs, 0, 'release clears it');
});

test('releasing a hold clears the restart count', () => {
  const held = { ...atMerging(), restarts: 3, stage: 'held' };
  const r = transition(held, 'requested', { now: T1, reason: 'released' });
  assert.equal(r.mergeRequest.restarts, 0);
});

test('merging can go back to testing when the head or base moved under a tested request', () => {
  const m = atMerging();
  const r = transition(m, 'testing', { now: T1, reason: 'head moved', queue: [], id: 'a' });
  assert.equal(r.error, undefined);
  assert.equal(r.mergeRequest.stage, 'testing');
  assert.equal(r.mergeRequest.round, m.round, 'new commits do not use up a round');
  assert.deepEqual(r.mergeRequest.history.at(-1), { ts: T1, from: 'merging', to: 'testing', reason: 'head moved' });
});

test('interim is kept only for a literal true', () => {
  const base = { prUrl: 'https://github.com/acme/widgets/pull/7', repo: 'acme/widgets', number: 7, base: 'main', head: 'feat/x', headSha: 'a', filedBy: 'agent' };
  assert.equal(createMergeRequest({ ...base, interim: true }, { now: T0 }).interim, true);
  assert.equal(createMergeRequest({ ...base, interim: 'yes' }, { now: T0 }).interim, false);
  assert.equal(mr().interim, false);
});

test('a request filed after a merged one starts again at round 1, keeping history', () => {
  const merged = { ...mr(), stage: 'merged', round: 3, interim: true };
  const next = createMergeRequest({
    prUrl: 'https://github.com/acme/widgets/pull/8', repo: 'acme/widgets', number: 8, base: 'main', head: 'feat/y', headSha: 'b', filedBy: 'agent',
  }, { now: T1, prev: merged });
  assert.equal(next.stage, 'requested');
  assert.equal(next.round, 1);
  assert.equal(next.interim, false);
  assert.equal(next.history.length, merged.history.length + 1);
});

const BASE_REQ = { prUrl: 'https://github.com/acme/widgets/pull/7', repo: 'acme/widgets', number: 7, base: 'main', head: 'feat/x', headSha: 'a', filedBy: 'agent' };

test('runtime-9-a: covers and final are recorded, and a request with neither is unchanged', () => {
  const plain = createMergeRequest(BASE_REQ, { now: T0 });
  assert.equal(plain.covers, null);
  assert.equal(plain.final, false);
  const scoped = createMergeRequest({ ...BASE_REQ, covers: [2, 1, 2], final: true }, { now: T0 });
  assert.deepEqual(scoped.covers, [1, 2]);
  assert.equal(scoped.final, true);
  assert.equal(createMergeRequest({ ...BASE_REQ, final: 'yes' }, { now: T0 }).final, false);
});

test('runtime-9-a: held and bounced requests can be settled by GitHub, merged or closed', () => {
  for (const stage of ['held', 'bounced']) {
    const m = { ...mr(), stage };
    assert.equal(transition(m, 'merged', { now: T1, reason: 'r' }).mergeRequest.stage, 'merged');
    assert.equal(transition(m, 'closed', { now: T1, reason: 'r' }).mergeRequest.stage, 'closed');
  }
  assert.ok(transition({ ...mr(), stage: 'testing' }, 'closed', { now: T1 }).error, 'only held and bounced reach closed');
  assert.ok(transition({ ...mr(), stage: 'closed' }, 'merged', { now: T1 }).error, 'closed is final');
});

test('runtime-9-a: a closed request is terminal and leaves the queue view', () => {
  const closed = { ...mr(), stage: 'closed' };
  assert.equal(isTerminal(closed), true);
  assert.deepEqual(groupQueue([card('c-1', closed)]), []);
});

test('prNamesCard matches the card id in the head branch or title, case-insensitively, on id boundaries', () => {
  assert.equal(prNamesCard({ id: 'glmps-2-0-83', head: 'glmps-runner/glmps-2.0/glmps-2-0-83', title: '' }), true);
  assert.equal(prNamesCard({ id: 'glmps-2-0-83', head: 'feat/x', title: 'Fix (card GLMPS-2-0-83)' }), true);
  assert.equal(prNamesCard({ id: 'glmps-2-0-8', head: 'glmps-runner/glmps-2-0-83', title: 'Other' }), false);
  assert.equal(prNamesCard({ id: 'glmps-1', head: 'feat/x', title: undefined }), false);
  assert.equal(prNamesCard({ id: '', head: 'feat/x', title: 'x' }), false);
});

test('parsePrView carries an optional title and still parses a response without one', () => {
  assert.equal(parsePrView(JSON.stringify({ baseRefName: 'main', headRefName: 'f', headRefOid: 'sha', state: 'OPEN', title: 'T' })).title, 'T');
  assert.equal(parsePrView(JSON.stringify({ baseRefName: 'main', headRefName: 'f', headRefOid: 'sha', state: 'OPEN' })).title, '');
});

// glmps-2-0-runtime-63: a bounce reaches the author by putting the card back in the queue.
const bounced = (m, reason, tests) => transition({ ...m, stage: 'testing', ...(tests ? { tests } : {}) }, 'bounced', { now: T1, reason }).mergeRequest;
const refile = (prev) => createMergeRequest({ prUrl: prev.prUrl, repo: prev.repo, number: prev.number, base: prev.base, head: prev.head, headSha: 'def456' }, { now: T1, prev });

test('bounceStreak counts bounces since the last merge', () => {
  const one = bounced(mr(), 'tests fail: exit code 1');
  assert.equal(bounceStreak(one), 1);
  const two = bounced(refile(one), 'reviewer asked for changes: x');
  assert.equal(bounceStreak(two), 2);
  const merged = { ...two, stage: 'merged', history: [...two.history, { ts: T1, from: 'bounced', to: 'merged', reason: 'merged' }] };
  assert.equal(bounceStreak(bounced(refile(merged), 'tests fail')), 1, 'a merge restarts the count');
  assert.equal(bounceStreak(mr()), 0);
});

test('AC-1: a bounced request for an idle card is requeued', () => {
  const m = bounced(mr(), 'tests fail: exit code 1');
  const d = bounceDisposition({ card: { id: 'c-1', state: 'idle' }, mr: m, maxRetries: 2 });
  assert.equal(d.action, 'requeue');
  assert.equal(d.streak, 1);
});

test('bounceNote carries the failure reason and the test tail', () => {
  const m = bounced(mr(), 'tests fail: exit code 1', { status: 'fail', reason: 'exit code 1', tail: 'not ok 3 - widgets render' });
  const note = bounceNote(m);
  assert.match(note, /tests fail: exit code 1/);
  assert.match(note, /not ok 3 - widgets render/);
  assert.match(note, /file the merge request again/);
  assert.match(bounceNote(bounced(mr(), 'PR head moved')), /PR head moved/);
  assert.doesNotMatch(bounceNote(bounced(mr(), 'reviewer asked for changes: y', { status: 'pass', tail: 'all green' })), /all green/,
    'a passing test tail is not the reason for the bounce');
});

test('AC-2: an operator-held card and a reintent card are not requeued', () => {
  const m = bounced(mr(), 'tests fail: exit code 1');
  const held = bounceDisposition({ card: { id: 'c-1', state: 'held' }, mr: m, maxRetries: 2 });
  assert.equal(held.action, 'skip');
  assert.match(held.reason, /operator/);
  const re = bounceDisposition({ card: { id: 'c-1', state: 'idle', gate: { status: 'FAIL', reintent: true } }, mr: m, maxRetries: 2 });
  assert.equal(re.action, 'skip');
  assert.match(re.reason, /restated intent/);
  for (const state of ['cancelled', 'archived']) {
    assert.equal(bounceDisposition({ card: { id: 'c-1', state }, mr: m, maxRetries: 2 }).action, 'skip', state);
  }
  assert.equal(bounceDisposition({ card: { id: 'c-1', state: 'in_progress' }, mr: m, maxRetries: 2 }).action, 'live');
});

// glmps-2-0-runtime-91: a done card whose request bounced has work that never
// landed, so the bounce reopens it rather than leaving the board showing done.
test('a bounce on a done card reopens it; the hold rules still apply first', () => {
  const m = bounced(mr(), 'reviewer asked for changes: AC-1 broken');
  const d = bounceDisposition({ card: { id: 'c-1', state: 'done' }, mr: m, maxRetries: 2 });
  assert.equal(d.action, 'reopen');
  assert.equal(d.streak, 1);
  assert.equal(bounceDisposition({ card: { id: 'c-1', state: 'done' }, mr: bounced(mr(), 'tests error: no checkout'), maxRetries: 2 }).action, 'hold');
  assert.equal(bounceDisposition({ card: { id: 'c-1', state: 'done' }, mr: m, maxRetries: 0 }).action, 'hold');
});

test('AC-2: past maxRetries consecutive bounces the card is held with a reason', () => {
  let m = bounced(mr(), 'tests fail: one');
  m = bounced(refile(m), 'tests fail: two');
  assert.equal(bounceDisposition({ card: { id: 'c-1', state: 'idle' }, mr: m, maxRetries: 2 }).action, 'requeue', 'the second bounce is still a retry');
  const third = { ...m, stage: 'bounced', history: [...m.history, { ts: T1, from: 'testing', to: 'bounced', reason: 'tests fail: three' }] };
  const d = bounceDisposition({ card: { id: 'c-1', state: 'idle' }, mr: third, maxRetries: 2 });
  assert.equal(d.action, 'hold');
  assert.match(d.reason, /3 bounces in a row/);
  assert.match(d.reason, /tests fail: three/);
  assert.equal(bounceDisposition({ card: { id: 'c-1', state: 'idle' }, mr: m, maxRetries: 1 }).action, 'hold');
});

test('a tests-error bounce holds the card: the author cannot fix the queue', () => {
  const m = bounced(mr(), 'tests error: no local checkout for wolfeb-dev/glmps');
  const d = bounceDisposition({ card: { id: 'c-1', state: 'idle' }, mr: m, maxRetries: 2 });
  assert.equal(d.action, 'hold');
  assert.match(d.reason, /could not run the tests/);
  assert.match(d.reason, /no local checkout/);
  assert.equal(bounceDisposition({ card: { id: 'c-1', state: 'held' }, mr: m, maxRetries: 2 }).action, 'skip');
  assert.equal(bounceDisposition({ card: { id: 'c-1', state: 'idle' }, mr: bounced(mr(), 'tests timeout: 600000 ms'), maxRetries: 2 }).action, 'requeue',
    'a timeout can be the author\'s hang, so it stays a retry');
});

test('a bounce the round cap turned into a hold holds the card too', () => {
  let m = mr();
  for (let r = 1; r < MAX_ROUNDS; r += 1) m = refile(bounced(m, `tests fail: ${r}`));
  const capped = bounced(m, 'tests fail: last');
  assert.equal(capped.stage, 'held');
  const d = bounceDisposition({ card: { id: 'c-1', state: 'idle' }, mr: capped, maxRetries: 10 });
  assert.equal(d.action, 'hold');
  assert.match(d.reason, /round cap/);
});

test('isBounceExit sees a bounce and a capped bounce, not other holds', () => {
  assert.equal(isBounceExit(bounced(mr(), 'tests fail')), true);
  let m = mr();
  for (let r = 1; r < MAX_ROUNDS; r += 1) m = refile(bounced(m, `tests fail: ${r}`));
  assert.equal(isBounceExit(bounced(m, 'tests fail: last')), true);
  assert.equal(isBounceExit(transition({ ...mr(), stage: 'testing' }, 'held', { now: T1, reason: 'merge queue paused' }).mergeRequest), false);
  assert.equal(isBounceExit(refile(refile(bounced(m, 'x')))), false, 'a re-file past the cap is not a bounce');
  assert.equal(isBounceExit(mr()), false);
});

// glmps-2-0-runtime-125: pause merging into a branch whose last full-suite run is red.
const RED = { sha: 'r'.repeat(40), ts: T1, files: ['server/test/x.test.js'], culprit: null, cardId: 'c-red' };

test('nextAction: a request red-held for the current red waits with the reason; a new red or a green run frees it', () => {
  const m = { ...mr(), redHold: RED.sha };
  const a = nextAction(m, [card('c-1', m)], { id: 'c-1', red: RED });
  assert.equal(a.action, 'wait');
  assert.match(a.reason, /paused: the full suite is red on main/);
  assert.equal(nextAction(m, [card('c-1', m)], { id: 'c-1', red: { ...RED, sha: 's'.repeat(40) } }).action, 'start-testing');
  assert.equal(nextAction(m, [card('c-1', m)], { id: 'c-1', red: null }).action, 'start-testing');
  assert.equal(nextAction(mr(), [card('c-1', mr())], { id: 'c-1', red: RED }).action, 'start-testing', 'a request not yet tested on this red still gets its run');
});

test('a red-held request does not block the queue behind it', () => {
  const held = { ...mr(), filedAt: '2026-10-17T09:00:00.000Z', redHold: RED.sha };
  const next = mr();
  assert.equal(nextAction(next, [card('c-1', held), card('c-2', next)], { id: 'c-2', red: RED }).action, 'start-testing');
});

test('groupQueue shows the pause on the lane of a red branch', () => {
  const m = mr();
  const [lane] = groupQueue([card('c-1', m)], { reds: { 'acme/widgets@main': RED } });
  assert.deepEqual(lane.paused, { reason: 'the full suite is red on main at rrrrrrr', sha: RED.sha, since: T1, files: RED.files });
  assert.equal(groupQueue([card('c-1', m)])[0].paused, null);
});

test('merging can be sent back to requested by a red-base hold', () => {
  let m = mr();
  for (const to of ['testing', 'merging']) m = transition(m, to, { now: T1, queue: [], id: 'a' }).mergeRequest;
  assert.equal(transition(m, 'requested', { now: T1, reason: 'red' }).mergeRequest.stage, 'requested');
});
