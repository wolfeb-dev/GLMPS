// server/lib/orchestration/release-version.js
//
// Automatic version numbers for the merge queue (cards glmps-2-0-209 and
// glmps-2-0-216, spec docs/specs/glmps-2-0-216-release-in-shell.md). The
// kernel may not push, so after a merge it asks the desktop app for one fixed
// release action (apps/shell/src/lib/release-run.js) through the gitops
// broker, and sends values only: the checkout, repo, base, PR number, card id,
// bump kind and gate summary. The app computes the version, reads the PR title
// for the changelog, commits, pushes, tags and creates the GitHub Release.
// The card title (often the operator's chat text) never leaves the kernel.

export const bumpKind = (taskClass) => (taskClass === 'feature' ? 'minor' : 'patch');

const clip = (s) => String(s ?? '').trim().slice(0, 300);

/**
 * Ask the desktop app to release one merged PR. `run` is the gitops broker's
 * run(). Resolves { ok: true, version, sha }, { ok: true, skipped: true, reason }
 * or { ok: false, reason }; never throws.
 */
export async function requestRelease({ run, repoPath, mr, card, taskClass }) {
  if (!Number.isInteger(mr?.number) || mr.number < 1) return { ok: false, reason: 'the merge request has no PR number' };
  try {
    const r = await run({
      kind: 'release', cwd: repoPath, repo: mr.repo, base: mr.base, number: mr.number,
      cardId: card?.id, bump: bumpKind(taskClass), summary: typeof card?.summary === 'string' ? card.summary.slice(0, 4000) : '',
    });
    let doc = null;
    try { doc = JSON.parse(String(r?.stdout ?? '')); } catch { doc = null; }
    if (!doc || typeof doc !== 'object' || typeof doc.ok !== 'boolean') return { ok: false, reason: `the desktop app returned no release result: ${clip(r?.stderr || r?.stdout || `exit ${r?.status}`)}` };
    if (doc.ok && doc.skipped) return { ok: true, skipped: true, reason: clip(doc.reason) };
    if (doc.ok) return { ok: true, version: String(doc.version ?? ''), sha: String(doc.sha ?? '') };
    return { ok: false, reason: clip(doc.reason) || 'release failed' };
  } catch (e) {
    return { ok: false, reason: clip(e?.message ?? e) };
  }
}
