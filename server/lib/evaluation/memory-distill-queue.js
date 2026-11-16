import fs from 'node:fs';
import path from 'node:path';

function distillDir(stateDir) {
  return path.join(stateDir, 'memory-distill');
}

function queueFile(stateDir) {
  return path.join(distillDir(stateDir), 'queue.json');
}

function watermarkFile(stateDir) {
  return path.join(distillDir(stateDir), 'watermark.json');
}

function statusFile(stateDir) {
  return path.join(distillDir(stateDir), 'status.json');
}

// How many recent extraction errors to remember (glmps-5: surface
// distiller failures instead of silently swallowing them). Kept tiny by design.
const MAX_RECENT_ERRORS = 10;

function readJson(file, fallback) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeJson(stateDir, file, obj) {
  fs.mkdirSync(distillDir(stateDir), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

function readQueue(stateDir) {
  const q = readJson(queueFile(stateDir), []);
  return Array.isArray(q) ? q : [];
}

function writeQueue(stateDir, queue) {
  writeJson(stateDir, queueFile(stateDir), queue);
}

export function enqueue(stateDir, { sessionId, transcriptPath, cwd }) {
  const queue = readQueue(stateDir);
  if (queue.some(r => r.sessionId === sessionId)) return;
  queue.push({ sessionId, transcriptPath, cwd, ts: Date.now(), attempts: 0 });
  writeQueue(stateDir, queue);
}

export function claimNext(stateDir) {
  const queue = readQueue(stateDir);
  if (!queue.length) return null;
  const req = queue.shift();
  writeQueue(stateDir, queue);
  return req;
}

export function isQueued(stateDir, sessionId) {
  return readQueue(stateDir).some(r => r.sessionId === sessionId);
}

export function getWatermark(stateDir) {
  const w = readJson(watermarkFile(stateDir), {});
  return (w && typeof w === 'object' && !Array.isArray(w)) ? w : {};
}

export function setWatermark(stateDir, obj) {
  writeJson(stateDir, watermarkFile(stateDir), obj);
}

export function markDone(stateDir, sessionId, lineCount) {
  const w = getWatermark(stateDir);
  w[sessionId] = lineCount;
  setWatermark(stateDir, w);
}

export function markFailed(stateDir, req) {
  const attempts = (req.attempts || 0) + 1;
  if (attempts > 2) return;
  const queue = readQueue(stateDir);
  queue.push({ ...req, attempts });
  writeQueue(stateDir, queue);
}

// distinct from markFailed.
// markFailed counts toward MAX_PROCESS_RETRIES and eventually drops the
// request while advancing the watermark (mc-21 give-up) -- correct for a
// generic per-session processing exception (e.g. a permanently unreadable
// transcript), where there is no real data to lose. It is WRONG for "the
// admittable delta exists but could not be durably queued anywhere" (a
// retry-queue push failure): giving up there silently discards a real
// delta. requeueForLater puts the request back unchanged (attempts is not
// incremented, and there is no cap) so it stays pending indefinitely across
// drain calls until the retry-queue write itself starts succeeding again.
export function requeueForLater(stateDir, req) {
  const queue = readQueue(stateDir);
  queue.push({ ...req });
  writeQueue(stateDir, queue);
}

// Distillation is fail-open by design (never blocks the loop), which used to
// mean a spawn error / timeout / is_error response was indistinguishable from
// "the model legitimately found nothing durable" - both just produced [].
// This tracks ONLY actual failures (never a legitimate empty extraction) so
// they land in <stateDir>/memory-distill/status.json instead of silently
// disappearing. Kept tiny: one lastError pointer + a capped ring buffer.
// No HTTP route serves it (glmps-2-0-runtime-5 removed one nothing read).
//
// D23/D24 cutover: recordDistillSuccess and
// its lastSuccess/recentSuccesses fields (glmps-32) are dropped.
// They tracked ONLY the pre-D23 distillFn's own success signal (a real LLM
// extraction ran and returned without error); nothing calls distillFn
// anymore (Mem0 does extraction internally), so nothing could ever populate
// them again. The registered memory-admission loop (K Task 6, server/lib/
// loops/plugin-loops.js) is the actively-fed success/failure signal for the
// admission path now. This status record stays error-only,
// still useful for the genuinely orthogonal process-error case
// (drainQueue's own outer catch, e.g. an unreadable transcript).

export function readDistillStatus(stateDir) {
  const s = readJson(statusFile(stateDir), null);
  if (!s || typeof s !== 'object' || Array.isArray(s)) {
    return { lastError: null, recentErrors: [] };
  }
  return {
    lastError: s.lastError && typeof s.lastError === 'object' ? s.lastError : null,
    recentErrors: Array.isArray(s.recentErrors) ? s.recentErrors : [],
  };
}

export function recordDistillError(stateDir, { sessionId = null, reason = 'error', detail = null, ts = Date.now() } = {}) {
  const status = readDistillStatus(stateDir);
  const entry = { ts, sessionId, reason, detail };
  status.lastError = entry;
  status.recentErrors = [entry, ...status.recentErrors].slice(0, MAX_RECENT_ERRORS);
  writeJson(stateDir, statusFile(stateDir), status);
  return status;
}
