// server/lib/orchestration/concurrent-writers.js
//
// Detect when 2+ live agent sessions share ONE working tree (same cwd, hence one
// .git/HEAD) with no worktree isolation - the condition under which two sessions
// silently overwrite each other's edits (the 2026-07-15 collision: two terminal
// `claude` sessions both in <repo> on main). Isolation machinery
// exists (glmps-71 worktrees) but defaults off and never reaches sessions launched
// by hand, so nothing warned that a sibling was live in the same directory.
//
// Pure + zero-dep. Two consumers:
//   - the dashboard alert (alert-sources.js), fed the live session index;
//   - the SessionStart warn hook (hooks/concurrency-warn.js), fed /api/state.

import { normPath } from './path-norm.js';

export const DEFAULT_STALE_MS = 15 * 60 * 1000;

export function normalizeCwd(cwd) {
  if (typeof cwd !== 'string' || !cwd) return '';
  return normPath(cwd, { collapse: true });
}

// A cwd under the isolated-worktrees dir is already isolated (its own checkout on
// its own branch); two sessions there do NOT collide.
export function isIsolatedWorktree(cwd, worktreesDir) {
  const c = normalizeCwd(cwd);
  if (!c) return false;
  // Convention: agent/session worktrees live under <repo>/.claude/worktrees/.
  // Recognize that directly so a standalone caller (the hook) needs no config.
  if (c.includes('/.claude/worktrees/')) return true;
  const w = normalizeCwd(worktreesDir);
  if (!w) return false;
  return c === w || c.startsWith(w + '/');
}

// A session counts as live unless we can prove it went stale (no recent heartbeat).
// With no clock (nowMs=0) or no lastTs, we can't prove staleness, so keep it.
//
// EXCEPT a dead index husk. The session index accumulates entries that can never
// be updated again: eventCount 0 and a transcriptPath whose file retention has
// since deleted, so lastTs stays 0 forever. The original fail-open counted every
// one of them as live, and because these only accumulate, they manufactured
// permanent, monotonically growing "N sessions sharing one working tree" alerts
// (measured 2026-07-29: 92 husks of 2,147 index entries produced 6 phantom
// groups, none of which contained 2 genuinely active sessions).
//
// eventCount is what separates a husk from a brand-new session: both have no
// heartbeat yet, but a session that has recorded activity still gets the benefit
// of the doubt, so a real collision at startup is still caught.
function isLive(s, nowMs, staleMs) {
  if (!s || !s.cwd) return false;
  const ts = Number(s.lastTs) || 0;
  if (!ts && !(Number(s.eventCount) > 0)) return false; // dead husk
  if (!nowMs) return true;
  if (!ts) return true; // activity but no heartbeat: absence does not prove staleness
  return nowMs - ts <= staleMs;
}

// Collision groups: 2+ live, non-isolated sessions sharing one normalized cwd.
export function detectConcurrentWriters({ sessions = [], worktreesDir = '', nowMs = 0, staleMs = DEFAULT_STALE_MS } = {}) {
  const byCwd = new Map();
  for (const s of Array.isArray(sessions) ? sessions : []) {
    if (!isLive(s, nowMs, staleMs)) continue;
    if (isIsolatedWorktree(s.cwd, worktreesDir)) continue;
    const key = normalizeCwd(s.cwd);
    if (!key) continue;
    if (!byCwd.has(key)) byCwd.set(key, new Map());
    byCwd.get(key).set(s.id, s); // de-dup by session id
  }
  const groups = [];
  for (const [cwd, m] of byCwd) {
    if (m.size >= 2) groups.push({ cwd, sessions: [...m.values()] });
  }
  return groups;
}

// For the SessionStart hook: the OTHER live, non-isolated sessions sharing THIS
// session's cwd (excluding self). Non-empty => warn the starting session.
export function otherWritersInSameTree({ sessions = [], cwd, selfId, worktreesDir = '', nowMs = 0, staleMs = DEFAULT_STALE_MS } = {}) {
  const self = normalizeCwd(cwd);
  if (!self || isIsolatedWorktree(cwd, worktreesDir)) return [];
  const seen = new Map();
  for (const s of Array.isArray(sessions) ? sessions : []) {
    if (!s || s.id === selfId) continue;
    if (!isLive(s, nowMs, staleMs)) continue;
    if (isIsolatedWorktree(s.cwd, worktreesDir)) continue;
    if (normalizeCwd(s.cwd) !== self) continue;
    seen.set(s.id, s);
  }
  return [...seen.values()];
}

// The blind spot that hid the 2026-07-22 collision: both sessions were in
// DIFFERENT directories (one primary tree, one worktree) of the SAME repo, so
// every same-cwd check said "no problem" while they fought over main. This
// reports live sessions sharing this session's repository regardless of
// directory, including isolated worktrees, which otherWritersInSameTree
// deliberately exempts.
//
// repoKeyOf(cwd) -> a stable per-repo identity (the git common dir) or null.
// Injected so this module stays pure and testable; the hook supplies a
// git-backed implementation.
export function otherWritersInSameRepo({ sessions = [], cwd, selfId, repoKeyOf, nowMs = 0, staleMs = DEFAULT_STALE_MS } = {}) {
  if (typeof repoKeyOf !== 'function') return [];
  const selfKey = repoKeyOf(cwd);
  if (!selfKey) return [];
  const selfCwd = normalizeCwd(cwd);
  const seen = new Map();
  for (const s of Array.isArray(sessions) ? sessions : []) {
    if (!s || s.id === selfId || !s.cwd) continue;
    if (!isLive(s, nowMs, staleMs)) continue;
    if (normalizeCwd(s.cwd) === selfCwd) continue; // same tree: the other check owns this
    if (repoKeyOf(s.cwd) !== selfKey) continue;
    seen.set(s.id, s);
  }
  return [...seen.values()];
}
