// server/test/nightly-run-payloads.test.js
//
// Covers the two gaps the nightly-run core left as explicit placeholders
// (estCost, nextBacklogProposal) and the run.completed payload that the
// morning brief actually reads.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  estimateRunCost,
  proposeNextBacklog,
  planRun,
  summarizeRun,
  runCompletedPayload,
} from '../lib/orchestration/nightly-run.js';
import { buildBrief } from '../lib/observability/morning-brief.js';

const cfg = { repoAllowlist: ['glmps'], maxItems: 1 };
const card = (id, over = {}) => ({ id, state: 'queued', project: 'glmps', order: 1, ...over });

// estimateRunCost

test('with no run history the cost estimate is null, not zero', () => {
  // Zero is a claim ("this run is free"). Null is the truth ("unknown").
  // A budget guardrail fed a fabricated zero would never pre-empt anything.
  assert.equal(estimateRunCost([]), null);
});

test('the cost estimate is the median of prior run costs', () => {
  const prior = [
    { payload: { costActual: { usd: 1 } } },
    { payload: { costActual: { usd: 5 } } },
    { payload: { costActual: { usd: 3 } } },
  ];
  assert.equal(estimateRunCost(prior), 3);
});

test('the cost estimate averages the middle two on an even sample', () => {
  const prior = [
    { payload: { costActual: { usd: 2 } } },
    { payload: { costActual: { usd: 4 } } },
  ];
  assert.equal(estimateRunCost(prior), 3);
});

test('runs with no recorded cost are ignored rather than counted as zero', () => {
  const prior = [
    { payload: { costActual: { usd: 4 } } },
    { payload: {} },
    { payload: { costActual: {} } },
  ];
  assert.equal(estimateRunCost(prior), 4);
});

test('planRun carries the estimate through and reports null when there is no history', () => {
  assert.equal(planRun({ backlog: [card('a')], config: cfg, now: 0 }).estCost, null);
  const withHistory = planRun({
    backlog: [card('a')], config: cfg, now: 0,
    priorRuns: [{ payload: { costActual: { usd: 2 } } }],
  });
  assert.equal(withHistory.estCost, 2);
});

// proposeNextBacklog

test('the next-night proposal is what tonight could not reach, in order', () => {
  const plan = planRun({
    backlog: [card('a', { order: 1 }), card('b', { order: 2 }), card('c', { order: 3 })],
    config: cfg,
    now: 0,
  });
  assert.deepEqual(plan.items.map((i) => i.id), ['a']);
  assert.deepEqual(proposeNextBacklog({ skipped: plan.skipped }), ['b', 'c']);
});

test('a quarantined or not-allowlisted card is never proposed for the next night', () => {
  const plan = planRun({
    backlog: [
      card('a', { order: 1 }),
      card('poison', { order: 2, quarantined: true }),
      card('elsewhere', { order: 3, project: 'other-repo' }),
      card('b', { order: 4 }),
    ],
    config: cfg,
    now: 0,
  });
  // Proposing a quarantined card would launder the poison gate through the
  // runner's own next-night suggestion.
  assert.deepEqual(proposeNextBacklog({ skipped: plan.skipped }), ['b']);
});

test('a blocked card is proposed, because its blocker may clear overnight', () => {
  const plan = planRun({
    backlog: [card('a', { order: 1 }), card('b', { order: 2, blockedBy: ['zzz'] })],
    config: cfg,
    now: 0,
  });
  assert.deepEqual(proposeNextBacklog({ skipped: plan.skipped }), ['b']);
});

test('the proposal is capped', () => {
  const backlog = Array.from({ length: 12 }, (_, i) => card(`c${i}`, { order: i }));
  const plan = planRun({ backlog, config: cfg, now: 0 });
  assert.equal(proposeNextBacklog({ skipped: plan.skipped, max: 3 }).length, 3);
});

test('summarizeRun fills nextBacklogProposal from the run it summarizes', () => {
  const plan = planRun({ backlog: [card('a', { order: 1 }), card('b', { order: 2 })], config: cfg, now: 0 });
  const payload = summarizeRun({ runId: plan.runId, items: plan.items, skipped: plan.skipped });
  assert.deepEqual(payload.nextBacklogProposal, ['b']);
});

// runCompletedPayload

test('runCompletedPayload uses the field names the handoff A2 table specifies', () => {
  const p = runCompletedPayload({
    runId: 'nightly-20260816',
    prs: [{ url: 'https://github.com/o/r/pull/1' }],
    itemsDone: ['a'],
    itemsBlocked: ['b'],
    gateResults: [{ gateName: 'tests', status: 'pass' }, { gateName: 'critic', status: 'skipped' }],
    spend: { usd: 1.25 },
    nextBacklogProposal: ['c'],
  });
  assert.equal(p.runId, 'nightly-20260816');
  assert.deepEqual(p.prs, ['https://github.com/o/r/pull/1']);
  assert.deepEqual(p.itemsDone, ['a']);
  assert.deepEqual(p.itemsBlocked, ['b']);
  assert.deepEqual(p.gatesSkipped, ['critic']);
  assert.equal(p.costActual.usd, 1.25);
  assert.deepEqual(p.nextBacklogProposal, ['c']);
});

test('the morning brief can actually read a runCompletedPayload', () => {
  // The regression this pins: the run summary and the brief were built by two
  // separate tracks, and the brief reads itemsDone/itemsBlocked/gatesSkipped/
  // prs/costActual. A payload using different names would leave the brief
  // silently empty rather than failing loudly.
  const p = runCompletedPayload({
    runId: 'nightly-20260816',
    prs: [{ url: 'https://github.com/o/r/pull/1' }],
    itemsDone: ['a'],
    itemsBlocked: ['blocked-1'],
    gateResults: [{ gateName: 'critic', status: 'skipped' }],
    spend: { usd: 1.25 },
  });
  const b = buildBrief({
    runEvents: [{ kind: 'run.completed', ts: '2026-08-16T06:00:00.000Z', payload: p }],
    reviews: [],
    integrity: [],
    now: Date.parse('2026-08-16T14:00:00.000Z'),
  });
  assert.ok(b.lines[0].includes('nightly-20260816'), b.lines.join(' | '));
  assert.ok(b.lines.some((l) => l.includes('1 item(s) done')), b.lines.join(' | '));
  assert.ok(b.lines.some((l) => l.includes('pull/1')), b.lines.join(' | '));
  assert.ok(b.lines.some((l) => l.includes('critic')), b.lines.join(' | '));
  assert.ok(b.lines.some((l) => l.includes('blocked-1')), b.lines.join(' | '));
});
