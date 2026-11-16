#!/usr/bin/env node
// SessionStart hook: warn when another live agent session is already working in
// THIS session's working tree, or elsewhere in the same repository.
//
// Two collisions shaped this hook:
//   2026-07-15 -- two `claude` sessions in <repo> on main, silently
//     overwriting each other's edits and uncommitted work. Same-cwd detection
//     was built for exactly that.
//   2026-07-22 -- two sessions in DIFFERENT trees of one repo (primary tree plus
//     a worktree) both advancing main: 12 alternating pushes to origin/main in
//     three hours. Same-cwd detection is blind to it by construction, because it
//     exempts isolated worktrees. Hence the repo-scope check below.
//
// Registered project-scoped (.claude/settings.json) so it fires for any session
// started IN this repo, including hand-launched CLI sessions that never touch
// GLMPS's launcher.
//
// It reports; it does not block. Enforcement on the integration ref is
// hooks/push-lease-guard.js.
//
// glmps-149: this hook used to read /api/state (~1.35 MB, growing with all-time
// session history) on a 900ms budget, and `catch { return []; }` made every
// timeout indistinguishable from a clean check. Measured across four real
// SessionStarts: 511ms, 231ms, 257ms, and one TimeoutError. It now reads the
// bounded /api/sessions/live endpoint, and says so out loud when it cannot.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { otherWritersInSameTree, otherWritersInSameRepo, isIsolatedWorktree }
  from '../server/lib/orchestration/concurrent-writers.js';

const PORT = process.env.GLMPS_PORT || '8123';
const HTTP_TIMEOUT_MS = Number(process.env.GLMPS_HOOK_HTTP_TIMEOUT_MS) || 3000;

// Returns { sessions } on success, or { unavailable: reason }. An unavailable
// check must never look like a clean one.
async function liveSessions() {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/sessions/live`, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
    if (!res.ok) return { unavailable: `dashboard returned HTTP ${res.status}` };
    const data = await res.json();
    const sessions = Array.isArray(data?.sessions) ? data.sessions : [];
    return { sessions: sessions.map((s) => ({ id: s.id ?? s.sessionId, cwd: s.cwd, lastTs: Number(s.lastTs) || 0 })) };
  } catch (e) {
    return { unavailable: e?.name === 'TimeoutError' ? `dashboard did not answer within ${HTTP_TIMEOUT_MS}ms` : 'dashboard unreachable' };
  }
}

// Stable per-repo identity: the git common dir, which every linked worktree of a
// repo shares. Cached, since sibling sessions often live in the same tree.
const repoKeyCache = new Map();
function repoKeyOf(cwd) {
  if (!cwd) return null;
  if (repoKeyCache.has(cwd)) return repoKeyCache.get(cwd);
  let key = null;
  try {
    key = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      { cwd, encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] })
      .trim().replace(/\\/g, '/').toLowerCase() || null;
  } catch { key = null; }
  repoKeyCache.set(cwd, key);
  return key;
}

function emit(msg) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: msg },
  }));
}

function sameTreeMessage(others, cwd) {
  const ids = others.map((o) => o.id).filter(Boolean).slice(0, 4).join(', ');
  return `Concurrent-writer warning: ${others.length} other live session(s) are already working in this ` +
    `exact directory (${cwd}) with no worktree isolation${ids ? ` [${ids}]` : ''}. Two sessions in one ` +
    `working tree share one .git/HEAD and can silently overwrite each other's edits and uncommitted work ` +
    `(the 2026-07-15 collision). If you will edit code here, isolate first ` +
    `(git worktree add ../<name> -b <branch>, then cd there) or commit early and often - never rely on ` +
    `uncommitted edits surviving, and avoid 'git checkout --'/branch switches that could clobber a sibling.`;
}

function sameRepoMessage(others) {
  const where = others.map((o) => `${o.id?.slice(0, 8) ?? '?'} in ${o.cwd}`).slice(0, 4).join('; ');
  return `Concurrent-repo notice: ${others.length} other live session(s) are working in this repository ` +
    `from a different directory [${where}]. Your files are isolated, but the integration ref is not: ` +
    `this is the 2026-07-22 collision, where two correctly-isolated sessions both advanced main and one ` +
    `session's local main went stale under an active merge. Before integrating, fetch and check whether ` +
    `the ref moved. The push-lease guard will block a push that races another holder.`;
}

async function run(inp) {
  const cwd = inp.cwd || process.cwd();
  const selfId = inp.session_id || inp.sessionId || null;

  const res = await liveSessions();
  if (res.unavailable) {
    emit(`Concurrent-writer check DID NOT RUN: ${res.unavailable}. Other live sessions may be working in ` +
      `this directory or repository and you have not been told about them. Treat this as unknown, not clear: ` +
      `check 'git worktree list' and the dashboard before editing shared files or pushing to the default branch.`);
    return;
  }

  const nowMs = Date.now();
  const sessions = res.sessions;
  const parts = [];

  // Same tree: the hard case. Skipped when this session is itself isolated.
  if (!isIsolatedWorktree(cwd, '')) {
    const sameTree = otherWritersInSameTree({ sessions, cwd, selfId, nowMs });
    if (sameTree.length) parts.push(sameTreeMessage(sameTree, cwd));
  }

  // Same repo, different tree: applies even when this session IS isolated,
  // which is exactly why the old hook could not see the 2026-07-22 collision.
  const sameRepo = otherWritersInSameRepo({ sessions, cwd, selfId, repoKeyOf, nowMs });
  if (sameRepo.length) parts.push(sameRepoMessage(sameRepo));

  if (parts.length) emit(parts.join('\n\n'));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => { raw += d; });
  process.stdin.on('end', async () => {
    try {
      await run(JSON.parse(raw || '{}'));
    } catch { /* fail open - never block a session start */ }
    process.exit(0);
  });
  process.stdin.on('error', () => process.exit(0));
}
