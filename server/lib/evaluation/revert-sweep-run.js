// server/lib/evaluation/revert-sweep-run.js
//
// The caller A0.3 shipped without.
//
// scanReverts, sweepInvalidations and orphanScan were all built, tested and
// documented as shipped, and nothing ever invoked them: platformAutonomyTick
// ran only the decay sweep and the reconciliation checks. Two consequences,
// both live until this module existed:
//
//   1. Reverting a commit never invalidated the lesson derived from it, which
//      is the exact failure A0.3 exists to prevent.
//   2. a0AcceptanceStatus.revertSweep could never become true, so allPassed
//      could never become true, so the learning-write freeze could never lift
//      by any legitimate path. The central safety story of the whole build
//      was unreachable.
//
// Scope is learningIntegrity.revertScanRepos, NOT nightly.repoAllowlist. That
// list is empty whenever nightly is off, which is the default, so gating on it
// would have left this as dead as it was before it had a caller.
//
// Every dependency is injectable so the unit test spawns no git and touches no
// real repo; server.js supplies the real ones.
//
// Fail-open per repo, deliberately: this runs inside the nightly tick, and a
// sweep that throws because one repo moved must not take the drift checks down
// with it. A repo that errors does NOT advance its watermark, so the range it
// failed on is retried next night rather than silently skipped.
//
// Zero runtime dependencies.
import { scanReverts as scanRevertsReal, readWatermark, writeWatermark } from '../observability/revert-scan.js';
import { sweepInvalidations as sweepReal, orphanScan as orphanReal } from './lesson-invalidate.js';

/**
 * runRevertSweep(stateDir, { repos, now, actor, ...injectables })
 *   -> { repos: [{ repo, refs, invalidated, orphaned, head, error }] }
 *
 * One row per scanned repo, always, so a caller can tell "scanned, nothing
 * found" from "never scanned" - the distinction the whole A0.3 story turns on.
 */
export async function runRevertSweep(stateDir, {
  repos = [],
  now,
  actor = 'nightly-runner',
  scan = scanRevertsReal,
  sweep = sweepReal,
  orphan = orphanReal,
  readMark = readWatermark,
  writeMark = writeWatermark,
  worktreesFor = () => [],
  fileTicket,
} = {}) {
  const out = { repos: [] };
  for (const repo of Array.isArray(repos) ? repos : []) {
    if (typeof repo !== 'string' || !repo.trim()) continue;
    const row = { repo, refs: [], invalidated: [], orphaned: [], head: null, error: null };
    try {
      const since = readMark(stateDir, repo);
      const { refs = [], head = null, error } = (await scan({ repo, since })) ?? {};
      row.refs = refs;
      row.head = head;
      if (error) {
        row.error = error;
        out.repos.push(row);
        continue;
      }
      if (refs.length > 0) {
        row.invalidated = sweep(stateDir, { refs, reason: 'revert', actor, now })?.invalidated ?? [];
        row.orphaned = orphan(stateDir, {
          refs, worktrees: worktreesFor(repo), docs: [], fileTicket, actor, now,
        })?.orphaned ?? [];
      }
      // Advance only on a real head. Advancing past a range we could not read
      // would silently skip whatever reverts were in it.
      if (head) writeMark(stateDir, repo, head);
    } catch (e) {
      row.error = e?.message ?? String(e);
    }
    out.repos.push(row);
  }
  return out;
}
