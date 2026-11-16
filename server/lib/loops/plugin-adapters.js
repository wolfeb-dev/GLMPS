// server/lib/loops/plugin-adapters.js
// the memory/judge/gepa adapters registerPluginLoops
// drives, extracted out of server.js into their own factory functions so
// they are directly unit-testable against fakes for admitSession, judgeSession
// and runGepa's real underlying shapes - not just against the loop-level
// { written: [...] } stand-ins plugin-loops.test.js uses for the loop
// contract itself.
import crypto from 'node:crypto';
import { admitSession, isFlagged } from '../plugins/memory-plugin.js';
import { judgeSession, eventsToTrajectory, readVerdicts } from '../plugins/judge-plugin.js';
import { closeGateVerdict, isGateVerdictStale } from '../kernel/obligation-sweeper.js';
import { isPromptEvent } from '../evaluation/outcome-metrics.js';
import { tsToMs } from '../observability/event-log.js';

//
// verify by re-scanning AND re-searching each written fact
// against ITS OWN text - never one shared search keyed only on written[0].
// A single query scoped to the first fact's text is blind to any OTHER
// fact that is not semantically close to it (round 2 probe: a fact about
// "operator prefers tabs" is invisible to a search for "CI runs on
// Windows"), which is a false negative that used to fail the checker (and,
// before the C1 fix below, re-admit) over a fact that was actually fine.
//
// once add() has returned, memory.admit is NEVER
// re-pushed - not from here, not from onFailed (plugin-loops.js), not from
// plugin-retry's own memory.admit branch. Mem0's add() is not idempotent,
// so retrying the whole (non-idempotent) condensed text after it already
// landed would duplicate every already-written fact. A written fact this
// checker finds still poisoned (or the fact admitSession itself already
// flagged and is retrying removal for, via pendingRemovals) is handled by
// queuing ONLY a narrow memory.remove job, deduped against whatever the
// queue already holds - never by failing in a way that triggers a
// re-admit. A fact search cannot find is a named miss (the checker's own
// `ok:false` reason, visible as the memory-admission loop's own failure),
// not a re-admit trigger either.
//
// the in-flight dedupe key is sessionId PLUS a hash of the
// condensed text, not sessionId alone - two genuinely different deltas for
// the SAME session (e.g. two condense pings before the first admission
// finishes) must both reach memory.add(), never collapse the second one
// onto the first's in-flight promise and silently drop its content.
//
// embedderMissingReason (set once at boot when the embed model is
// missing/unreadable) makes EVERY admission attempt fail cleanly while it
// stays true, keeping the memory-admission loop's own failure streak (and
// alert) up continuously - a no-op/empty admission must not silently clear
// it.
//
// the add-returned mark is a per-key SHARED state
// object ({ addReturned, promise }), one per in-flight dedupe key, set from
// INSIDE admitSession (its onAddReturned hook) the instant memory.add
// resolves - not when admitSession itself returns, which can be much later
// (it still awaits remove() for any poisoned fact, and a ceiling timeout can
// fire in that window). Every caller of admit() for that key, including a
// second caller riding the in-flight promise, gets the SAME object on its
// own ctx (ctx.admitState), so onFailed and plugin-retry read one source of
// truth. `promise` lets onFailed wait (bounded) for an add() still in flight
// before it decides whether a whole re-admission is needed (minor 4).
export function createMemoryAdapter({ memoryPlugin, scan, stateDir, retryQueue, embedderMissingReason = null, log = console.error }) {
  const inFlight = new Map(); // "sessionId:hash(condensed)" -> { addReturned, promise }

  function inFlightKey(payload) {
    const hash = crypto.createHash('sha256').update(String(payload.condensed ?? '')).digest('hex');
    return `${payload.sessionId}:${hash}`;
  }

  async function realAdmit(payload, ctx, state) {
    if (embedderMissingReason) throw new Error(embedderMissingReason);
    // an EXPLICIT field, never a reason-string
    // heuristic. Round 4 moves the moment it is set from "admitSession
    // returned" to "memory.add resolved" (onAddReturned), and onto the
    // shared per-key state rather than this one caller's ctx alone.
    const result = await admitSession({
      memory: memoryPlugin, sessionId: payload.sessionId, project: payload.project, condensed: payload.condensed,
      scan, stateDir, signal: ctx?.signal ?? null, onAddReturned: () => { state.addReturned = true; },
    });
    // Minor: the one real Mem0 extraction call is counted
    // from admitSession's own authoritative addCalled report, not a second,
    // separately-maintained copy of its two early-return gates (a poison-
    // blocked transcript, an empty message list) that could silently drift
    // from the real logic.
    if (result.addCalled) ctx?.countModelCall?.();
    // only ids CONFIRMED queued (the push itself did
    // not throw) are ever treated as "already being remediated" - a push
    // failure must never be swallowed by a log-only catch, since that would
    // let a still-live poisoned fact pass verifyAdmitted silently (nothing
    // left to flag it: not re-scanned, because pendingRemovals already
    // named it; not actually queued for removal either). Reported here only
    // as a log; the checker (verifyAdmitted, below) is what makes a push
    // failure a real, named, visible failure - not this fire-and-forget path.
    const queuedRemovals = [];
    for (const id of result.pendingRemovals || []) {
      const q = queueRemoval(id);
      if (q.ok) queuedRemovals.push(id);
      else log('[loops] memory.remove enqueue failed', id, q.reason);
    }
    return { ...result, project: payload.project, queuedRemovals };
  }

  // C1/I2: a narrow memory.remove job for `id`, deduped against whatever the
  // retry queue already holds - never a second push for the same fact.
  // Feature-detects `.take` so a minimal test double (push-only) never
  // throws; the real retry-queue.js (and every committed test) has it.
  // Returns whether the push actually landed (I2: a caller must be able to
  // tell a confirmed queue from a swallowed failure).
  function queueRemoval(id) {
    const already = typeof retryQueue.take === 'function'
      && retryQueue.take(Number.MAX_SAFE_INTEGER, { now: Infinity }).some((j) => j.kind === 'memory.remove' && j.removeId === id);
    if (already) return { ok: true };
    try { retryQueue.push({ kind: 'memory.remove', removeId: id }); return { ok: true }; }
    catch (e) { return { ok: false, reason: e && e.message ? e.message : String(e) }; }
  }

  return {
    admit(payload, ctx) {
      const key = inFlightKey(payload);
      const existing = inFlight.get(key);
      if (existing) {
        // a retry of the SAME session+text already in flight rides the
        // SAME attempt, never a duplicate. I1: it also shares that
        // attempt's add-returned state.
        if (ctx) ctx.admitState = existing;
        return existing.promise;
      }
      const state = { addReturned: false, promise: null };
      if (ctx) ctx.admitState = state;
      state.promise = realAdmit(payload, ctx, state).finally(() => { if (inFlight.get(key) === state) inFlight.delete(key); });
      inFlight.set(key, state);
      return state.promise;
    },
    remove(id) { return memoryPlugin.remove({ id }); },
    async verifyAdmitted(result) {
      // skip only ids CONFIRMED queued for removal
      // (result.queuedRemovals, set by realAdmit above only when the push
      // itself succeeded) - never the wider result.pendingRemovals, which
      // admitSession reports regardless of whether the queue push landed.
      // A fact admitSession flagged but could NOT get queued is still live,
      // unremediated, and must not pass silently.
      const queuedIds = new Set(result.queuedRemovals || []);
      const pendingIds = new Set(result.pendingRemovals || []);
      const live = (result.written || []).filter((w) => !queuedIds.has(w.id));
      for (const w of live) {
        const knownPoisoned = pendingIds.has(w.id);
        const factScan = knownPoisoned ? null : scan(String(w.memory || ''));
        if (knownPoisoned || isFlagged(factScan)) {
          // A poisoned fact already known (its own queue push failed, I2) or
          // one the checker's OWN re-scan caught that admitSession's scan
          // did not already flag (defensive - should not happen with the
          // same scan function, but never a re-admit trigger either way).
          const q = queueRemoval(w.id);
          if (!q.ok) return { ok: false, reason: `memory.remove for ${w.id} could not be queued: ${q.reason}` };
          return { ok: false, reason: 'poisoned fact admitted' };
        }
      }
      if (live.length && result.project) {
        // each fact is verified by searching for ITS OWN text, never
        // one shared query scoped to written[0] alone.
        try {
          const missing = [];
          for (const w of live) {
            const found = await memoryPlugin.search({ project: result.project, query: w.memory, k: Math.max(5, live.length) });
            if (!(found.results || []).some((r) => r.id === w.id)) missing.push(w.id);
          }
          if (missing.length) return { ok: false, reason: `search did not find ${missing.length} admitted fact(s)` };
        } catch (e) {
          return { ok: false, reason: `search verification failed: ${e && e.message ? e.message : String(e)}` };
        }
      }
      return { ok: true };
    },
  };
}

