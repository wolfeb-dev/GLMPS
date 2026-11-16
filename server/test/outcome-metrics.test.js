import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeMetrics, summarizeOutcomes, summarizeByActor, isPromptEvent, otherShare, OTHER_SHARE } from '../lib/evaluation/outcome-metrics.js';

test('isPromptEvent matches kind:"prompt" and kind:"tool" tool:"user"', () => {
  assert.equal(isPromptEvent({ kind: 'prompt' }), true);
  assert.equal(isPromptEvent({ kind: 'tool', tool: 'user' }), true);
  assert.equal(isPromptEvent({ kind: 'tool', tool: 'Bash' }), false);
  assert.equal(isPromptEvent({ kind: 'command' }), false);
});

test('turns counts real Claude-Code user-prompt events (kind:tool, tool:user), not just kind:prompt', () => {
  const events = [
    { kind: 'tool', tool: 'user', ts: 1000 },
    { kind: 'tool', tool: 'Bash', ts: 1200 },
    { kind: 'tool_result', ts: 1700 },
    { kind: 'tool', tool: 'user', ts: 2000 },
  ];
  const m = computeMetrics({ events });
  assert.equal(m.turns, 2);
});

// A human turn (kind:'tool', tool:'user') must never count as a tool call.
// extract-claude.js and extract-antigravity.js both stamp the prompt event
// with kind:'tool', the same kind real tool_use events carry, so any filter
// keyed on kind==='tool' alone silently folds turns into toolCalls.
test('toolCalls excludes prompt events: N human turns + M real tool calls -> toolCalls === M, not M+N', () => {
  const events = [
    { kind: 'tool', tool: 'user', ts: 1000 },   // turn 1
    { kind: 'tool', tool: 'Bash', ts: 1100 },   // real tool call 1
    { kind: 'tool_result', ts: 1150 },
    { kind: 'tool', tool: 'Grep', ts: 1200 },   // real tool call 2
    { kind: 'tool_result', ts: 1250 },
    { kind: 'tool', tool: 'user', ts: 1300 },   // turn 2
    { kind: 'tool', tool: 'Glob', ts: 1400 },   // real tool call 3
    { kind: 'tool_result', ts: 1450 },
  ];
  const m = computeMetrics({ events });
  assert.equal(m.turns, 2);
  assert.equal(m.toolCalls, 3);
});

test('toolWait pairing excludes prompt events: a tool_result right after a prompt is not attributed wait time', () => {
  // No real tool event at all -> toolEvents is empty -> toolWait stays null
  // (absent), not a fake wait time credited to the human turn.
  const events = [
    { kind: 'tool', tool: 'user', ts: 1000 },
    { kind: 'tool_result', ts: 1500 },
  ];
  const m = computeMetrics({ events });
  assert.equal(m.wallClockMs.toolWait, null);
});

test('editApplyFailures stays null (absent) for a session with only a prompt event and no real tool calls', () => {
  const events = [{ kind: 'tool', tool: 'user', ts: 1000 }];
  const m = computeMetrics({ events });
  assert.equal(m.editApplyFailures, null);
});

test('turns, wall-clock, toolWait, ctx', () => {
  const events = [
    { kind: 'prompt', ts: 1000 },
    { kind: 'tool', tool: 'Bash', ts: 1200 },
    { kind: 'tool_result', ts: 1700, error: false },
    { kind: 'tool', tool: 'Edit', ts: 1800 },
    { kind: 'tool_result', ts: 1850, error: true },
    { kind: 'answer', ts: 2000 },
  ];
  const m = computeMetrics({ events, usage: { input: 10, output: 20, ctxUsedPct: 40 } });
  assert.equal(m.turns, 1);
  assert.equal(m.wallClockMs.total, 1000);
  assert.equal(m.wallClockMs.toolWait, 550);
  assert.equal(m.toolCalls, 2);
  assert.equal(m.toolErrors, 1);
  assert.equal(m.tokens.in, 10);
  assert.equal(m.contextUsageRatio, 0.4);
  assert.equal(m.firstTry, true);
});

