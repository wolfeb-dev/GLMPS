// server/test/capability-feed-dispatched-worktree.test.js
// TDD (glmps-97) - dispatched Agent(isolation:"worktree") sessions get a
// separate Claude Code process rooted at .claude/worktrees/<agent-*|lane-*>/
// with zero visibility into skills the ORCHESTRATOR invoked before dispatch.
// Skill-gated gap codes false-positive there; non-skill-gated codes must not
// be suppressed. See capability-feed-core.js block comment for full rationale.
//
// Run: node --test server/test/capability-feed-dispatched-worktree.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  feedFromTranscript,
  isDispatchedWorktreeCwd,
  filterDispatchedWorktreeGaps,
} from '../lib/observability/capability-feed-core.js';

function editEvent(filePath) {
  return { kind: 'file-edit', op: 'write', path: filePath, lane: 'feed', tool: 'Edit', ts: Date.now() };
}

function readEvent(filePath) {
  return { kind: 'file-edit', op: 'read', path: filePath, lane: 'feed', tool: 'Read', ts: Date.now() };
}

const DISPATCHED_CWD_AGENT = 'D:\\glmps\\.claude\\worktrees\\agent-a1b2c3';
const DISPATCHED_CWD_LANE = 'D:\\glmps\\.claude\\worktrees\\lane-g97';
const NORMAL_CWD = 'D:\\glmps';

// isDispatchedWorktreeCwd - cwd classifier

test('isDispatchedWorktreeCwd: true for .claude/worktrees/agent-* (Windows backslashes)', () => {
  assert.equal(isDispatchedWorktreeCwd(DISPATCHED_CWD_AGENT), true);
});

test('isDispatchedWorktreeCwd: true for .claude/worktrees/lane-* (Windows backslashes)', () => {
  assert.equal(isDispatchedWorktreeCwd(DISPATCHED_CWD_LANE), true);
});

test('isDispatchedWorktreeCwd: true for .claude/worktrees/agent-* (POSIX forward slashes)', () => {
  assert.equal(isDispatchedWorktreeCwd('/home/user/glmps/.claude/worktrees/agent-77'), true);
});

test('isDispatchedWorktreeCwd: false for a normal repo root', () => {
  assert.equal(isDispatchedWorktreeCwd(NORMAL_CWD), false);
});

test('isDispatchedWorktreeCwd: false for the MC queue-runner worktree layout (state/runner/worktrees)', () => {
  // Different mechanism entirely (glmps-71 sessionWorktreePlan/worktreePlan) - 
  // must not be conflated with the Agent(isolation:"worktree") dispatch path.
  assert.equal(isDispatchedWorktreeCwd('D:\\glmps\\state\\runner\\worktrees\\glmps\\job-123'), false);
});

test('isDispatchedWorktreeCwd: false/safe for null, undefined, empty string', () => {
  assert.equal(isDispatchedWorktreeCwd(null), false);
  assert.equal(isDispatchedWorktreeCwd(undefined), false);
  assert.equal(isDispatchedWorktreeCwd(''), false);
});

// filterDispatchedWorktreeGaps - standalone reusable helper (for server.js
// follow-up wiring at its two direct detectGaps call sites)

test('filterDispatchedWorktreeGaps: strips all four skill-gated codes for a dispatched cwd', () => {
  const gaps = [
    { code: 'ui-without-frontend-design', severity: 'warn', message: 'x' },
    { code: 'ui-design-too-late', severity: 'warn', message: 'x' },
    { code: 'plan-skipped-on-large-change', severity: 'warn', message: 'x' },
    { code: 'done-without-verification', severity: 'warn', message: 'x' },
  ];
  const filtered = filterDispatchedWorktreeGaps(gaps, DISPATCHED_CWD_AGENT);
  assert.deepEqual(filtered, []);
});

test('filterDispatchedWorktreeGaps: leaves heavy-edits-no-subagents and reread-loop even for a dispatched cwd', () => {
  const gaps = [
    { code: 'heavy-edits-no-subagents', severity: 'info', message: 'x' },
    { code: 'reread-loop', severity: 'info', message: 'x' },
  ];
  const filtered = filterDispatchedWorktreeGaps(gaps, DISPATCHED_CWD_AGENT);
  assert.deepEqual(filtered.map(g => g.code).sort(), ['heavy-edits-no-subagents', 'reread-loop']);
});

test('filterDispatchedWorktreeGaps: returns gaps unchanged for a non-dispatched cwd', () => {
  const gaps = [
    { code: 'ui-without-frontend-design', severity: 'warn', message: 'x' },
    { code: 'heavy-edits-no-subagents', severity: 'info', message: 'x' },
  ];
  const filtered = filterDispatchedWorktreeGaps(gaps, NORMAL_CWD);
  assert.deepEqual(filtered, gaps);
});

