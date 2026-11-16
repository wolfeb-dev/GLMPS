// server/lib/governance/push-lease-store.js
//
// Persistence for the push lease. The lease lives in the repo's GIT COMMON DIR
// (`git rev-parse --git-common-dir`), which every linked worktree of a repo
// shares. That sharing is the point: the 2026-07-22 collision was two sessions
// in different worktrees of one repo both advancing main, so the contention
// domain has to be the repo, not the directory.
//
// Being inside .git also means the lease can never be committed and needs no
// .gitignore entry.
//
// Every function fails soft. A guard that throws would brick every Bash call.

import fs from 'node:fs';
import path from 'node:path';

const LEASE_FILE = 'mc-push-lease.json';

export function leasePath(gitCommonDir) {
  return path.join(String(gitCommonDir ?? ''), LEASE_FILE);
}

/** @returns {object|null} the lease, or null if absent/corrupt/unreadable. */
export function readLease(gitCommonDir) {
  try {
    const raw = fs.readFileSync(leasePath(gitCommonDir), 'utf8');
    const j = JSON.parse(raw);
    return j && typeof j === 'object' ? j : null;
  } catch {
    return null;
  }
}

/** Atomic replace: write a temp file next to the target, then rename over it. */
export function writeLease(gitCommonDir, lease) {
  const target = leasePath(gitCommonDir);
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(lease));
    fs.renameSync(tmp, target);
    return true;
  } catch {
    try { fs.unlinkSync(tmp); } catch { /* nothing to clean up */ }
    return false;
  }
}

export function clearLease(gitCommonDir) {
  try {
    fs.unlinkSync(leasePath(gitCommonDir));
    return true;
  } catch {
    return false; // already gone, or unwritable
  }
}
