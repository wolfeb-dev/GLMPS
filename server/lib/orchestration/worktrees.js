// server/lib/orchestration/worktrees.js
// Shared git-worktree isolation (glmps-71). Extracted from queue-runner.js so
// interactive sessions (terminal launcher, resume, chat-ticket launches) reuse the
// same pure plan/recipe helpers as runner jobs. House split: pure recipes +
// parsers here; callers execute them through an async git runner (never a
// shell, never on the server event loop).
import path from 'node:path';
import { normPath } from './path-norm.js';

// Isolation is mandatory once more than one lane can run (maxConcurrent > 1)
// and can be forced on for a single lane via the `useWorktrees` config flag.
export function shouldIsolate({ useWorktrees = false, maxConcurrent = 1 } = {}) {
  return !!useWorktrees || maxConcurrent > 1;
}

// Scrub anything that is not path- and git-branch-safe (spaces, ~ ^ : ? * etc.)
// down to '-', so the worktree dir is clean and the branch name is git-legal.
// A dot-only segment ('.', '..') would walk path.join out of baseDir, so it is
// replaced too.
export function safeSeg(s) {
  const seg = String(s ?? '').replace(/[^A-Za-z0-9._-]/g, '-');
  return /^\.+$/.test(seg) ? '-' : seg;
}

// Deterministic, collision-free location + branch for a runner job: one dir per
// (project, jobId) under baseDir, on branch glmps-runner/<project>/<jobId>.
export function worktreePlan({ baseDir, project, jobId }) {
  const proj = safeSeg(project);
  const job = safeSeg(jobId);
  return { dir: path.join(baseDir, proj, job), branch: `glmps-runner/${proj}/${job}` };
}

// Same shape for an interactive session: branch session/<project>/<shortid>,
// so the unmerged-branch guard (and humans) can tell session worktrees from
// runner-job worktrees at a glance.
export function sessionWorktreePlan({ baseDir, project, sessionId }) {
  const proj = safeSeg(project);
  const sid = safeSeg(String(sessionId ?? '').slice(0, 12));
  return { dir: path.join(baseDir, proj, `session-${sid}`), branch: `session/${proj}/${sid}` };
}

// Pure git command recipes (file + argv). `-B` (force-create/reset) tolerates
// a leftover branch from a crashed run. `startPoint` is the freshly fetched
// upstream: without it the branch starts at the repo checkout's HEAD, which
// lags whatever was merged since the checkout last pulled (glmps-2-0-41).
export function worktreeAddRecipe({ repo, dir, branch, startPoint = null }) {
  const args = ['-C', repo, 'worktree', 'add', '-B', branch, dir];
  if (startPoint) args.push(startPoint);
  return { file: 'git', args };
}

/**
 * Add a worktree on `branch`, tolerating a leftover branch from a crashed run.
 * `-B` resets the branch to the start point, which would discard commits an
 * agent made on it and that the start point lacks; in that case the branch is
 * reused as it is and `reusedBranch` is true so the caller can say so in the
 * devlog. `run(recipe)` resolves `{ status, stdout, stderr }` and never throws.
 * A failed probe falls through to plain `-B`, as before.
 */