test('empty events -> nulls, no throw', () => {
  const m = computeMetrics({ events: [], usage: null });
  assert.equal(m.wallClockMs.total, null);
  assert.equal(m.toolCalls, 0);
  assert.equal(m.tokens.in, null);
  assert.equal(m.contextUsageRatio, null);
  assert.equal(m.editApplyFailures, null);
  assert.equal(m.churn, null);
  assert.equal(m.extra.readEditRatio, null);
});

test('editApplyFailures counts failed results paired to the nearest preceding Edit/Write/NotebookEdit call', () => {
  // Shaped like real extract-claude.js output: edit tool calls carry
  // kind:'file-edit' (not kind:'tool'), so pairing must key off `tool`, not `kind`.
  const events = [
    { kind: 'tool', tool: 'Read', ts: 100 },
    { kind: 'tool_result', ts: 110, error: false },
    { kind: 'file-edit', tool: 'Edit', path: '/a.js', ts: 200 },
    { kind: 'tool_result', ts: 210, error: true },
    { kind: 'file-edit', tool: 'Write', path: '/b.js', ts: 300 },
    { kind: 'tool_result', ts: 310, error: false },
    { kind: 'file-edit', tool: 'NotebookEdit', path: '/c.ipynb', ts: 400 },
    { kind: 'tool_result', ts: 410, error: true },
    { kind: 'file-edit', tool: 'MultiEdit', path: '/d.js', ts: 500 },
    { kind: 'tool_result', ts: 510, error: true },
  ];
  const m = computeMetrics({ events });
  assert.equal(m.editApplyFailures, 3);
});

test('editApplyFailures ignores a failure following a non-edit tool, and is 0 (not null) when edits never fail', () => {
  const events = [
    { kind: 'command', tool: 'Bash', ts: 100 },
    { kind: 'tool_result', ts: 110, error: true },
    { kind: 'file-edit', tool: 'Edit', path: '/a.js', ts: 200 },
    { kind: 'tool_result', ts: 210, error: false },
  ];
  const m = computeMetrics({ events });
  assert.equal(m.editApplyFailures, 0);
});

test('editApplyFailures does not double-pair: a tool_result with no new preceding tool event is skipped', () => {
  const events = [
    { kind: 'file-edit', tool: 'Edit', path: '/a.js', ts: 100 },
    { kind: 'tool_result', ts: 110, error: true },
    { kind: 'tool_result', ts: 120, error: true }, // no preceding unmatched tool event
  ];
  const m = computeMetrics({ events });
  assert.equal(m.editApplyFailures, 1);
});

test('editApplyFailures is null only when there are zero tool events at all', () => {
  const events = [{ kind: 'prompt', ts: 100 }, { kind: 'answer', ts: 200 }];
  const m = computeMetrics({ events });
  assert.equal(m.editApplyFailures, null);
});

test('churn counts re-edits of a path already touched earlier; first touch is free', () => {
  const events = [
    { kind: 'file-edit', tool: 'Edit', path: '/a.js', ts: 100 },
    { kind: 'file-edit', tool: 'Write', path: '/b.js', ts: 200 },
    { kind: 'file-edit', tool: 'Edit', path: '/a.js', ts: 300 },
    { kind: 'file-edit', tool: 'NotebookEdit', path: '/a.js', ts: 400 },
  ];
  const m = computeMetrics({ events });
  assert.equal(m.churn, 2);
});

test('churn is null with no edit events, 0 when every edited path was touched once', () => {
  assert.equal(computeMetrics({ events: [{ kind: 'tool', tool: 'Read', ts: 1 }] }).churn, null);
  const events = [
    { kind: 'file-edit', tool: 'Edit', path: '/a.js', ts: 100 },
    { kind: 'file-edit', tool: 'Write', path: '/b.js', ts: 200 },
  ];
  assert.equal(computeMetrics({ events }).churn, 0);
});

