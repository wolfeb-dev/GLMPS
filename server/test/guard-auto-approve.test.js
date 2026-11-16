// Card glmps-2-0-201: the auto-approve bar, caps, probation and digest.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  POLICY, autoApproveCandidate, probationVerdict, newRecord, digestText, runAutoApproveTick,
  readAutoApproveState, writeAutoApproveState,
} from '../lib/evaluation/guard-auto-approve.js';
import { GUARD_TEMPLATES, GUARD_ANCHORS } from '../lib/evaluation/guard-coverage.js';
import { scanText } from '../lib/governance/poison-scan.js';
import { LearningWriteFrozenError } from '../lib/evaluation/lesson-write.js';

const DAY = 86400000;
const NOW = Date.UTC(2026, 10, 13, 12);
const TPL = { 'sleep-poll': '- Never poll with sleep N then cat.' };

function row(code, project, sids, { status = 'pending', at = NOW - DAY, id } = {}) {
  return { id: id ?? `${code}|${project}`, source: 'gap', code, project, status, lastSeenTs: at,
    sightings: sids.map((sid, i) => ({ sid, ts: at - i * 1000 })) };
}
const qualifying = () => [row('sleep-poll', 'D--a', ['s1', 's2', 's3']), row('sleep-poll', 'D--b', ['s4', 's5'])];

test('every template matches its own coverage anchor and scans clean', () => {
  for (const [code, rule] of Object.entries(GUARD_TEMPLATES)) {
    assert.ok(GUARD_ANCHORS[code], `${code} has no anchor`);
    assert.match(rule, GUARD_ANCHORS[code], `${code} template would not mark its code covered`);
    assert.equal(scanText(rule).clean, true, `${code} template trips the poison scan`);
    assert.match(rule, /^- [\x20-\x7e]+$/, `${code} template must be one ASCII bullet line`);
  }
});

test('5 sessions across 2 repos in 7 days qualifies, with the template text and its evidence', () => {
  const r = autoApproveCandidate({ items: qualifying(), records: [], templates: TPL, now: NOW });
  assert.equal(r.candidate.code, 'sleep-poll');
  assert.equal(r.candidate.rule, TPL['sleep-poll']);
  assert.deepEqual(r.candidate.evidence, { sessions: 5, repos: 2, windowDays: 7 });
});

test('4 sessions, or 5 sessions in one repo, or sightings older than 7 days, do not qualify', () => {
  const four = [row('sleep-poll', 'D--a', ['s1', 's2', 's3']), row('sleep-poll', 'D--b', ['s4'])];
  assert.equal(autoApproveCandidate({ items: four, records: [], templates: TPL, now: NOW }).candidate, undefined);
  const oneRepo = [row('sleep-poll', 'D--a', ['s1', 's2', 's3', 's4', 's5'])];
  assert.equal(autoApproveCandidate({ items: oneRepo, records: [], templates: TPL, now: NOW }).candidate, undefined);
  const stale = [row('sleep-poll', 'D--a', ['s1', 's2', 's3'], { at: NOW - 8 * DAY }), row('sleep-poll', 'D--b', ['s4', 's5'], { at: NOW - 8 * DAY })];
  assert.equal(autoApproveCandidate({ items: stale, records: [], templates: TPL, now: NOW }).candidate, undefined);
});

test('a code with no template, or already covered, or already applied, never qualifies', () => {
  assert.equal(autoApproveCandidate({ items: qualifying(), records: [], templates: {}, now: NOW }).candidate, undefined);
  const covered = [...qualifying(), row('sleep-poll', 'D--c', ['s9'], { status: 'covered' })];
  assert.equal(autoApproveCandidate({ items: covered, records: [], templates: TPL, now: NOW }).candidate, undefined);
  const applied = [...qualifying(), row('sleep-poll', 'D--c', ['s9'], { status: 'applied' })];
  assert.equal(autoApproveCandidate({ items: applied, records: [], templates: TPL, now: NOW }).candidate, undefined);
});

