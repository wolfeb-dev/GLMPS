#!/usr/bin/env node
// SessionStart hook: the morning brief (handoff Part B, B6).
//
// The symmetric counterpart to the done-gate Stop hook. Where done-gate asks
// "is this finished", this asks "what happened while you were away": last
// nightly run result (PRs awaiting review, gates skipped, blockers), the ONE
// Big Thing from the latest weekly review, integrity findings, and how long
// since the last weekly and monthly review.
//
// Two rules from the spec, both deliberate:
//
//   * It degrades SILENTLY. If the dashboard is not running, it prints
//     nothing at all and exits 0. That is the opposite of concurrency-warn.js,
//     which shouts when its check could not run - and the difference is
//     correct. A missed concurrency check hides a hazard that can destroy
//     work, so silence there would be dangerous. A missed brief hides only
//     information, and a session that starts with "the brief did not run"
//     every time the server is down trains the operator to ignore hook output.
//
//   * Under one second. A brief is worth roughly a second of session start and
//     no more, so the fetch is hard-bounded and failure is a no-op.
//
// All the content logic lives in server/lib/observability/morning-brief.js and
// is served by GET /api/brief; this file is only transport.
import { fileURLToPath } from 'node:url';

const PORT = process.env.GLMPS_PORT || '8123';
const HTTP_TIMEOUT_MS = Number(process.env.GLMPS_BRIEF_TIMEOUT_MS) || 900;

function emit(msg) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: msg },
  }));
}

async function run() {
  if (process.env.GLMPS_MORNING_BRIEF === 'off') return;

  let data;
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/brief`, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
    if (!res.ok) return; // silent by design, see the header comment
    data = await res.json();
  } catch {
    return; // unreachable dashboard, unreadable state: say nothing
  }

  const lines = Array.isArray(data?.lines) ? data.lines.filter((l) => typeof l === 'string' && l.trim()) : [];
  if (lines.length === 0) return; // nothing worth an operator's attention

  const tail = data?.truncated ? '\n(more detail in the dashboard)' : '';
  emit(`Morning brief:\n${lines.join('\n')}${tail}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  run()
    .catch(() => { /* fail open - never block a session start */ })
    .finally(() => process.exit(0));
}
