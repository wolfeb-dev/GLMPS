// server/lib/kernel/start-reason.js
// Why did the kernel start (card glmps-2-0-85)? A stopping kernel writes a stop
// record (requested restart or clean stop, who asked, the close step it was in
// if it overran); the next start reads it and classifies itself. No record
// means the last process never reached its close: a crash, a kill or power
// loss. Six restarts on 2026-10-24 took an hour of log reading to sort into
// deploys, requested restarts and none-of-the-above; this keeps the answer.
import fs from 'node:fs';
import path from 'node:path';
import { formatTime } from '../../../web/shared/time-format.js';

export const STARTS_KEPT = 50;
export const START_ALERT_WINDOW_MS = 7 * 24 * 3600 * 1000;
export const RESTART_STORM = 4;
const DAY_MS = 24 * 3600 * 1000;

const dirOf = (stateDir) => path.join(stateDir, 'kernel');
const stopFile = (stateDir) => path.join(dirOf(stateDir), 'last-stop.json');
const startsFile = (stateDir) => path.join(dirOf(stateDir), 'starts.json');

function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }
// Synchronous on purpose: the stop record is written on the way out, often
// moments before process.exit.
function writeJson(f, obj) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, f);
}

// Who pressed restart, in words: the dashboard runs in the desktop app or a
// browser, anything else is a script.
export function requesterOf(headers = {}, remote = null) {
  const ua = String(headers['user-agent'] ?? '');
  const via = /electron|glmps/i.test(ua) ? 'desktop app' : /mozilla/i.test(ua) ? 'browser' : ua ? 'script' : 'unknown client';
  let page = null;
  try { page = headers.referer ? new URL(headers.referer).pathname : null; } catch { /* not a URL */ }
  return { via, page, remote: remote ?? null, ua: ua.slice(0, 160) || null };
}

export function recordStop(stateDir, { kind, by = null, version = null, lastWakeTs = null, now = Date.now() }) {
  writeJson(stopFile(stateDir), { kind, by, version, lastWakeTs, at: now });
}

// The close overran its deadline: say which step held it, on the same record.
export function noteStopOverrun(stateDir, stage) {
  const rec = readJson(stopFile(stateDir));
  if (rec) writeJson(stopFile(stateDir), { ...rec, overranIn: stage ?? 'unknown' });
}

// A new version is a deploy however the restart came: the documented deploy
// is a pull plus the dashboard's Restart server (docs/glmps-2-instance.md),
// and counting it as a requested restart would feed the restart alert. The
// version compared is the one the last process booted with.
export function classifyStart({ stop, previous, version }) {
  if (!previous) return 'first recorded start';
  if (!stop || !(stop.at >= previous.at)) return 'unclean exit';
  if (previous.version && version && previous.version !== version) return 'deploy';
  if (stop.kind === 'restart-requested') return 'requested restart';
  return 'stop';
}

export function recordStart(stateDir, { version, now = Date.now() }) {
  const ring = Array.isArray(readJson(startsFile(stateDir))) ? readJson(startsFile(stateDir)) : [];
  const stop = readJson(stopFile(stateDir));
  const previous = ring.at(-1) ?? null;
  const reason = classifyStart({ stop, previous, version });
  const entry = {
    at: now, reason, version,
    prevVersion: previous?.version ?? null,
    stoppedAt: stop && previous && stop.at >= previous.at ? stop.at : null,
    by: stop?.kind === 'restart-requested' && reason !== 'unclean exit' ? stop.by : null,
    minutesAfterWake: stop?.lastWakeTs && reason !== 'unclean exit' ? Math.round((stop.at - stop.lastWakeTs) / 60_000) : null,
    overranIn: stop?.overranIn ?? null,
  };
  writeJson(startsFile(stateDir), [...ring, entry].slice(-STARTS_KEPT));
  try { fs.rmSync(stopFile(stateDir), { force: true }); } catch { /* the next start compares times anyway */ }
  return entry;
}

export function readStarts(stateDir) {
  const ring = readJson(startsFile(stateDir));
  return Array.isArray(ring) ? ring : [];
}

export function startsSummary(ring, { now = Date.now() } = {}) {
  const last = ring.at(-1) ?? null;
  const day = ring.filter((s) => now - s.at <= DAY_MS);
  const byReason = {};
  for (const s of day) byReason[s.reason] = (byReason[s.reason] ?? 0) + 1;
  return { last_start: last ? { reason: last.reason, at: new Date(last.at).toISOString() } : null, starts_24h: byReason };
}

function startDetail(s) {
  const bits = [];
  if (s.by) bits.push(`asked by the ${s.by.via}${s.by.page ? ` (${s.by.page})` : ''}`);
  if (s.minutesAfterWake !== null && s.minutesAfterWake <= 30) bits.push(`${s.minutesAfterWake} min after a wake from standby`);
  if (s.overranIn) bits.push(`the shutdown overran its 8 s limit in: ${s.overranIn}`);
  return bits.join('; ');
}

export function kernelStartAlerts(ring, { now = Date.now() } = {}) {
  const out = [];
  for (const s of ring) {
    if (s.reason !== 'unclean exit' || now - s.at > START_ALERT_WINDOW_MS) continue;
    out.push({
      source: 'kernel-start', severity: 'warn',
      title: `GLMPS 2.0 kernel restarted after an unclean exit at ${formatTime(s.at)}`,
      detail: 'The previous kernel process never reached its shutdown: a crash, a kill, or power loss. Check the service err log around that time.',
      target: null, ts: s.at,
    });
  }
  const storm = ring.filter((s) => now - s.at <= DAY_MS && s.reason !== 'deploy' && s.reason !== 'first recorded start');
  if (storm.length >= RESTART_STORM) {
    const last = storm.at(-1);
    out.push({
      source: 'kernel-start', severity: 'warn',
      title: `GLMPS 2.0 kernel restarted ${storm.length} times in 24 hours, not counting deploys`,
      detail: storm.map((s) => `${formatTime(s.at)} ${s.reason}${startDetail(s) ? ` (${startDetail(s)})` : ''}`).join('\n'),
      target: null, ts: last.at,
    });
  }
  return out;
}
