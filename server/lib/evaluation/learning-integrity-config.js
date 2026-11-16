// server/lib/evaluation/learning-integrity-config.js
//
// Config for the learning-integrity layer (Part A0 of the platform-autonomy
// plan): whether the learning-write freeze is active, the per-scope decay
// half-life, the strength floor at which a lesson goes dormant, which actors
// the freeze applies to, and which repos the A0.3 revert sweep scans.
//
// There is deliberately NO enforceProvenance switch. One existed, was
// defaulted, returned and surfaced on GET /api/lessons, and was read by
// nothing: assertProvenance has always been unconditional. It advertised a
// control that did not exist, and the only thing turning it off could have
// meant is weakening the one invariant this whole layer is built on.
//
// Mirrors this codebase's config idiom: a pure function that takes the
// whole loaded config object and returns a fully-defaulted block, so a
// caller never has to guard against a missing key.
//
// Also home to a0AcceptanceStatus (A0.6): the four acceptance flags that
// gate lifting the learning-write freeze. Every flag is COMPUTED FROM THE
// LEDGER, never self-declared - there is no config field or in-memory flag
// anywhere that says "A0 is accepted"; the only way allPassed becomes true
// is for the ledger and spine to actually show a decay sweep ran, a revert
// actually invalidated a lesson, and a promotion was both approved and later
// revoked at least once.
//
// Zero runtime dependencies.
import { readLessonRows } from './lesson-ledger.js';
import { readSpineEvents, SPINE_KINDS } from '../observability/spine.js';

const DEFAULTS = Object.freeze({
  freeze: true,
  halfLifeDays: Object.freeze({ repo: 30, desk: 90, global: 90 }),
  strengthFloor: 0.2,
  frozenActors: Object.freeze(['nightly-runner']),
  // Which repos the A0.3 revert sweep scans. Deliberately NOT nightly's
  // repoAllowlist: that list is empty whenever nightly is off, which is the
  // default, so gating the sweep on it would leave A0.3 as dead as it was
  // before it had a caller at all. Empty here means "the caller decides",
  // and server.js supplies its own repo root, which is the only repo this
  // resolver could not name for itself (it is a pure function).
  revertScanRepos: Object.freeze([]),
  // The decay and revert sweeps as registered kernel loops (card
  // glmps-2-0-runtime-15). On by default: two of the four freeze-lift checks
  // are computed from events only these sweeps write, so a default of off is
  // a freeze that can never lift. Defaulted here rather than in
  // config-defaults.js because the server merges config.json shallowly, and a
  // live file that already carries a learningIntegrity block would drop it.
  sweeps: Object.freeze({ enabled: true, everyMs: 6 * 3_600_000, maxAgeMs: 24 * 3_600_000 }),
});

export function learningIntegrityConfig(cfg = {}) {
  const overrides = cfg?.learningIntegrity ?? {};
  return {
    freeze: overrides.freeze ?? DEFAULTS.freeze,
    halfLifeDays: { ...DEFAULTS.halfLifeDays, ...(overrides.halfLifeDays ?? {}) },
    strengthFloor: overrides.strengthFloor ?? DEFAULTS.strengthFloor,
    frozenActors: overrides.frozenActors ?? [...DEFAULTS.frozenActors],
    revertScanRepos: Array.isArray(overrides.revertScanRepos)
      ? overrides.revertScanRepos.filter((r) => typeof r === 'string' && r.trim())
      : [...DEFAULTS.revertScanRepos],
    sweeps: { ...DEFAULTS.sweeps, ...(overrides.sweeps ?? {}) },
  };
}

/**
 * a0AcceptanceStatus(stateDir) -> { provenance, decay, revertSweep, promotionGate, allPassed }
 *
 * - provenance: true once at least one lesson has ever been created. Every
 *   'created' row in the ledger was written by createLesson, which asserts
 *   provenance BEFORE appending (lesson-provenance.js's assertProvenance) -
 *   so "a created row exists" and "every lesson that exists carries valid
 *   provenance" are the same fact here. Re-checked defensively rather than
 *   assumed, so a row that somehow landed without one still fails this.
 * - decay: true once at least one lesson.decayed spine event exists (a real
 *   decay sweep actually moved a lesson to dormant).
 * - revertSweep: true once at least one lesson.invalidated event exists
 *   whose payload.reason is exactly 'revert' (an intentional_break
 *   invalidation does not satisfy this - the acceptance bar is specifically
 *   that the revert path has been exercised for real).
 * - promotionGate: true once BOTH a promotion.approved and a
 *   promotion.revoked event exist - proof the whole gate (grant, then
 *   later take back) has actually been exercised, not just the happy path.
 * - allPassed: every flag above true.
 */
export function a0AcceptanceStatus(stateDir) {
  const rows = readLessonRows(stateDir, {});
  const createdRows = rows.filter((r) => r?.type === 'created');
  const provenance = createdRows.length > 0 && createdRows.every((r) => r?.provenance && typeof r.provenance.scope === 'string');

  const decayed = readSpineEvents(stateDir, { kind: SPINE_KINDS.LESSON_DECAYED });
  const decay = decayed.length > 0;

  const invalidated = readSpineEvents(stateDir, { kind: SPINE_KINDS.LESSON_INVALIDATED });
  const revertSweep = invalidated.some((e) => e?.payload?.reason === 'revert');

  const approved = readSpineEvents(stateDir, { kind: SPINE_KINDS.PROMOTION_APPROVED });
  const revoked = readSpineEvents(stateDir, { kind: SPINE_KINDS.PROMOTION_REVOKED });
  const promotionGate = approved.length > 0 && revoked.length > 0;

  return {
    provenance,
    decay,
    revertSweep,
    promotionGate,
    allPassed: provenance && decay && revertSweep && promotionGate,
  };
}
