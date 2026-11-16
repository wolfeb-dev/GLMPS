// server/lib/loops/plugin-loops.js
// Phase P's plugin work as registered loops (K3 absorbs pluginHealth): one
// health source, one alert block. The plugins do the work; a different actor
// checks it; a failure queues the work for retry and shows as a loop failure.
//
// C1 (memory.remove no longer duplicates the whole
// admission), I2 (judge.session retries go through session-judge's own
// maker/checker, not a bare re-call), I3 (never re-judge a row with a
// verdict), I5 (named per-job reasons, the run fails on any bump so the
// alert stays up for the whole outage, dead-letter restored), I6 (abort is
// honoured; an in-flight job stays leased across an abandoned tick), I7
// (maxModelCalls: null is the honest ceiling for a maker whose real model
// calls happen out-of-process and cannot be counted through ctx here).
import fs from 'node:fs';
import path from 'node:path';

const MAX_ATTEMPTS = 10;

function appendDeadLetter(file, entry) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

// Minor 4: resolves to a named outcome ('returned', 'rejected:
// <message>' or 'wait-expired') once `promise` settles or `ms` passes,
// whichever is first. Never rejects; its own timer is cleared either way.
// K Task 16 phase-end carry 2: setTimer/clearTimer are injectable (default
// the real global ones) so a caller can route this through the SAME clock a
// loop registry was built with - its own call site below passes the
// registry's own setTimer/clearTimer, so a test driving that registry with a
// fake, manually-fired clock can resolve this deterministically too, never
// depending on a real wall-clock wait.
export async function settledWithin(promise, ms, { setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let t;
  const expiry = new Promise((res) => { t = setTimer(() => res('wait-expired'), ms); t?.unref?.(); });
  try {
    return await Promise.race([
      promise.then(() => 'returned', (e) => `rejected: ${e && e.message ? e.message : String(e)}`),
      expiry,
    ]);
  } finally {
    clearTimer(t);
  }
}

export function registerPluginLoops({
  registry, retryQueue, memory, judge, gepa, gepaEveryMs = 0, deadLetterFile = null,
  pluginRetryTimeoutMs = 10 * 60_000, pluginRetryEveryMs = 5 * 60_000, admitSettleWaitMs = 30_000,
}) {
  const eventSla = { maxAgeMs: 7 * 24 * 3_600_000, obligation: false };

  registry.registerLoop({
    name: 'memory-admission', trigger: { onEvent: 'session.condensed' },
    maker: async (ctx) => ({ outcome: 'done', result: await memory.admit(ctx.payload, ctx) }),
    checker: async (result) => memory.verifyAdmitted(result),
    // maxModelCalls: 1:
    // Mem0's own extraction is exactly one model call per real add()
    // attempt, counted by the adapter itself (plugin-adapters.js's
    // realAdmit) via ctx.countModelCall() - plugin-retry's OWN re-dispatch
    // of a queued memory.admit job stays advisory (its ceiling comment,
    // below), since that ctx belongs to a different loop.
    ceiling: { maxAttempts: 1, maxModelCalls: 1, timeoutMs: 120_000 }, sla: eventSla,
    allowOverlap: true,
    // a reason prefixed "checker:" (registry.js's own
    // classify() convention) means the MAKER already returned - add()
    // already ran and, ordinarily, already succeeded - so this is a
    // post-add failure. memory.admit is never re-pushed for one: Mem0's
    // add() is not idempotent, and the checker (plugin-adapters.js's
    // verifyAdmitted) already queued whatever narrow memory.remove job the
    // failure actually calls for. Only a genuine maker failure (add()
    // itself threw, or never ran at all - embedderMissingReason,
    // memory.admit rejecting outright) reaches onFailed with an
    // unprefixed reason, and only THAT case is safe (and necessary) to
    // retry as a whole admission.
    // an EXPLICIT field (round 3: ctx.addReturned; round
    // 4: ctx.admitState.addReturned, below - plugin-adapters.js) replaces
    // the "checker:" reason-prefix heuristic, which leaked on a checker
    // TIMEOUT or any other ceiling error raised after add() already
    // succeeded (reason is plain "timeout"/"ceiling:model-calls", no
    // "checker:" prefix, so the old gate wrongly treated it as "the maker
    // never returned" and re-pushed a duplicate admission).
    // the mark now lives on ctx.admitState, the
    // adapter's per-key SHARED state, set from inside admitSession the
    // instant memory.add resolves (not when admitSession returns - it may
    // still be awaiting remove() for a poisoned fact when the ceiling
    // fires). A second caller riding the same in-flight admission shares it.
    // Minor 4: a timeout DURING add() itself is not yet proof add()
    // will never land - wait (bounded, admitSettleWaitMs) on the in-flight
    // admission first, and only re-push the whole admission if add() still
    // has not returned once that wait ends (it failed, or it is still hung).
    onFailed: async (ctx) => {
      const s = ctx.admitState;
      if (s && !s.addReturned && s.promise) await settledWithin(s.promise, admitSettleWaitMs, { setTimer: registry.setTimer, clearTimer: registry.clearTimer });
      if (s?.addReturned) return;
      retryQueue.push({ kind: 'memory.admit', ...ctx.payload });
    },
  });

  registry.registerLoop({
    name: 'session-judge', trigger: { onEvent: 'outcome.finalized' },
    // judgeSession returns early with no verdict for an empty trajectory: that is nothing-to-do, not a failure.
    // the judge's two real model calls (classify, verdict) ARE
    // countable in-process, so ctx is threaded through to the adapter,
    // which calls ctx.countModelCall() for each - a real ceiling, not advisory.
    maker: async (ctx) => {
      const r = await judge.judge(ctx.payload, ctx);
      if (r && r.judged === false) return { outcome: 'nothing-to-do' };
      return { outcome: 'done', result: { rowId: ctx.payload.row.id, ticketId: ctx.payload.ticketId ?? null, ts: (r && r.ts) ?? Date.now() } };
    },
    // glmps-2-0-39: with re-judging, a row can hold an older verdict, so the
    // one found must be the one THIS run wrote (same ts) or it proves nothing.
    checker: async ({ rowId, ts }) => {
      const v = judge.verdictFor(rowId);
      if (!v) return { ok: false, reason: `no verdict row for ${rowId}` };
      if (v.ts != null && ts != null && v.ts !== ts) return { ok: false, reason: `latest verdict for ${rowId} is not this run's (ts ${v.ts} != ${ts})` };
      return { ok: true, verifierRef: `judge:${rowId}` };
    },
    // the judge closer moves here, onto the checker-success path (a
    // different actor than the maker), instead of living inside the judge
    // adapter's own maker-side call - per the plan's own placement (K4
    // Task 11 brief, line 2579). verdictTs guards against a stale verdict
    // closing a fresher obligation for the same ticket (obligation-sweeper.js).
    onVerified: async (result, verdict, ctx) => {
      // an explicit field, set BEFORE attempting the
      // close - a verdict row already landed (the checker just passed) by
      // this point, whatever closeGateVerdict itself does next. onFailed
      // (the direct/non-suppressed dispatch path) reads this instead of
      // parsing a "publish:" prefix off the thrown reason string.
      if (ctx) ctx.verdictLanded = true;
      if (result.ticketId) await judge.closeGateVerdict({ ticketId: result.ticketId, rowId: result.rowId, verdictTs: result.ts });
    },
    ceiling: { maxAttempts: 1, maxModelCalls: 2, timeoutMs: 120_000 }, sla: eventSla,
    allowOverlap: true,
    // ctx.verdictLanded (set by onVerified above, the moment it starts -
    // the checker already passed) means only closeGateVerdict itself failed.
    // A full judge.session re-push would needlessly re-run the model on an
    // already-verified row AND get silently skipped by plugin-retry's own
    // I3 double-judge guard (verdictFor(rowId) is now truthy), leaving the
    // close never retried at all. A narrow judge.close job retries just
    // the close. (plugin-retry's own dispatch of this loop always passes
    // suppressOnFailed:true, so THIS hook only ever fires for a DIRECT,
    // non-suppressed dispatch - e.g. registry.emit('outcome.finalized', ...)
    // - production's real judge.session traffic is handled by plugin-retry's
    // own checkerPassed check on registry.runNow's returned result instead,
    // since onFailed is never even called on that path.)
    onFailed: async (ctx) => {
      const p = ctx.payload;
      if (ctx.verdictLanded) {
        retryQueue.push({ kind: 'judge.close', rowId: p.row.id, ticketId: p.ticketId ?? null });
        return;
      }
      retryQueue.push({ kind: 'judge.session', rowId: p.row.id, sessionId: p.sessionId, firstPrompt: p.firstPrompt, ticketId: p.ticketId ?? null });
    },
  });

  registry.registerLoop({
    name: 'guard-proposals', trigger: gepaEveryMs > 0 ? { everyMs: gepaEveryMs } : { onEvent: 'gepa.requested' },
    // Minor: on the scheduled trigger, the
    // FIRST run fires after gepaEveryMs too, not the generic 30s
    // bootDelayMs default - a 45-minute-ceiling, real-model-calling job has
    // no business starting 30 seconds after boot just because that is
    // registerLoop's one-size-fits-all default for an everyMs loop.
    // bootDelayMs is ignored entirely on the onEvent trigger (registry.js
    // only schedules a timer when trigger.everyMs is set).
    bootDelayMs: gepaEveryMs > 0 ? gepaEveryMs : undefined,
    maker: async () => { const r = await gepa.run(); if (!r.ok) throw new Error(r.error || 'gepa failed'); return { outcome: r.proposed.length ? 'done' : 'nothing-to-do', result: r }; },
    checker: async (r) => (r.proposed.every((p) => Array.isArray(p.sourceItemIds) && p.sourceItemIds.length) ? { ok: true } : { ok: false, reason: 'proposal without provenance' }),
    // maxModelCalls: null (I7, advisory): GEPA's own judge-model calls run
    // inside its isolated python subprocess (propose_guards.py), never
    // routed through this ctx - plugins.gepa.maxMetricCalls is passed to the
    // CLI itself (the gepa adapter, server.js) as ITS OWN internal budget,
    // just not enforceable from this side (so this loop takes no copy of it).
    ceiling: { maxAttempts: 1, maxModelCalls: null, timeoutMs: 45 * 60_000 },
    sla: gepaEveryMs > 0 ? { maxAgeMs: gepaEveryMs * 2 } : eventSla,
  });

  // a job still being worked when the WHOLE tick's own ceiling timeout
  // fires stays leased here across that abandonment - the orphaned attempt
  // (registry.js's execute() lets it keep running after giving up waiting
  // on it) still owns the job until it actually finishes, so the NEXT
  // scheduled tick's take(5) must not re-take (and double-process) it.
  const leasedJobIds = new Set();
  // Minor 5: memory.admit job ids whose add() has already
  // returned but which are not yet confirmed acked (the ack itself threw,
  // or something after add() failed). Recorded BEFORE the ack; the bump
  // path checks it, and the next tick acks such a job without ever calling
  // admit() again. In-process only: see the round-4 report's FINDINGS.
  const addReturnedJobIds = new Set();
  registry.registerLoop({
    name: 'plugin-retry', trigger: { everyMs: pluginRetryEveryMs },
    // Minor: the FIRST tick fires after
    // pluginRetryEveryMs too, matching every later one - not the generic
    // 30s bootDelayMs default, which would otherwise start draining
    // retry-queue.js sooner than the loop's own stated cadence implies.
    bootDelayMs: pluginRetryEveryMs,
    // an explicit, FLAT backoff (baseMs === maxMs, both the
    // loop's own tick interval) - never registerLoop's generic default,
    // whose 24h maxMs would otherwise let I5's own "fail on any bump" run
    // exponentially back the WHOLE queue's next tick off by as much as a
    // full day after only a handful of consecutive failures, starving
    // every OTHER queued job (not just the failing one) along with it.
    backoff: { baseMs: pluginRetryEveryMs, maxMs: pluginRetryEveryMs },
    maker: async (ctx) => {
      const before = retryQueue.size();
      // Minor: the lease filter is applied to a batch
      // LARGER than 5 before slicing down to 5, not after - taking exactly
      // 5 and THEN filtering out already-leased ones could return fewer
      // than 5 (or zero) real candidates even when 5+ unleased jobs exist
      // behind them in the queue, starving them for no reason.
      const jobs = retryQueue.take(5 + leasedJobIds.size).filter((j) => !leasedJobIds.has(j.id)).slice(0, 5);
      if (!jobs.length) return { outcome: 'nothing-to-do' };
      let acked = 0; let bumped = 0; const gaveUp = []; const failedReasons = [];
      // I2/I5a: a shutdown mid-tick (registry.stop()) must never ack a
      // judge.session job as if it had been judged - the dispatch below
      // never even reaches the judge in that case (registry.js's own
      // run() short-circuits with reason:'registry stopped' before the
      // maker is called at all). Detected via the dispatch's own outcome,
      // not ctx.signal (stop() does not abort an ALREADY-running tick's
      // AbortController - only run()'s own re-entry guard, checked fresh
      // on the NEXT runNow call, however soon that is).
      let stoppedMidTick = false;
      for (const job of jobs) {
        // stop taking on NEW jobs once aborted; whatever is already
        // leased (none yet, at this point in the loop) stays leased until
        // its own attempt actually returns.
        if (ctx.signal?.aborted) break;
        leasedJobIds.add(job.id);
        try {
          if (job.kind === 'memory.admit') {
            // once admit() has RETURNED, this job's
            // work is done - ack it unconditionally, no matter what verify
            // finds. Mem0's add() is not idempotent, so bumping this job
            // (which would re-run admit()/add() on the NEXT tick) over a
            // post-add verify failure is exactly the re-admit bug: the
            // adapter's own checker already queues whatever narrow
            // memory.remove retry a poisoned/missing fact calls for: a
            // verify failure here is reported as a named tick-level reason
            // (so the alert still surfaces it), never a reason to retry
            // THIS job again.
            // I1/minor 5: a per-JOB ctx (never the tick's shared
            // ctx, which spans up to 5 jobs) so the adapter's per-key
            // admitState - set the instant add() resolves, and shared with
            // any in-flight admission this job rides - is this job's alone
            // to read here.
            if (!addReturnedJobIds.has(job.id)) {
              const jobCtx = { signal: ctx.signal, countModelCall: ctx.countModelCall };
              let r; let admitError = null;
              try { r = await memory.admit(job, jobCtx); } catch (e) { admitError = e; }
              // add() never returned: a genuine pre-add failure, safe (and
              // necessary) to retry as a whole admission - the bump below.
              if (admitError && !jobCtx.admitState?.addReturned) throw admitError;
              addReturnedJobIds.add(job.id);
              if (admitError) {
                failedReasons.push(`memory.admit: failed after add() returned (never re-admitted): ${admitError.message || String(admitError)}`);
              } else {
                const v = await memory.verifyAdmitted(r);
                if (!v.ok) failedReasons.push(`memory.admit: verify failed after add() returned: ${v.reason}`);
              }
            }
            retryQueue.ack(job.id); acked++;
            addReturnedJobIds.delete(job.id);
            continue;
          } else if (job.kind === 'memory.remove') {
            await memory.remove(job.removeId);
          } else if (job.kind === 'judge.close') {
            // Minor: a null verdictFor is a real anomaly (a
            // judge.close job should only ever exist once a verdict has
            // landed) - a named, bumpable reason, never a silent ack.
            const v = judge.verdictFor(job.rowId);
            if (!v) throw new Error(`judge.close: no verdict found for row ${job.rowId}`);
            if (job.ticketId) await judge.closeGateVerdict({ ticketId: job.ticketId, rowId: job.rowId, verdictTs: v.ts ?? null });
          } else if (job.kind === 'judge.session') {
            // never re-run the model for a row that already has a verdict.
            // but never ack such a job WITHOUT closing
            // either. The verdict can have landed late (a maker timeout, then
            // the orphaned judge finished), or an earlier close/push failed.
            // Run the idempotent close with that verdict's own ts (the
            // judge.close behaviour) before acking; a close failure throws a
            // named reason and bumps this job for another try.
            // glmps-2-0-39: a verdict older than the card's open gate obligation
            // was written mid-run and can never close it (freshness guard), so
            // it is re-judged rather than retried. Optional call: only the
            // real adapter knows the obligation store.
            const existing = judge.verdictFor(job.rowId);
            const stale = !!existing && !!job.ticketId && !!judge.verdictStale?.({ ticketId: job.ticketId, verdictTs: existing.ts ?? null });
            if (existing && !stale) {
              if (job.ticketId) await judge.closeGateVerdict({ ticketId: job.ticketId, rowId: job.rowId, verdictTs: existing.ts ?? null });
            } else {
              // through session-judge's own maker/checker/onVerified (a
              // real different-actor check, not a bare re-call) - its own
              // onFailed is suppressed because THIS job (already durably
              // queued) is the one record of it; session-judge pushing a
              // second one would duplicate it.
              const r = await registry.runNow('session-judge', {
                row: { id: job.rowId }, sessionId: job.sessionId, firstPrompt: job.firstPrompt, ticketId: job.ticketId, rebuildEvents: true,
              }, { suppressOnFailed: true });
              if (r.outcome === 'failed') {
                // r.checkerPassed (registry.js's own
                // EXPLICIT field, not a "publish:" string parse) means the
                // verdict already landed and only the close itself failed.
                // Converting THIS job to judge.close (instead of bumping it
                // as judge.session) is what production actually runs
                // through - plugin-retry's own dispatch always suppresses
                // session-judge's onFailed, so that hook (which queues
                // judge.close on the direct/non-suppressed path) never
                // fires here at all; without this branch, the NEXT tick's
                // own I3 double-judge guard above would see the verdict
                // already exists and silently ack the job without ever
                // retrying the close.
                // push the narrow judge.close FIRST, then ack.
                // A push that throws leaves this judge.session job in place
                // (bumped by the catch below), and the next tick's guard
                // above closes it from the landed verdict - the close is
                // never lost between an ack and a failed push.
                if (r.checkerPassed) {
                  retryQueue.push({ kind: 'judge.close', rowId: job.rowId, ticketId: job.ticketId ?? null });
                  retryQueue.ack(job.id); acked++;
                  continue;
                }
                throw new Error(r.reason);
              }
              if (r.outcome === 'nothing-to-do' && r.reason) {
                // I2/I5a: the dispatch never actually ran (registry stopped
                // mid-tick, or an unexpected overlap) - this job was never
                // judged. Leave it entirely untouched (neither ack nor
                // bump - a shutdown is not the job's own fault, it must not
                // spend part of its retry budget) and stop taking on
                // further work this tick too.
                stoppedMidTick = true;
                break;
              }
            }
          } else throw new Error(`unknown job kind ${job.kind}`);
          retryQueue.ack(job.id); acked++;
        } catch (e) {
          // no bare catch - every per-job failure carries a named reason
          // into this tick's own thrown error, below.
          const reason = e && e.message ? e.message : String(e);
          if (job.kind === 'memory.admit' && addReturnedJobIds.has(job.id)) {
            // Minor 5: add() already returned for this job, so
            // bumping it (or dead-lettering it as unfinished work) would
            // re-run add() on a later tick. Leave it queued and marked; the
            // next tick acks it without re-admitting. Named, so the tick fails.
            failedReasons.push(`memory.admit: ${reason} (after add() returned; the job will be acked, never re-admitted)`);
            continue;
          }
          if ((job.attempts ?? 0) + 1 >= MAX_ATTEMPTS) {
            // restore the dead-letter write - a job that spends its
            // whole retry budget is not just dropped, it is recorded.
            const dl = deadLetterFile
              ? appendDeadLetter(deadLetterFile, { ...job, attempts: (job.attempts ?? 0) + 1, gaveUpAt: Date.now(), reason })
              : { ok: true };
            if (dl.ok) { retryQueue.ack(job.id); acked++; gaveUp.push({ kind: job.kind, reason }); }
            else { retryQueue.bump(job.id); bumped++; failedReasons.push(`${job.kind}: dead-letter write failed: ${dl.error}`); }
          } else {
            retryQueue.bump(job.id); bumped++;
            failedReasons.push(`${job.kind}: ${reason}`);
          }
        } finally {
          leasedJobIds.delete(job.id);
        }
      }
      // I2/I5a: a mid-tick stop ends the tick cleanly (not a failure - a
      // graceful shutdown is expected, not an outage) without acking or
      // bumping the job that was never actually attempted, and without the
      // queue-accounting checker below running at all (nothing-to-do skips
      // the checker in registry.js).
      if (stoppedMidTick) return { outcome: 'nothing-to-do' };
      const after = retryQueue.size();
      // the run FAILS whenever anything was bumped or gave up this tick,
      // not only once the retry budget is fully spent - the loop's own
      // failure streak (and the alert it drives) stays up for the whole
      // outage, naming every job's own reason, instead of going quiet
      // between a first failure and an eventual give-up.
      if (gaveUp.length || failedReasons.length) {
        const parts = [
          ...gaveUp.map((g) => `gave up after ${MAX_ATTEMPTS} attempts: ${g.kind} (${g.reason})`),
          ...failedReasons,
        ];
        throw new Error(parts.join('; '));
      }
      return { outcome: 'done', result: { taken: jobs.length, acked, bumped, before, after } };
    },
    // A different actor: re-querying retryQueue.size() (or an equivalent
    // count) here, rather than only re-checking the arithmetic the maker
    // already self-reported in `r`, is what actually catches a queue whose
    // size() disagrees with its own take()/ack() bookkeeping - re-validating
    // r.before/r.after alone can never catch that, since both were read
    // through the SAME (possibly lying) size() call and a constant bias
    // cancels out of any before/after comparison. take(..., { now: Infinity })
    // matches size()'s own "every job, due or not" definition (the same
    // idiom server.js's finalize sweep already uses), so a job still inside
    // its notBefore quiescence window is not mistaken for a discrepancy.
    checker: async (r) => {
      const real = retryQueue.take(Number.MAX_SAFE_INTEGER, { now: Infinity }).length;
      return (r.acked + r.bumped === r.taken && real === r.after)
        ? { ok: true }
        : { ok: false, reason: `queue accounting mismatch ${JSON.stringify(r)}, actual queue size ${real}` };
    },
    // maxModelCalls: null (I7, advisory): this loop only ever delegates
    // real model-touching work to memory.admit / session-judge, each
    // already counted (or documented as advisory) under their OWN ceiling;
    // nothing here is itself a model call to count. timeoutMs is
    // configurable (pluginRetryTimeoutMs) purely for I6's own test, which
    // needs a real, short-lived race to prove a job still in flight when
    // this bound fires stays leased for the next tick - production keeps
    // the 10-minute default.
    ceiling: { maxAttempts: 1, maxModelCalls: null, timeoutMs: pluginRetryTimeoutMs }, sla: { maxAgeMs: 30 * 60_000 },
  });
}
