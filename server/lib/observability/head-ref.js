// server/lib/observability/head-ref.js
//
// Resolve a repo's current HEAD sha by READING the git directory, not by
// spawning git.
//
// Why this exists: A0.3's revert sweep matches reverted commit shas against a
// lesson's `derivedFromRefs`. A lesson with no refs can never be invalidated
// by reverting the code it came from, which makes the sweep decorative for the
// most common lesson source (a gap detected during a session). So the gap
// pipeline needs the commit state a gap was observed against.
//
// Why not `git rev-parse HEAD`: the call site is the /api/state poll loop and
// the Stop hook, both of which run on this codebase's hot path, and spawning a
// subprocess per gap per poll is exactly the sync-git-on-the-event-loop
// pattern that a previous perf fix removed from this server. Reading two small
// files is cheap enough to do inline and spawns nothing.
//
// Handles the three layouts that actually occur here:
//   * a normal repo         .git/ is a directory
//   * a linked worktree     .git is a FILE containing "gitdir: <path>"
//   * packed refs           .git/refs/heads/<branch> does not exist; the sha
//                           lives in .git/packed-refs
// and a detached HEAD, where .git/HEAD is the sha itself.
//
// Returns null for anything it cannot resolve. A null ref means "this lesson
// is outside the revert sweep's reach", which is a correct and honest state;
// guessing a sha would be far worse, since a wrong ref could invalidate an
// unrelated lesson.
import fs from 'node:fs';
import path from 'node:path';

const SHA_RE = /^[0-9a-f]{40}$/i;
const DEFAULT_TTL_MS = 60_000;

// repoPath -> { sha, at }
const cache = new Map();

export function clearHeadRefCache() { cache.clear(); }

// Resolve the real git dir for a path: either <repo>/.git as a directory, or
// the "gitdir: ..." pointer a linked worktree leaves in its place.
function gitDirOf(repoPath) {
  const dotGit = path.join(repoPath, '.git');
  let st;
  try { st = fs.statSync(dotGit); } catch { return null; }
  if (st.isDirectory()) return dotGit;
  if (!st.isFile()) return null;
  try {
    const m = fs.readFileSync(dotGit, 'utf8').match(/^gitdir:\s*(.+)\s*$/m);
    if (!m) return null;
    const p = m[1].trim();
    return path.isAbsolute(p) ? p : path.resolve(repoPath, p);
  } catch { return null; }
}

function fromPackedRefs(gitDir, ref) {
  try {
    for (const line of fs.readFileSync(path.join(gitDir, 'packed-refs'), 'utf8').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#') || t.startsWith('^')) continue;
      const [sha, name] = t.split(/\s+/);
      if (name === ref && SHA_RE.test(sha)) return sha.toLowerCase();
    }
  } catch { /* no packed-refs */ }
  return null;
}

function resolve(repoPath) {
  const gitDir = gitDirOf(repoPath);
  if (!gitDir) return null;

  let head;
  try { head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim(); } catch { return null; }

  // Detached HEAD: the file is the sha.
  if (SHA_RE.test(head)) return head.toLowerCase();

  const m = head.match(/^ref:\s*(.+)$/);
  if (!m) return null;
  const ref = m[1].trim();

  // A linked worktree keeps its own HEAD but shares refs with the common dir,
  // so a loose ref may live under either. commondir points at the shared one.
  const roots = [gitDir];
  try {
    const common = fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim();
    if (common) roots.push(path.isAbsolute(common) ? common : path.resolve(gitDir, common));
  } catch { /* not a linked worktree */ }

  for (const root of roots) {
    try {
      const sha = fs.readFileSync(path.join(root, ref), 'utf8').trim();
      if (SHA_RE.test(sha)) return sha.toLowerCase();
    } catch { /* try the next root, then packed-refs */ }
  }
  for (const root of roots) {
    const packed = fromPackedRefs(root, ref);
    if (packed) return packed;
  }
  return null;
}

/**
 * The current HEAD sha of `repoPath`, or null.
 *
 * Cached for `ttlMs` because the call site can ask many times per poll tick
 * for the same repo, and HEAD moves at human speed.
 *
 * `now` is injectable so the cache behavior is testable without sleeping.
 */
export function headRef(repoPath, { now = Date.now(), ttlMs = DEFAULT_TTL_MS } = {}) {
  if (!repoPath || typeof repoPath !== 'string') return null;
  const hit = cache.get(repoPath);
  if (hit && now - hit.at < ttlMs) return hit.sha;
  const sha = resolve(repoPath);
  cache.set(repoPath, { sha, at: now });
  return sha;
}
