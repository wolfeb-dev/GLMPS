import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  METRIC_IDS, mergeQueueFirstTry, cardSessionIds, firstPassMerged, timeToFirstReview, breachToCard, commitTsBySession, computeOutcomeMetrics,
} from '../lib/evaluation/lens-outcome-metrics.js';

const MIN = 60000;

// Card glmps-2-0-192, decision (a): per-PR CI is gone (card glmps-2-0-134) and
// no commit carries a Claude co-author trailer, so the CI tile is the merge
// queue's first-try test pass instead. A timeout is load, not a failure.
const mr = (merged, ...hops) => ({ mergeRequest: { stage: merged ? 'merged' : 'testing', history: [
  { ts: '2026-11-01T00:00:00Z', from: null, to: 'requested', reason: 'filed' },
  ...hops.map((reason) => ({ ts: '2026-11-01T00:10:00Z', from: 'testing', to: reason.startsWith('held:') ? 'held' : 'bounced', reason: reason.replace(/^held:/, '') })),
  ...(merged ? [{ ts: '2026-11-01T01:00:00Z', from: 'merging', to: 'merged', reason: '' }] : []),
] } });
test('merge queue first try: merged requests with no test-failure bounce, timeouts excused', () => {
  const items = [
    { id: 'm1', ...mr(true) },
    { id: 'm2', ...mr(true, 'tests fail: exit code 1 (failed again on a rerun)') },
    { id: 'm3', ...mr(true, 'tests fail: timed out after 1800000 ms') },
    { id: 'm4', ...mr(true, 'held:round cap (3) reached: tests fail: exit code 1') },
    { id: 'm5', ...mr(true, 'reviewer asked for changes: AC-2 not met') },
    { id: 'm6', ...mr(false) },
    { id: 'm7' },
  ];
  const r = mergeQueueFirstTry({ items, since: 0 });
  assert.deepEqual(r.value, { value: 0.6, evidence: 'measured', n: 5 });
  assert.deepEqual(r.refs.map((x) => x.id).sort(), ['m1', 'm2', 'm3', 'm4', 'm5']);
  assert.equal(r.refs.find((x) => x.id === 'm2').value, false);
  assert.equal(mergeQueueFirstTry({ items, since: Date.parse('2026-12-01T00:00:00Z') }).value.evidence, 'absent');
});

// Card glmps-2-0-197 (review of 192): the queue rules a second timeout on the
// same head "the change, not load", so it counts; a tests error is the queue's
// own infra fault, which the queue holds without relaunching the author.
test('merge queue first try: a double-timeout bounce counts, a tests error is excused', () => {
  const r = mergeQueueFirstTry({ since: 0, items: [
    { id: 'd1', ...mr(true, 'tests fail: timed out after 1800000 ms twice on abc1234 while glmps-2-0-9 passed in between') },
    { id: 'd2', ...mr(true, 'held:round cap (3) reached: tests fail: timed out after 1800000 ms twice on abc1234 while x passed in between') },
    { id: 'e1', ...mr(true, 'held:tests error: spawn node ENOENT') },
    { id: 'e2', ...mr(true, 'tests error: could not create the merge worktree') },
  ] });
  const byId = Object.fromEntries(r.refs.map((x) => [x.id, x.value]));
  assert.deepEqual(byId, { d1: false, d2: false, e1: true, e2: true });
});

test('cardSessionIds reads the runner session record, not only the legacy field', () => {
  assert.deepEqual(cardSessionIds({ sessionId: null, runSession: { sessionId: 'b', previousSessionIds: ['a'] } }), ['a', 'b']);
  assert.deepEqual(cardSessionIds({ sessionId: 'x' }), ['x']);
  assert.deepEqual(cardSessionIds({}), []);
});

test('merged from the first pass: runner cards match session- prefixed outcome rows; a relaunch is not first pass', () => {
  const items = [
    { id: 'r1', state: 'done', gate: { status: 'PASS' }, sessionId: null, doneAt: 100, runSession: { sessionId: 'u1' } },
    { id: 'r2', state: 'done', gate: { status: 'PASS' }, sessionId: null, doneAt: 100, runSession: { sessionId: 'u3', previousSessionIds: ['u2'] } },
  ];
  const outcomes = [{ id: 'session-u1', firstTry: true }, { id: 'session-u3', firstTry: true }];
  const r = firstPassMerged({ outcomes, items, since: 0 });
  assert.deepEqual(r.value, { value: 0.5, evidence: 'measured', n: 2 });
});

test('time to first review: a runner card uses its earliest session commit', () => {
  const items = [{ id: 'r1', sessionId: null, createdAt: 0, gate: { status: 'PASS', ts: 40 * MIN }, runSession: { sessionId: 'u2', previousSessionIds: ['u1'] } }];
  const commits = new Map([['u1', 10 * MIN], ['u2', 30 * MIN]]);
  const r = timeToFirstReview({ items, verdicts: [], commitTsBySession: commits, since: 0 });
  assert.deepEqual(r.value, { value: 30, evidence: 'measured', n: 1 });
});

