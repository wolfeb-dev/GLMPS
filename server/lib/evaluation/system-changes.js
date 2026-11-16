// server/lib/evaluation/system-changes.js
//
// Unifies the three learning loops (memory / guardrail / promotion) into one
// SystemChange ledger - the "observe (spine) / measure (champion-challenger +
// shadow) / surface (one ledger)" architecture. Each loop keeps its own GATE
// policy (memory=liberal, guard=medium, promotion=conservative) but every row
// a loop produces gets mapped into the same shape so the dashboard has ONE
// ledger + ONE scoreboard instead of three.
//
// SystemChange = {
//   id: string, type: 'memory'|'guard'|'promotion'|'skill'|'measurable'|'research-candidate', title: string,
//   evidence: { sessionId?: string|null, eventRefs?: string[] },
//   status: 'proposed'|'applied'|'measuring'|'kept'|'reverted',
//   measuredEffect: object|null,   // shape varies by type; null = "not yet measured"
//   gatePolicy: 'liberal'|'medium'|'conservative',
//   ts: number|null,               // epoch ms, for sorting/scoreboard trend
// }
//
// Pure + injectable: buildSystemChanges() takes already-read store data (the
// caller does the fs/store reads; this module does zero I/O). Fail-open per
// source - a broken/malformed source contributes zero rows, it never throws
// the whole aggregation. Never invents numbers: any field the underlying
// store doesn't actually have comes back null.
import { promotionView } from './promotion-view.js';


// learning-store.js status enum -> SystemChange status. 'dispatched' means "sent
// to a headless hand to apply" - not yet confirmed live, so it still reads as
// proposed. 'discarded'/'failed' never went live (or didn't survive) - closest
// honest fit in the fixed 5-state enum is 'reverted' (the substrate is not
// carrying this change forward).
const GUARD_STATUS = {
  pending: 'proposed',
  dispatched: 'proposed',
  applied: 'measuring',
  discarded: 'reverted',
  failed: 'reverted',
};

function guardChangeFrom(item, shadow) {
  const status = GUARD_STATUS[item.status] ?? 'proposed';
  // gap.code IS the taskClass shadow-arm records under (confirmed by the real
  // gap-detect -> recordShadow wiring), join on it, never fabricate a rate.
  const bucket = item.code && shadow?.byClass ? shadow.byClass[item.code] : null;
  return {
    id: `guard-${item.id}`,
    type: 'guard',
    title: item.title ?? item.code ?? 'guard change',
    evidence: { sessionId: item.lastSessionId ?? item.sessionId ?? null },
    status,
    // A guard's fire count is real (the trigger condition recurred); it is
    // NEVER a claim the guard helped, hence the explicit 'exercised' tag
    // rather than a bare rate a reader could mistake for efficacy.
    measuredEffect: bucket ? { fireCount: bucket.fireCount ?? 0, episodes: bucket.episodeCount ?? null, evidence: 'exercised' } : null,
    gatePolicy: 'medium',
    ts: item.updatedTs ?? item.createdTs ?? null,
  };
}

function guardChanges(learningItems, shadow) {
  const out = [];
  for (const item of Array.isArray(learningItems) ? learningItems : []) {
    if (!item || typeof item !== 'object' || !item.id) continue; // malformed row, skip only it
    // 'covered' (glmps-2-0-82): a detection of a guard line that already
    // existed, so no change to the system was ever proposed or made.
    if (item.status === 'covered') continue;
    try { out.push(guardChangeFrom(item, shadow)); } catch { /* fail-open per row */ }
  }
  return out;
}

// listProposals() only ever returns the pending review tail - once approved a
// proposal becomes a plain memory file with no further instrumentation, so
// every row we see here is, honestly, still 'proposed' with nothing measured.

function memoryChangeFrom(p) {
  return {
    id: `memory-${p.id}`,
    type: 'memory',
    title: p.fact?.name ?? 'memory proposal',
    evidence: { sessionId: p.sessionId ?? null },
    status: 'proposed',
    measuredEffect: null,
    gatePolicy: 'liberal',
    ts: typeof p.ts === 'number' ? p.ts : null,
  };
}

function memoryChanges(memoryProposals) {
  const out = [];
  for (const p of Array.isArray(memoryProposals) ? memoryProposals : []) {
    if (!p || typeof p !== 'object' || !p.id) continue;
    try { out.push(memoryChangeFrom(p)); } catch { /* fail-open per row */ }
  }
  return out;
}

