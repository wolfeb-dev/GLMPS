// server/lib/observability/revert-scan.js
//
// Find revert commits since a watermark (handoff A0.3, and the resolution of
// the spec's open question G5).
//
// The spec assumed git hooks would emit revert and merge events, and listed
// installing them as a prerequisite for A0.3 being testable. This module
// replaces that plan for two reasons:
//
//   1. A git hook only fires in the clone where the command ran. A revert
//      pushed from another machine, merged through a PR on GitHub, or made in
//      a sibling worktree by a different agent produces no local hook event at
//      all - and those are precisely the reverts most likely to invalidate a
//      lesson nobody is watching.
//   2. A hook has to be installed, per repo, by hand. A scan needs nothing
//      installed and works retroactively on history that already exists.
//
// So: read `git log` since a per-repo watermark, pull the reverted refs out of
// the commit bodies, and hand them to the provenance sweep.
//
// Only git's own generated trailer counts. `git revert` writes an exact line,
// "This reverts commit <sha>.", and matching only that shape means a doc that
// says "here is how to revert commit abc1234" cannot invalidate a lesson. The
// false-positive cost here is high (a lesson wrongly invalidated is silently
// lost knowledge), so the parser is deliberately strict rather than clever.
//
// Zero runtime dependencies. `runGit` is injectable so every test is offline.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

// <sha> NUL <full body> 0x1e, so a body containing blank lines (every real
// commit body does) cannot be confused with a record boundary.
export const LOG_FORMAT = '%H%x00%B%x1e';

const RS = String.fromCharCode(0x1e);
const NUL = String.fromCharCode(0);

// git's own revert trailer, anchored to a line start so prose cannot match.
const REVERT_TRAILER = /^\s*This reverts commit ([0-9a-f]{7,40})\b/gim;

/**
 * Pull every reverted ref out of a list of commit bodies.
 * @param bodies string[]
 * @returns string[] lowercased shas, de-duplicated, in first-seen order
 */
export function revertedRefs(bodies = []) {
  const out = [];
  const seen = new Set();
  for (const body of bodies) {
    if (typeof body !== 'string') continue;
    REVERT_TRAILER.lastIndex = 0;
    let m;
    while ((m = REVERT_TRAILER.exec(body)) !== null) {
      const ref = m[1].toLowerCase();
      if (!seen.has(ref)) { seen.add(ref); out.push(ref); }
    }
  }
  return out;
}

const DEFAULT_TIMEOUT_MS = 30_000;

function defaultRunGit(repo, timeoutMs) {
  return (args) => new Promise((resolve, reject) => {
    execFile('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024, timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) reject(new Error(err.killed ? `git log timed out after ${timeoutMs} ms` : (String(stderr ?? '').trim() || err.message)));
      else resolve(stdout ?? '');
    });
  });
}

/**
 * Scan a repo for revert commits since a watermark.
 *
 * @param repo     absolute path to the repo
 * @param since    the previous head sha, or null for "everything reachable"
 * @param runGit   injectable (args) -> stdout, or a promise of it
 * @param timeoutMs  bound on the git call; a hung git reports an error
 * @returns { refs: string[], head: string|null, error?: string }
 *
 * Never throws. A missing repo, a detached state, a watermark sha that no
 * longer exists after a force-push: all of these report "nothing found" with
 * the reason attached. The caller is a nightly sweep, and a sweep that crashes
 * the run because one repo moved is worse than a sweep that skips it.
 */
export async function scanReverts({ repo, since = null, runGit, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const run = runGit ?? defaultRunGit(repo, timeoutMs);
  const range = since ? `${since}..HEAD` : null;
  const args = ['log', `--format=${LOG_FORMAT}`, ...(range ? [range] : [])];

  let raw;
  try {
    let timer;
    const limit = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`git log timed out after ${timeoutMs} ms`)), timeoutMs); });
    try { raw = await Promise.race([Promise.resolve().then(() => run(args)), limit]); } finally { clearTimeout(timer); }
  } catch (e) {
    return { refs: [], head: null, error: e?.message ?? String(e) };
  }

  const records = String(raw).split(RS).map((r) => r.trim()).filter(Boolean);
  if (records.length === 0) return { refs: [], head: null };

  const bodies = [];
  let head = null;
  for (const rec of records) {
    const i = rec.indexOf(NUL);
    if (i === -1) continue;
    const sha = rec.slice(0, i).trim();
    if (head === null && sha) head = sha; // git log is newest-first
    bodies.push(rec.slice(i + 1));
  }

  return { refs: revertedRefs(bodies), head };
}

// Watermark
//
// Per repo, so scanning one repo cannot advance another's cursor. Kept in one
// small JSON file rather than a ledger: it is a cursor, not history, and it is
// always safe to lose (losing it just re-scans, which is idempotent because
// the sweep it feeds is idempotent).

function watermarkFile(stateDir) {
  return path.join(stateDir, 'lessons', 'revert-watermarks.json');
}

function loadAll(stateDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(watermarkFile(stateDir), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function readWatermark(stateDir, repoKey) {
  const v = loadAll(stateDir)[repoKey];
  return typeof v === 'string' && v ? v : null;
}

export function writeWatermark(stateDir, repoKey, head) {
  const all = loadAll(stateDir);
  all[repoKey] = head;
  const file = watermarkFile(stateDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(all, null, 2));
  fs.renameSync(tmp, file);
  return all;
}
