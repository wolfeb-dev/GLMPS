// GET /healthz: the kernel's liveness contract (program K1). Built from
// in-memory state only; never a file read per request.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';

// Scan 2026-10-15 F7: /healthz is open to remote clients, and a loop's
// 'failed:<reason>' carries stderr tails, local paths and model output. An
// undetailed view (remote, no token) keeps liveness only: status, uptime and
// per loop the outcome class before ':' and the failure count.
// `kernel` (card glmps-2-0-85): last_start, starts_24h and shell, detailed
// view only - who restarted the kernel and the desktop app's pickup times are
// local detail, like loop failure text.
export function buildHealthz({ version, bootTs, now = Date.now, loops = {}, openObligations = null, lastEventTs = null, eventLoopDelay = null, detailed = true, kernel = null }) {
  const t = now(); const view = {}; let degraded = false;
  for (const [name, l] of Object.entries(loops || {})) {
    const cf = l?.consecutiveFailures ?? 0;
    const outcome = l?.lastOutcome ?? null;
    view[name] = detailed
      ? { lastOutcome: outcome, ageS: l?.lastRunTs == null ? null : Math.round((t - l.lastRunTs) / 1000), consecutiveFailures: cf }
      : { lastOutcome: outcome == null ? null : String(outcome).split(':')[0], consecutiveFailures: cf };
    if (cf >= 3) degraded = true;
  }
  const status = degraded ? 'degraded' : 'up';
  const uptime_s = Math.floor((t - bootTs) / 1000);
  if (!detailed) return { status, uptime_s, loops: view };
  const body = { status, version, uptime_s, open_obligations: openObligations, last_event_ts: lastEventTs, ...(kernel ?? {}), loops: view };
  if (eventLoopDelay) body.event_loop_delay_ms = eventLoopDelay;
  return body;
}

// glmps-2-0-runtime-10: event-loop delay over a rolling window, so a stall
// that slows every background loop is measured rather than inferred from
// probe latency. The window resets on the first read after it elapses, which
// needs no timer of its own.
export function createEventLoopDelayMonitor({ windowMs = 5 * 60_000, now = Date.now, histogram = monitorEventLoopDelay({ resolution: 20 }) } = {}) {
  histogram.enable();
  let windowStart = now();
  const ms = (ns) => Math.round(ns / 1e5) / 10;
  return {
    read() {
      const t = now();
      if (t - windowStart >= windowMs) { histogram.reset(); windowStart = t; }
      return { p50: ms(histogram.percentile(50)), p99: ms(histogram.percentile(99)), max: ms(histogram.max), window_s: Math.round((t - windowStart) / 1000) };
    },
    stop() { histogram.disable(); },
  };
}

// A kernel bundled in the installer has no .git; the stage step records its
// commit in bundle.json instead (glmps-2-0-59).
function bundleCommit(repoRoot) {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(repoRoot, 'bundle.json'), 'utf8')).commit;
    return /^[0-9a-f]{7,}$/.test(String(c)) ? String(c).slice(0, 7) : null;
  } catch { return null; }
}

export function readBootVersion({ repoRoot, pkgVersion, execFileImpl = execFile, log = () => {} }) {
  const bundled = bundleCommit(repoRoot);
  if (bundled) return Promise.resolve(`${pkgVersion ?? '0.0.0'}+${bundled}`);
  return new Promise((resolve) => {
    execFileImpl('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, windowsHide: true, timeout: 4000 }, (err, out) => {
      // Called exactly once, at boot: a failure here means the running kernel
      // never learns its own commit (version stays '+unknown' for the whole
      // process lifetime), which is worth a named reason in the log even
      // though it is not worth failing boot over.
      if (err) log(`git rev-parse HEAD failed, version stays +unknown: ${err.message || err}`);
      const sha = !err && /^[0-9a-f]{7,}/.test(String(out).trim()) ? String(out).trim().slice(0, 7) : 'unknown';
      resolve(`${pkgVersion ?? '0.0.0'}+${sha}`);
    });
  });
}