// promotion-view.js's Pareto verdict enum {promote,hold,reject} over aggregate
// metrics maps directly onto the SystemChange status axis.
const VERDICT_STATUS = { promote: 'kept', hold: 'measuring', reject: 'reverted' };

function latestTsForUnit(rows, unit) {
  let max = null;
  for (const r of rows) {
    if (r?.unit !== unit) continue;
    const t = typeof r.ts === 'number' ? r.ts : (typeof r.ts === 'string' ? Date.parse(r.ts) : NaN);
    if (Number.isFinite(t) && (max === null || t > max)) max = t;
  }
  return max;
}

function promotionChanges(outcomeRows) {
  const out = [];
  const rows = Array.isArray(outcomeRows) ? outcomeRows : [];
  if (!rows.length) return out;

  let base;
  try {
    base = promotionView(rows);
  } catch {
    return out; // fail-open: a broken promotion-view call contributes nothing
  }
  if (!base.available) return out;

  const championUnit = base.champion.unit;
  for (const u of base.units) {
    if (u.unit === championUnit) continue;
    try {
      const v = promotionView(rows, { champion: championUnit, challenger: u.unit });
      if (!v.available) continue;
      out.push({
        id: `promotion-${u.unit}`,
        type: 'promotion',
        title: `${u.unit} vs ${championUnit}`,
        evidence: { eventRefs: [] },
        status: VERDICT_STATUS[v.verdict] ?? 'measuring',
        measuredEffect: {
          directions: v.directions,
          champion: v.champion,
          challenger: v.challenger,
          perMetric: v.perMetric,
          sequential: v.sequential,
        },
        gatePolicy: 'conservative',
        ts: latestTsForUnit(rows, u.unit),
      });
    } catch { /* fail-open per challenger unit */ }
  }
  return out;
}

// Shared branch for a skill's whole propose-only lifecycle. `action`
// discriminates the three row shapes (adopt/archive/update) within the
// single type:'skill' - see docs/superpowers/plans/2026-07-09-skill-
// capability-lifecycle.md Part A. adopt rows come from a real state machine
// (skill-adopt-store.js) so they can reach any of the 5 statuses; archive/
// update rows are pure recomputed-on-demand candidate lists (no persisted
// state machine, mirrors guard-retire.js's retireCandidates()) so they are
// always 'proposed' - turning them into kept/reverted would require a
// human-executed filesystem action that is out of scope here.

const SKILL_ADOPT_STATUS = {
  discovered: 'proposed', quarantined: 'proposed', 'pending-approval': 'proposed',
  approved: 'measuring', trialing: 'measuring',
  kept: 'kept', rejected: 'reverted',
};

function skillAdoptChangeFrom(item, shadow) {
  const status = SKILL_ADOPT_STATUS[item.status] ?? 'proposed';
  const bucket = item.gapCode && shadow?.byClass ? shadow.byClass[item.gapCode] : null;
  const name = item.candidate?.name ?? item.gapCode ?? 'skill candidate';
  return {
    id: `skill-adopt-${item.id}`,
    type: 'skill',
    title: `adopt: ${name}`,
    evidence: { sessionId: item.sessionId ?? null },
    status,
    measuredEffect: bucket ? { shadowRates: bucket } : null,
    gatePolicy: 'conservative',
    ts: item.updatedTs ?? item.createdTs ?? null,
    action: 'adopt',
    skillRef: {
      id: item.id, name,
      plugin: item.candidate?.registryName ?? null,
      source: 'registry',
    },
  };
}

function skillArchiveChangeFrom(cand) {
  return {
    id: `skill-archive-${cand.id}`,
    type: 'skill',
    title: `archive: ${cand.name}`,
    evidence: { sessionId: null },
    status: 'proposed',
    measuredEffect: {
      uses: 0,
      observedDays: typeof cand.observedDays === 'number' ? cand.observedDays : null,
      exempt: false,
    },
    gatePolicy: 'medium',
    ts: null,
    action: 'archive',
    skillRef: { id: cand.id, name: cand.name, plugin: cand.plugin ?? null, source: 'installed' },
  };
}