test('a code that was ever auto-approved (even reverted) is never auto-approved again', () => {
  const records = [{ code: 'sleep-poll', status: 'reverted', approvedTs: NOW - 40 * DAY }];
  assert.equal(autoApproveCandidate({ items: qualifying(), records, templates: TPL, now: NOW }).candidate, undefined);
});

test('a rule that trips the poison scan is refused', () => {
  const r = autoApproveCandidate({ items: qualifying(), records: [], templates: TPL, now: NOW, scan: () => ({ clean: false }) });
  assert.equal(r.candidate, undefined);
});

test('caps: 1 per 24 hours and 10 live at once', () => {
  const recent = [{ code: 'x', status: 'probation', approvedTs: NOW - 2 * 3600000 }];
  assert.match(autoApproveCandidate({ items: qualifying(), records: recent, templates: TPL, now: NOW }).reason, /1 per day/);
  const ten = Array.from({ length: 10 }, (_, i) => ({ code: `c${i}`, status: i % 2 ? 'kept' : 'probation', approvedTs: NOW - 30 * DAY }));
  assert.match(autoApproveCandidate({ items: qualifying(), records: ten, templates: TPL, now: NOW }).reason, /10 live/);
  const reverted = ten.map((r) => ({ ...r, status: 'reverted' }));
  assert.ok(autoApproveCandidate({ items: qualifying(), records: reverted, templates: TPL, now: NOW }).candidate);
});

test('probation: reverted when the gap recurs at least as often as in the 14 days before, kept when it drops', () => {
  const approvedTs = NOW - 15 * DAY;
  const before = row('sleep-poll', 'D--a', ['b1', 'b2', 'b3', 'b4'], { at: approvedTs - DAY, id: 'pre' });
  const rec = newRecord({ candidate: { code: 'sleep-poll', rule: 'r', itemId: 'pre', evidence: {} }, items: [before], now: approvedTs, lessonId: 'legacy:pre' });
  assert.equal(rec.baseline, 4);
  assert.equal(rec.probationEndsTs, approvedTs + POLICY.probationDays * DAY);
  const same = row('sleep-poll', 'D--b', ['p1', 'p2', 'p3', 'p4'], { at: approvedTs + 2 * DAY, id: 'post' });
  assert.equal(probationVerdict(rec, [before, same]).verdict, 'revert');
  const fewer = row('sleep-poll', 'D--b', ['p1'], { at: approvedTs + 2 * DAY, id: 'post' });
  assert.equal(probationVerdict(rec, [before, fewer]).verdict, 'kept');
});

test('digestText leads with the counts and is empty for no events', () => {
  assert.equal(digestText([]), '');
  const t = digestText([
    { type: 'approved', code: 'sleep-poll', evidence: { sessions: 6, repos: 2 } },
    { type: 'aged-out', itemId: 'a' }, { type: 'aged-out', itemId: 'b' },
  ]);
  assert.match(t.split('\n')[0], /1 approved, 0 reverted, 0 kept, 2 aged out/);
  assert.match(t, /sleep-poll/);
});

function harness({ items, enabled = true, canAct = true, state } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-auto-approve-'));
  if (state) writeAutoApproveState(dir, state);
  let store = { items, config: {}, seq: 0 };
  const calls = { land: [], unland: [] };
  const deps = {
    now: NOW, enabled, canAct, templates: TPL,
    loadStore: () => store, saveStore: (s) => { store = s; },
    readState: () => readAutoApproveState(dir), writeState: (s) => writeAutoApproveState(dir, s),
    land: (c) => { calls.land.push(c); return { lessonId: `legacy:${c.itemId}`, result: { commit: 'sha', changed: true } }; },
    unland: (r) => { calls.unland.push(r); return { revoked: true }; },
  };
  return { dir, deps, calls, store: () => store };
}

