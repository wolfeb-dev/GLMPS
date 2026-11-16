// server/lib/evaluation/memory-distill-worker.js
//
// Serial background worker: drains the distiller queue one request at a time
// (single-threaded keeps the memory dir writes race-free). Per request: read
// the transcript DELTA since the watermark, condense it, and admit it via
// the Mem0 plugin (server/lib/plugins/memory-plugin.js). Fail-open per item:
// a bad session is marked failed (retry-capped) and never stalls the queue.
//
// D23/D24 cutover (glmps-159 task 6): the pre-D23 distillFn + classifyFact +
// writeDistilledFact pipeline (LLM extraction -> confidence/dedup gate -> L3
// pool file) is retired. Mem0's own `add({ infer: true })` does extraction
// and dedup internally against the project's own vector store; there is no
// local memory-index/lexical-dedup bookkeeping left for this worker to do.
//
// K Task 6: this worker no longer calls admitSession directly, or manages a
// retryQueue/health tracker of its own. It condenses the transcript delta and
// emits 'session.condensed' (deps.emit -> loopRegistry.emit, server.js); the
// registered memory-admission loop (server/lib/loops/plugin-loops.js) does
// the admission, checks it with a different actor, and queues its own retry
// on failure. emit() never rejects (registry.js), so markDone always runs
// after it resolves, whatever the loop's own outcome was.
import fs from 'node:fs';
import path from 'node:path';
import { condenseTranscript } from './memory-distill-core.js';
import {
  claimNext, markDone, markFailed, getWatermark, recordDistillError, requeueForLater,
} from './memory-distill-queue.js';
import { projectSlugFor } from '../plugins/memory-plugin.js';

const CONDENSE_MAX_BYTES = 60000;

// glmps-21: a per-session processing EXCEPTION (e.g. an unreadable
// transcript -- thrown before admission is ever attempted) gets one retry
// before drainQueue gives up and advances the watermark forward rather than
// leaving it stuck (see drainQueue's catch below). This is orthogonal to
// admitSession's own throw/retry handling, which processRequest itself
// catches and routes to retryQueue instead.
const MAX_PROCESS_RETRIES = 2;

// Best-effort re-read at give-up time, matching the sweeper's own
// countFileLines: catch-and-default-to-0 rather than let a still-broken
// transcript throw again here.
function bestEffortLineCount(transcriptPath) {
  try { return fs.readFileSync(transcriptPath, 'utf8').split('\n').filter(Boolean).length; }
  catch { return 0; }
}

export async function processRequest(req, { stateDir, cfg, emit }) {
  const memoryDir = path.join(path.dirname(req.transcriptPath), 'memory');
  const raw = fs.readFileSync(req.transcriptPath, 'utf8'); // throws -> caught by drainQueue
  const allLines = raw.split('\n').filter(Boolean);
  const lineCount = allLines.length;

  const wm = getWatermark(stateDir);
  const start = wm[req.sessionId] || 0;
  const condensed = condenseTranscript(allLines.slice(start), { maxBytes: CONDENSE_MAX_BYTES });

  // Cheap skip: too little new material to be worth admitting. Advance the
  // watermark anyway so we do not re-scan the same delta forever.
  if (Buffer.byteLength(condensed) < cfg.minTranscriptBytes) {
    markDone(stateDir, req.sessionId, lineCount);
    return { skipped: true, admitted: null };
  }

  // The project slug is read off the transcript's own directory name, not
  // recomputed: Claude Code already wrote it there (see
  // memory-plugin.js#projectSlugFor and memory-distill-sweeper.js's
  // sanitizeRoot, which verifies the same convention).
  const project = projectSlugFor(memoryDir);
  // K Task 6: the registered memory-admission loop does the admission, the
  // checking, and (on failure) its own retry-queue push - this worker only
  // ever has to hand the delta over and record that it did. emit() (registry.
  // js) resolves an array of loop outcomes and never rejects.
  //
  // markDone must NOT run when the delta was never
  // durably handed off anywhere - two distinct cases, both marked
  // retryQueueUnavailable so drainQueue's own catch (below) leaves the
  // request pending for a later drain instead of advancing the watermark
  // past data that genuinely still needs a retry:
  //   - the registry itself is stopped (emit's own 'nothing-to-do'/
  //     'registry stopped', server.js shutting down mid-drain) - the event
  //     was never even attempted.
  //   - the loop ran, failed, AND its own onFailed queueing (the retry-queue
  //     push that is supposed to make this retryable later) also failed -
  //     registry.js reports that as the explicit onFailedError field (Phase
  //     K final review minor: no longer parsed out of the reason text).
  // Phase K final review minor: EVERY outcome is read, not just the first:
  // any one loop on this event that was stopped, or whose onFailed queueing
  // failed, means the delta is not durably handed off.
  const outcomes = await emit('session.condensed', { sessionId: req.sessionId, project, condensed });
  // no outcome at all (emit() returned an empty
  // array - no loop registered for this event) is not a success either; the
  // delta was never durably handed off anywhere, so it must not fall
  // through to markDone.
  if (!Array.isArray(outcomes) || outcomes.length === 0) {
    throw Object.assign(new Error('no loop handled session.condensed'), { retryQueueUnavailable: true });
  }
  for (const outcome of outcomes) {
    if (outcome?.outcome === 'nothing-to-do' && outcome.reason === 'registry stopped') {
      throw Object.assign(new Error('registry stopped'), { retryQueueUnavailable: true });
    }
    if (outcome?.outcome === 'failed' && outcome.onFailedError !== undefined) {
      throw Object.assign(new Error(outcome.reason || `onFailed: ${outcome.onFailedError}`), { retryQueueUnavailable: true });
    }
  }
  markDone(stateDir, req.sessionId, lineCount);
  return { skipped: false, admitted: outcomes[0]?.result ?? null };
}

