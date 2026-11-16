// server/lib/orchestration/workspace-store.js
// Zero-dep functional store for the per-session agent workspace object.
// One small JSON file per session under <stateDir>/workspace/<id>.json,
// atomic tmp+rename (mirrors runner-store.js). Selectivity: ~5 declared
// slots + observed summary + one divergence verdict + one steer slot.
import fs from 'node:fs';
import path from 'node:path';

const dir = (stateDir) => path.join(stateDir, 'workspace');
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

function blank(sessionId) {
  return { sessionId, updatedTs: 0, declared: null, observed: null, divergence: null, steer: null };
}

export function readWorkspace(stateDir, sessionId) {
  return readJson(fileFor(stateDir, sessionId), null);
}

// glmps-100: coerce each ts to a number before Math.max. A pre-existing
// workspace file with a STRING ts (e.g. declared.ts written before the
// numeric-nowTs fix in d756519) would otherwise poison Math.max into
// NaN -> a NaN updatedTs that JSON-serializes to null. String ISO ts parse to
// epoch ms; anything non-finite degrades to 0.
const numTs = (t) => (typeof t === 'string' ? (Date.parse(t) || 0) : (Number.isFinite(t) ? t : 0));

function mutate(stateDir, sessionId, fn) {
  const ws = readWorkspace(stateDir, sessionId) ?? blank(sessionId);
  fn(ws);
  ws.updatedTs = Math.max(numTs(ws.updatedTs), numTs(ws.declared?.ts), numTs(ws.observed?.ts), numTs(ws.divergence?.ts), numTs(ws.steer?.ts));
  writeJson(fileFor(stateDir, sessionId), ws);
  return ws;
}

export function writeDeclared(stateDir, sessionId, delta) {
  return mutate(stateDir, sessionId, (ws) => {
    const cur = ws.declared ?? { goal: '', hypothesis: null, concepts: [], blockedOn: null, nextStep: null, ts: 0 };
    const merged = { ...cur, ...delta };
    if (Array.isArray(merged.concepts)) merged.concepts = merged.concepts.slice(0, 5);
    ws.declared = merged;
  });
}

export function writeObserved(stateDir, sessionId, observed) {
  return mutate(stateDir, sessionId, (ws) => { ws.observed = observed; });
}

export function writeDivergence(stateDir, sessionId, divergence) {
  return mutate(stateDir, sessionId, (ws) => { ws.divergence = divergence; });
}

export function writeSteer(stateDir, sessionId, { note, from, ts }) {
  return mutate(stateDir, sessionId, (ws) => { ws.steer = { note: String(note ?? ""), from: from ?? null, ts: ts ?? 0, consumedTs: null, deliveries: 0, lastDeliveredTs: null }; });
}

// How many times a steer note is handed out before it is retired, and how old
// it may get first.
//
// glmps-74: consumeSteer used to retire the note on the FIRST read.
// Subagents inherit their parent's session_id, so a subagent's PreToolUse hook
// read and consumed steers addressed to the MAIN session - whichever process
// made a tool call first won the race. Observed 2026-08-21: an operator note
// consumed 4.3 seconds after it arrived, by a subagent that had no way to know
// it was legitimate and correctly refused it. The operator's instruction was
// simply lost, and this had been happening for weeks.
//
// There is no reliable way for the hook to tell a subagent from its parent, so
// this does not try. Handing the note out a few times means a subagent eating
// one delivery no longer costs the operator the message. Bounded, because an
// unbounded redelivery would nag; time-limited, because re-injecting an
// hours-old instruction into a session that has moved on is worse than
// dropping it - by then the operator has almost certainly re-asked.
export const STEER_MAX_DELIVERIES = 3;
export const STEER_MAX_AGE_MS = 30 * 60_000;
// Minimum gap between deliveries. Found by running the real experiment rather
// than reasoning about it: with routing fixed the orchestrator is the only
// consumer, and three tool calls in quick succession burned all three
// deliveries and showed the operator the same note three times in a row.
// Redelivery exists to survive a MISSED delivery, not to repeat a delivered
// one, so a burst gets it once and the retries are spread out behind it.
export const STEER_REDELIVER_AFTER_MS = 90_000;

export function consumeSteer(stateDir, sessionId, ts) {
  const ws = readWorkspace(stateDir, sessionId);
  if (!ws?.steer || ws.steer.consumedTs != null) return null;

  const sentAt = Number.isFinite(ws.steer.ts) ? ws.steer.ts : null;
  const delivered = Number.isFinite(ws.steer.deliveries) ? ws.steer.deliveries : 0;
  // Staleness applies ONLY to a note that has actually been delivered at least
  // once. The rule exists because re-injecting an hours-old instruction into a
  // session that has moved on is worse than dropping it - but that reasoning is
  // about a note somebody already ACTED on. A note nobody has ever seen is not
  // out of date, it is unread, and retiring it is exactly the message loss this
  // whole area exists to prevent.
  //
  // Caught in production hours after the staleness rule shipped: an operator
  // note sat 164 minutes with deliveries:0 (the session had signed off, so
  // nothing polled) and the first poll afterwards retired it unread.
  const stale = delivered > 0
    && sentAt != null && Number.isFinite(ts) && (ts - sentAt) > STEER_MAX_AGE_MS;

  if (stale) {
    // Retire it rather than leaving it pending forever, so a dangling note
    // cannot resurface days later.
    mutate(stateDir, sessionId, (w) => { w.steer.consumedTs = ts; });
    return null;
  }

  const lastAt = Number.isFinite(ws.steer.lastDeliveredTs) ? ws.steer.lastDeliveredTs : null;
  if (lastAt != null && Number.isFinite(ts) && (ts - lastAt) < STEER_REDELIVER_AFTER_MS) return null;

  const steer = { ...ws.steer };
  const next = delivered + 1;
  const last = next >= STEER_MAX_DELIVERIES;
  mutate(stateDir, sessionId, (w) => {
    w.steer.deliveries = next;
    w.steer.lastDeliveredTs = ts;
    if (last) w.steer.consumedTs = ts;
  });
  return { ...steer, deliveries: next, consumedTs: last ? ts : null };
}

export function listWorkspaces(stateDir, ids) {
  const out = [];
  for (const id of ids) { const ws = readWorkspace(stateDir, id); if (ws) out.push(ws); }
  return out;
}