test('tick: off means nothing happens at all', async () => {
  const h = harness({ items: qualifying(), enabled: false });
  const r = await runAutoApproveTick(h.deps);
  assert.equal(r.outcome, 'nothing-to-do');
  assert.equal(h.calls.land.length, 0);
});

test('tick: lands one qualifying guard, marks the row applied, opens probation, and queues a digest', async () => {
  const h = harness({ items: qualifying() });
  const r = await runAutoApproveTick(h.deps);
  assert.equal(r.outcome, 'done');
  assert.equal(h.calls.land.length, 1);
  assert.equal(r.result.approved, 'sleep-poll');
  const st = readAutoApproveState(h.dir);
  assert.equal(st.records[0].status, 'probation');
  assert.equal(st.records[0].lessonId, 'legacy:sleep-poll|D--a');
  assert.equal(h.store().items.find((i) => i.id === 'sleep-poll|D--a').status, 'applied');
  assert.match(r.result.digest, /1 approved/);
  writeAutoApproveState(h.dir, { ...st, lastDigestTs: NOW });
  const again = await runAutoApproveTick(h.deps);
  assert.equal(h.calls.land.length, 1, 'the daily cap holds on the next tick');
  assert.equal(again.result.digest, null, 'one digest per day');
});

test('tick: a closed act gate lands nothing', async () => {
  const h = harness({ items: qualifying(), canAct: false });
  await runAutoApproveTick(h.deps);
  assert.equal(h.calls.land.length, 0);
});

test('tick: ages out stale pending rows', async () => {
  const h = harness({ items: [row('reread-loop', 'D--a', ['s1'], { at: NOW - 31 * DAY })] });
  const r = await runAutoApproveTick(h.deps);
  assert.deepEqual(r.result.aged, ['reread-loop|D--a']);
  assert.equal(h.store().items[0].discardReason, 'aged-out');
});

test('tick: a failed probation reverts the guard and discards the applied row', async () => {
  const approvedTs = NOW - 15 * DAY;
  const items = [row('sleep-poll', 'D--a', ['p1', 'p2', 'p3'], { status: 'applied', at: approvedTs + DAY })];
  const state = { records: [{ code: 'sleep-poll', itemId: 'sleep-poll|D--a', lessonId: 'legacy:x', rule: 'r', status: 'probation',
    approvedTs, baseline: 3, probationEndsTs: approvedTs + 14 * DAY }], events: [], lastDigestTs: null };
  const h = harness({ items, state });
  const r = await runAutoApproveTick(h.deps);
  assert.deepEqual(r.result.reverted, ['sleep-poll']);
  assert.equal(h.calls.unland.length, 1);
  assert.equal(readAutoApproveState(h.dir).records[0].status, 'reverted');
  assert.equal(h.store().items[0].status, 'discarded');
  assert.equal(h.store().items[0].discardReason, 'auto-reverted');
});

test('tick: a land failure is reported as an error and leaves the row pending', async () => {
  const h = harness({ items: qualifying() });
  h.deps.land = () => { throw new Error('freeze'); };
  const r = await runAutoApproveTick(h.deps);
  assert.match(r.result.errors[0], /freeze/);
  assert.equal(h.store().items[0].status, 'pending');
  assert.equal(readAutoApproveState(h.dir).records.length, 0);
});

// Card glmps-2-0-205: the operator's freeze is a deliberate pause, not a
// fault; failing on it every hour filed a diagnosis card for nothing.
test('tick: a learning-write freeze refusal is a skip, not an error', async () => {
  const h = harness({ items: qualifying() });
  h.deps.land = () => { throw new LearningWriteFrozenError('learning-write freeze is active for actor auto-approver'); };
  const r = await runAutoApproveTick(h.deps);
  assert.deepEqual(r.result.errors, []);
  assert.equal(r.result.skipped, 'learning-write freeze');
  assert.equal(r.outcome, 'nothing-to-do');
  assert.equal(h.store().items[0].status, 'pending');
});
