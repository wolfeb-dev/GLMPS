// server/lib/observability/git-status.js
// Per-repo git working-tree status (dirty/ahead/behind/branch) for the
// dashboard's project rows. Parses `git status --porcelain=v2 --branch`,
// which is stable/scriptable (unlike the human-facing `git status`).
//
// House split: pure recipe builder + pure parser + an async scanner that
// takes an injected `exec(file, args) -> stdout | Promise<stdout>` - the
// server executes recipes with its own concurrency-limited execFile wrapper;
// this module never touches child_process directly, which is what keeps it
// synchronously testable.


export function statusRecipe(dir) {
  return { file: 'git', args: ['-C', dir, 'status', '--porcelain=v2', '--branch'] };
}


// porcelain=v2 --branch output: header lines start with `# `; everything else
// is one changed/untracked/unmerged/ignored path entry, one per line:
//   1 <XY> ...            ordinary changed entry
//   2 <XY> ...             renamed/copied entry
//   u <XY> ...             unmerged (conflicted) entry
//   ? <path>               untracked
//   ! <path>               ignored (excluded from the dirty count)
export function parseStatus(stdout) {
  let dirty = 0;
  let ahead = 0;
  let behind = 0;
  let branch = null;
  let head = null;
  let detached = false;

  for (const line of String(stdout ?? '').split('\n')) {
    if (line === '') continue;
    if (line.startsWith('# ')) {
      const header = line.slice(2);
      if (header.startsWith('branch.head ')) {
        branch = header.slice('branch.head '.length).trim();
        detached = branch === '(detached)';
      } else if (header.startsWith('branch.oid ')) {
        const oid = header.slice('branch.oid '.length).trim();
        head = /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(oid) ? oid : null;
      } else if (header.startsWith('branch.ab ')) {
        const m = /\+(\d+)\s+-(\d+)/.exec(header);
        if (m) {
          ahead = Number(m[1]);
          behind = Number(m[2]);
        }
      }
      continue;
    }
    if (line.startsWith('!')) continue; // ignored - not counted as dirty
    dirty++;
  }

  return { dirty, ahead, behind, branch, head, detached };
}


/**
 * @param dir  repo path
 * @param exec injected `(file, args) -> stdout | Promise<stdout>` (never
 *             child_process directly - the caller supplies a concurrency-
 *             limited execFile wrapper in production, a plain fake in tests).
 * @returns parsed status, or null on any error (missing repo, git failure,
 *          timeout) so the caller can degrade gracefully instead of crashing.
 */
export async function gitStatus(dir, exec) {
  try {
    const { file, args } = statusRecipe(dir);
    const stdout = await exec(file, args);
    return parseStatus(stdout);
  } catch {
    return null;
  }
}
