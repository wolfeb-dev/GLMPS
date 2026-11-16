#!/usr/bin/env node
// PreToolUse hook: SESSION CONTROL. Three jobs, cheapest first:
//   1. stop  (glmps-28) - deny every tool call while the operator has
//            halted this session.
//   2. gate  (glmps-29) - hold a risky tool call until the operator
//            approves or denies it in chat.
//   3. steer (glmps-99)           - inject a pending operator note as context.
//
// NAME: this file is still called workspace-steer.js because the user's global
// settings.json registers it by that exact path. Renaming it would silently
// unregister the hook, which is a failure mode with no error message, so the
// name stays narrower than the job and this comment carries the difference.
//
// Steady state is one small read of a file that usually does not exist. The gate
// path costs an HTTP round trip, but only once the matcher has already fired, so
// an ordinary tool call pays nothing for it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readWorkspace, consumeSteer } from '../server/lib/orchestration/workspace-store.js';
import { readControl } from '../server/lib/orchestration/control-store.js';
import { shouldGate } from '../server/lib/orchestration/gate-matcher.js';
import { gateConfig, gateDeadlineMs, describeWait } from '../server/lib/orchestration/gate-config.js';
import { resolveStateDir } from '../server/lib/state-dir.js';
import { readMaintenance } from '../server/lib/kernel/maintenance.js';

// Is steering allowed in this process? The PRESENCE OF A PENDING NOTE is the
// real gate (nextSteerContext below); this only answers "did the operator turn
// the feature off outright".
//
// This was `GLMPS_WORKSPACE_STEER === '1'`, which made an UNSET variable mean
// "disabled" - and nothing anywhere set it, so the whole steer arm was dead and
// every Slack thread was one-shot while the router still replied "steered the
// running session". Setting the env at launch cannot fix it: nativeTerminalRecipe
// accepts no env, so a launched session can never be handed one this way (D20:
// every launch is a native terminal now, there is no other kind to consider).
// The original design allowed presence-of-note as the gate
// (docs/superpowers/specs/2026-07-10-agent-workspace-design.md:183); this
// implements that half.
export function steerEnabled(env = process.env) {
  return String(env?.GLMPS_WORKSPACE_STEER ?? '') !== '0';
}

// Is this hook firing inside a SUBAGENT rather than the orchestrator?
//
// glmps-74. Subagents inherit their parent's session_id, so
// session_id cannot tell them apart - which is exactly how a subagent came to
// consume the operator's steer note while the main agent never saw it.
//
// The first attempt keyed off transcript_path, reasoning from the fact that
// subagent transcripts live at <project>/<session>/subagents/agent-<id>.jsonl.
// A live control test refuted it: the subagent still saw the note.
// Instrumenting the real hook showed why - transcript_path in the PAYLOAD is
// the parent's transcript, byte-identical for both. The files differ; the
// field does not.
//
// The real discriminator is explicit. Captured from the live hook, same
// session, orchestrator vs subagent:
//   orchestrator: [... permission_mode, effort,               hook_event_name ...]
//   subagent:     [... permission_mode, agent_id, agent_type, hook_event_name ...]
// Claude Code simply tells you, so ask it rather than inferring from paths.
//
// FAILS TOWARD DELIVERING: a payload without these fields reads as
// not-a-subagent. If Claude Code stops sending them the worst case degrades to
// a duplicate delivery, never back to a lost operator instruction - which is
// the failure actually being fixed here.
export function isSubagentCall(input) {
  if (!input || typeof input !== 'object') return false;
  const id = input.agent_id;
  const type = input.agent_type;
  return (typeof id === 'string' && id !== '') || (typeof type === 'string' && type !== '');
}

export function nextSteerContext(stateDir, sessionId, { gate, ts, input } = {}) {
  if (!gate || !sessionId) return null;
  // Decline BEFORE consuming: a subagent must not burn a delivery from the
  // budget either, or a few subagent tool calls would exhaust the note before
  // the orchestrator ever polled.
  if (isSubagentCall(input)) return null;
  const ws = readWorkspace(stateDir, sessionId);
  if (!ws?.steer || ws.steer.consumedTs != null) return null;
  const steer = consumeSteer(stateDir, sessionId, ts);
  return steer ? `[GLMPS steer from ${steer.from}] ${steer.note}` : null;
}


/**
 * Deny decision while this session is stopped, else null.
 *
 * Unlike a steer note this is NEVER consumed on read: a stop is standing state,
 * so every subsequent tool call sees it until an operator lifts it. The reason
 * text has to do two things at once, because it is the only channel back to the
 * agent: relay why it was stopped, and tell it what to do now. Without the
 * second half a denied agent typically retries the same call in a loop.
 */
export function stopDecision(stateDir, sessionId) {
  try {
    const rec = readControl(stateDir, sessionId);
    if (!rec?.stop) return null;
    const from = rec.stop.from ? ` by ${rec.stop.from}` : '';
    return {
      permissionDecision: 'deny',
      permissionDecisionReason:
        `GLMPS: this session was STOPPED${from}. Reason: ${rec.stop.reason}. ` +
        `Do not retry and do not start new work. Summarize what you did, what state you left ` +
        `things in, and anything half-finished, then stop.`,
    };
  } catch { return null; }
}


const GATE_POLL_MIN_MS = 500;
const GATE_POLL_MAX_MS = 30_000;


