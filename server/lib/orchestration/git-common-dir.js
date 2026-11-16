// server/lib/orchestration/git-common-dir.js
// One scan root per repository (glmps-192). Every linked worktree of a repo
// (.claude/worktrees/*, D:/<repo>-wt-*) is its own git checkout, so a root
// set built from session cwds and additionalDirectories listed the same repo
// up to seven times, and the residency feed and the unmerged-branch scan each
// repeated every branch query once per copy on the shared 3-slot git limiter.
// Reads only the .git pointer files on disk (no git subprocess), so it is
// safe to call synchronously from gitRepoRoots().
import fs from 'node:fs';
import path from 'node:path';

export const commonDirKey = (p) => path.resolve(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

// A .git directory is its own common dir. A .git FILE names a gitdir; a
// linked worktree's gitdir (<repo>/.git/worktrees/<id>) holds a `commondir`
// file pointing back at <repo>/.git, while a submodule's gitdir has none and
// is a separate repository. Null when the root is not readable as a checkout.
export function gitCommonDir(root) {
  const dotGit = path.join(root, '.git');
  try {
    const st = fs.statSync(dotGit);
    if (st.isDirectory()) return dotGit;
    const m = fs.readFileSync(dotGit, 'utf8').match(/^gitdir:\s*(.+)$/m);
    if (!m) return null;
    const gitDir = path.resolve(root, m[1].trim());
    try { return path.resolve(gitDir, fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim()); }
    catch { return gitDir; }
  } catch { return null; }
}

function isPrimaryCheckout(root) {
  try { return fs.statSync(path.join(root, '.git')).isDirectory(); } catch { return false; }
}

// Keeps one root per common dir, in input order. The survivor is the
// primary checkout (where the operator works, so its dirty state is the one
// worth reporting) if it is in the set, else the first linked worktree seen.
// A root whose common dir cannot be read is kept: dropping a repo from the
// scan would be a silent loss, a duplicate is only a cost.
export function dedupeByCommonDir(roots, { commonDirOf = gitCommonDir, isPrimary = isPrimaryCheckout } = {}) {
  const winner = new Map();
  const groupOf = roots.map((r) => {
    const cd = commonDirOf(r);
    if (!cd) return null;
    const k = commonDirKey(cd);
    if (!winner.has(k) || (isPrimary(r) && !isPrimary(winner.get(k)))) winner.set(k, r);
    return k;
  });
  return roots.filter((r, i) => groupOf[i] === null || winner.get(groupOf[i]) === r);
}