test('churn also recognizes kind==="edit" events with a path (non-Claude adapters)', () => {
  const events = [
    { kind: 'edit', path: '/a.js', ts: 100 },
    { kind: 'edit', path: '/a.js', ts: 200 },
  ];
  const m = computeMetrics({ events });
  assert.equal(m.churn, 1);
});

test('extra.readEditRatio divides read-type tool calls by edit-type events, rounded to 2 decimals', () => {
  const events = [
    { kind: 'tool', tool: 'Read', ts: 100 },
    { kind: 'tool', tool: 'Grep', ts: 150 },
    { kind: 'tool', tool: 'Glob', ts: 180 },
    { kind: 'file-edit', tool: 'Edit', path: '/a.js', ts: 200 },
    { kind: 'file-edit', tool: 'Write', path: '/b.js', ts: 300 },
  ];
  const m = computeMetrics({ events });
  assert.equal(m.extra.readEditRatio, 1.5);
});

test('extra.readEditRatio is null when there are no edit events', () => {
  const events = [{ kind: 'tool', tool: 'Read', ts: 100 }];
  const m = computeMetrics({ events });
  assert.equal(m.extra.readEditRatio, null);
});

test('summarizeOutcomes aggregates by taskClass, evidence-tagged', () => {
  const rows = [
    { taskClass: 'feature', turns: 3, firstTry: true, verifier: { exitOk: true }, contextUsageRatio: 0.5, churn: 1 },
    { taskClass: 'feature', turns: 5, firstTry: false, verifier: { exitOk: false }, contextUsageRatio: 0.7, churn: 3 },
    { taskClass: 'debug', turns: 2, firstTry: true, verifier: { exitOk: null }, contextUsageRatio: null, churn: null },
  ];
  const s = summarizeOutcomes(rows);
  assert.equal(s.byClass.feature.n, 2);
  assert.equal(s.byClass.feature.medianTurns.value, 4);
  assert.equal(s.byClass.feature.medianTurns.evidence, 'measured');
  assert.equal(s.byClass.feature.verifierPassRate.value, 0.5);
  assert.equal(s.byClass.feature.firstTryRate.value, 0.5);
  assert.equal(s.byClass.feature.medianChurn.value, 2);
  assert.equal(s.byClass.debug.verifierPassRate.evidence, 'absent');
  assert.equal(s.byClass.debug.verifierPassRate.n, 0);
  assert.equal(s.byClass.debug.medianChurn.evidence, 'absent');
});

test('summarizeOutcomes: zero-variance medianTurns at n >= 10 is tagged constant', () => {
  const rows = new Array(10).fill(0).map(() => ({ taskClass: 'x', turns: 0 }));
  const s = summarizeOutcomes(rows);
  assert.equal(s.byClass.x.medianTurns.evidence, 'constant');
  assert.equal(s.byClass.x.medianTurns.value, 0);
});

test('summarizeByActor groups rows by actor before summarizing, mirroring summarizeOutcomes per group', () => {
  const rows = [
    { actor: 'alice', taskClass: 'feature', turns: 3, firstTry: true, verifier: { exitOk: true } },
    { actor: 'alice', taskClass: 'feature', turns: 5, firstTry: false, verifier: { exitOk: false } },
    { actor: 'bob', taskClass: 'feature', turns: 2, firstTry: true, verifier: { exitOk: true } },
    { taskClass: 'feature', turns: 1, firstTry: true, verifier: { exitOk: true } }, // no actor
  ];
  const s = summarizeByActor(rows);
  assert.equal(s.byActor.alice.byClass.feature.n, 2);
  assert.equal(s.byActor.alice.byClass.feature.medianTurns.value, 4);
  assert.equal(s.byActor.bob.byClass.feature.n, 1);
  assert.equal(s.byActor.__unknown__.byClass.feature.n, 1);
});