/**
 * Open a gate on the server and block until it is decided or the deadline
 * passes. Every side effect is injected so this is testable with no server and
 * no real waiting.
 *
 * Fails OPEN if the server cannot be reached. That is a deliberate, documented
 * limitation: this is an operator-convenience gate, not a security boundary.
 * The real boundaries (live-install-guard, zones, poison-scan) are local and
 * static and keep working with the server down; failing closed here would mean
 * a stopped server silently bricks every running agent.
 */
export async function awaitGate({
  port, sessionId, tool, summary,
  deadlineMs = gateDeadlineMs(null),
  now = Date.now, sleep = (ms) => new Promise(r => setTimeout(r, ms)),
  fetchImpl = globalThis.fetch,
} = {}) {
  const allow = { permissionDecision: 'allow', permissionDecisionReason: null };
  const base = `http://127.0.0.1:${port}/api/control/gate`;
  let gateId = null;
  try {
    const res = await fetchImpl(base, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, tool, summary }),
    });
    gateId = (await res.json())?.id ?? null;
  } catch { return allow; }        // server unreachable: fail open
  if (!gateId) return allow;

  const started = now();
  let wait = GATE_POLL_MIN_MS;
  for (;;) {
    if (now() - started >= deadlineMs) break;
    try {
      const res = await fetchImpl(`${base}/${encodeURIComponent(gateId)}?session=${encodeURIComponent(sessionId)}`);
      const body = await res.json();
      if (body?.decision === 'approved') {
        return { permissionDecision: 'allow', permissionDecisionReason: `Approved by ${body.by ?? 'the operator'}.` };
      }
      if (body?.decision === 'denied') {
        return {
          permissionDecision: 'deny',
          permissionDecisionReason:
            `GLMPS: the operator DENIED this action${body.by ? ` (${body.by})` : ''}` +
            `${body.reason ? `: ${body.reason}` : '.'} Do not retry it. Continue with the rest of your task, ` +
            `or stop and explain what you cannot do without it.`,
        };
      }
    } catch { /* a transient poll failure must not abandon a pending gate */ }
    await sleep(wait);
    wait = Math.min(wait * 2, GATE_POLL_MAX_MS);
  }
  // Timed out. The gate record survives on the server, so a later approval makes
  // an identical retry pass immediately. Say so, or the agent treats this as a
  // permanent refusal and works around it.
  return {
    permissionDecision: 'deny',
    permissionDecisionReason:
      `GLMPS: this action needs operator approval and none arrived within ` +
      `${describeWait(deadlineMs)}. Request ${gateId} is still pending. Do something else useful ` +
      `if you can, then retry the IDENTICAL call later - once it is approved the retry goes ` +
      `straight through.`,
  };
}

// A Restart run (card glmps-2-0-170) takes the kernel down for under a minute or
// two. While its record says `restarting`, hold the tool call and then let it
// through. The ceiling stays far under the registered hook timeout (50000 s),
// because a hook that times out is cancelled and the tool runs anyway; past the
// ceiling this fails open on purpose. Read from disk: the kernel may be down.
export const MAINTENANCE_HOLD_MAX_MS = 5 * 60_000;
const MAINTENANCE_POLL_MS = 2_000;

export async function awaitMaintenance(stateDir, {
  now = Date.now, sleep = (ms) => new Promise(r => setTimeout(r, ms)),
  pollMs = MAINTENANCE_POLL_MS, maxWaitMs = MAINTENANCE_HOLD_MAX_MS,
} = {}) {
  try {
    const restarting = () => readMaintenance(stateDir, now())?.phase === 'restarting';
    if (!restarting()) return { held: false };
    const started = now();
    while (restarting()) {
      if (now() - started >= maxWaitMs) return { held: true, reason: 'timeout' };
      await sleep(pollMs);
    }
    return { held: true, reason: 'cleared' };
  } catch { return { held: false, reason: 'error' }; }
}

// CLI entry: read the PreToolUse JSON on stdin, emit a decision or context.
async function main() {
  try {
    const stateDir = resolveStateDir();
    let raw = '';
    for await (const chunk of process.stdin) raw += chunk;
    let input = {};
    try { input = JSON.parse(raw) || {}; } catch {}
    const sessionId = input.session_id || process.env.CLAUDE_SESSION_ID || null;
    const emit = (o) => process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', ...o } }));

    // 1. Stop wins over everything: a stopped session must not reach a gate or
    //    receive a steer note, both of which imply it is still working.
    const stop = stopDecision(stateDir, sessionId);
    if (stop) return emit(stop);

    // 1b. A restart in progress: wait it out, then carry on with the call.
    await awaitMaintenance(stateDir);

    // 2. Gate. The matcher is evaluated here, against the attempted action.
    const cfg = gateConfig({ stateDir: process.env.GLMPS_STATE_DIR ? stateDir : undefined });
    if (cfg.enabled) {
      const m = shouldGate({ tool: input.tool_name, toolInput: input.tool_input, cwd: input.cwd, config: cfg });
      if (m.gated) {
        const d = await awaitGate({
          port: Number(process.env.GLMPS_PORT || 8123), sessionId,
          tool: input.tool_name, summary: m.summary,
          deadlineMs: gateDeadlineMs(cfg),
        });
        if (d.permissionDecision !== 'allow') return emit(d);
        return;                     // approved: fall through and run the tool
      }
    }

    // 3. Steer note, if one is pending.
    const ctx = nextSteerContext(stateDir, sessionId, {
      gate: steerEnabled(process.env), ts: Date.now(), input,
    });
    if (ctx) emit({ additionalContext: ctx });
  } catch { /* fail open: never break tool use on a hook error */ }
}



// Run only as a CLI, not when imported by tests.
if (fileURLToPath(import.meta.url) === process.argv[1]) main();
