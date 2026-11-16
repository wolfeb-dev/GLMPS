// server/lib/orchestration/pr-file.js
//
// Injectable `gh pr create` wrapper for the nightly run (handoff A3: the
// nightly run never merges to main, it only files a PR for a human to
// review). Nothing else in this codebase files a PR today, so there is no
// existing wrapper to reuse or copy from.
//
// `filePr` must NEVER throw: a nightly run with no operator watching it live
// degrades a PR-filing failure to a reported blocker, not a crash that drops
// the rest of the run's bookkeeping (spend, gate results, the review.completed
// summary) on the floor. `run(file, args)` is fully injectable and defaults
// to a real spawnSync('gh', ...) call so tests never shell out.
import { spawnSync } from 'node:child_process';

function defaultRun(file, args, opts) {
  return spawnSync(file, args, opts);
}

/**
 * `filePr({ repo, branch, base='main', title, body, dryRun=false, run }) ->
 * { filed:boolean, url:string|null, reason?:string }`.
 *
 *   - `dryRun:true` short-circuits before `run` is ever called, and reports
 *     `reason:'dry-run'`.
 *   - A missing `gh` binary (the injected `run` returning a spawn result
 *     shaped `{ error: { code: 'ENOENT' } }`, which is exactly what Node's
 *     real `spawnSync` returns when the executable cannot be found) reports
 *     `reason:'gh-missing'`.
 *   - A non-zero exit reports `reason:'gh-failed'` and carries `stderr` for
 *     diagnostics.
 *   - `run` throwing outright (not just returning an ENOENT-shaped result) is
 *     also caught: a PR-filing failure must degrade the nightly run to
 *     "blocked", never crash it.
 */
export function filePr({ repo, branch, base = 'main', title, body, dryRun = false, run = defaultRun } = {}) {
  if (dryRun) {
    return { filed: false, url: null, reason: 'dry-run' };
  }

  let result;
  try {
    result = run('gh', [
      'pr', 'create',
      '--head', branch,
      '--base', base,
      '--title', title,
      '--body', body,
    ], { cwd: repo, windowsHide: true });
  } catch (err) {
    return { filed: false, url: null, reason: 'gh-error', error: err?.message ?? String(err) };
  }

  if (result?.error?.code === 'ENOENT') {
    return { filed: false, url: null, reason: 'gh-missing' };
  }
  if (result?.error) {
    return { filed: false, url: null, reason: 'gh-error', error: result.error.message ?? String(result.error) };
  }
  if (result?.status !== 0) {
    return {
      filed: false, url: null, reason: 'gh-failed',
      status: result?.status ?? null,
      stderr: typeof result?.stderr === 'string' ? result.stderr : (result?.stderr?.toString?.() ?? ''),
    };
  }

  const stdout = typeof result.stdout === 'string' ? result.stdout : (result.stdout?.toString?.() ?? '');
  const url = stdout.trim().split(/\s+/).find((tok) => /^https?:\/\//.test(tok)) ?? null;
  return { filed: true, url };
}

/**
 * `prBody({ runId, items, gateResults, spend }) -> string`. The standard PR
 * body naming the run, the gates run and skipped, and the spend, so a human
 * reviewing an autonomous PR the next morning does not have to go dig up the
 * run's spine events just to see what checked out and what did not.
 */
export function prBody({ runId, items = [], gateResults = [], spend } = {}) {
  const lines = [`Nightly run: ${runId ?? 'unknown'}`, ''];

  if (items.length) {
    lines.push('## Items');
    for (const item of items) {
      lines.push(`- ${item.id}${item.title ? `: ${item.title}` : ''}`);
    }
    lines.push('');
  }

  if (gateResults.length) {
    lines.push('## Gates');
    for (const g of gateResults) {
      lines.push(`- ${g.gateName}: ${g.status}${g.details ? ` (${g.details})` : ''}`);
    }
    lines.push('');
  }

  const s = spend ?? {};
  const usd = Number.isFinite(s.usd) ? s.usd : 0;
  const tokens = Number.isFinite(s.tokens) ? s.tokens : 0;
  lines.push(`## Spend`, `$${usd} / ${tokens} tokens`);

  return lines.join('\n');
}
