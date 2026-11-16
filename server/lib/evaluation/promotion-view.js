/**
 * promotion-view.js
 * Builds the champion/challenger promotion view for the Experiments page:
 * aggregate outcome rows by `unit`, pick a champion (incumbent) and challenger,
 * and run the Pareto promotion evaluator over their aggregate metrics.
 * Pure; zero deps beyond promotion.js.
 */
import { evaluatePromotion, evaluatePromotionSequential } from './promotion.js';
import { tagValue } from './evidence.js';

// Which direction is "better" for each aggregate metric the verdict compares.
export const DIRECTIONS = {
  medianTurns: 'lower',
  verifierPassRate: 'higher',
  firstTryRate: 'higher',
  medianContextUsage: 'lower',
};

// Minimum raw per-unit outcome rows (each side) before the small-sample
// sequential test is attempted at all. Below this, promotionView() still
// returns the aggregate Pareto verdict - only `sequential.available` is false.
export const MIN_SEQUENTIAL_ROWS = 5;

function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function metricsFor(rows) {
  const turns = rows.map(r => r.turns).filter(v => v != null);
  const vr = rows.filter(r => r.verifier?.exitOk != null).map(r => r.verifier.exitOk === true);
  const ft = rows.filter(r => r.firstTry != null).map(r => r.firstTry === true);
  const ctx = rows.map(r => r.contextUsageRatio).filter(v => v != null);
  return {
    medianTurns: tagValue(median(turns), turns),
    verifierPassRate: tagValue(vr.length ? vr.filter(Boolean).length / vr.length : null, vr),
    firstTryRate: tagValue(ft.length ? ft.filter(Boolean).length / ft.length : null, ft),
    medianContextUsage: tagValue(median(ctx), ctx),
  };
}

// Groups raw rows by `unit`; shared by aggregateByUnit (aggregate metrics) and
// promotionView (which also needs the raw per-row samples for the sequential test).
function groupByUnit(rows) {
  const groups = {};
  for (const row of rows) {
    const u = row.unit ?? '(unversioned)';
    (groups[u] ??= []).push(row);
  }
  return groups;
}

/**
 * Aggregate outcome rows by `unit` (the version/cohort axis). Each of the
 * four metrics is an evidence-tagged envelope from evidence.js's tagValue():
 * { value, evidence: 'measured'|'constant'|'absent', n, reason? }.
 * @returns {Record<string, {unit, n, medianTurns:object, verifierPassRate:object, firstTryRate:object, medianContextUsage:object}>}
 */
export function aggregateByUnit(rows = []) {
  const groups = groupByUnit(rows);
  const byUnit = {};
  for (const [u, gr] of Object.entries(groups)) {
    byUnit[u] = { unit: u, n: gr.length, ...metricsFor(gr) };
  }
  return byUnit;
}

// Raw numeric `turns` samples for a set of rows (the per-outcome-row metric fed
// to the sequential test - turns is the only continuous per-row metric on an
// OutcomeRow; verifier/firstTry are booleans and contextUsageRatio is sparser).
function turnsSamples(rows) {
  return rows.map(r => r.turns).filter(v => Number.isFinite(v));
}

// medianTurns is lower-is-better; sign-flip so the mSPRT's "B is higher" convention
// consistently reads as "challenger better" regardless of the metric's own direction.
function directionalSamples(samples, direction) {
  return direction === 'lower' ? samples.map(v => -v) : samples;
}

// Counts how many of the four metrics are 'measured' for a unit's tagged
// aggregate (the shape metricsFor now returns after Task 4).
function measuredCount(unitMetrics) {
  return Object.values(unitMetrics).filter((m) => m && m.evidence === 'measured').length;
}

function pluckEvidence(unitMetrics) {
  const out = {};
  for (const [k, v] of Object.entries(unitMetrics)) {
    if (k === 'unit' || k === 'n') continue;
    out[k] = v?.evidence ?? 'absent';
  }
  return out;
}

/**
 * promotionView(rows, { champion, challenger }) -> view object.
 * Defaults: champion = the unit with the MOST outcomes (the incumbent with the
 * longest track record); challenger = the next unit by outcome count. Either can
 * be overridden by passing an explicit unit id. Needs >= 2 units to compare.
 */
export function promotionView(rows = [], { champion, challenger } = {}) {
  const byUnit = aggregateByUnit(rows);
  const units = Object.values(byUnit).sort((a, b) => b.n - a.n);
  if (units.length < 2) {
    return {
      available: false,
      reason: units.length === 0 ? 'no outcome records yet' : 'need at least two units to compare',
      units,
      directions: DIRECTIONS,
    };
  }
  const champUnit = (champion && byUnit[champion]) ? byUnit[champion] : units[0];
  const chalUnit = (challenger && byUnit[challenger]) ? byUnit[challenger]
    : units.find(u => u.unit !== champUnit.unit);

  // Refuse to issue a promote/hold/reject recommendation when fewer than two
  // of the four aggregate metrics are a real measurement on either side. A
  // verdict resting on one non-quality proxy (or on zero real metrics) is
  // worse than admitting there isn't enough evidence yet.
  const champMeasured = measuredCount(champUnit);
  const chalMeasured = measuredCount(chalUnit);
  if (champMeasured < 2 || chalMeasured < 2) {
    return {
      available: true,
      verdict: 'insufficient-evidence',
      champion: champUnit,
      challenger: chalUnit,
      directions: DIRECTIONS,
      perMetric: { champion: pluckEvidence(champUnit), challenger: pluckEvidence(chalUnit) },
      n: { champion: champUnit.n, challenger: chalUnit.n },
      units,
    };
  }

  const ev = evaluatePromotion({ champion: champUnit, challenger: chalUnit, directions: DIRECTIONS });

  // Small-sample sequential decision (mSPRT), companion to the Pareto verdict
  // above - NOT a replacement. Pareto stays the guardrail-regression veto over
  // aggregate medians; this runs over the raw per-outcome-row `turns` samples for
  // the same champion/challenger pair, so a call can be made before enough units
  // have accumulated for the aggregate to be trustworthy. `sequential.available`
  // distinguishes "not enough per-unit rows for this test" from the top-level
  // `available:false` above ("not enough units to compare at all").
  const groups = groupByUnit(rows);
  const sequential = evaluatePromotionSequential({
    championSamples: directionalSamples(turnsSamples(groups[champUnit.unit] ?? []), DIRECTIONS.medianTurns),
    challengerSamples: directionalSamples(turnsSamples(groups[chalUnit.unit] ?? []), DIRECTIONS.medianTurns),
    minSamples: MIN_SEQUENTIAL_ROWS,
  });

  return {
    available: true,
    champion: champUnit,
    challenger: chalUnit,
    directions: DIRECTIONS,
    verdict: ev.verdict,
    rationale: ev.rationale,
    perMetric: ev.perMetric,
    n: { champion: champUnit.n, challenger: chalUnit.n },
    units,
    sequential,
  };
}