function skillUpdateChangeFrom(cand) {
  return {
    id: `skill-update-${cand.id}`,
    type: 'skill',
    title: `update: ${cand.id} ${cand.version ?? '?'} -> ${cand.latestVersion ?? '?'}`,
    evidence: { sessionId: null },
    status: 'proposed',
    measuredEffect: {
      currentVersion: cand.version ?? null,
      latestVersion: cand.latestVersion ?? null,
      sourceRepo: cand.sourceRepo ?? null,
    },
    gatePolicy: 'medium',
    ts: null,
    action: 'update',
    skillRef: { id: cand.id, name: cand.id, plugin: null, source: 'installed' },
  };
}

function skillChanges(skillAdoptItems, skillArchiveCandidates, skillUpdateCandidates, shadow) {
  const out = [];
  for (const item of Array.isArray(skillAdoptItems) ? skillAdoptItems : []) {
    if (!item || typeof item !== 'object' || !item.id) continue;
    try { out.push(skillAdoptChangeFrom(item, shadow)); } catch { /* fail-open per row */ }
  }
  for (const cand of Array.isArray(skillArchiveCandidates) ? skillArchiveCandidates : []) {
    if (!cand || typeof cand !== 'object' || !cand.id) continue;
    try { out.push(skillArchiveChangeFrom(cand)); } catch { /* fail-open per row */ }
  }
  for (const cand of Array.isArray(skillUpdateCandidates) ? skillUpdateCandidates : []) {
    if (!cand || typeof cand !== 'object' || !cand.id) continue;
    try { out.push(skillUpdateChangeFrom(cand)); } catch { /* fail-open per row */ }
  }
  return out;
}

// A measurable's current decision is its LATEST label (measurables-store.js's
// `labels` is an append-only history) - no labels at all reads as 'proposed',
// same honesty convention every other mapper in this file uses.
const MEASURABLE_STATUS = { approve: 'kept', reject: 'reverted', prune: 'reverted' };

function measurableChangeFrom(m) {
  const labels = Array.isArray(m.labels) ? m.labels : [];
  const decision = labels.length ? labels[labels.length - 1].decision : null;
  const status = decision ? (MEASURABLE_STATUS[decision] ?? 'proposed') : 'proposed';
  return {
    id: `measurable-${m.id}`,
    type: 'measurable',
    title: m.title ?? m.kind ?? 'measurable',
    evidence: { sessionId: m.evidence?.sessionId ?? null },
    status,
    measuredEffect: m.metric ?? null,
    gatePolicy: 'medium',
    ts: m.updatedTs ?? m.createdTs ?? null,
  };
}

function measurableChanges(measurables) {
  const out = [];
  for (const m of Array.isArray(measurables) ? measurables : []) {
    if (!m || typeof m !== 'object' || !m.id) continue;
    try { out.push(measurableChangeFrom(m)); } catch { /* fail-open per row */ }
  }
  return out;
}

// research-scanner-store.js's own 5-status state machine (quarantined ->
// proposed -> trialing -> kept | retired) maps directly onto the SystemChange
// status axis - this is the SAME shape skill-adopt-store.js's rows already
// use above, just a distinct `type` per the Coordination Contract ("a build
// never reuses or overloads another's type").

const RESEARCH_CANDIDATE_STATUS = {
  quarantined: 'proposed', proposed: 'proposed',
  trialing: 'measuring', kept: 'kept', retired: 'reverted',
};

function researchCandidateChangeFrom(item) {
  const name = item.candidate?.name ?? item.id;
  return {
    id: `research-candidate-${item.id}`,
    type: 'research-candidate',
    title: `research: ${name}`,
    evidence: { sessionId: null },
    status: RESEARCH_CANDIDATE_STATUS[item.status] ?? 'proposed',
    measuredEffect: item.trial?.verifierResult ? { verifierResult: item.trial.verifierResult } : null,
    gatePolicy: 'conservative',
    ts: item.updatedTs ?? item.createdTs ?? null,
    sourceRef: item.candidate?.sourceRef ?? null,
  };
}

function researchCandidateChanges(items) {
  const out = [];
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item !== 'object' || !item.id) continue;
    try { out.push(researchCandidateChangeFrom(item)); } catch { /* fail-open per row */ }
  }
  return out;
}

