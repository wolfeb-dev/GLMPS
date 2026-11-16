// server/lib/project-roots.js
// Pure candidate filter (glmps-73): decides whether a session cwd is even
// eligible to be considered a project root, BEFORE a caller does its own
// .git-existence check. Platform-independent on purpose (same reasoning as
// zones.js / worktree-project.js): a session's cwd can be a Windows path even
// when this runs on a POSIX CI host, so no node:path here -- string/regex only.
//
// Root cause (glmps-73, confirmed against live data): the Antigravity CLI
// (agy) auto-`git init`s + snapshot-commits inside its own per-session scratch
// dir (~/.gemini/antigravity-cli/brain/<uuid>) as an internal undo mechanism,
// unrelated to any real user project. That gives the scratch dir a genuine
// .git DIRECTORY (not a worktree pointer file), so it slips past both the
// worktree filter and the plain .git-existence filter used by /api/projects,
// gitRepoRoots, and repoForProject, and pollutes all three with ~90 UUID-named
// "projects". Antigravity IDE's own brain/<uuid> dirs (no .git of their own)
// reach the same candidate list via the session-cwd fallback in pollCore()
// (cwd falls back to the session's own storage dir when no workspace label is
// known) -- excluding by parent dir keeps that case out too, regardless of
// whether that adapter ever starts stamping .git in there as well.

const norm = (p) => String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function under(child, parent) {
  const p = norm(parent).toLowerCase();
  if (!p) return false;
  const c = norm(child).toLowerCase();
  return c === p || c.startsWith(p + '/');
}

// isProjectRootCandidate(cwd, { antigravityDirs, claudeDir }) -> boolean
// Excludes a session cwd from ever being treated as a project-root candidate
// when either is true:
//   (a) it sits under any Antigravity data dir (P.antigravityDirs) or under
//       the Claude data dir (P.claudeDir) -- agent-internal scratch/session
//       storage, never a user project; or
//   (b) its basename is a bare UUID -- session-id-named scratch dirs are
//       never a legitimate project root on this machine, regardless of
//       location or of whether a caller's own .git filter would otherwise
//       admit it (agy-cli's auto-git-init makes that filter alone insufficient).
export function isProjectRootCandidate(cwd, { antigravityDirs = [], claudeDir = null } = {}) {
  const c = norm(cwd);
  if (!c) return false;
  for (const dir of antigravityDirs) if (under(c, dir)) return false;
  if (claudeDir && under(c, claudeDir)) return false;
  const basename = c.split('/').filter(Boolean).pop() ?? '';
  if (UUID_RE.test(basename)) return false;
  return true;
}
