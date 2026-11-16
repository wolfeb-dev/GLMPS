// server/lib/evaluation/lesson-dedupe.js
//
// Collapse duplicate lesson records to one per distinct rule.
//
// The 2026-08-21 migration copied 47 guard lessons out of the legacy store that
// are really only TEN distinct rules: the same lesson learned repeatedly from
// separate sessions. The legacy store's own semantic dedup (2026-07-09) works -
// 43 of the 44 duplicates predate it - but the migration carried the historical
// residue across without deduping it. That was my omission, not a flaw in the
// dedup.
//
// Duplicates are not merely untidy here. Eight records for ONE behaviour
// fragment invalidation: revert the commit behind one and the other seven
// survive, still asserting the guard is justified. Decay acts on each
// independently too. The integrity layer would be reasoning about eight
// shadows of one fact.
//
// PURE. The caller decides what to do with the plan, so the policy below is
// visible and tested rather than buried in a one-off script.
//
// Two deliberate conservatisms:
//   * The EARLIEST row is the keeper. It is the origin, and it carries the
//     provenance closest to the moment the lesson was actually learned.
//   * A row with no dedupe key is left strictly alone. Without a key we cannot
//     prove two rows are the same rule, and a wrong merge silently destroys a
//     distinct lesson. Absence of evidence is not a match.
//
// Zero runtime dependencies.

/**
 * planDedupe(lessons) -> { keep, retire }
 *
 * `lessons` are projection rows (from lessonsCurrent) each optionally carrying
 * a `dedupeKey` - the legacy store's rule `code`, which is what actually
 * identifies "the same rule" here.
 *
 * `retire` lists the rows to invalidate with reason 'duplicate'. Already
 * invalidated rows are never returned, so re-running is idempotent and the
 * ledger does not grow on every pass.
 */
export function planDedupe(lessons) {
  const rows = (Array.isArray(lessons) ? lessons : []).filter((l) => l && typeof l === 'object' && l.lessonId);
  const groups = new Map();
  const keep = [];

  for (const row of rows) {
    const key = typeof row.dedupeKey === 'string' && row.dedupeKey ? row.dedupeKey : null;
    if (!key) { if (row.status !== 'invalidated') keep.push(row); continue; }
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  const retire = [];
  for (const group of groups.values()) {
    const live = group.filter((r) => r.status !== 'invalidated');
    if (live.length === 0) continue;           // nothing left to keep or retire
    const sorted = live.slice().sort((a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')));
    keep.push(sorted[0]);
    for (const dup of sorted.slice(1)) retire.push(dup);
  }

  return { keep, retire };
}
