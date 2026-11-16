// server/lib/observability/unmerged-branches.js
// Finished-but-unmerged branch guard (glmps-66). Catches the recurring miss where
// a session commits finished work to a feature branch and nobody merges it: flags
// local branches that are patch-ahead of the default branch, idle past a staleness
// threshold, and not referenced by any open backlog ticket. Findings surface as
// dashboard alerts via collectAlerts() -> /api/alerts.
//
// House split: pure git recipes + parsers + detector here; the server executes
// recipes with execFileSync (never a shell) and injects `exec` into scanRepos.

import fs from 'node:fs';
import path from 'node:path';
import { CLOSED_STATES } from '../orchestration/backlog-store.js';

const DAY_MS = 24 * 60 * 60 * 1000;
// sourced from backlog-store.js's single
// CLOSED_STATES rather than a local copy, so this cannot drift from it the
// way nightly-exec.js's own FINISHED copy already did once. idle is
// deliberately excluded there (reopenable), so an idle ticket's branch still
// counts as referenced here, same as any other open ticket.
const OPEN_STATES_EXCLUDED = CLOSED_STATES;


export function forEachRefRecipe({ repo }) {
  return {
    file: 'git',
    args: ['-C', repo, 'for-each-ref', '--format=%(refname:short)\t%(committerdate:unix)\t%(objectname)', 'refs/heads'],
  };
}

// git cherry: `+ sha` = commit whose patch is NOT in base (truly unmerged),
// `- sha` = patch-equivalent (already in base under another SHA). Using cherry
// instead of rev-list means content-merged branches never fire.
export function cherryRecipe({ repo, base, branch }) {
  return { file: 'git', args: ['-C', repo, 'cherry', base, branch] };
}