let draining = false;

/**
 * Drain the whole queue serially. Re-entrant guard: a concurrent call (ping +
 * interval firing together) returns immediately rather than running in parallel.
 */
export async function drainQueue(deps) {
  if (draining) return { processed: 0, busy: true };
  draining = true;
  let processed = 0;
  // sessionIds already
  // requeued-for-later within THIS call. requeueForLater appends to the
  // tail of the same on-disk queue claimNext reads from, so without this
  // guard the while loop below would immediately reclaim the very request
  // it just deferred (an infinite loop when it is the only pending item, or
  // pointless repeated retries against a retry-queue that is not going to
  // start working again mid-tick anyway). Seeing a sessionId a second time
  // means every other pending request has already been tried this call
  // (FIFO claim + append-to-tail), so it is put back once more and the
  // drain ends here, leaving it for the NEXT external drainQueue() call.
  const deferredThisRun = new Set();
  try {
    let req;
    while ((req = claimNext(deps.stateDir))) {
      if (deferredThisRun.has(req.sessionId)) {
        requeueForLater(deps.stateDir, req);
        break;
      }
      try { await processRequest(req, deps); processed++; }
      catch (err) {
        // processRequest itself never touches a
        // retryQueue directly any more, but it DOES throw this way when
        // emit()'s own outcome shows the delta was never durably handed off
        // anywhere (the registry stopped mid-drain, or the loop's own
        // onFailed queueing failed) - the delta is still genuinely
        // admittable (the transcript read fine), just not durably queued,
        // which is not the "give up, nothing to lose" case mc-21 below
        // handles - leaving it pending for a later drain instead of
        // markFailed's attempt cap or markDone ever running on it.
        if (err && err.retryQueueUnavailable) {
          deferredThisRun.add(req.sessionId);
          requeueForLater(deps.stateDir, req);
          continue;
        }
        recordDistillError(deps.stateDir, {
          sessionId: req.sessionId, reason: 'process-error',
          detail: err && err.message ? err.message : String(err),
          ts: deps.nowMs ?? Date.now(),
        });
        // glmps-21: give up at the same attempt count markFailed's
        // own cap would, but advance the watermark instead of leaving it
        // stuck (see comment on MAX_PROCESS_RETRIES above).
        if ((req.attempts || 0) < MAX_PROCESS_RETRIES) {
          markFailed(deps.stateDir, req);
        } else {
          // Advance FORWARD only. markDone SETS the watermark (w[sid] = lineCount),
          // so a give-up while the transcript is transiently unreadable
          // (bestEffortLineCount -> 0) would otherwise REGRESS a prior successful
          // admission's watermark to 0, re-processing already-admitted lines once
          // the file becomes readable again. max() with the current watermark
          // keeps give-up monotonic; the permanently-unreadable case (prior 0)
          // still lands at 0, matching the sweeper's own 0-count read.
          const prior = getWatermark(deps.stateDir)[req.sessionId] || 0;
          markDone(deps.stateDir, req.sessionId, Math.max(prior, bestEffortLineCount(req.transcriptPath)));
        }
      }
    }
  } finally {
    draining = false;
  }
  return { processed };
}