test('summarizeByActor on an empty/all-unattributed set behaves like a single __unknown__ group', () => {
  assert.deepEqual(summarizeByActor([]), { byActor: {} });
  const rows = [{ taskClass: 'debug', turns: 1 }];
  const s = summarizeByActor(rows);
  assert.equal(Object.keys(s.byActor).length, 1);
  assert.equal(s.byActor.__unknown__.byClass.debug.n, 1);
});

// extract-claude.js stamps ts as the transcript's ISO-8601 string, and string
// subtraction is NaN, so every Claude-Code session reported a NaN wall clock.
test('ISO-string ts: wallClockMs.total and toolWait are real millisecond spans', () => {
  const events = [
    { kind: 'tool', tool: 'user', ts: '2026-07-01T10:00:00.000Z' },
    { kind: 'tool', tool: 'Bash', ts: '2026-07-01T10:00:01.000Z' },
    { kind: 'tool_result', ts: '2026-07-01T10:00:03.500Z' },
    { kind: 'tool', tool: 'Read', ts: '2026-07-01T10:00:04.000Z' },
    { kind: 'tool_result', ts: '2026-07-01T10:00:05.000Z' },
  ];
  const m = computeMetrics({ events });
  assert.equal(m.wallClockMs.total, 5000);
  assert.equal(m.wallClockMs.toolWait, 3500);
});

test('ISO-string ts out of order and mixed with numeric ts are sorted chronologically', () => {
  const t0 = Date.parse('2026-07-01T10:00:00.000Z');
  const events = [
    { kind: 'tool_result', ts: '2026-07-01T10:00:02.000Z' },
    { kind: 'tool', tool: 'user', ts: t0 },
    { kind: 'tool', tool: 'Bash', ts: '2026-07-01T10:00:01.000Z' },
  ];
  const m = computeMetrics({ events });
  assert.equal(m.wallClockMs.total, 2000);
  assert.equal(m.wallClockMs.toolWait, 1000);
});

const judged = (i, taskClass, extra = {}) => ({ id: `r${i}`, taskClass, extra: { judge: { ts: i, ...extra } } });

test('otherShare: the window is the last N judged rows by judge time, against the 15% target', () => {
  assert.equal(OTHER_SHARE.window, 200);
  assert.equal(OTHER_SHARE.target, 0.15);
  const rows = [];
  // the 10 oldest judged rows are all 'other' and fall outside a window of 10
  for (let i = 0; i < 10; i++) rows.push(judged(i, 'other'));
  for (let i = 10; i < 20; i++) rows.push(judged(i, i < 11 ? 'other' : 'feature'));
  rows.reverse(); // file order must not matter
  const s = otherShare(rows, { window: 10 });
  assert.equal(s.window, 10);
  assert.equal(s.n, 10);
  assert.equal(s.other, 1);
  assert.equal(s.share, 0.1);
  assert.equal(s.target, 0.15);
  assert.equal(s.meetsTarget, true);
});

test('otherShare: unjudged, pending and judge-skipped rows are not in the window', () => {
  const rows = [
    { id: 'pre-judge', taskClass: 'other' },
    { id: 'pending', taskClass: 'pending' },
    judged(1, 'other', { skipped: 'no-events' }),
    judged(2, 'other'),
    judged(3, 'review'),
  ];
  const s = otherShare(rows);
  assert.equal(s.window, 200);
  assert.equal(s.n, 2);
  assert.equal(s.other, 1);
  assert.equal(s.share, 0.5);
  assert.equal(s.meetsTarget, false);
});

test('otherShare: no judged rows reports a null share, never a fabricated 0%', () => {
  const s = otherShare([{ id: 'x', taskClass: 'other' }]);
  assert.equal(s.n, 0);
  assert.equal(s.share, null);
  assert.equal(s.meetsTarget, null);
});
