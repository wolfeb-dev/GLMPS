// server/lib/observability/graph-refresh.js
// Pure decision logic for the scheduled full graph rebuild. No I/O, no imports.
//
// WHY THERE IS NO COMMIT-STALENESS GATE
// A gate that only fires when `builtAtCommit !== headCommit` (the shape the
// wiki loop's own checker uses) is wrong here, and the 2026-07-28 incident is
// why. graphify's post-commit hook rebuilds incrementally, and an incremental rebuild only
// preserves prior nodes `if graph.json exists` (graphify watch.py:515). Once
// graph.json went missing, every commit rewrote a stub holding just that
// commit's changed files (55 nodes of a 771-file repo), and graphify's own
// shrink guard could not object because it short-circuits on an empty baseline
// (watch.py:339). The stub's built_at_commit tracked HEAD exactly the whole
// time, so it looked perfectly fresh. A commit-drift gate would have skipped it
// for all 54 commits it stayed broken.
//
// So this tick fires blind on its interval. A full re-extraction (changed_paths
// = None) rebuilds from the corpus rather than from the previous graph, which is
// what makes it a repair and not just an update. Deliberately NOT passing
// --force: growing a stub back to full size passes graphify's shrink guard on
// its own, and --force would disable the one native guard that does work.

/**
 * planGraphRebuildTick({ enabled, running, lastRunAt, now, minIntervalMs })
 *
 * true iff ALL of:
 *  - the schedule is enabled
 *  - no previous rebuild is still in flight (single-flight: a slow rebuild must
 *    never be stacked by the next tick)
 *  - the throttle window has elapsed: `now - lastRunAt >= minIntervalMs`
 *    (`lastRunAt` absent/null means "never run yet", so a first tick fires)
 *
 * Any non-numeric `now`/`minIntervalMs` returns false: never rebuild on an
 * ambiguous clock.
 *
 * @returns {boolean}
 */
export function planGraphRebuildTick({ enabled, running, lastRunAt, now, minIntervalMs } = {}) {
  if (!enabled || running) return false;
  if (typeof now !== 'number' || typeof minIntervalMs !== 'number') return false;
  const last = typeof lastRunAt === 'number' ? lastRunAt : -Infinity;
  return (now - last) >= minIntervalMs;
}

/**
 * selectRebuildRoots(roots, { hasGraphDir })
 *
 * Narrow the server's full project-root list to the repos this schedule may
 * rebuild: those that already have a `graphify-out/` directory. A repo that
 * never used graphify is skipped, so a daily job never silently starts indexing
 * every project on the box.
 *
 * Selection keys off the DIRECTORY, not graph.json. paths.js `graphPathFor()`
 * returns null when graph.json is absent, which is precisely the state needing
 * repair, so selecting by graph.json would skip the one repo that needs this
 * most.
 *
 * `hasGraphDir(root) -> boolean` is injected (the server passes an fs check;
 * tests pass a plain predicate), keeping this module pure.
 *
 * @returns {string[]} matching roots, input order preserved
 */
export function selectRebuildRoots(roots, { hasGraphDir } = {}) {
  if (!Array.isArray(roots) || typeof hasGraphDir !== 'function') return [];
  return roots.filter((r) => r && hasGraphDir(r));
}