// North-star (aggregate weekly rollup trend) is a stretch feature with no
// wired historical-rollup source yet - omitted as null rather than invented.
function buildScoreboard(changes) {
  const tracked = changes.length;
  const netPositive = changes.filter(c => c.status === 'kept').length;
  const revertedNoHelp = changes.filter(c => c.status === 'reverted').length;
  const unmeasured = changes.filter(c => c.status === 'proposed' || c.status === 'measuring').length;
  return { tracked, netPositive, revertedNoHelp, unmeasured, northStar: null };
}

// Extends the changes ledger with 4 paired, denominator-visible metrics over
// a rolling window, so the Loop view never shows a bare rate with no sense
// of the sample size behind it. Pure: consumes only the already-built
// SystemChange[] (no I/O, no store reads) - the caller (server.js's
// /api/changes handler) passes buildSystemChanges().changes straight in.
//
// Window: a change counts toward every metric below only when its `ts` is a
// finite number inside [now - windowDays, now]. A change with ts:null (no
// known timestamp) is excluded from every windowed count rather than
// guessed into the window - same "never invent a number" discipline the
// rest of this file already follows.
//
// Field-by-field provenance (this function does NOT invent data the input
// doesn't carry):
//   isAdopted(c) = a capability row that reached ACTIVE use: status 'kept',
//     OR (type 'guard' AND status 'measuring'). The guard carve-out exists
//     because GUARD_STATUS (top of file) has no path to 'kept' at all - a
//     guard's ceiling in the fixed status enum is 'applied' -> 'measuring',
//     there is no "shadow-confirmed -> kept" transition in learning-store.js
//     today. Without this carve-out no guard could ever count as accepted/
//     adopted no matter how many are applied and firing (glmps-138 I2 fix).
//   isCapability(c) = type !== 'measurable'. A measurable row is a META-
//     decision about retiring a DIFFERENT capability (a guard-retire.js /
//     skill-retire.js candidate, persisted via measurable-persist.js), not a
//     capability adoption itself - it must not dilute or inflate acceptance/
//     regression (glmps-138 I3 fix). It still drives lifecycle.deprecated
//     below (that field's whole purpose is counting measurable rows).
//   acceptance.proposed/.accepted = windowed, isCapability rows only;
//     .accepted is the isAdopted subset (not only literal 'kept').
//   regression.adopted = same isAdopted/isCapability population as
//     acceptance.accepted. .reverted = windowed, isCapability, status
//     'reverted', AND NOT isProposalStageRejection(c) (see that function's
//     own doc comment below for the full per-type reasoning). Originally
//     (glmps-138 I2/I3) this excluded guard rows only, via a hardcoded
//     `type !== 'guard'`: GUARD_STATUS maps BOTH discarded and failed to
//     'reverted' unconditionally, and neither is ever reached FROM
//     'applied'/'measuring' in learning-store.js today - every guard
//     'reverted' row is a proposal-stage rejection, not a regression of
//     something that was actually adopted, and counting them inflated the
//     rate against a denominator (adopted) that structurally could never
//     include a guard. glmps-142 generalized this to skill and research-
//     candidate rows too, which have the identical structural property in
//     their own backing stores (verified, not assumed - see
//     isProposalStageRejection's comment) but were missing the exclusion,
//     so a skill/research candidate rejected before ever being adopted
//     could inflate regression.rate the same way guard rows used to.
//     promotion is deliberately excluded from this exclusion (regression.
//     reverted still counts every windowed, isCapability, status:'reverted'
//     promotion row, same as before glmps-142) - see isProposalStageRejection.
//     .rate = reverted/adopted (0 when adopted is 0,
//     never NaN); .band = 'healthy' for 0.05 <= rate <= 0.20, else 'low'
//     (< 0.05) or 'high' (> 0.20) - a target BAND, not a floor to minimize
//     (see the design spec: 0% is also a bad sign, not just >20%).
//     NOTE (glmps-138 I4): this is a trailing-window APPROXIMATION of the
//     spec's literal "reverted within N days of that item's OWN adoption" -
//     SystemChange carries a single `ts` per row (its last status-change
//     time), not a separate adopted-ts/reverted-ts pair, so a specific
//     revert can't be linked back to its own adoption date from this shape
//     alone. A trailing window over "recently adopted" vs "recently
//     reverted" is the closest available proxy given the data on hand -
//     documented here as a known, accepted simplification, not a silent one.
//   guardHits.count = the `guardFires` value the CALLER supplies (server.js
//     reads shadow-arm.js's raw per-fire log, which has real per-firing
//     timestamps these SystemChange rows don't carry) - this function stays
//     pure/I-O-free, so it never reads the shadow log itself, it just trusts
//     the number it's given. No value supplied -> 0, NEVER a fallback to
//     counting guard SystemChange ROWS (that counted distinct guard IDEAS
//     present in the window, not fire EVENTS - glmps-138 I1 fix).
//   lifecycle.adopted = same isAdopted/isCapability population as
//     acceptance.accepted (glmps-138 I2 fix: previously status 'kept' only,
//     so a guard could never appear here either). lifecycle.deprecated =
//     windowed changes of type 'measurable' (any status) - a measurable row
//     IS a guard/skill retire candidate by construction, so its presence
//     this period already means "flagged for deprecation", independent of
//     whether the human decision on it (approve/reject/prune) has landed
//     yet. lifecycle.retired = same population as regression.reverted (kept
//     in lock-step - they were already defined identically before this fix,
//     and remain so, including the glmps-142 isProposalStageRejection
//     generalization): type 'measurable' is excluded so a single row never
//     lands in both the deprecated and retired buckets at once, and guard/
//     skill/research-candidate proposal-stage rejections are excluded for
//     the same reason as regression.reverted above.
export const MS_PER_DAY = 86400000;
export const DEFAULT_WINDOW_DAYS = 30;
const REGRESSION_BAND_LOW = 0.05;
const REGRESSION_BAND_HIGH = 0.20;