//
// the judge's two real model calls (classify, verdict) are countable
// in-process - ctx.countModelCall() is called exactly twice whenever
// judgeSession is actually going to make them (a non-empty trajectory;
// judgeSession's own no-events short-circuit never reaches the model at
// all, so nothing is counted for that case either).
//
// the judge closer (closeGateVerdict) is NOT called from here any more
// - it lives on session-judge's own onVerified (checker-success) path,
// plugin-loops.js. closeGateVerdict is still exposed on this adapter object
// so plugin-loops.js's onVerified hook can reach it without importing the
// kernel obligation module itself.
export function createJudgeAdapter({ judgePlugin, stateDir, appendDevlog, eventLog, readEvents, obligationStore }) {
  return {
    async judge(payload, ctx) {
      const events = payload.rebuildEvents
        ? readEvents(stateDir, { sessionId: payload.sessionId })
        : (eventLog.get(payload.sessionId) || []);
      if (ctx && eventsToTrajectory(events).length) { ctx.countModelCall(); ctx.countModelCall(); }
      // closer freshness (closeGateVerdict's verdictTs
      // guard, obligation-sweeper.js) uses the judged SESSION's own end time
      // (its last event's own ts), normalized through tsToMs - real events
      // carry `ts` as an ISO-8601 string, and comparing an un-normalized
      // string against a numeric openedTs coerces to NaN, which is never
      // less than anything, silently disabling the guard (every verdict,
      // however stale, would close). ONE ts source feeds BOTH the close
      // attempted right here (via onVerified, result.ts) and a later retry
      // (judge.close, which rereads the SAME verdict row back off disk) by
      // passing this as judgeSession's own `now` - the verdict file's
      // record.ts and this adapter's returned ts are then the exact same
      // value, not two independently-computed timestamps.
      const lastEventMs = events.length ? tsToMs(events[events.length - 1].ts) : null;
      const closeTs = () => lastEventMs ?? Date.now();
      const result = await judgeSession({
        // A reconciled job has no firstPrompt (it was never finalized here).
        judge: judgePlugin, stateDir, row: payload.row, events, firstPrompt: payload.firstPrompt || (events.find(isPromptEvent) || {}).label || '',
        ticketId: payload.ticketId ?? null, appendDevlog, now: closeTs,
      });
      return result.skipped ? { judged: false } : { judged: true, ts: closeTs() };
    },
    // The file is append-only and a stale row is re-judged, so the latest
    // verdict for a row is the authoritative one.
    verdictFor(rowId) {
      const all = readVerdicts(stateDir).filter((v) => v.rowId === rowId);
      return all.length ? all[all.length - 1] : null;
    },
    closeGateVerdict(args) {
      return closeGateVerdict({ store: obligationStore, ...args });
    },
    verdictStale(args) {
      return isGateVerdictStale({ store: obligationStore, ...args });
    },
  };
}

