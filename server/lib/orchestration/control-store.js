// server/lib/orchestration/control-store.js
// Per-session OPERATOR CONTROL record: the one place that answers "should this
// session stop?" and "is this tool call waiting on an approval?".
// One small JSON file per session under <stateDir>/control/<id>.json, atomic
// tmp+rename (mirrors workspace-store.js and runner-store.js).
//
// WRITER DISCIPLINE, load-bearing: the SERVER is the only writer of this file.
// The PreToolUse hook that consumes it runs inside the agent's own process, so
// letting the hook write here too would be a read-modify-write race across
// processes - the same lost-update defect the SCUT review found in
// settings.saveSettings. The hook therefore POSTs to 127.0.0.1 and lets the
// single server process serialize every mutation.
//
// Why a record and not a signal: launchSession returns pid: null for every
// target except native-terminal, so there is no process to signal. A record the
// already-registered global PreToolUse hook reads is the only mechanism that
// reaches every launched session.
import fs from 'node:fs';
import path from 'node:path';

const dir = (stateDir) => path.join(stateDir, 'control');
// Same flattening as workspace-store: a session id is used as a filename, so
// separators must never survive into the path or a crafted id could write
// outside the control dir.
const fileFor = (stateDir, id) => path.join(dir(stateDir), `${String(id).replace(/[\\/:]/g, '-')}.json`);

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return fallback; }
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

// gateWaitMs: running total of time this session has spent BLOCKED on approval
// gates, banked as each one is decided. The queue runner subtracts it so a
// waiting job is not mistaken for a runaway one.
const blank = (sessionId) => ({ sessionId, updatedTs: 0, stop: null, gate: null, gateWaitMs: 0 });

/** The control record for a session, or null if it has never had one. */
export function readControl(stateDir, sessionId) {
  if (!sessionId) return null;
  return readJson(fileFor(stateDir, sessionId), null);
}

function mutate(stateDir, sessionId, fn) {
  const rec = readControl(stateDir, sessionId) ?? blank(sessionId);
  const out = fn(rec);
  if (out === null) return null;               // caller rejected the mutation
  rec.updatedTs = Math.max(Number(rec.updatedTs) || 0, Number(rec.stop?.ts) || 0, Number(rec.gate?.decidedTs) || 0, Number(rec.gate?.requestedTs) || 0);
  writeJson(fileFor(stateDir, sessionId), rec);
  return rec;
}

/**
 * Halt this session. A stop is STANDING state, not a one-shot note: it is read
 * on every subsequent tool call and is never auto-consumed, because the point is
 * that the agent cannot act again until an operator lifts it.
 */
export function setStop(stateDir, sessionId, { reason, from, ts } = {}) {
  return mutate(stateDir, sessionId, (rec) => {
    rec.stop = { reason: String(reason ?? 'stopped by the operator'), from: from ?? null, ts: Number(ts) || 0 };
  });
}

/** Lift a stop, letting the session act again. */
export function clearStop(stateDir, sessionId) {
  return mutate(stateDir, sessionId, (rec) => { rec.stop = null; });
}

/** Record a tool call waiting on operator approval. Replaces any prior gate. */
export function openGate(stateDir, sessionId, { id, tool, summary, ts } = {}) {
  return mutate(stateDir, sessionId, (rec) => {
    rec.gate = {
      id: String(id), tool: tool ?? null, summary: String(summary ?? ''),
      requestedTs: Number(ts) || 0, decision: 'pending',
      decidedBy: null, decidedTs: null, reason: null,
    };
  });
}

/**
 * Resolve a gate. Returns null (and writes nothing) unless `id` names the
 * CURRENTLY PENDING gate.
 *
 * Both guards matter. Matching on the id stops a slow answer to an earlier,
 * harmless request from releasing a different and possibly riskier one the
 * session has since reached. Refusing an already-decided gate makes the
 * decision idempotent, so a double-click or a retried Slack delivery cannot
 * flip a denial into an approval.
 */
export function decideGate(stateDir, sessionId, id, { decision, by, reason, ts } = {}) {
  return mutate(stateDir, sessionId, (rec) => {
    if (rec.gate?.id !== String(id) || rec.gate.decision !== 'pending') return null;
    rec.gate.decision = decision === 'approved' ? 'approved' : 'denied';
    rec.gate.decidedBy = by ?? null;
    rec.gate.decidedTs = Number(ts) || 0;
    rec.gate.reason = reason ?? null;
    // Bank the wait. A job blocked on a gate is not a runaway job, but the queue
    // runner's maxRuntimeMs only sees wall clock since launch, so without this
    // every gated job would trip the 30-minute overrun and be requeued while its
    // agent is alive and merely waiting. A DENIAL banks time too: the job spent
    // it either way. Only a real decision banks, so the refused double-decision
    // guarded above adds nothing.
    const waited = (Number(ts) || 0) - (Number(rec.gate.requestedTs) || 0);
    if (waited > 0) rec.gateWaitMs = (Number(rec.gateWaitMs) || 0) + waited;
  });
}

/** Which of these sessions holds `gateId`, if any. */
export function findGate(stateDir, sessionIds, gateId) {
  for (const sessionId of sessionIds ?? []) {
    const rec = readControl(stateDir, sessionId);
    if (rec?.gate?.id === String(gateId)) return { sessionId, gate: rec.gate };
  }
  return null;
}