test('filterDispatchedWorktreeGaps: safe on non-array gaps input', () => {
  assert.deepEqual(filterDispatchedWorktreeGaps(undefined, DISPATCHED_CWD_AGENT), []);
});

// feedFromTranscript integration - the actual Stop-hook path

// (a) A dispatched-worktree session with a UI-edit-without-frontend-design
//     transcript must NOT surface the ui-without-frontend-design gap: the
//     parent orchestrator already invoked frontend-design before dispatch, and
//     this child transcript has no visibility into that.
test('(a) dispatched-worktree session: UI edit without frontend-design does NOT flag ui-without-frontend-design', () => {
  const events = [editEvent('web/styles.css')];
  const { gaps } = feedFromTranscript({
    events, lines: [], skillsUsed: [], project: 'lane-g97', sessionId: 's1',
    cwd: DISPATCHED_CWD_LANE,
  });
  assert.ok(!gaps.some(g => g.code === 'ui-without-frontend-design'),
    'expected ui-without-frontend-design to be suppressed for a dispatched-worktree cwd');
});

// (b) The SAME transcript from a normal (non-dispatched) cwd must still flag.
test('(b) same transcript from a normal cwd STILL flags ui-without-frontend-design', () => {
  const events = [editEvent('web/styles.css')];
  const { gaps } = feedFromTranscript({
    events, lines: [], skillsUsed: [], project: 'glmps', sessionId: 's1',
    cwd: NORMAL_CWD,
  });
  assert.ok(gaps.some(g => g.code === 'ui-without-frontend-design'),
    'expected ui-without-frontend-design to still fire for a normal (non-dispatched) cwd');
});

// (b2) Same, with cwd omitted entirely (the pre-glmps-97 caller shape) - must
//      default to NOT suppressing, since undefined cwd is not a dispatched cwd.
test('(b2) feedFromTranscript with no cwd argument at all still flags ui-without-frontend-design', () => {
  const events = [editEvent('web/styles.css')];
  const { gaps } = feedFromTranscript({
    events, lines: [], skillsUsed: [], project: 'glmps', sessionId: 's1',
  });
  assert.ok(gaps.some(g => g.code === 'ui-without-frontend-design'));
});

// (c) reread-loop is NOT suppressed even for a dispatched-worktree session -
//     it is a real signal about THIS session's own behavior regardless of
//     what the parent orchestrator did. heavy-edits-no-subagents used to be
//     the other such code; it is retired (card glmps-2-0-82).
test('(c) dispatched-worktree session: retired heavy-edits-no-subagents no longer flags', () => {
  const events = Array.from({ length: 16 }, (_, i) => editEvent(`server/lib/foo${i}.js`));
  const { gaps } = feedFromTranscript({
    events, lines: [], skillsUsed: [], project: 'lane-g97', sessionId: 's1',
    cwd: DISPATCHED_CWD_LANE,
  });
  assert.ok(!gaps.some(g => g.code === 'heavy-edits-no-subagents'),
    'heavy-edits-no-subagents is retired');
});

test('(c) dispatched-worktree session: reread-loop still flags', () => {
  const events = Array.from({ length: 9 }, () => readEvent('server/lib/foo.js'));
  const { gaps } = feedFromTranscript({
    events, lines: [], skillsUsed: [], project: 'lane-g97', sessionId: 's1',
    cwd: DISPATCHED_CWD_LANE,
  });
  assert.ok(gaps.some(g => g.code === 'reread-loop'),
    'reread-loop must remain live for dispatched-worktree sessions');
});

// (d) plan-skipped-on-large-change and ui-design-too-late (the other two
//     skill-gated codes) are suppressed for a dispatched-worktree session too.
test('(d) dispatched-worktree session: plan-skipped-on-large-change is suppressed', () => {
  const events = [editEvent('a.js'), editEvent('b.js'), editEvent('c.js')];
  const { gaps } = feedFromTranscript({
    events, lines: [], skillsUsed: [], project: 'lane-g97', sessionId: 's1',
    cwd: DISPATCHED_CWD_LANE,
  });
  assert.ok(!gaps.some(g => g.code === 'plan-skipped-on-large-change'));
});

test('(d) same plan-skipped-on-large-change transcript from a normal cwd still flags', () => {
  const events = [editEvent('a.js'), editEvent('b.js'), editEvent('c.js')];
  const { gaps } = feedFromTranscript({
    events, lines: [], skillsUsed: [], project: 'glmps', sessionId: 's1',
    cwd: NORMAL_CWD,
  });
  assert.ok(gaps.some(g => g.code === 'plan-skipped-on-large-change'));
});
