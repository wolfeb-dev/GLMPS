// server/lib/kernel/crash-records.js
// 2.0 down alert: the kernel cannot report its own death while it is dead,
// but once the watchdog restarts it, every crash record from the last 7 days
// becomes an alert-center row, so a death the toast missed is still seen.
import fs from 'node:fs';
import path from 'node:path';

export const CRASH_ALERT_WINDOW_MS = 7 * 24 * 3600 * 1000;

// Signal is only named when present: on Windows it is always null and says nothing.
function causeOf(rec) {
  const x = rec?.lastExit;
  if (x?.gaveUp) return `the supervisor gave up restarting it (${x.gaveUp}; last code ${x.code ?? 'none'})`;
  if (x) return `last exit: code ${x.code ?? 'none'}${x.signal ? `, signal ${x.signal}` : ''} (${x.kind ?? 'unknown'})`;
  if (rec?.hostRebootedSinceLastOk) return 'no exit record; the host rebooted while it was down';
  return 'no exit record (the supervisor did not see the exit)';
}

function restartText(rec) {
  const n = Array.isArray(rec?.failedRestarts) ? rec.failedRestarts.length : 0;
  if (rec?.restart?.ok) return n ? `Restarted after ${n} failed attempt${n === 1 ? '' : 's'}.` : 'Restart: ok.';
  if (rec?.restart?.pending) return 'Restart: failed (the start timed out and may still complete).';
  return 'Restart: failed.';
}

export function kernelCrashAlerts(stateDir, { now = Date.now() } = {}) {
  const dir = path.join(stateDir, 'crashes');
  let files;
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort().slice(-20); } catch { return []; }
  const out = [];
  for (const f of files) {
    let rec;
    try { rec = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
    const ts = Date.parse(rec?.detectedAt ?? '');
    if (!Number.isFinite(ts) || now - ts > CRASH_ALERT_WINDOW_MS) continue;
    out.push({
      source: 'kernel-crash', severity: 'warn',
      title: `GLMPS 2.0 kernel was found down at ${rec.detectedAt}`,
      detail: `Last healthy: ${rec.lastOkAt ?? 'unknown'}. ${causeOf(rec)}. ${restartText(rec)}${rec.count > 1 ? ` Found down ${rec.count} times, last ${rec.lastTs}.` : ''} Record: crashes/${f}`,
      target: null, ts,
    });
  }
  return out;
}
