// Phase 0 substrate integration: exercise outcome-record + task-classify +
// outcome-store + cross-model-eval together as they will be composed downstream.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { emptyOutcome, mergeOutcome } from '../lib/evaluation/outcome-record.js';
import { classifyTask } from '../lib/evaluation/task-classify.js';
import { appendOutcome, readOutcomes, updateOutcome } from '../lib/evaluation/outcome-store.js';
import { criticDisagreement } from '../lib/evaluation/cross-model-eval.js';
import { finalizeSession } from '../lib/evaluation/session-outcome.js';
import { isPromptEvent } from '../lib/evaluation/outcome-metrics.js';
import { extractClaudeEvents } from '../lib/observability/extract-claude.js';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'mc-outcome-int-')); }

test('classify -> build -> append -> read -> backfill round trip', async () => {
  const d = tmp();
  const { taskClass } = classifyTask({
    firstPrompt: 'implement a new outcomes panel',
    filesTouched: ['web/evaluation/outcomes.js'],
  });
  assert.equal(taskClass, 'feature');

  let row = emptyOutcome({ id: 'session-int-1', unit: 'session', taskClass });
  row = mergeOutcome(row, { turns: 5, verifier: { tests: true }, committed: true, revertedLater: null });
  appendOutcome(d, row);

  const read = readOutcomes(d, { unit: 'session' });
  assert.equal(read.length, 1);
  assert.equal(read[0].taskClass, 'feature');
  assert.equal(read[0].verifier.tests, true);
  assert.equal(read[0].turns, 5);

  // lagging-truth backfill
  updateOutcome(d, 'session-int-1', { revertedLater: false });
  assert.equal(readOutcomes(d)[0].revertedLater, false);
});

test('cross-model critic disagreement stays fail-open with no key', async () => {
  // No ANTHROPIC_API_KEY supplied -> null, never throws, no network.
  const v = await criticDisagreement({ question: 'q', answer: 'a', apiKey: '' });
  assert.equal(v, null);
});

// This is the spec's own stated acceptance criterion (task 9 of
// docs/superpowers/plans/2026-07-29-loop-measurement-honesty.md), run for
// real against the actual finalizeSession path rather than restated as a
// hand-assembled row. Before this plan, verifier.exitOk, taskClass, and
// turns were dead across all production rows: taskClass was always "other"
// (firstPrompt never reached classifyTask), turns was always 0, and
// verifier.exitOk was always null (nothing fed the done-gate verdict in).
//
// Task 2 fixed the turns/taskClass selector (isPromptEvent), but the
// flagship adapter, extract-claude.js, emitted no prompt event at all for a
// real Claude Code transcript until Task 10 taught it to parse 'user'-type
// transcript lines. An earlier revision of this test hand-assembled
// {kind:'tool', tool:'user'} events directly and so could not catch that:
// it exercised the selector, never the extractor. The events below instead
// come from feeding a synthetic Claude Code transcript (the same JSONL
// shape server/test/fixtures/claude-code/transcript.jsonl uses) through the
// real extractClaudeEvents(), so a regression in the extractor's user-line
// handling, Task 2's selector, or Task 6's done-gate wiring fails this test.
//
// The transcript also includes a tool_result echo after each tool call (the
// harness posting the tool's result back in as a 'user'-type line) precisely
// because that shape is the crux this test guards: only the ONE real human
// prompt may count as a turn, not the two tool-result echoes. No adapter
// emits a kind:'tool_result' event, so this transcript does not synthesize
// one either.
test('acceptance: a synthetic episode end to end produces exitOk, taskClass, and turns all non-trivial', () => {
  const stateDir = tmp();
  const SID = 'acceptance-s1';
  const transcript = [
    { type: 'user', timestamp: '2026-07-01T10:00:00Z',
      message: { content: 'Fix the flaky retry test' } },
    { type: 'assistant', timestamp: '2026-07-01T10:00:05Z',
      message: { content: [{ id: 't1', type: 'tool_use', name: 'Edit',
        input: { file_path: '/src/retry.test.js', old_string: 'a', new_string: 'b' } }] } },
    { type: 'user', timestamp: '2026-07-01T10:00:10Z',
      message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'Applied successfully' }] } },
    { type: 'assistant', timestamp: '2026-07-01T10:00:15Z',
      message: { content: [{ id: 't2', type: 'tool_use', name: 'Bash',
        input: { command: 'npm test', description: 'npm test' } }] } },
    { type: 'user', timestamp: '2026-07-01T10:00:20Z',
      message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: 'All tests passed' }] } },
  ];
  const events = transcript.flatMap(o => extractClaudeEvents(JSON.stringify(o), SID));
  // Exactly one prompt event: the real human turn. If the two tool_result
  // echoes above were miscounted this would read 3, not 1.
  assert.equal(events.filter(isPromptEvent).length, 1);

  const doneGateRecords = [{ result: 'pass' }];
  const acceptanceText = '- [x] tests pass\n';

  const { row } = finalizeSession(stateDir, {
    sessionId: SID,
    events,
    usage: { input: 100, output: 50, ctxUsedPct: 10 },
    firstPrompt: events.find(isPromptEvent).label,
    filesTouched: [...new Set(events.filter(e => e.path).map(e => e.path))],
    acceptanceText,
    doneGateRecords,
    unit: 'prompt-test',
  });

  assert.equal(row.verifier.exitOk, true);
  // D23/D24 judge cutover (glmps-159 task 8): finalizeSession no longer runs
  // classifyTask - every row starts 'pending' and the judge plugin fills in
  // the real class from the finalize route, fire-and-forget, once judged.
  assert.equal(row.taskClass, 'pending');
  assert.equal(row.turns, 1);
});
