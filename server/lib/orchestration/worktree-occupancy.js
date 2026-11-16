// server/lib/orchestration/worktree-occupancy.js
// Is any process sitting in a worktree checkout, asked of the OS rather than of
// session liveness (glmps-87). Every removal path's other evidence
// (the runner ledger, reclaimVerdict's liveDirs, the sweeper's occupancy) comes
// from session discovery, and an idle open session can read as ended there. On
// 2026-08-29 that let the runner reclaim glmps-84's checkout under its
// live session: on Windows a non-forced `git worktree remove` of a clean tree
// deletes every file, fails only on the final rmdir, and has already dropped the
// registration, so nothing reached the session but a later ENOENT.
import fs from 'node:fs';
import path from 'node:path';
import { isUnderDir } from './worktrees.js';

const BUSY = new Set(['EBUSY', 'EPERM', 'EACCES']);

/**
 * -> { inUse, reason }. win32: a directory that is any process's cwd (or holds
 * an open handle) cannot be renamed, so rename it to a sibling and straight
 * back. linux: some process's /proc/<pid>/cwd is inside it. Elsewhere there is
 * no probe and the answer is `unprobed`, leaving the caller's other guards to
 * stand alone. An unexpected error is "in use": no evidence never authorizes a
 * removal (glmps-53).
 */
export function dirInUse(dir, { platform = process.platform, fsImpl = fs } = {}) {
  if (!dir) return { inUse: false, reason: 'no-dir' };
  try { if (!fsImpl.existsSync(dir)) return { inUse: false, reason: 'missing' }; }
  catch (e) { return { inUse: true, reason: `probe-error:${e?.code ?? e?.message}` }; }
  if (platform === 'win32') return renameProbe(dir, fsImpl);
  if (platform === 'linux') return procCwdProbe(dir, fsImpl);
  return { inUse: false, reason: 'unprobed' };
}

function renameProbe(dir, fsImpl) {
  const probe = `${dir}.occupancy-probe-${process.pid}`;
  try { fsImpl.renameSync(dir, probe); }
  catch (e) {
    if (BUSY.has(e?.code)) return { inUse: true, reason: `rename-${e.code}` };
    return { inUse: true, reason: `probe-error:${e?.code ?? e?.message}` };
  }
  // The directory must come back under its own name whatever happens; a few
  // retries ride out an indexer or antivirus handle landing in between.
  for (let i = 0; i < 20; i++) {
    try { fsImpl.renameSync(probe, dir); return { inUse: false, reason: 'free' }; }
    catch { /* retry */ }
  }
  return { inUse: true, reason: `probe-restore-failed:${probe}` };
}

function procCwdProbe(dir, fsImpl) {
  let pids;
  try { pids = fsImpl.readdirSync('/proc').filter((n) => /^\d+$/.test(n)); }
  catch (e) { return { inUse: true, reason: `probe-error:${e?.code ?? e?.message}` }; }
  for (const pid of pids) {
    let cwd;
    try { cwd = fsImpl.readlinkSync(`/proc/${pid}/cwd`); } catch { continue; } // exited, or another user's
    if (isUnderDir(cwd, dir)) return { inUse: true, reason: `cwd-of-pid-${pid}` };
  }
  return { inUse: false, reason: 'free' };
}

// Beside the directory, not in it, so it outlives the removal: a session that
// hits ENOENT in its checkout can read what took it.
export function reclaimMarkerPath(dir) {
  return path.join(path.dirname(dir), `${path.basename(dir)}.reclaimed.json`);
}

export function writeReclaimMarker(dir, { branch = null, by, outcome, ts = Date.now() } = {}) {
  fs.writeFileSync(reclaimMarkerPath(dir), JSON.stringify({ dir, branch, by, outcome, ts }, null, 2));
}

export function clearReclaimMarker(dir) {
  fs.rmSync(reclaimMarkerPath(dir), { force: true });
}
