// The shell's supervision loop (section 0 contract, kept in the shell because
// registerLoop lives in the kernel it supervises). Maker: startService.
// Checker: checkHealth. One tick in flight; a ceiling of maxStartAttempts per
// down streak; exponential backoff between starts; onGiveUp once per cause per
// streak (a port conflict, or the kernel itself down).
//
// One slow probe is not down (card glmps-2-0-runtime-65): a kernel that was up
// stays reported up until failThreshold probes fail inside failWindowMs and
// the kernel has been silent for noAnswerMs, with the recheck pace raised to
// suspectPollMs meanwhile. And a kernel whose process still answers
// (isKernelAlive) is never sent a start request however slow its health is;
// it is reported degraded instead. Only a kernel that gives no answer for the
// sustained window is started. A kernel that stays alive but silent for
// hungNoticeMs raises onGiveUp once (reason unresponsive:*) so a permanent
// hang is surfaced; it is still never restarted from here.
export const SUPERVISOR_DEFAULTS = Object.freeze({
  pollMs: 10000, maxStartAttempts: 5, backoffBaseMs: 2000, backoffMaxMs: 60000,
  failThreshold: 3, failWindowMs: 30000, noAnswerMs: 10000, suspectPollMs: 3000, hungNoticeMs: 300000,
});
const REFUSED = new Set(['not-installed', 'access-denied', 'disabled']);

export function backoffMs(attempt, { backoffBaseMs, backoffMaxMs }) {
  return Math.min(backoffMaxMs, backoffBaseMs * 2 ** Math.max(0, attempt - 1));
}

