// server/lib/observability/decision-log-sweep.js
//
// Incremental cross-repo sweep for the decision log (glmps-143).
//
// CONCURRENCY (binding): the sweep spans every tracked repo (~16 on this box).
// Git runs through an INJECTED async runGit with a hard in-flight cap. Never
// execFileSync on the event loop: that is a mistake this codebase already made
// once and recorded (memory: node-event-loop-git-subprocess-guard).
//
// Per-repo failures are isolated. A repo that is not a git checkout, has no
// resolvable default branch, or whose git call rejects, is SKIPPED WITH A
// REASON in the return value. Nothing about a sweep is allowed to be silent:
// a truncated or partial sweep that reports success reads as "nothing changed",
// which is exactly the false confidence this feature exists to remove.
import { FORMAT, parseMergeLog, selectEntries, resolveDefaultBranch } from './decision-log-git.js';
import { append, loadWatermarks, saveWatermarks } from './decision-log-store.js';

export const MAX_CONCURRENCY = 4;
export const DEFAULT_BACKFILL_DAYS = 90;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Canonicalize and de-duplicate a repo list.
 *
 * REPO_ROOT arrives as `D:\proj` while the synced
 * additionalDirectories carry `D:/proj`. A bare Set treats those as
 * two repos, so the same history is swept twice and every entry is duplicated
 * (observed live on the first real sweep). Separators are unified and, on
 * case-insensitive filesystems, case is folded for comparison while the first
 * spelling seen is the one kept.
 *
 * @param {string[]} paths
 * @param {{caseInsensitive?: boolean}} opts
 * @returns {string[]}
 */
export function normalizeRepoList(paths, { caseInsensitive = process.platform === 'win32' } = {}) {
  const seen = new Map();
  for (const raw of Array.isArray(paths) ? paths : []) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    const unified = raw.replace(/\\/g, '/').replace(/\/+$/, '');
    const key = caseInsensitive ? unified.toLowerCase() : unified;
    if (!seen.has(key)) seen.set(key, unified);
  }
  return [...seen.values()];
}

/** Run tasks with a bounded number in flight. Rejections are captured per task. */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      try { results[i] = { ok: true, value: await fn(items[i]) }; }
      catch (err) { results[i] = { ok: false, err }; }
    }
  });
  await Promise.all(workers);
  return results;
}

async function sweepOne({ repo, runGit, sinceTs }) {
  const symbolic = await runGit(repo, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).catch(() => '');
  const branchesOut = await runGit(repo, ['branch', '--format=%(refname:short)']).catch(() => '');
  const branches = String(branchesOut).split('\n').map((s) => s.trim()).filter(Boolean);

  const branch = resolveDefaultBranch(symbolic, branches);
  if (!branch) return { entries: [], skipped: 'no default branch (no origin/HEAD, no main, no master)' };

  const sinceArg = `--since=${new Date(sinceTs).toISOString()}`;
  const base = [`--format=${FORMAT}`, sinceArg, branch];

  const mergesOut = await runGit(repo, ['log', '--merges', '--first-parent', ...base]);
  const merges = parseMergeLog(mergesOut);

  // Only pay for the second call when there are no merges to describe the work.
  let commits = [];
  if (!merges.length) {
    const commitsOut = await runGit(repo, ['log', '--first-parent', ...base]);
    commits = parseMergeLog(commitsOut);
  }

  return { entries: selectEntries({ merges, commits }), skipped: null };
}

/**
 * @param {{repos:string[], stateDir:string, runGit:Function, now:number,
 *          backfillDays?:number, log?:Function}} opts
 * @returns {Promise<{swept:number, added:number, skipped:Array, notes:Array}>}
 */
export async function sweepRepos({ repos = [], stateDir, runGit, now = Date.now(), backfillDays = DEFAULT_BACKFILL_DAYS, log } = {}) {
  const watermarks = loadWatermarks(stateDir);
  const skipped = [];
  const notes = [];

  const plan = repos.map((repo) => {
    const wm = Number(watermarks[repo]);
    if (Number.isFinite(wm)) return { repo, sinceTs: wm };
    // First run for this repo: bounded backfill, and SAY SO.
    const sinceTs = now - backfillDays * DAY_MS;
    notes.push({ repo, reason: `first run: backfill capped at ${backfillDays} days` });
    return { repo, sinceTs };
  });

  const results = await mapLimit(plan, MAX_CONCURRENCY, async ({ repo, sinceTs }) => {
    const r = await sweepOne({ repo, runGit, sinceTs });
    return { repo, sinceTs, ...r };
  });

  const rows = [];
  const nextWatermarks = { ...watermarks };

  for (let i = 0; i < results.length; i++) {
    const res = results[i];
    const repo = plan[i].repo;
    if (!res.ok) { skipped.push({ repo, reason: String(res.err?.message ?? res.err) }); continue; }
    if (res.value.skipped) { skipped.push({ repo, reason: res.value.skipped }); continue; }

    const entries = res.value.entries.filter((e) => e.ts > (Number(watermarks[repo]) || 0));
    for (const e of entries) {
      rows.push({ ts: e.ts, repo, commit: e.commit, what: e.what, why: e.why, source: 'git' });
    }
    const maxTs = entries.reduce((m, e) => Math.max(m, e.ts), Number(watermarks[repo]) || 0);
    nextWatermarks[repo] = Math.max(maxTs, Number(watermarks[repo]) || 0, plan[i].sinceTs);
  }

  append(stateDir, rows);
  saveWatermarks(stateDir, nextWatermarks);

  if (typeof log === 'function') {
    for (const s of skipped) log(`decision-log: skipped ${s.repo}: ${s.reason}`);
    for (const n of notes) log(`decision-log: ${n.repo}: ${n.reason}`);
  }

  return { swept: repos.length, added: rows.length, skipped, notes };
}
