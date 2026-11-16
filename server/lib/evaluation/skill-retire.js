// server/lib/evaluation/skill-retire.js
//
// Pure: propose ARCHIVE candidates for installed skills that have never been
// invoked across a long observation window. Deliberately mirrors
// guard-retire.js's retireCandidates() line for line in structure and
// guarantees: pure, propose-only, fail-open on missing evidence. Never
// deletes or moves a skill's files itself - "archive, not delete" is
// enforced by SCOPE (this module has no filesystem-mutation code path at
// all, see the design doc's acceptance criterion #1/#5), so there is nothing
// here to accidentally delete. A human (or a future explicit action) decides
// whether to actually archive a flagged skill's files.
//
// Why 180 days, not 90
//
// skills-view.js's `uses` is an all-time cumulative count - uses===0 means
// "never invoked since logging began," not "unused in the last N days." That
// conflates a genuinely dead skill with a rare-but-legitimate one (e.g. a
// quarterly-cadence skill installed yesterday also has uses===0). The
// observation window (skill-observation-log.js's firstSeen) answers "how
// long have we actually been watching," and 180 days is chosen to safely
// span TWO full quarters even for a skill exercised only once per quarter - 
// a single 90-day window risks flagging a quarterly skill the day before its
// next legitimate use.
import { staleness, DEFAULT_STALE_DAYS, DEFAULT_RETIRE_DAYS } from './guard-retire.js';

export const DEFAULT_MIN_OBSERVATION_DAYS = 180;

const MS_PER_DAY = 86400000;

/**
 * @param {Array<{id, name, plugin, installed, uses}>} skills   buildSkillsView().skills rows
 * @param {Record<string, number>} observedSince   skill-observation-log.js's getObservedSince()
 * @param {string[]} [exempt]   operator-curated skill ids never surfaced (config.json
 *   skillLifecycle.exempt) - honored BEFORE the observation-window check, so a
 *   newly-added exemption takes effect immediately without waiting out the window.
 * @param {{ minObservationDays?: number }} [opts]
 * @returns {Array<{ id, name, plugin, reason, observedDays }>}
 */
export function archiveCandidates(skills, observedSince, exempt = [], { minObservationDays = DEFAULT_MIN_OBSERVATION_DAYS } = {}) {
  const exemptSet = new Set(Array.isArray(exempt) ? exempt : []);
  const since = (observedSince && typeof observedSince === 'object') ? observedSince : {};
  const list = Array.isArray(skills) ? skills : [];
  const out = [];

  for (const s of list) {
    if (!s || typeof s !== 'object' || !s.id) continue; // malformed row, skip only it
    if (!s.installed) continue;                          // only installed skills are archive candidates
    if ((s.uses ?? 0) !== 0) continue;                    // ever used at all -> not a candidate
    if (exemptSet.has(s.id)) continue;                    // operator-curated exemption, checked BEFORE the window
    const firstSeen = since[s.id];
    if (typeof firstSeen !== 'number' || !Number.isFinite(firstSeen)) continue; // never observed - no evidence, fail-open
    const observedDays = (Date.now() - firstSeen) / MS_PER_DAY;
    if (observedDays < minObservationDays) continue;      // too soon - could be a quarterly skill

    out.push({
      id: s.id,
      name: s.name,
      plugin: s.plugin ?? null,
      reason: `installed and unused for ${Math.floor(observedDays)} days`,
      observedDays,
    });
  }

  return out;
}

// Staleness-based archive candidates (glmps-138 Task 4)
//
// archiveCandidates() above only ever considers skills with uses===0 (NEVER
// invoked). This complements it: a skill that WAS used but has gone quiet
// for a while, per skills-view.js's `lastSeen` (populated whenever uses>0).
// Same staleDays/retireDays two-tier shape as guard-retire.js's
// staleGuardCandidates() (staleness() is imported from there rather than
// duplicated), and the same propose-only guarantee: this module still has no
// filesystem-mutation code path at all.

/**
 * @param {Array<{id, name, plugin, installed, uses, lastSeen}>} skills   buildSkillsView().skills rows
 * @param {string[]} [exempt]   operator-curated skill ids never surfaced (config.json
 *   skillLifecycle.exempt) - same precedent as archiveCandidates() above.
 * @param {{ now?: number, staleDays?: number, retireDays?: number, earliestObservedTs?: number }} [opts]
 *   earliestObservedTs: the earliest recorded
 *   skill-event ts the caller actually has on hand. A short/young event
 *   history cannot distinguish "genuinely unused for retireDays" from "we
 *   have not been watching long enough to know" - every used-at-least-once
 *   skill would otherwise look stale the moment observation starts (a fresh
 *   2.0 shadow instance reads the real ~/.claude inventory by design but has
 *   its own sparse, young event history). When the observed window is
 *   younger than retireDays, this returns [] rather than risk a false
 *   positive. Omit it entirely to skip this guard (e.g. existing callers
 *   that construct `skills` rows directly, with no real event log behind
 *   them, keep today's behavior unchanged).
 * @returns {Array<{ id, name, plugin, reason: 'stale', lastUsedDays: number }>}
 *   Only skills that reach `retireDays` since last use are included - a
 *   skill merely past `staleDays` is flagged via staleness() directly but
 *   does not appear in this array.
 */
export function staleArchiveCandidates(skills, exempt = [], { now = Date.now(), staleDays = DEFAULT_STALE_DAYS, retireDays = DEFAULT_RETIRE_DAYS, earliestObservedTs } = {}) {
  if (typeof earliestObservedTs === 'number' && Number.isFinite(earliestObservedTs)) {
    const observedDays = (now - earliestObservedTs) / MS_PER_DAY;
    if (observedDays < retireDays) return [];
  }
  const exemptSet = new Set(Array.isArray(exempt) ? exempt : []);
  const list = Array.isArray(skills) ? skills : [];
  const out = [];

  for (const s of list) {
    if (!s || typeof s !== 'object' || !s.id) continue;   // malformed row, skip only it
    if (!s.installed) continue;                            // only installed skills are candidates
    if ((s.uses ?? 0) === 0) continue;                      // never used at all -> archiveCandidates()'s territory, not staleness
    if (exemptSet.has(s.id)) continue;                      // operator-curated exemption

    const lastSeenMs = typeof s.lastSeen === 'string' ? Date.parse(s.lastSeen) : NaN;
    const { proposeRetire, lastUsedDays } = staleness(Number.isFinite(lastSeenMs) ? lastSeenMs : undefined, now, { staleDays, retireDays });
    if (!proposeRetire) continue;

    out.push({ id: s.id, name: s.name, plugin: s.plugin ?? null, reason: 'stale', lastUsedDays });
  }

  return out;
}