export function defaultBranchRecipe({ repo }) {
  return { file: 'git', args: ['-C', repo, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'] };
}

export function revParseRecipe({ repo, ref }) {
  return { file: 'git', args: ['-C', repo, 'rev-parse', '--verify', '--quiet', ref] };
}


export function parseRefList(text) {
  const out = [];
  for (const line of String(text ?? '').split('\n')) {
    const [name, unix, sha] = line.trim().split('\t');
    if (!name || !unix || isNaN(Number(unix))) continue;
    out.push({ name, lastCommitMs: Number(unix) * 1000, ...(sha ? { sha } : {}) });
  }
  return out;
}

// glmps-2-0-runtime-86: a boot launched 660 `git cherry` processes in 90 s and
// the disk contention stalled the kernel's sync reads for seconds. Cherry's
// answer depends only on the base and branch tips, so `cache` (a Map shared by
// every caller) holds it per tip pair. A missing tip skips the cache and a
// failed run is dropped from it, so the next call retries.
const CHERRY_CACHE_MAX = 5000;
export function cherryFor({ exec, cache, repo, base, baseSha, branch, branchSha }) {
  const run = async () => parseCherry(await exec(...toPair(cherryRecipe({ repo, base, branch }))));
  if (!cache || !baseSha || !branchSha) return run();
  const key = `${repo}\0${baseSha}\0${branchSha}`;
  if (cache.has(key)) return cache.get(key);
  if (cache.size >= CHERRY_CACHE_MAX) cache.clear();
  const p = run();
  cache.set(key, p);
  p.catch(() => { if (cache.get(key) === p) cache.delete(key); });
  return p;
}

// The keys are commit ids, so a saved answer never goes stale: a restart that
// loads the file launches cherry only for tips that moved while it was down.
// Pending git results can take seconds to settle, so `shouldWrite` is asked
// after they do: a server that closed meanwhile gets no late write into stateDir.
export async function saveCherryCache(file, cache, { shouldWrite = () => true } = {}) {
  const entries = await Promise.allSettled([...cache].map(async ([k, p]) => [k, await p]));
  if (!shouldWrite()) return;
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const out = Object.fromEntries(entries.filter((e) => e.status === 'fulfilled').map((e) => e.value));
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.promises.writeFile(tmp, JSON.stringify(out));
  await fs.promises.rename(tmp, file);
}

// The scan's git exec, refused once the server has closed, so a scan still
// running at shutdown spawns no new child.
export const closableExec = (isClosed, exec) => (file, args) => (isClosed() ? Promise.reject(new Error('server closed')) : exec(file, args));

export function loadCherryCache(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return new Map(Object.entries(raw).slice(-CHERRY_CACHE_MAX).map(([k, v]) => [k, Promise.resolve(v)]));
  } catch { return new Map(); }
}

export const tipsOf = (refs) => new Map(refs.filter((r) => r.sha).map((r) => [r.name, r.sha]));

/**
 * The default branch as { name, base, baseSha }. `name` is the bare local name
 * (what the branch list and alerts are labelled and filtered by), `base` is what
 * to compare against: the remote-tracking ref (`origin/main`) when origin/HEAD
 * resolves, else the local name. A local main nobody pulls goes stale, and
 * against it every branch cut from a fresh origin/main reads as unmerged.
 * `baseSha` keys the cherry cache, so it must be the tip of `base`, never the
 * local head's; it stays undefined (uncached) when it cannot be read.
 * `refs` is the local-heads list, used only for the no-origin/HEAD fallback.
 */
export async function resolveDefaultBase({ repo, exec, refs = null }) {
  let head = '';
  try { head = String(await exec(...toPair(defaultBranchRecipe({ repo })))).trim(); } catch { /* no origin/HEAD */ }
  const name = head.split('/').pop();
  if (name) {
    let baseSha;
    try { baseSha = String(await exec(...toPair(revParseRecipe({ repo, ref: head })))).trim() || undefined; } catch { /* uncached */ }
    return { name, base: head, baseSha };
  }
  const local = (refs ?? []).some((r) => r.name === 'main') ? 'main' : 'master';
  return { name: local, base: local, baseSha: tipsOf(refs ?? []).get(local) };
}

export function parseCherry(text) {
  let unmerged = 0, equivalent = 0;
  for (const line of String(text ?? '').split('\n')) {
    if (line.startsWith('+ ')) unmerged++;
    else if (line.startsWith('- ')) equivalent++;
  }
  return { unmerged, equivalent };
}


// Anchored glob (only `*` is special) -> RegExp. 'autoresearch/*' matches the
// whole branch name, not a substring.
function globToRe(glob) {
  return new RegExp('^' + String(glob).split('*').map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
}

// Session-worktree branches (glmps-71) look like `session/<project>/<shortid>`
// (see orchestration/worktrees.js sessionWorktreePlan). A finding on one of
// these is exactly the "ended but unmerged" lifecycle case the worktree
// sweeper refuses to touch - extract the shortid so the alert can link
// straight back to the session instead of just the project's kanban.
const SESSION_BRANCH_RE = /^session\/[^/]+\/([^/]+)$/;

/**
 * @param repos   [{ project, defaultBranch, branches: [{ name, lastCommitMs, unmerged }] }]
 * @param tickets backlog items [{ state, branch, title, prompt }] (any project)
 * @param now     ms clock (injected for testability)
 * @param staleMs branch must be idle this long before it counts as "finished" (default 3 days)
 * @param ignoreBranches anchored globs for branches never meant to merge (machine-generated runs)
 * @param ignoreProjects projects to skip wholesale (clone/variant repos that mirror another's branches)
 * @returns findings [{ project, branch, unmerged, lastCommitMs, sessionId? }]
 *          (sessionId is present only for `session/<project>/<shortid>` branches)
 */
export function detectUnmergedBranches({ repos = [], tickets = [], now = Date.now(), staleMs = 3 * DAY_MS, ignoreBranches = [], ignoreProjects = [] } = {}) {
  const open = tickets.filter(t => t && !OPEN_STATES_EXCLUDED.has(String(t.state)));
  const referenced = (branch) => open.some(t =>
    String(t.branch ?? '') === branch ||
    String(t.title ?? '').includes(branch) ||
    String(t.prompt ?? '').includes(branch));
  const ignoreRes = ignoreBranches.map(globToRe);

  const findings = [];
  for (const r of repos) {
    if (ignoreProjects.includes(r.project)) continue;
    for (const b of r.branches ?? []) {
      if (b.name === r.defaultBranch) continue;
      if (ignoreRes.some(re => re.test(b.name))) continue;
      if (!(b.unmerged > 0)) continue;
      if (now - b.lastCommitMs < staleMs) continue;
      if (referenced(b.name)) continue;
      const sessionMatch = SESSION_BRANCH_RE.exec(b.name);
      findings.push({
        project: r.project, branch: b.name, unmerged: b.unmerged, lastCommitMs: b.lastCommitMs,
        ...(sessionMatch ? { sessionId: sessionMatch[1] } : {}),
      });
    }
  }
  return findings;
}


/**
 * Turn real repos into detector-ready shapes. `exec(file, args) -> stdout |
 * Promise<stdout>` is injected (server passes an async execFile wrapper so
 * this never blocks the event loop; tests pass a plain synchronous fake - 
 * `await`ing a non-Promise resolves immediately, so both work unchanged).
 * Repos run concurrently, and within a repo every branch's `git cherry` call
 * runs concurrently too (each is read-only and independent of the others) - 
 * this is the O(branches) hot spot, previously the dominant cost of
 * /api/alerts (a single populous repo can have dozens of local branches). A
 * repo whose git calls fail is skipped - the guard must never break
 * /api/alerts.
 * @param roots [{ project, path }]
 */
export async function scanRepos({ roots = [], exec, cherryCache = null } = {}) {
  const results = await Promise.all(roots.map(async (root) => {
    try {
      const refs = parseRefList(await exec(...toPair(forEachRefRecipe({ repo: root.path }))));
      const { name: defaultBranch, base, baseSha } = await resolveDefaultBase({ repo: root.path, exec, refs });
      const branches = await Promise.all(
        refs.filter(ref => ref.name !== defaultBranch).map(async (ref) => {
          const { unmerged } = await cherryFor({ exec, cache: cherryCache, repo: root.path, base, baseSha, branch: ref.name, branchSha: ref.sha });
          return { name: ref.name, lastCommitMs: ref.lastCommitMs, unmerged };
        }));
      return { project: root.project, defaultBranch, branches };
    } catch { return null; /* not a repo / git missing - skip */ }
  }));
  return results.filter(Boolean);
}

function toPair(recipe) {
  return [recipe.file, recipe.args];
}