//
// Minor: compares runGepa's own reported
// `proposed` count against what actually landed in the learning queue
// (touched.length), failing when the CLI claims proposals but none of them
// stuck - a real discrepancy the checker's own provenance check alone
// cannot see (it only inspects the proposals THIS run reports, never
// cross-checks that count against reality). `touched` itself only ever
// counts items with a non-empty derivedFrom - an operator's own edit to an
// existing gepa-sourced item (which also bumps updatedTs) is never
// mistaken for a fresh GEPA touch.
export function createGepaAdapter({ runGepa, runGepaArgs, learningStore, stateDir }) {
  return {
    async run() {
      const beforeMap = new Map(
        learningStore.load(stateDir).items.filter((i) => i.source === 'gepa').map((i) => [i.id, i.updatedTs]),
      );
      const r = await runGepa(runGepaArgs());
      if (r.error === 'no-failures') return { ok: true, proposed: [] };
      if (!r.ok) return { ok: false, error: r.error || 'gepa-failed' };
      const after = learningStore.load(stateDir).items.filter((i) => i.source === 'gepa');
      const touched = after.filter((i) => beforeMap.get(i.id) !== i.updatedTs && Array.isArray(i.derivedFrom) && i.derivedFrom.length);
      if (r.proposed > 0 && touched.length === 0) {
        return { ok: false, error: `gepa proposed ${r.proposed} rule(s) but none landed in the learning queue` };
      }
      return { ok: true, proposed: touched.map((i) => ({ sourceItemIds: i.derivedFrom })) };
    },
  };
}