function regressionBand(rate) {
  if (rate < REGRESSION_BAND_LOW) return 'low';
  if (rate > REGRESSION_BAND_HIGH) return 'high';
  return 'healthy';
}

function isAdopted(c) {
  return c.status === 'kept' || (c.type === 'guard' && c.status === 'measuring');
}

function isCapability(c) {
  return c.type !== 'measurable';
}

// glmps-142: generalizes the guard-only exclusion regression.reverted used
// to hardcode (`c.type !== 'guard'`). A status:'reverted' row is a
// proposal-stage rejection, not a genuine regression, when the capability's
// OWN backing store makes 'kept' (or the type's isAdopted-equivalent
// active state) STRUCTURALLY unreachable after the native status that
// collapsed into 'reverted' - i.e. the store's real mutator for that
// terminal transition throws if the item is already 'kept' (a TERMINAL
// guard), so a row can NEVER read 'reverted' having passed through 'kept'
// first. Verified against each store directly, not assumed:
//   guard: GUARD_STATUS maps discarded/failed -> 'reverted'.
//     learning-store.js has no applied/measuring -> discarded/failed path
//     (discard fires from pending/dispatched; failed fires when an apply
//     ATTEMPT throws, before the item ever reaches 'applied'). Original
//     glmps-138 I2/I3 exclusion.
//   skill (adopt rows only - archive/update rows are always 'proposed',
//     never 'reverted', so this predicate is moot for them): SKILL_ADOPT_
//     STATUS maps rejected -> 'reverted'. skill-adopt-store.js's
//     rejectCandidate AND resolveTrial both throw if the item's current
//     status is already in TERMINAL = {kept, rejected} - 'rejected' is
//     reachable only from quarantined/pending-approval/approved/trialing.
//   research-candidate: RESEARCH_CANDIDATE_STATUS maps retired ->
//     'reverted'. research-scanner-store.js's retireCandidate AND
//     resolveTrial both throw the same way, on the same TERMINAL =
//     {kept, retired} guard - 'retired' is reachable only from
//     quarantined/proposed/trialing.
// promotion is deliberately NOT included here: VERDICT_STATUS's verdict is
// recomputed fresh from a live champion/challenger comparison on every
// buildSystemChanges() call (promotion-view.js), with no persisted
// terminal-state guard anywhere in that path - a unit's verdict can
// legitimately swing from 'promote' (kept) to 'reject' (reverted) across
// calls as new outcome rows arrive or the champion changes (e.g. a
// formerly-incumbent unit dethroned by a newer one with more outcomes).
// Excluding it type-wide here would silently UNDER-count real regressions,
// the opposite failure mode from the one this predicate exists to fix.
function isProposalStageRejection(c) {
  if (c.type === 'guard') return true;
  if (c.type === 'skill') return true;
  if (c.type === 'research-candidate') return true;
  return false;
}