export function createSupervisor({ checkHealth, startService, isKernelAlive = async () => false, portConflict = async () => null, canStart = true, now = Date.now,
  setTimer = setTimeout, clearTimer = clearTimeout, onChange = () => {}, onGiveUp = () => {},
  log = () => {}, ...overrides }) {
  const cfg = { ...SUPERVISOR_DEFAULTS, ...overrides };
  let s = {
    state: 'checking', reason: null, attempts: 0, maxAttempts: cfg.maxStartAttempts,
    streakStartTs: null, lastOkTs: null, lastHealth: null, lastHealthReason: null,
    lastStart: null, nextCheckTs: null, lastOutcome: null, gaveUpNotified: false,
  };
  let timer = null;
  let stopped = false;
  let running = false;
  // If retryNow() lands while a tick is already in flight, it does not start
  // a second concurrent tick (one tick in flight at a time); it queues exactly
  // one immediate follow-up, fired from the in-flight tick's `finally` once
  // that tick is done. retryNow() itself resolves at once in this case: it
  // must never wait on a tick it cannot itself unblock, or a caller that
  // awaits retryNow() before satisfying whatever the in-flight tick is itself
  // waiting on (e.g. a slow checkHealth) would deadlock the whole chain. The
  // attempts/state reset (applyRetryReset) is applied only once that in-flight
  // tick has fully settled, not at retryNow()'s call time: resetting immediately would race the in-flight tick's own
  // settle(), which would land right over the reset with whatever it was
  // already going to report.
  let pendingRetry = false;
  let failTimes = [];
  let firstFailTs = null;
  let hungSinceTs = null;

  // A caller-supplied callback (onChange/log/onGiveUp) must never be able to
  // take the loop down with it: report and move on.
  function safeCall(name, fn, ...args) {
    try { fn(...args); }
    catch (e) { process.stderr.write(`shell supervisor: ${name} callback threw: ${e && e.stack ? e.stack : e}\n`); }
  }

  // Every tick ends here exactly once: publish the new state (with the time of
  // the next check, which the offline page counts down to). The next timer is
  // armed BEFORE notifying callbacks, so a throwing onChange/log can never
  // leave the loop with no timer running.
  function settle(patch, delayMs) {
    const prev = s.state;
    s = { ...s, ...patch, nextCheckTs: now() + delayMs };
    if (!stopped) {
      clearTimer(timer);
      timer = setTimer(tick, delayMs);
    }
    if (s.state !== prev) safeCall('log', log, 'info', 'supervisor state', { from: prev, to: s.state, reason: s.reason });
    safeCall('onChange', onChange, { ...s });
  }
  // Once per cause per streak (card glmps-2-0-221): a port-conflict notice
  // tells the user to free the port, so the kernel then failing to start is a
  // different problem and gets its own notice.
  let notifiedCause = null;
  function giveUpOnce(cause = 'down') {
    if (s.gaveUpNotified && notifiedCause === cause) return;
    notifiedCause = cause;
    s = { ...s, gaveUpNotified: true };
    safeCall('onGiveUp', onGiveUp, { ...s });
  }

  async function tick() {
    if (running || stopped) return;
    running = true;
    try {
      const h = await checkHealth();
      if (h.ok) {
        failTimes = []; firstFailTs = null; hungSinceTs = null;
        const recovered = s.streakStartTs !== null;
        settle({ state: h.body.status === 'degraded' ? 'degraded' : 'up', reason: null, attempts: 0,
          streakStartTs: null, lastOkTs: now(), lastHealth: h.body, lastHealthReason: null,
          gaveUpNotified: false, lastOutcome: recovered ? 'done' : 'nothing-to-do' }, cfg.pollMs);
        return;
      }
      const t = now();
      failTimes = failTimes.filter((x) => t - x < cfg.failWindowMs);
      if (failTimes.length === 0) firstFailTs = t;
      failTimes.push(t);
      const wasUp = s.state === 'up' || s.state === 'degraded';
      const sustained = failTimes.length >= cfg.failThreshold && t - firstFailTs >= cfg.noAnswerMs;
      if (wasUp && !sustained) {
        settle({ lastHealthReason: h.reason, lastOutcome: `failed:${h.reason}` }, cfg.suspectPollMs);
        return;
      }
      const base = { streakStartTs: s.streakStartTs ?? now(), lastHealth: null, lastHealthReason: h.reason, lastOutcome: `failed:${h.reason}` };
      if (!canStart) {
        settle({ ...base, state: 'offline', reason: `remote-kernel:${h.reason}` }, cfg.pollMs);
        giveUpOnce();
        return;
      }
      if (s.state === 'refused') { settle(base, cfg.pollMs); return; }
      let alive = false;
      try { alive = await isKernelAlive(); } catch { alive = false; }
      // Card glmps-2-0-214: an answering port that is not this app's kernel
      // belongs to another program; waiting on it would wait forever.
      // 'offline', not 'refused', so the poll after it is freed starts the kernel.
      const conflict = alive && !wasUp ? await portConflict(h) : null;
      if (conflict) {
        settle({ ...base, state: 'offline', reason: conflict }, cfg.pollMs);
        giveUpOnce('port-conflict');
        return;
      }
      if (alive) {
        hungSinceTs ??= t;
        settle({ ...base, state: wasUp ? 'degraded' : 'starting', reason: `${wasUp ? 'unresponsive' : 'waiting'}:${h.reason}` }, cfg.suspectPollMs);
        if (t - hungSinceTs >= cfg.hungNoticeMs) giveUpOnce();
        return;
      }
      if (s.attempts >= cfg.maxStartAttempts) {
        settle({ ...base, state: 'offline', reason: `gave-up:${s.lastStart?.reason ?? h.reason}` }, cfg.pollMs);
        giveUpOnce();
        return;
      }
      // Recorded before the maker runs (and before it is logged), so a
      // throwing startService or a throwing logger still counts against the
      // 5-attempt ceiling instead of bypassing it.
      s = { ...s, attempts: s.attempts + 1 };
      const r = await startService();
      safeCall('log', log, r.ok ? 'info' : 'warn', 'sc.exe start', { attempt: s.attempts, ...r });
      if (REFUSED.has(r.reason)) {
        settle({ ...base, state: 'refused', reason: r.reason, lastStart: r }, cfg.pollMs);
        giveUpOnce();
        return;
      }
      settle({ ...base, state: 'starting', reason: r.ok ? `waiting:${h.reason}` : r.reason, lastStart: r }, backoffMs(s.attempts, cfg));
    } catch (e) {
      safeCall('log', log, 'error', 'supervisor tick failed', { error: e.stack || e.message });
      settle({ state: 'offline', reason: `supervisor-error:${e.message}`, lastOutcome: 'failed:supervisor-error', streakStartTs: s.streakStartTs ?? now() }, cfg.pollMs);
    } finally {
      running = false;
      if (pendingRetry) {
        pendingRetry = false;
        // The reset applies now, once this tick has fully settled with
        // whatever it was already going to settle with. Applying it at retryNow()'s call time instead would land on
        // the state this in-flight tick is still about to overwrite: e.g. a
        // start attempt that is about to report access-denied would settle
        // to 'refused' right over the reset, and the queued follow-up would
        // then see 'refused' and only poll health, so the operator's retry
        // never actually retries.
        applyRetryReset();
        tick().catch((e) => {
          process.stderr.write(`shell supervisor: queued retry tick failed: ${e && e.stack ? e.stack : e}\n`);
        });
      }
    }
  }

  function applyRetryReset() {
    s = { ...s, attempts: 0, gaveUpNotified: false, state: s.state === 'refused' || s.state === 'offline' ? 'checking' : s.state };
    clearTimer(timer);
  }

  return {
    start: () => tick(),
    stop() { stopped = true; clearTimer(timer); },
    retryNow() {
      if (running) { pendingRetry = true; return Promise.resolve(); }
      applyRetryReset();
      return tick();
    },
    snapshot: () => ({ ...s }),
  };
}
