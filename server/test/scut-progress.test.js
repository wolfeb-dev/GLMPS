// server/test/scut-progress.test.js
//
// Progress check-ins into the Slack thread (glmps-74, operator ask).
// The operator watches a parked thread, not the dashboard, and the pain is the
// long heads-down stretch where the agent stops talking. So: report where we
// are and how much is left, into the thread, without depending on the agent
// remembering to say so.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planProgress, progressCheckIn, formatCheckIn } from '../lib/scut/progress.js';

const PLAN = [
  '# Some plan',
  '',
  '## Stage 1: close the loops',
  '',
  '### Task 1: wire the sweep',
  '',
  '- [x] **Step 1: Write the failing test**',
  '- [x] **Step 2: Run it, confirm it fails**',
  '- [ ] **Step 3: Implement**',
  '',
  '### Task 2: route drift into the alert center',
  '',
  '- [ ] **Step 1: Write the failing test**',
  '- [ ] **Step 2: Implement**',
].join('\n');

test('planProgress counts every step and finds the task holding the first unticked one', () => {
  const p = planProgress(PLAN);
  assert.equal(p.total, 5);
  assert.equal(p.done, 2);
  assert.equal(p.currentTask, 'Task 1: wire the sweep');
  assert.equal(p.stage, 'Stage 1: close the loops');
});

test('planProgress reports completion when every box is ticked', () => {
  const done = PLAN.replace(/- \[ \]/g, '- [x]');
  const p = planProgress(done);
  assert.equal(p.done, 5);
  assert.equal(p.total, 5);
  assert.equal(p.currentTask, null, 'nothing is in progress when nothing is left');
  assert.equal(p.complete, true);
});

test('planProgress on a plan with no checkboxes yields no denominator, not a fake zero', () => {
  // A plan-shaped doc with no steps must not report "0/0" or 0%. Absence of a
  // denominator is the honest answer, and the caller renders no bar for it.
  const p = planProgress('# Notes\n\nSome prose, no steps.');
  assert.equal(p.total, 0);
  assert.equal(p.hasDenominator, false);
});

test('planProgress tolerates junk input rather than throwing on a half-written file', () => {
  for (const bad of [null, undefined, 42, '']) {
    const p = planProgress(bad);
    assert.equal(p.total, 0);
    assert.equal(p.hasDenominator, false);
  }
});


const NOW = Date.parse('2026-08-21T22:00:00.000Z');
const THROTTLE = 5 * 60_000;

test('the first check-in for a plan is due immediately', () => {
  const d = progressCheckIn({ prev: null, next: planProgress(PLAN), now: NOW, throttleMs: THROTTLE });
  assert.equal(d.due, true);
});

test('no check-in while the task has not changed, however many steps get ticked', () => {
  // The operator asked for TASK boundaries, not every step: a 60-step plan
  // would otherwise post 60 times.
  const prev = { currentTask: 'Task 1: wire the sweep', postedTs: NOW };
  const oneMoreStep = planProgress(PLAN.replace('- [ ] **Step 3: Implement**', '- [x] **Step 3: Implement**'));
  assert.equal(oneMoreStep.currentTask, 'Task 2: route drift into the alert center');

  const sameTask = { ...planProgress(PLAN) };
  assert.equal(progressCheckIn({ prev, next: sameTask, now: NOW + THROTTLE + 1, throttleMs: THROTTLE }).due, false);
});

test('a task boundary is due, but not before the throttle window elapses', () => {
  const prev = { currentTask: 'Task 1: wire the sweep', postedTs: NOW };
  const moved = planProgress(PLAN.replace('- [ ] **Step 3: Implement**', '- [x] **Step 3: Implement**'));
  assert.equal(progressCheckIn({ prev, next: moved, now: NOW + 60_000, throttleMs: THROTTLE }).due, false,
    'inside the window it waits');
  assert.equal(progressCheckIn({ prev, next: moved, now: NOW + THROTTLE + 1, throttleMs: THROTTLE }).due, true);
});

test('a throttled boundary change is DEFERRED, never dropped', () => {
  // Comparing against the last POSTED task (not the last observed one) is what
  // makes this true: the change stays pending until a window opens, so the
  // operator sees it late rather than never.
  const prev = { currentTask: 'Task 1: wire the sweep', postedTs: NOW };
  const moved = planProgress(PLAN.replace('- [ ] **Step 3: Implement**', '- [x] **Step 3: Implement**'));
  for (const t of [NOW + 1000, NOW + 60_000, NOW + 200_000]) {
    assert.equal(progressCheckIn({ prev, next: moved, now: t, throttleMs: THROTTLE }).due, false);
  }
  assert.equal(progressCheckIn({ prev, next: moved, now: NOW + THROTTLE + 1, throttleMs: THROTTLE }).due, true,
    'and it still fires once the window opens');
});

test('completion is always worth one final check-in', () => {
  const prev = { currentTask: 'Task 2: route drift into the alert center', postedTs: NOW };
  const done = planProgress(PLAN.replace(/- \[ \]/g, '- [x]'));
  assert.equal(progressCheckIn({ prev, next: done, now: NOW + THROTTLE + 1, throttleMs: THROTTLE }).due, true);
});

test('a plan with no denominator never produces a check-in', () => {
  const none = planProgress('# no steps here');
  assert.equal(progressCheckIn({ prev: null, next: none, now: NOW, throttleMs: THROTTLE }).due, false);
});


test('formatCheckIn leads with the ratio and names where we are', () => {
  const text = formatCheckIn(planProgress(PLAN), { elapsedMs: 38 * 60_000 });
  assert.match(text, /2\/5/);
  assert.match(text, /Task 1: wire the sweep/);
  assert.match(text, /38m/);
});

test('formatCheckIn says finished rather than showing 5/5 and a current task', () => {
  const text = formatCheckIn(planProgress(PLAN.replace(/- \[ \]/g, '- [x]')), { elapsedMs: 60_000 });
  assert.match(text, /5\/5/);
  assert.doesNotMatch(text, /Task 2/);
});

// glmps-2-0-211: "6/6 - plan complete" followed by silence read as finished while
// the gate, PR and merge were still ahead. All ticked is not closed.
test('formatCheckIn says the card is still open when every plan step is ticked', () => {
  const text = formatCheckIn(planProgress(PLAN.replace(/- \[ \]/g, '- [x]')), { elapsedMs: 13 * 60_000 });
  assert.doesNotMatch(text, /plan complete/);
  assert.match(text, /plan steps done/);
  assert.match(text, /card still open/);
  assert.match(text, /verification, PR and merge/);
  assert.match(text, /13m elapsed/);
});

test('formatCheckIn omits elapsed when it is unknown, rather than printing 0m', () => {
  const text = formatCheckIn(planProgress(PLAN), {});
  assert.match(text, /2\/5/);
  assert.doesNotMatch(text, /0m/);
});
