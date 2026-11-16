import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { nextSteerContext, steerEnabled, isSubagentCall } from '../../hooks/workspace-steer.js';
import { writeSteer, STEER_REDELIVER_AFTER_MS } from '../lib/orchestration/workspace-store.js';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'mc-steer-')); }

test('gate off -> no context even if a note exists', () => {
  const sd = tmp();
  writeSteer(sd, 's1', { note: 'FROZEN', from: 'op', ts: 1 });
  assert.equal(nextSteerContext(sd, 's1', { gate: false, ts: 2 }), null);
});

test('gate on + pending note -> context, redelivered a bounded number of times', () => {
  // This asserted consumed-on-FIRST-read until glmps-74. That was the
  // bug: subagents share their parent's session_id, so a subagent's hook won the
  // race, consumed the operator's note, and the main agent never saw it.
  const sd = tmp();
  writeSteer(sd, 's1', { note: 'work in the mutable file', from: 'op', ts: 1 });
  // Spaced past STEER_REDELIVER_AFTER_MS: redelivery is a retry for a MISSED
  // note, not a repeat inside one burst of tool calls.
  const gap = STEER_REDELIVER_AFTER_MS + 1;
  assert.match(nextSteerContext(sd, 's1', { gate: true, ts: 1000 }), /mutable file/);
  assert.equal(nextSteerContext(sd, 's1', { gate: true, ts: 1001 }), null, 'not repeated moments later');
  assert.match(nextSteerContext(sd, 's1', { gate: true, ts: 1000 + gap }), /mutable file/, 'still available');
  assert.match(nextSteerContext(sd, 's1', { gate: true, ts: 1000 + 2 * gap }), /mutable file/);
  assert.equal(nextSteerContext(sd, 's1', { gate: true, ts: 1000 + 3 * gap }), null, 'and then it stops');
});

// The steer arm was dead in production: main() computed the gate as
// GLMPS_WORKSPACE_STEER === '1', and NOTHING sets that variable - not server/, not
// the user's settings.json - so every steer note ever written was silently
// dropped and the router still answered "steered the running session". The
// launch paths cannot fix it by setting the env: nativeTerminalRecipe takes no
// env (and the editor-companion record, since deleted, had no env field
// either), so a launched session could never receive it. Per the original design (2026-07-10-agent-workspace
// -design.md:183) the presence of a pending note IS the gate; the env var is
// demoted to an explicit kill switch.

test('steerEnabled: unset env enables steering (the note is the gate)', () => {
  assert.equal(steerEnabled({}), true);
});

test('steerEnabled: GLMPS_WORKSPACE_STEER=0 is an explicit kill switch', () => {
  assert.equal(steerEnabled({ GLMPS_WORKSPACE_STEER: '0' }), false);
});

test('steerEnabled: GLMPS_WORKSPACE_STEER=1 still enables (back-compat with launched sessions)', () => {
  assert.equal(steerEnabled({ GLMPS_WORKSPACE_STEER: '1' }), true);
});

test('no sessionId -> no context, even with the gate open', () => {
  const sd = tmp();
  writeSteer(sd, 's1', { note: 'do not leak into an unbound session', from: 'op', ts: 1 });
  assert.equal(nextSteerContext(sd, null, { gate: true, ts: 2 }), null);
});

// Subagents inherit their parent's session_id, so session_id cannot tell them
// apart - that is what let a subagent consume the operator's note.
//
// My first attempt used transcript_path, reasoning from the fact that subagent
// transcripts live at <project>/<session>/subagents/agent-<id>.jsonl. A live
// control test refuted it: the subagent SAW the note. Instrumenting the real
// hook showed why - transcript_path in the payload is the PARENT's transcript,
// byte-identical for both.
//
// The real discriminator is explicit in the payload. Captured from the live
// hook, orchestrator vs subagent on the same session:
//   orchestrator: [... permission_mode, effort,               hook_event_name ...]
//   subagent:     [... permission_mode, agent_id, agent_type, hook_event_name ...]
// Claude Code simply tells you: a subagent call carries agent_id/agent_type.

test('isSubagentCall keys off agent_id / agent_type, which only a subagent carries', () => {
  assert.equal(isSubagentCall({ session_id: 's', agent_id: 'a1', agent_type: 'general-purpose' }), true);
  assert.equal(isSubagentCall({ session_id: 's', agent_id: 'a1' }), true, 'agent_id alone is enough');
  assert.equal(isSubagentCall({ session_id: 's', agent_type: 'debugger' }), true);
});

test('an orchestrator payload is not a subagent call', () => {
  // The real captured shape, minus the fields that do not matter here.
  assert.equal(isSubagentCall({
    session_id: 'e0e65e8e', permission_mode: 'default', effort: 'high',
    hook_event_name: 'PreToolUse', tool_name: 'Bash',
  }), false);
});

test('a missing or junk payload FAILS TOWARD DELIVERING', () => {
  // If Claude Code ever stops sending these fields, the worst case must be a
  // duplicate delivery to a subagent - never a lost operator instruction,
  // which is the failure actually being fixed.
  assert.equal(isSubagentCall(undefined), false);
  assert.equal(isSubagentCall(null), false);
  assert.equal(isSubagentCall({}), false);
  assert.equal(isSubagentCall({ agent_id: '' }), false, 'an empty id is not an id');
  assert.equal(isSubagentCall('nonsense'), false);
});

test('nextSteerContext declines to consume when the caller is a subagent', () => {
  const sd = tmp();
  writeSteer(sd, 's1', { note: 'the orchestrator should get this', from: 'op', ts: 1 });

  const asSub = nextSteerContext(sd, 's1', { gate: true, ts: 2, input: { agent_id: 'a1', agent_type: 'general-purpose' } });
  assert.equal(asSub, null, 'a subagent gets nothing');

  const asMain = nextSteerContext(sd, 's1', { gate: true, ts: 3, input: { effort: 'high' } });
  assert.match(asMain, /orchestrator should get this/, 'and the note is still there for the main agent');
});

test('a subagent poll does not burn a delivery from the budget', () => {
  const sd = tmp();
  writeSteer(sd, 's2', { note: 'n', from: 'op', ts: 1 });
  for (let i = 0; i < 5; i++) {
    nextSteerContext(sd, 's2', { gate: true, ts: 2 + i, input: { agent_id: 'a' } });
  }
  assert.match(nextSteerContext(sd, 's2', { gate: true, ts: 20, input: {} }), /n/,
    'the note is untouched and still available to its real recipient');
});
