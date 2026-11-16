// server/lib/observability/graph-status.js
// Pure functions: derive display/staleness status for a single graphify graph,
// and decide which graphs a no-argument rebuild should target.
// No I/O, no imports, fully testable in isolation.

// Do two commit ids name the same commit? Tolerates a short SHA against a full
// one in either direction, matching loadGraph() in code-graph.js. Exact
// equality would report a graph stamped with an abbreviated SHA as permanently
// stale, and the two modules disagreeing is worse than either rule alone.
function sameCommit(a, b) {
  const x = String(a);
  const y = String(b);
  return x.startsWith(y) || y.startsWith(x);
}

/**
 * computeGraphStatus({ project, root, nodes, builtAtCommit, headCommit, mtimeMs, verifiedAtCommit })
 *
 * Returns:
 *   { project, root, nodes, rebuiltMs, builtAtCommit, verifiedAtCommit, headCommit, needsUpdate, freshness }
 *
 * `freshness` is the honest three-state answer:
 *   'stale'    both commits known, and they differ
 *   'fresh'    both commits known, and they match
 *   'unknown'  either commit is missing, so freshness cannot be determined
 *
 * `needsUpdate` keeps its original narrow meaning: true only for 'stale', i.e.
 * only when we positively KNOW the graph is behind. It is deliberately left
 * alone so existing consumers do not change behavior.
 *
 * The distinction is not academic. On 2026-08-16 graphify's incremental write
 * path stopped emitting `built_at_commit`, so the two most actively rebuilt
 * graphs on this machine reported needsUpdate:false while their freshness was
 * in fact unknown. A blind graph rendered as a healthy one. 'unknown' exists so
 * that absence of evidence stops reading as evidence of freshness.
 *
 * `verifiedAtCommit` separates accurate from current (upgrade plan 7b step 3):
 * graphify leaves built_at_commit alone when a full re-extraction finds no
 * topology change, so a repo whose commits touch only docs read stale forever
 * while being correct. A graph verified at HEAD by such a no-op is fresh.
 * Collapse is not this function's job; the integrity store alarms on that.
 */
export function computeGraphStatus({ project, root, nodes, builtAtCommit, headCommit, mtimeMs, verifiedAtCommit = null }) {
  const verified = !!(verifiedAtCommit && headCommit && sameCommit(verifiedAtCommit, headCommit));
  const known = !!(builtAtCommit && headCommit) || verified;
  const freshness = !known
    ? 'unknown'
    : ((verified || sameCommit(builtAtCommit, headCommit)) ? 'fresh' : 'stale');

  return {
    project,
    root,
    nodes: nodes | 0,
    rebuiltMs: mtimeMs ?? null,
    builtAtCommit: builtAtCommit ?? null,
    verifiedAtCommit: verifiedAtCommit ?? null,
    headCommit: headCommit ?? null,
    needsUpdate: freshness === 'stale',
    freshness,
  };
}

/**
 * selectRebuildTargets(statuses) -> string[] of roots
 *
 * Which graphs should a no-argument `POST /api/graph/rebuild` actually rebuild?
 * Known-stale graphs, plus graphs whose freshness is unknown: rebuilding an
 * unknown graph is precisely how its missing marker gets restored, so skipping
 * it would leave it blind forever.
 *
 * When nothing needs rebuilding, fall back to every root. That fallback is
 * pre-existing behavior and is kept deliberately: an operator who explicitly
 * asks for a rebuild with no target still gets one.
 */
export function selectRebuildTargets(statuses) {
  const all = Array.isArray(statuses) ? statuses : [];
  const wanted = all.filter(s => s && (s.needsUpdate || s.freshness === 'unknown'));
  return (wanted.length ? wanted : all).map(s => s.root);
}
