// server/lib/observability/wiki-status.js
// Pure function: derive staleness for a generated codebase wiki.
// No I/O, no imports - mirrors graph-status.js so it is testable in isolation.

/**
 * computeWikiStatus({ builtAtCommit, headCommit, builtFromGraph, currentGraph, sections })
 *
 * `freshness` is the honest three-state answer, matching computeGraphStatus:
 *   'stale'    the wiki is positively behind: the commits differ, or they
 *              match but the graph it was built from has since changed
 *   'fresh'    the commits match AND the recorded graph fingerprint matches
 *              the current graph's
 *   'unknown'  a marker needed to decide is missing
 * `staleReason` names the row that applied (null when fresh):
 *   commit-unrecorded | head-unreadable | commit | graph-unrecorded |
 *   graph-unreadable | graph
 *
 * `needsUpdate` keeps its original narrow meaning: true only for 'stale', i.e.
 * only when we positively KNOW the wiki is behind.
 *
 * builtAtCommit is the HEAD the build ran at (the wiki loop only builds once
 * the graph's own built_at_commit equals it). Commit equality alone is not
 * enough: graphify rewrites the graph at an unchanged HEAD (a version upgrade
 * moved glmps 6140 -> 6451 nodes on 2026-08-29 with HEAD
 * untouched), so the manifest's graph fingerprint (graph-fingerprint.js) is
 * compared too. A build that recorded none reads 'unknown', never 'fresh':
 * the 2026-08-16 lesson (f7e0c0f) that missing evidence must not collapse
 * into a healthy state.
 *
 * Per-section `stale` echoes the wiki-level flag; true per-file incremental
 * staleness is computed in the build CLI via git diff, not here.
 *
 * `sections` is the manifest's section list ([{ slug, title, ... }]) or absent.
 * Returns: { needsUpdate, freshness, staleReason, sections: [{ slug, stale }] }
 */
export function computeWikiStatus({ builtAtCommit, headCommit, builtFromGraph = null, currentGraph = null, sections } = {}) {
  let freshness;
  let staleReason;
  if (!builtAtCommit) [freshness, staleReason] = ['unknown', 'commit-unrecorded'];
  else if (!headCommit) [freshness, staleReason] = ['unknown', 'head-unreadable'];
  else if (builtAtCommit !== headCommit) [freshness, staleReason] = ['stale', 'commit'];
  else if (!builtFromGraph) [freshness, staleReason] = ['unknown', 'graph-unrecorded'];
  else if (!currentGraph) [freshness, staleReason] = ['unknown', 'graph-unreadable'];
  else if (builtFromGraph !== currentGraph) [freshness, staleReason] = ['stale', 'graph'];
  else [freshness, staleReason] = ['fresh', null];
  const needsUpdate = freshness === 'stale';
  const list = Array.isArray(sections) ? sections : [];
  return {
    needsUpdate,
    freshness,
    staleReason,
    sections: list.map(s => ({ slug: s.slug, stale: needsUpdate })),
  };
}

/**
 * wikiRebuildArgs({ cliPath, target, llm, outDir })
 *
 * Argument list for spawning scripts/wiki-build-cli.mjs. `outDir` redirects
 * the CLI's output (`--out`).
 */
export function wikiRebuildArgs({ cliPath, target, llm = false, outDir = null } = {}) {
  const args = [cliPath, target];
  if (llm) args.push('--llm');
  if (outDir) args.push('--out', outDir);
  return args;
}