test('merged from the first pass: gated-done items joined to firstTry', () => {
  const items = [
    { id: 'c1', state: 'done', gate: { status: 'PASS', ts: 5 }, sessionId: 's1', doneAt: 100 },
    { id: 'c2', state: 'done', gate: { status: 'WAIVED', ts: 5 }, sessionId: 's2', doneAt: 100 }, // waived: not tested, not merged
    { id: 'c3', state: 'done', gate: { status: 'FAIL', ts: 5 }, sessionId: 's3', doneAt: 100 }, // not merged
    { id: 'c4', state: 'done', gate: null, sessionId: 's4', doneAt: 100 },                      // gate-less close
    { id: 'c5', state: 'done', gate: { status: 'PASS', ts: 5 }, sessionId: 's5', doneAt: 100 }, // no outcome row
  ];
  const outcomes = [{ id: 's1', firstTry: true }, { id: 's2', firstTry: false }, { id: 's3', firstTry: true }, { id: 's4', firstTry: true }];
  const r = firstPassMerged({ outcomes, items, since: 0 });
  assert.deepEqual(r.value, { value: 1, evidence: 'measured', n: 1 });
  assert.deepEqual(r.refs.map((x) => x.id).sort(), ['c1']);
});

test('time to first review: earliest of gate and judge verdict after the first commit', () => {
  const items = [
    { id: 'c1', sessionId: 's1', createdAt: 0, gate: { status: 'PASS', ts: 90 * MIN } },
    { id: 'c2', sessionId: 's2', createdAt: 0, gate: null },
    { id: 'c3', sessionId: 's3', createdAt: 0, gate: { status: 'PASS', ts: 5 * MIN } }, // gate before commit: ignored
  ];
  const verdicts = [{ ticketId: 'c1', ts: 30 * MIN }, { ticketId: 'c2', ts: 50 * MIN }];
  const commits = new Map([['s1', 10 * MIN], ['s2', 20 * MIN], ['s3', 10 * MIN]]);
  const r = timeToFirstReview({ items, verdicts, commitTsBySession: commits, since: 0 });
  assert.deepEqual(r.value, { value: 25, evidence: 'measured', n: 2 }); // median of 20 and 30 minutes
});

test('breach to card uses origin.streakStartTs', () => {
  const items = [
    { id: 'l1', source: 'loop-diagnosis', createdAt: 12 * MIN, origin: { via: 'loop-diagnosis', loop: 'wiki', streakStartTs: 2 * MIN } },
    { id: 'l2', source: 'loop-diagnosis', createdAt: 5 * MIN, origin: { via: 'loop-diagnosis', loop: 'git-remote-feed' } }, // no breach ts
    { id: 'x', source: 'manual', createdAt: 5 * MIN },
  ];
  const r = breachToCard({ items, since: 0 });
  assert.deepEqual(r.value, { value: 10, evidence: 'measured', n: 1 });
  assert.equal(breachToCard({ items: [], since: 0 }).value.evidence, 'absent');
});

test('commitTsBySession takes the earliest commit per session, ISO or epoch ts', () => {
  const m = commitTsBySession([
    { sessionId: 's1', gitOp: 'commit', ts: '2026-09-01T00:10:00Z' },
    { sessionId: 's1', gitOp: 'commit', ts: '2026-09-01T00:05:00Z' },
    { sessionId: 's1', gitOp: 'push', ts: '2026-09-01T00:01:00Z' },
    { sessionId: 's2', gitOp: 'commit', ts: 1000 },
  ]);
  assert.equal(m.get('s1'), Date.parse('2026-09-01T00:05:00Z'));
  assert.equal(m.get('s2'), 1000);
});

test('computeOutcomeMetrics: four metrics, each tagged, an empty backlog is absent with a reason', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-lom-'));
  try {
    const deps = {
      readOutcomes: () => [], loadBacklog: () => ({ items: [] }),
      readEvents: () => [], readVerdicts: () => [],
    };
    const out = await computeOutcomeMetrics({ stateDir, now: 1e12, windowDays: 30, deps });
    assert.deepEqual(out.metrics.map((m) => m.id), METRIC_IDS);
    for (const m of out.metrics) {
      assert.ok(['measured', 'constant', 'absent'].includes(m.value.evidence), m.id);
      assert.equal(typeof m.basis, 'string');
      assert.ok(Array.isArray(m.refs));
    }
    assert.match(out.metrics[0].value.reason, /no merge request merged/);
    assert.equal(out.windowDays, 30);
  } finally { fs.rmSync(stateDir, { recursive: true, force: true }); }
});

// a malformed input (a backlog whose items is an object, a
// QA trend file that is not a list) is that metric's absent reason, never
// a thrown 500 for the whole response.
test('S-F5: a non-array input is an absent metric with a reason, not a throw', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-lom-'));
  try {
    const deps = {
      readOutcomes: () => null, loadBacklog: () => ({ items: { a: 1 } }),
      readEvents: () => 'x', readVerdicts: () => ({}),
    };
    const out = await computeOutcomeMetrics({ stateDir, now: 1e12, windowDays: 30, deps });
    assert.deepEqual(out.metrics.map((m) => m.id), METRIC_IDS);
    for (const m of out.metrics) {
      assert.equal(m.value.evidence, 'absent', m.id);
      assert.match(m.value.reason, /not a list/, m.id);
    }
  } finally { fs.rmSync(stateDir, { recursive: true, force: true }); }
});
