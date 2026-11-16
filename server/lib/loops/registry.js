// The loop registry: the program's section 0 loop contract, made real. Every
// scheduled job the kernel owns is registered here. A run is maker then a
// separate checker; the outcome is exactly one of done, nothing-to-do or
// failed:<reason>; a ceiling bounds attempts, model calls and wall-clock; a
// failure backs off; the third consecutive failure fires onStreak once.
import fs from 'node:fs';
import path from 'node:path';
import { LOOP_ABOUT } from './loop-about.js';

export class CeilingError extends Error {
  constructor(message) { super(message); this.name = 'CeilingError'; }
}

const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const OK_OUTCOMES = new Set(['done', 'nothing-to-do']);
const STREAK_AT = 3;
const BOOT_FLOOR_MS = 30_000;

function validate(spec, loops) {
  const s = spec || {};
  if (!NAME_RE.test(String(s.name || ''))) throw new TypeError(`loop name must be kebab-case: ${s.name}`);
  if (loops.has(s.name)) throw new TypeError(`loop already registered: ${s.name}`);
  const t = s.trigger || {};
  const kinds = ['everyMs', 'onEvent', 'external'].filter((k) => t[k] !== undefined);
  if (kinds.length !== 1) throw new TypeError(`loop ${s.name}: trigger needs exactly one of everyMs, onEvent, external`);
  if (typeof s.maker !== 'function' || typeof s.checker !== 'function') throw new TypeError(`loop ${s.name}: maker and checker are functions`);
  if (s.maker === s.checker) throw new TypeError(`loop ${s.name}: checker must differ from maker`);
  const c = s.ceiling;
  // maxModelCalls: null means "advisory, not
  // enforced" - for a maker whose model calls happen out-of-process (Mem0's
  // own internal extraction, GEPA's python subprocess) and so cannot be
  // counted through ctx.countModelCall() at all. A bare `null >= 0` is true
  // in JS, so this is checked explicitly rather than relying on that
  // coercion to mean the same thing.
  if (!c || !(c.maxAttempts >= 1) || !(c.maxModelCalls === null || c.maxModelCalls >= 0) || !(c.timeoutMs > 0)) throw new TypeError(`loop ${s.name}: ceiling { maxAttempts, maxModelCalls, timeoutMs } required`);
  if (!s.sla || !(s.sla.maxAgeMs > 0 || (s.sla.maxAgeMs === null && s.sla.obligation === false))) throw new TypeError(`loop ${s.name}: sla { maxAgeMs } required (null only with obligation: false)`);
}

function freshRecord(name) {
  return { name, trigger: null, sla: null, lastRunTs: null, lastOutcome: null, lastReason: null, consecutiveFailures: 0,
    recentFailures: [], streakStartTs: null, nextRunTs: null, lastOkTs: null, fresh: {} };
}

