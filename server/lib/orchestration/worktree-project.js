// server/lib/orchestration/worktree-project.js
// Pure cwd classifier (glmps-71 task A3): recognizes a session or runner-job
// cwd living under the runner's worktrees base dir and resolves it back to its
// PARENT project, so a worktree-isolated session never fragments into its own
// project row on the dashboard (Kanban navigator, Analytics grouping, session
// titles). Platform-independent on purpose (same reasoning as zones.js): a
// session's cwd can be a Windows path even when this runs on a POSIX CI host,
// so no node:path here - string/regex only.
//
// Layout produced by server/lib/orchestration/worktrees.js:
//   session:  <worktreesDir>/<project>/session-<shortSessionId>   (sessionWorktreePlan)
//   runner:   <worktreesDir>/<project>/<jobId>                    (worktreePlan)
// `project` here is the sanitized slug (safeSeg'd), matching what other
// project-keying code already uses (e.g. path.basename(root) in /api/projects).

import { normPath } from './path-norm.js';

const norm = (p) => normPath(p, { lower: false });

// worktreeParent(cwd, { worktreesDir }) -> { project, kind: 'session'|'runner', id } | null
// Returns null when cwd is not under worktreesDir, or is missing the
// project/session-or-job segments needed to identify a specific worktree.
export function worktreeParent(cwd, { worktreesDir } = {}) {
  const base = norm(worktreesDir);
  const c = norm(cwd);
  if (!base || !c) return null;

  const baseLower = base.toLowerCase();
  const cLower = c.toLowerCase();
  const isExact = cLower === baseLower;
  const isNested = cLower.startsWith(baseLower + '/');
  if (!isExact && !isNested) return null;

  const rest = isExact ? '' : c.slice(base.length + 1);
  const segs = rest.split('/').filter(Boolean);
  if (segs.length < 2) return null; // need at least <project>/<session-or-job>

  const [project, second] = segs;
  if (/^session-/i.test(second)) {
    return { project, kind: 'session', id: second.replace(/^session-/i, '') };
  }
  return { project, kind: 'runner', id: second };
}

// worktreeInfo(cwd, { worktreesDir }) -> { branch, parent, kind, id } | null
// Convenience wrapper for dashboard display (session cards, detail header,
// Analytics grouping): same classification as worktreeParent, plus the branch
// name reconstructed via the exact naming convention sessionWorktreePlan /
// worktreePlan already use (server/lib/orchestration/worktrees.js) - 
// session/<project>/<id> or glmps-runner/<project>/<id>. Derived purely from
// cwd, so it does not depend on any stamp made at launch time surviving into
// the session's persisted record.
export function worktreeInfo(cwd, opts = {}) {
  const wt = worktreeParent(cwd, opts);
  if (!wt) return null;
  const branch = wt.kind === 'session'
    ? `session/${wt.project}/${wt.id}`
    : `glmps-runner/${wt.project}/${wt.id}`;
  return { branch, parent: wt.project, kind: wt.kind, id: wt.id };
}