export async function addWorktree({ repo, dir, branch, startPoint = null, run }) {
  const exists = await run({ file: 'git', args: ['-C', repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`] });
  if (exists.status === 0) {
    const behind = await run({ file: 'git', args: ['-C', repo, 'merge-base', '--is-ancestor', branch, startPoint || 'HEAD'] });
    if (behind.status === 1) {
      const r = await run(worktreeCheckoutRecipe({ repo, dir, branch }));
      return { ok: r.status === 0, reusedBranch: true, result: r };
    }
  }
  const r = await run(worktreeAddRecipe({ repo, dir, branch, startPoint }));
  return { ok: r.status === 0, reusedBranch: false, result: r };
}

// The worktree already holding a branch, from git's refusal to check it out a
// second time ("... is already used by worktree at '<path>'" or
// "... is already checked out at '<path>'"). null for any other failure.
export function branchOwnerFromStderr(stderr) {
  const m = /(?:already used by worktree|already checked out) at '([^']+)'/.exec(String(stderr ?? ''));
  return m ? m[1] : null;
}

// Re-attach an existing branch at `dir` (a reopened card whose worktree was
// cleaned up after its outcome was recorded).
export function worktreeCheckoutRecipe({ repo, dir, branch }) {
  return { file: 'git', args: ['-C', repo, 'worktree', 'add', dir, branch] };
}
export function worktreeFetchRecipe({ repo }) {
  return { file: 'git', args: ['-C', repo, 'fetch', '-q', 'origin'] };
}
// The remote-tracking ref the checkout's branch follows, e.g. `origin/main`
// or `origin/glmps2/main`. Fails when the branch has no upstream.
export function upstreamRefRecipe({ repo }) {
  return { file: 'git', args: ['-C', repo, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'] };
}
// The remote's default branch, e.g. `origin/main`: the start point when the
// checkout has no upstream. The live clone sits on a detached HEAD because its
// main is checked out by the service's own worktree (card glmps-2-0-159).
export const REMOTE_DEFAULT_REF_ARGS = Object.freeze(['rev-parse', '--abbrev-ref', 'origin/HEAD']);
export function remoteDefaultRefRecipe({ repo }) {
  return { file: 'git', args: ['-C', repo, ...REMOTE_DEFAULT_REF_ARGS] };
}
export function worktreeRemoveRecipe({ repo, dir }) {
  return { file: 'git', args: ['-C', repo, 'worktree', 'remove', '--force', dir] };
}
export function worktreePruneRecipe({ repo }) {
  return { file: 'git', args: ['-C', repo, 'worktree', 'prune'] };
}
export function listWorktreesRecipe({ repo }) {
  return { file: 'git', args: ['-C', repo, 'worktree', 'list', '--porcelain'] };
}

// Parse `git worktree list --porcelain`: blank-line-separated stanzas of
// `worktree <path>` / `HEAD <sha>` / `branch refs/heads/<name>` (or `detached`).
export function parseWorktreeList(text) {
  const out = [];
  let cur = null;
  for (const line of String(text ?? '').split('\n')) {
    const l = line.trim();
    if (l.startsWith('worktree ')) { cur = { dir: l.slice(9), branch: null, head: null }; out.push(cur); }
    else if (cur && l.startsWith('HEAD ')) cur.head = l.slice(5);
    else if (cur && l.startsWith('branch refs/heads/')) cur.branch = l.slice(18);
    else if (!l) cur = null;
  }
  return out;
}

/**
 * Is `dir` the same as, or inside, `base`?
 *
 * Shared by the sweeper (occupancy + managed-dir containment) and the runner's
 * worktree reclaim, which MUST agree: a one-sided guard here is how a live
 * agent's checkout gets deleted by the path the other side would have spared
 * (glmps-53). Windows-tolerant (backslashes, drive-letter case) and
 * trailing-slash tolerant. An empty base returns false rather than matching
 * everything.
 */
// Shared by isUnderDir and pathsEqual below - one normalization rule, so a
// containment check and an identity check can never quietly diverge on what
// "the same path" means (Windows-tolerant: separator, drive-letter case,
// trailing slash).

export function isUnderDir(dir, base) {
  const d = normPath(dir), b = normPath(base);
  if (!d || !b) return false;
  return d === b || d.startsWith(b + '/');
}

/**
 * Is `a` the SAME directory as `b`? Task 11 fix round 1, minor: a purge
 * route matching a card's recorded worktree against `git worktree list`'s
 * own entries needs exact identity, not containment - a bare `===` on two
 * `fs.realpathSync` results is case-SENSITIVE, and on win32 a drive letter
 * can legitimately come back a different case than the caller's own path,
 * producing a false negative (and here, a false 404) for a perfectly real,
 * registered worktree.
 */
export function pathsEqual(a, b) {
  const x = normPath(a), y = normPath(b);
  return !!x && x === y;
}
