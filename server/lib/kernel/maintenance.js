// server/lib/kernel/maintenance.js
// The maintenance record: one durable file that says "a Restart run is
// quiescing the box". The runner and merge queue read it to start nothing new,
// and the session-control hook reads it straight from disk because the kernel
// may be down. It expires by itself so a crashed run cannot hold the box
// (card glmps-2-0-170). It is deliberately not the board pause or runner
// disabled flag: promotion refuses to run under those.
import fs from 'node:fs';
import path from 'node:path';

export const MAINTENANCE_TTL_MS = 45 * 60_000;
const FILE = 'maintenance.json';
export const PHASES = ['quiescing', 'restarting'];

const pathFor = (stateDir) => path.join(stateDir, FILE);

function write(stateDir, rec) {
  fs.mkdirSync(stateDir, { recursive: true });
  const tmp = `${pathFor(stateDir)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(rec) + '\n');
  fs.renameSync(tmp, pathFor(stateDir));
}

export function readMaintenance(stateDir, now = Date.now()) {
  try {
    const r = JSON.parse(fs.readFileSync(pathFor(stateDir), 'utf8'));
    if (!r || typeof r.runId !== 'string' || !PHASES.includes(r.phase) || !Number.isFinite(r.expiresAt)) return null;
    return now < r.expiresAt ? r : null;
  } catch { return null; }
}

export function beginMaintenance(stateDir, { runId, phase = 'quiescing', now = Date.now(), ttlMs = MAINTENANCE_TTL_MS }) {
  const rec = { runId, phase, startedTs: now, expiresAt: now + ttlMs };
  write(stateDir, rec);
  return rec;
}

export function setMaintenancePhase(stateDir, runId, phase, { now = Date.now() } = {}) {
  const cur = readMaintenance(stateDir, now);
  if (!cur || cur.runId !== runId) return null;
  const rec = { ...cur, phase };
  write(stateDir, rec);
  return rec;
}

/**
 * Release a hold no process can finish (card glmps-2-0-173): its run is
 * finished in the approvals ledger (`entries`), or it was taken before this
 * process booted (`bootTs`) and either the ledger never saw it or nothing in
 * this kernel will resume it (`resumer` false: SCUT is off). A hold this
 * process took is its own live run. Otherwise only the run's own end clears
 * it, and the hook stalls every live session while it stands. Returns true
 * when it cleared a record.
 */
export function releaseOrphanedMaintenance(stateDir, { entries = [], resumer = true, bootTs = 0, now = Date.now() } = {}) {
  const rec = readMaintenance(stateDir, now);
  if (!rec) return false;
  let started = false;
  let finished = false;
  for (const e of entries) {
    if (e?.id !== rec.runId) continue;
    if (e.type === 'run-started') started = true;
    if (e.type === 'run-finished') finished = true;
  }
  if (!finished && (rec.startedTs >= bootTs || (resumer && started))) return false;
  return clearMaintenance(stateDir, rec.runId);
}

/** Without a runId the record is cleared whoever owns it; with one, only its owner clears it. */
export function clearMaintenance(stateDir, runId = null) {
  try {
    if (runId != null) {
      let cur = null;
      try { cur = JSON.parse(fs.readFileSync(pathFor(stateDir), 'utf8')); } catch { /* corrupt or absent */ }
      if (cur && cur.runId !== runId) return false;
    }
    fs.rmSync(pathFor(stateDir), { force: true });
    return true;
  } catch { return false; }
}
