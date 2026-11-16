// server/lib/scut/progress.js
//
// Progress check-ins into a parked Slack thread (glmps-74).
//
// The operator watches the thread, not the dashboard, and the pain is the long
// heads-down stretch where the agent stops narrating. So the SERVER computes
// and posts these, not the agent: a mechanism that depended on the agent
// remembering to report would fail in exactly the situation it exists for.
//
// THE DENOMINATOR IS REAL OR ABSENT, never invented. A percentage needs a total
// known up front, and most agent work discovers its scope as it goes; a bar
// that sits at 40% for an hour and then jumps, or slides backwards, teaches the
// operator to ignore it. But this codebase already maintains a true one:
// implementation plans under docs/superpowers/plans/ are checkbox lists that
// plan-lint already counts and agents already tick as they work. When a session
// has a plan, ticked/total is honest. When it does not, this reports
// hasDenominator:false and the caller says nothing at all - silence being the
// truthful answer rather than a made-up number.
//
// Pure. No I/O, no clock: the caller supplies the text and the time.
//
// Zero runtime dependencies.

// A plan step: a checkbox line, the shape plans (and to-tickets acceptance
// criteria) use and plan-lint counts.
const STEP_RE = /^\s*-\s*\[([ xX])\]/;
// Headings. `### Task N: ...` is the boundary the operator asked to be notified
// on; `## Stage N: ...` is the coarser grouping, carried for context.
const TASK_RE = /^###\s+(.+?)\s*$/;
const STAGE_RE = /^##\s+(?!#)(.+?)\s*$/;

/**
 * planProgress(markdown) -> {
 *   done, total, hasDenominator, complete, currentTask, stage
 * }
 *
 * `currentTask` is the task heading that owns the FIRST unticked step - the
 * thing actually in progress - and is null once everything is ticked.
 */
export function planProgress(markdown) {
  const text = typeof markdown === 'string' ? markdown : '';
  let done = 0;
  let total = 0;
  let stage = null;
  let task = null;
  let currentTask = null;
  let currentStage = null;

  for (const line of text.split('\n')) {
    const stageM = line.match(STAGE_RE);
    if (stageM) { stage = stageM[1]; continue; }
    const taskM = line.match(TASK_RE);
    if (taskM) { task = taskM[1]; continue; }

    const stepM = line.match(STEP_RE);
    if (!stepM) continue;
    total += 1;
    if (stepM[1] === ' ') {
      // First unticked step wins: that is where the work actually is.
      if (currentTask === null) { currentTask = task; currentStage = stage; }
    } else {
      done += 1;
    }
  }

  const hasDenominator = total > 0;
  const complete = hasDenominator && done === total;
  return {
    done,
    total,
    hasDenominator,
    complete,
    currentTask: complete ? null : currentTask,
    stage: complete ? null : currentStage,
  };
}

/**
 * progressCheckIn({ prev, next, now, throttleMs }) -> { due, reason }
 *
 * prev is the last POSTED state ({ currentTask, postedTs }) or null.
 *
 * Comparing against the last POSTED task rather than the last observed one is
 * deliberate and load-bearing: a boundary change that arrives inside the
 * throttle window stays "changed", so it is DEFERRED to the next open window
 * rather than dropped. The operator sees a move late, never not at all.
 */
export function progressCheckIn({ prev, next, now, throttleMs = 5 * 60_000 } = {}) {
  if (!next || !next.hasDenominator) return { due: false, reason: 'no-denominator' };
  if (!prev) return { due: true, reason: 'first' };

  const changed = next.complete
    ? prev.currentTask !== null || prev.complete !== true
    : next.currentTask !== prev.currentTask;
  if (!changed) return { due: false, reason: 'same-task' };

  const since = Number.isFinite(prev.postedTs) && Number.isFinite(now) ? now - prev.postedTs : Infinity;
  if (since < throttleMs) return { due: false, reason: 'throttled' };

  return { due: true, reason: next.complete ? 'complete' : 'task-boundary' };
}

function humanElapsed(ms) {
  if (!Number.isFinite(ms) || ms < 60_000) return null;
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

/**
 * The one line the operator actually reads. Ratio first, because that is the
 * question being asked ("how much more"), then where we are, then elapsed.
 */
export function formatCheckIn(progress, { elapsedMs } = {}) {
  const parts = [`${progress.done}/${progress.total}`];
  if (progress.complete) {
    // All ticked is not closed (glmps-2-0-211): "plan complete" followed by a
    // quiet wait on the gate and merge queue read as finished. The server does
    // not know the ETA, so it names what is left and leaves the time to the
    // agent's own waiting-state post.
    parts.push('plan steps done, card still open: verification, PR and merge to go');
  } else {
    const where = [progress.stage, progress.currentTask].filter(Boolean).join(' / ');
    if (where) parts.push(where);
  }
  const el = humanElapsed(elapsedMs);
  if (el) parts.push(`${el} elapsed`);
  return parts.join(' - ');
}
