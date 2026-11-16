// server/lib/evaluation/episode-id.js
// Resolves the identity of a task episode: the unit this loop measures
// against instead of a raw session id. A single Claude Code session can span
// many unrelated tasks (one observed session spanned 7 days); an episode is
// the closest available proxy for "one task", resolved in priority order:
// backlog ticket id, else branch name, else worktree path, else session id.
// Pure, zero deps.
import * as backlogStore from '../orchestration/backlog-store.js';

/**
 * @param {{ ticketId?: string|null, branch?: string|null, worktreePath?: string|null, sessionId?: string|null }} opts
 * @returns {string|null}
 */
export function resolveEpisodeId({ ticketId, branch, worktreePath, sessionId } = {}) {
  for (const candidate of [ticketId, branch, worktreePath, sessionId]) {
    if (typeof candidate === 'string' && candidate) return candidate;
  }
  return null;
}

/**
 * Best-effort, fail-open lookup: does this session already belong to a
 * backlog ticket (the queue runner sets item.sessionId once a job's runtime
 * session is known)? Falls back to the session's cwd (worktree path in the
 * queue-runner's one-worktree-per-job model), then the session id itself.
 * @param {string} stateDir
 * @param {{ sessionId?: string|null, cwd?: string|null }} opts
 * @returns {string|null}
 */
export function episodeIdForSession(stateDir, { sessionId = null, cwd = null } = {}) {
  let ticketId = null;
  // Only search when sessionId is a real string: most backlog items have
  // sessionId:null (never attributed to a session), so matching against a
  // null/absent sessionId here would return an unrelated ticket's id instead
  // of falling through to cwd/sessionId as intended.
  if (typeof sessionId === 'string' && sessionId) {
    try {
      const items = backlogStore.load(stateDir)?.items ?? [];
      ticketId = items.find((i) => i && i.sessionId === sessionId)?.id ?? null;
    } catch { /* fail-open: no backlog signal, fall through */ }
  }
  return resolveEpisodeId({ ticketId, worktreePath: cwd, sessionId });
}