export function buildLoopMetrics(changes, { now = Date.now(), windowDays = DEFAULT_WINDOW_DAYS, guardFires = null } = {}) {
  const windowStart = now - windowDays * MS_PER_DAY;
  const list = Array.isArray(changes) ? changes : [];
  const windowed = list.filter((c) => {
    if (!c || typeof c !== 'object') return false;
    return typeof c.ts === 'number' && Number.isFinite(c.ts) && c.ts >= windowStart && c.ts <= now;
  });

  const capabilities = windowed.filter(isCapability);

  const proposed = capabilities.length;
  const accepted = capabilities.filter(isAdopted).length;
  const acceptanceRate = proposed > 0 ? accepted / proposed : 0;

  const adopted = accepted; // same population - see field-by-field provenance above
  const reverted = capabilities.filter((c) => c.status === 'reverted' && !isProposalStageRejection(c)).length;
  const regressionRate = adopted > 0 ? reverted / adopted : 0;

  const guardHitsCount = (typeof guardFires === 'number' && Number.isFinite(guardFires)) ? guardFires : 0;

  const lifecycleAdopted = accepted;
  const lifecycleDeprecated = windowed.filter((c) => c.type === 'measurable').length;
  const lifecycleRetired = reverted;

  return {
    acceptance: { accepted, proposed, rate: acceptanceRate },
    regression: { reverted, adopted, rate: regressionRate, band: regressionBand(regressionRate) },
    guardHits: { count: guardHitsCount },
    lifecycle: { adopted: lifecycleAdopted, deprecated: lifecycleDeprecated, retired: lifecycleRetired },
  };
}

// Every defect this design fixes went unnoticed for two to seven weeks. A
// tile per capability kind, showing when it last actually changed state,
// makes the next dead edge visible in days instead of weeks, but only if it
// lands where it is actually looked at and can actually go red (see the
// design doc's own risk section), hence 14 days: half the pre-registered
// 2-week baseline window this design's rollout uses.
export const DEFAULT_LIVENESS_STALE_DAYS = 14;

/**
 * @param {Array<{type: string, ts: number|null}>} changes
 * @param {{ now?: number, staleDays?: number }} [opts]
 * @returns {Record<string, { lastTs: number|null, ageDays: number|null, stale: boolean }>}
 */
export function buildLiveness(changes, { now = Date.now(), staleDays = DEFAULT_LIVENESS_STALE_DAYS } = {}) {
  const list = Array.isArray(changes) ? changes : [];
  const lastTsByType = {};
  for (const c of list) {
    if (!c || typeof c.type !== 'string') continue;
    if (typeof c.ts !== 'number' || !Number.isFinite(c.ts)) continue;
    if (!(c.type in lastTsByType) || c.ts > lastTsByType[c.type]) lastTsByType[c.type] = c.ts;
  }
  const typesSeen = new Set(list.filter((c) => c && typeof c.type === 'string').map((c) => c.type));
  const out = {};
  for (const type of typesSeen) {
    const lastTs = lastTsByType[type] ?? null;
    const ageDays = lastTs != null ? (now - lastTs) / MS_PER_DAY : null;
    out[type] = { lastTs, ageDays, stale: lastTs == null || ageDays > staleDays };
  }
  return out;
}

export function buildSystemChanges({
  outcomeRows,
  learningItems,
  memoryProposals,
  shadow,
  skillAdoptItems = [],
  skillArchiveCandidates = [],
  skillUpdateCandidates = [],
  measurables = [],
  researchCandidateItems = [],
} = {}) {
  let guard = [], memory = [], promotion = [], skill = [], measurable = [], researchCandidate = [];
  try { guard = guardChanges(learningItems, shadow); } catch { guard = []; }
  try { memory = memoryChanges(memoryProposals); } catch { memory = []; }
  try { promotion = promotionChanges(outcomeRows); } catch { promotion = []; }
  try { skill = skillChanges(skillAdoptItems, skillArchiveCandidates, skillUpdateCandidates, shadow); } catch { skill = []; }
  try { measurable = measurableChanges(measurables); } catch { measurable = []; }
  try { researchCandidate = researchCandidateChanges(researchCandidateItems); } catch { researchCandidate = []; }

  const changes = [...guard, ...memory, ...promotion, ...skill, ...measurable, ...researchCandidate]
    .sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));

  return { changes, scoreboard: buildScoreboard(changes) };
}