export function createLoopRegistry({ stateDir, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout,
  onStreak = null, onRun = null, obligations = null, log = () => {}, bootStaggerMs = 2_000 } = {}) {
  const dir = path.join(stateDir, 'loops');
  fs.mkdirSync(dir, { recursive: true });
  const loops = new Map();   // name -> { spec, rec }
  const timers = new Map();  // name -> timer handle
  const running = new Set();
  // name -> Set<AbortController>, one entry per
  // in-flight run() call (allowOverlap can have more than one at once).
  // abort(name) below aborts every AbortController in flight for that name
  // -- the SAME ctx.signal a maker already receives, so a caller like
  // spawnWikiBuild (which already kills its child tree on abort) is torn
  // down on shutdown with no loop-specific wiring needed in the registry.
  const inFlightAbort = new Map();
  // ACs that abort() itself aborted (as
  // opposed to execute()'s own internal ceiling-timeout abort), so run()
  // can tell "this failure is because something ASKED this run to stop"
  // from "this run genuinely failed on its own". A WeakSet so an entry
  // never outlives the AbortController it tags.
  const externallyAbortedACs = new WeakSet();
  // glmps-2-0-65: every run() promise still in flight, record() included, so
  // drain() can wait for all of them rather than only the names a caller knows.
  const inFlightRuns = new Set();
  let stopped = false;

  const fileOf = (name) => path.join(dir, `${name}.json`);
  function load(name) {
    try { return { ...freshRecord(name), ...JSON.parse(fs.readFileSync(fileOf(name), 'utf8')) }; }
    catch (e) { if (e.code !== 'ENOENT') log(`loop ${name}: state unreadable, starting a fresh record: ${e.message}`); return freshRecord(name); }
  }
  function save(rec) {
    const f = fileOf(rec.name); const tmp = `${f}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(rec, null, 2));
    fs.renameSync(tmp, f);
  }

  // glmps-2-0-runtime-10: a failure backoff must not outrun the freshness
  // obligation it exists to meet, so it is capped to leave one full
  // ceiling.timeoutMs before lastOkTs + sla.maxAgeMs. Once that point has
  // passed the deadline is already lost, and the plain backoff applies rather
  // than a zero-delay retry loop.
  function delayAfter(spec, rec) {
    if (rec.consecutiveFailures === 0) return spec.trigger.everyMs;
    const backoff = Math.min(spec.backoff.maxMs, spec.backoff.baseMs * 2 ** (rec.consecutiveFailures - 1));
    if (!(spec.sla?.maxAgeMs > 0) || rec.lastOkTs == null) return backoff;
    const untilLatestStart = rec.lastOkTs + spec.sla.maxAgeMs - spec.ceiling.timeoutMs - now();
    return untilLatestStart > 0 ? Math.min(backoff, untilLatestStart) : backoff;
  }
  function schedule(name, ms) {
    const L = loops.get(name);
    if (stopped || !L || !L.spec.trigger.everyMs) return;
    if (timers.has(name)) clearTimer(timers.get(name));
    L.rec.nextRunTs = now() + ms;
    const h = setTimer(() => { timers.delete(name); run(name, null).catch((e) => log(`loop ${name} run crashed: ${e?.message || e}`)); }, ms);
    h?.unref?.();
    timers.set(name, h);
  }

  // glmps-2-0-runtime-84: a restart resumes the persisted cadence rather than
  // re-arming bootDelayMs from zero. With bootDelayMs equal to everyMs, deploys
  // landing every ~30 min kept a 30-min loop from ever firing. Capped at
  // bootDelayMs so no loop starts later than it used to, and floored at
  // BOOT_FLOOR_MS so an overdue loop does not stampede the boot.
  function firstDelay(spec, rec) {
    if (rec.lastRunTs == null) return spec.bootDelayMs;
    const floor = Math.min(spec.bootDelayMs, BOOT_FLOOR_MS);
    const untilDue = rec.lastRunTs + spec.trigger.everyMs - now();
    return Math.max(floor, Math.min(spec.bootDelayMs, untilDue));
  }

  // glmps-2-0-runtime-86: the floor above gave every overdue loop the same
  // 30 s first delay, so a deploy fired 15+ of them in one 4 s busy run. A
  // first run at or past the floor that would start within bootStaggerMs of
  // another first run is moved to just after it.
  const firstRunAts = [];
  function staggered(ms) {
    if (ms < BOOT_FLOOR_MS) return ms;
    // one clock read: a tick between two reads would shave a millisecond off ms
    const t = now();
    let at = t + ms;
    for (let moved = true; moved;) {
      moved = false;
      for (const other of firstRunAts) {
        if (Math.abs(other - at) < bootStaggerMs) { at = other + bootStaggerMs; moved = true; }
      }
    }
    firstRunAts.push(at);
    return at - t;
  }

  function registerLoop(spec) {
    validate(spec, loops);
    const full = {
      bootDelayMs: 30_000, allowOverlap: false, onFailed: null, onVerified: null,
      ...spec,
      about: spec.about ?? LOOP_ABOUT[spec.name] ?? null,
      backoff: spec.backoff ?? { baseMs: spec.trigger.everyMs ?? 60_000, maxMs: 24 * 3_600_000 },
    };
    const rec = load(spec.name);
    rec.trigger = spec.trigger; rec.sla = spec.sla;
    save(rec);
    loops.set(spec.name, { spec: full, rec });
    if (spec.trigger.everyMs) schedule(spec.name, staggered(firstDelay(full, rec)));
    obligations?.onRegister?.(spec.name, full);
    return { name: spec.name, runNow: (payload, opts) => runNow(spec.name, payload, opts) };
  }

  function classify(e) {
    if (e instanceof CeilingError) return e.message;
    if (e?.code === 'loop-timeout') return 'timeout';
    if (e?.code === 'loop-checker') return `checker:${e.message}`;
    return String(e?.message || e || 'failed');
  }

  async function execute(L, payload, opts = {}, ac = new AbortController()) {
    const { spec } = L;
    let calls = 0; let timer;
    const ctx = {
      name: spec.name, payload, attempt: L.rec.consecutiveFailures + 1, signal: ac.signal,
      countModelCall() { calls += 1; if (spec.ceiling.maxModelCalls !== null && calls > spec.ceiling.maxModelCalls) throw new CeilingError('ceiling:model-calls'); },
    };
    const timeout = new Promise((_, rej) => {
      timer = setTimer(() => { ac.abort(); rej(Object.assign(new Error('timeout'), { code: 'loop-timeout' })); }, spec.ceiling.timeoutMs);
    });
    // onVerified and onFailed each get their own fresh ceiling.timeoutMs bound, started when the
    // hook itself starts, never the run's single shared `timeout` above. That shared promise can
    // already be settled (rejected) by the time a hook runs, because the hook's own antecedent
    // failure can be the very timeout that ended the maker or checker; racing a slow-but-succeeding
    // hook against an already-rejected promise would misreport it as timing out even though it
    // actually finished. A fresh full budget per hook (not a fraction of whatever is left, which
    // can be zero or negative in that same case) keeps every hook able to run at all. Its own timer
    // is cleared as soon as the hook settles, whichever way.
    async function boundedHook(fn) {
      let hookTimer;
      const hookTimeout = new Promise((_, rej) => {
        hookTimer = setTimer(() => rej(Object.assign(new Error('timeout'), { code: 'loop-timeout' })), spec.ceiling.timeoutMs);
      });
      try { return await Promise.race([fn(), hookTimeout]); }
      finally { clearTimer(hookTimer); }
    }
    try {
      let made; let lastErr;
      for (let i = 0; i < spec.ceiling.maxAttempts; i++) {
        try { made = await Promise.race([spec.maker(ctx), timeout]); lastErr = null; break; }
        catch (e) { lastErr = e; if (e instanceof CeilingError || e?.code === 'loop-timeout') break; }
      }
      if (lastErr) throw lastErr;
      // A maker that swallows its own CeilingError must not escape the ceiling: the tally is
      // checked independently of whatever outcome the maker returned. Both checks are skipped
      // outright when maxModelCalls is null (advisory, out-of-process calls).
      if (spec.ceiling.maxModelCalls !== null && calls > spec.ceiling.maxModelCalls) throw new CeilingError('ceiling:model-calls');
      if (!made || !OK_OUTCOMES.has(made.outcome)) throw new Error(`maker returned no valid outcome (${made?.outcome})`);
      if (spec.ceiling.maxModelCalls !== null && (made.modelCalls ?? 0) > spec.ceiling.maxModelCalls) throw new CeilingError('ceiling:model-calls');
      if (made.outcome === 'nothing-to-do') return { outcome: 'nothing-to-do', reason: null, fresh: made.fresh ?? null, verifierRef: null, result: made.result };
      let verdict;
      try {
        verdict = await Promise.race([spec.checker(made.result, ctx), timeout]);
      } catch (e) {
        // A ceiling raised inside the checker (e.g. its own countModelCall() calls) is a ceiling
        // failure, not a checker failure: re-throw it unchanged, exactly like a timeout.
        if (e instanceof CeilingError || e?.code === 'loop-timeout') throw e;
        throw Object.assign(new Error(e?.message ?? String(e)), { code: 'loop-checker' });
      }
      if (!verdict || verdict.ok !== true) throw Object.assign(new Error(verdict?.reason || 'rejected'), { code: 'loop-checker' });
      if (spec.onVerified) {
        // The side effect that must only follow a passing check (the wiki's publish, an obligation close).
        try { await boundedHook(() => spec.onVerified(made.result, verdict, ctx)); }
        catch (pe) { throw Object.assign(new Error(`publish:${pe?.message || pe}`), { code: 'loop-publish' }); }
      }
      return { outcome: 'done', reason: null, fresh: made.fresh ?? null, verifierRef: verdict.verifierRef ?? null, result: made.result };
    } catch (e) {
      let reason = classify(e);
      // an EXPLICIT field, not a caller parsing
      // the reason string for a "publish:" prefix - a failure tagged
      // `code: 'loop-publish'` means the checker already passed (a verdict
      // landed) and only the onVerified side effect itself failed, so a
      // caller like plugin-retry's judge.session dispatch can tell "retry
      // just the close" from "re-run the whole thing" without any string
      // parsing of its own.
      // Left `undefined` (never `false`) for the ordinary case so existing
      // callers comparing the whole result object (e.g. deepEqual against
      // { outcome, reason }) are unaffected - only the onVerified-failure
      // case ever adds this key.
      const checkerPassed = e?.code === 'loop-publish' ? true : undefined;
      // suppressOnFailed: a caller re-dispatching
      // an already-durably-queued job through this loop's own maker/checker
      // (plugin-retry running a due judge.session job through session-judge)
      // owns queueing that job itself; the loop's own onFailed would
      // otherwise push a SECOND, duplicate retry job on top of it. Scoped to
      // this one call only - the loop's ordinary onEvent-triggered runs are
      // unaffected.
      // Phase K final review minor: an onFailed failure (the loop's own
      // retry-queue push, say) is an EXPLICIT field, onFailedError, so a
      // caller (memory-distill-worker) never parses "; onFailed:" out of the
      // reason text. The suffix stays in `reason` for the human reading it.
      let onFailedError;
      if (spec.onFailed && !opts.suppressOnFailed) {
        try { await boundedHook(() => spec.onFailed(ctx, reason)); }
        catch (qe) { onFailedError = String(qe?.message || qe); reason = `${reason}; onFailed: ${onFailedError}`; }
      }
      return { outcome: 'failed', reason, fresh: null, verifierRef: null, checkerPassed, onFailedError };
    } finally {
      clearTimer(timer);
    }
  }

  function record(L, { outcome, reason, fresh, verifierRef }) {
    const rec = L.rec; const t = now();
    rec.lastRunTs = t;
    if (outcome === 'failed') {
      if (rec.consecutiveFailures === 0) rec.streakStartTs = t;
      rec.consecutiveFailures += 1;
      rec.lastOutcome = `failed:${reason}`; rec.lastReason = reason;
      rec.recentFailures = [...rec.recentFailures, { ts: t, reason }].slice(-3);
    } else {
      rec.consecutiveFailures = 0; rec.streakStartTs = null;
      rec.lastOutcome = outcome; rec.lastReason = null; rec.lastOkTs = t;
      if (fresh) rec.fresh = fresh;
    }
    // A failed write must not stop a scheduled loop for good: keep the in-memory record and every
    // callback going, and surface the failure through log (and onRun) instead of throwing it.
    let saveError = null;
    try { save(rec); }
    catch (e) { saveError = e; log(`loop ${rec.name}: state save failed, continuing with the in-memory record: ${e?.message || e}`); }
    if (outcome === 'failed' && rec.consecutiveFailures === STREAK_AT && onStreak) {
      try { onStreak({ name: rec.name, record: JSON.parse(JSON.stringify(rec)) }); }
      catch (e) { log(`loop ${rec.name}: onStreak failed: ${e?.message || e}`); }
    }
    // A throwing obligations adapter must not break this run: the state is
    // already persisted above, and onRun (the dashboard broadcast) still has
    // to fire below regardless of what this hook does.
    if (outcome !== 'failed') {
      try { obligations?.onOk?.(rec.name, { outcome, verifierRef, ts: t }); }
      catch (e) { log(`loop ${rec.name}: obligations.onOk failed: ${e?.message || e}`); }
    }
    if (onRun) {
      const evt = { name: rec.name, outcome, reason: reason ?? null, consecutiveFailures: rec.consecutiveFailures };
      if (saveError) evt.saveError = saveError.message || String(saveError);
      try { onRun(evt); }
      catch (e) { log(`loop ${rec.name}: onRun failed: ${e?.message || e}`); }
    }
  }

  function run(name, payload, opts = {}) {
    const p = runOnce(name, payload, opts);
    inFlightRuns.add(p);
    const forget = () => inFlightRuns.delete(p);
    p.then(forget, forget);
    return p;
  }

  async function runOnce(name, payload, opts = {}) {
    const L = loops.get(name);
    if (!L) throw new Error(`unknown loop: ${name}`);
    if (L.spec.trigger.external) throw new Error(`loop ${name} is external: report its outcome instead`);
    if (stopped) return { outcome: 'nothing-to-do', reason: 'registry stopped' };
    if (running.has(name) && !L.spec.allowOverlap) return { outcome: 'nothing-to-do', reason: 'already running' };
    running.add(name);
    const ac = new AbortController();
    let acs = inFlightAbort.get(name);
    if (!acs) { acs = new Set(); inFlightAbort.set(name, acs); }
    acs.add(ac);
    let res;
    try { res = await execute(L, payload, opts, ac); }
    finally {
      running.delete(name);
      acs.delete(ac);
      if (!acs.size) inFlightAbort.delete(name);
    }
    // a run whose failure came from
    // THIS registry's own abort() call made AFTER stop() (server shutdown
    // tearing down an in-flight run) must leave the persisted record
    // untouched entirely -- it never got a real chance to succeed or fail
    // on its own merits, and recording it as a normal failure would let a
    // handful of ordinary restarts during a build climb consecutiveFailures
    // to STREAK_AT and fire a false "loop failing" alert. Scoped tightly:
    // only when BOTH abort() was actually called for this run's own AC AND
    // the registry is now stopped -- an abort() call with no stop() (e.g. a
    // ceiling ultimately unrelated to shutdown) still records as a normal
    // failure, unchanged from before.
    if (res.outcome === 'failed' && stopped && externallyAbortedACs.has(ac)) {
      if (L.spec.trigger.everyMs) schedule(name, delayAfter(L.spec, L.rec)); // a no-op while stopped
      return { outcome: 'nothing-to-do', reason: 'aborted at shutdown' };
    }
    // Re-arm the interval timer in a finally: whatever record() does (including throwing, if a
    // callback outside our control misbehaves) must never leave an everyMs loop unscheduled.
    try {
      record(L, res);
    } finally {
      if (L.spec.trigger.everyMs) schedule(name, delayAfter(L.spec, L.rec));
    }
    return {
      outcome: res.outcome, reason: res.reason,
      ...(res.result !== undefined ? { result: res.result } : {}),
      // forwarded alongside outcome/reason so a caller (e.g.
      // plugin-retry's judge.session dispatch) can branch on it directly.
      ...(res.checkerPassed !== undefined ? { checkerPassed: res.checkerPassed } : {}),
      ...(res.onFailedError !== undefined ? { onFailedError: res.onFailedError } : {}),
    };
  }

  const runNow = (name, payload = null, opts = {}) => run(name, payload, opts);

  async function emit(kind, payload = null) {
    const names = [...loops.values()].filter((L) => L.spec.trigger.onEvent === kind).map((L) => L.spec.name);
    // allSettled: one loop's rejection must not discard the outcomes of the others triggered by
    // the same event. run() itself never rejects in practice (execute()/record() catch
    // everything internally), but a caller here gets the plain run() result either way -
    // unwrapped from allSettled's {status,value} envelope, which no caller ever wants - with a
    // rejection (belt-and-suspenders, should one ever escape run()) reported the same shape a
    // failed run already uses, never thrown out of emit() itself.
    const settled = await Promise.allSettled(names.map((n) => run(n, payload)));
    return settled.map((s) => (s.status === 'fulfilled' ? s.value : { outcome: 'failed', reason: s.reason?.message || String(s.reason) }));
  }

  function report(name, { outcome, reason = null, fresh = null } = {}) {
    const L = loops.get(name);
    if (!L) throw new Error(`unknown loop: ${name}`);
    const ok = outcome === 'done' || outcome === 'nothing-to-do';
    if (!ok && outcome !== 'failed') throw new TypeError(`outcome must be done, nothing-to-do or failed: ${outcome}`);
    // Only an external loop may report success: an internal loop's success must come from its checker.
    if (ok && !L.spec.trigger.external) throw new TypeError(`loop ${name} is internal: only a failure can be reported; success comes from its checker`);
    record(L, { outcome, reason: ok ? null : String(reason || 'failed'), fresh, verifierRef: null });
  }

  function get(name) { const L = loops.get(name); return L ? JSON.parse(JSON.stringify(L.rec)) : null; }

  function snapshot() {
    const out = {}; const t = now();
    for (const [name, { rec }] of loops) {
      out[name] = { lastOutcome: rec.lastOutcome, lastRunTs: rec.lastRunTs, ageS: rec.lastRunTs == null ? null : Math.round((t - rec.lastRunTs) / 1000),
        consecutiveFailures: rec.consecutiveFailures, lastReason: rec.lastReason, nextRunTs: rec.nextRunTs, trigger: rec.trigger, sla: rec.sla,
        lastOkTs: rec.lastOkTs, streakStartTs: rec.streakStartTs };
    }
    return out;
  }

  function describe() { return [...loops.values()].map(({ spec }) => ({ name: spec.name, about: spec.about })); }

  function stop() {
    stopped = true;
    for (const h of timers.values()) clearTimer(h);
    timers.clear();
  }

  // stop() only cancels FUTURE scheduled runs (the
  // timers); it does not know about, or wait for, a run already in flight.
  // A caller closing a resource that run might still touch (the obligations
  // sqlite handle) needs to ask first. An unknown name is simply not
  // running, never a throw - this is a query, not a loop-existence check.
  function isRunning(name) { return running.has(name); }

  // glmps-2-0-65: resolves once no run of any loop is in flight, including
  // its record() and obligations hook. Meant after stop(), when no new run can
  // start; a caller bounds the wait itself. Never rejects.
  async function drain() {
    while (inFlightRuns.size) await Promise.allSettled([...inFlightRuns]);
  }

  // aborts every ctx.signal currently in flight
  // for `name` (ordinarily at most one, more than one only under
  // allowOverlap). Returns whether there was anything to abort, so a caller
  // (server.js's close()) can tell "torn down" from "nothing was running".
  // An unknown or idle name is simply nothing to abort, never a throw -
  // same posture as isRunning.
  function abort(name, reason) {
    const acs = inFlightAbort.get(name);
    if (!acs || !acs.size) return false;
    const err = reason instanceof Error ? reason : new Error(String(reason || 'aborted'));
    for (const ac of acs) { externallyAbortedACs.add(ac); ac.abort(err); }
    return true;
  }

  // K Task 16 phase-end carry 2: setTimer/clearTimer are exposed as-is (the
  // exact pair this registry itself was constructed with - the real global
  // ones by default, or whatever a caller injected) so a loop built on top
  // of this registry (plugin-loops.js's settledWithin) can schedule its OWN
  // timeout through the SAME clock, rather than reaching for the global
  // setTimeout/clearTimeout directly - which a test driving this registry
  // with a fake/manually-fired clock would never see or control.
  return { registerLoop, emit, runNow, report, snapshot, describe, get, stop, isRunning, drain, abort, setTimer, clearTimer };
}
