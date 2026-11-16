// web/evaluation/substrate-loop.js
// Loop - Evolution pillar view (glmps-138 Task 7 restructure; internal name
// "substrate-loop" / data-view kept for hook-path stability). Structure per
// the design spec ("View 1 - Loop"):
//   1. Metrics strip (always visible, top) - the 4 paired, denominator-
//      visible loopMetrics from GET /api/changes (acceptance, regression
//      w/ target band, guardrail hits, lifecycle counts). No vanity
//      accumulation counters.
//   2. In-view segmented control - Ledger | Signals | Outcomes:
//      - Ledger: the unified 6-type SystemChange[] ledger (unchanged from
//        the prior single-page render) plus the Activity Spine evidence
//        drill-down, mounted eagerly (it's the default segment).
//      - Signals: mounts alerts.js's renderAlerts() (security/governance
//        detections), lazy-mounted on first activation.
//      - Outcomes: mounts experiments.js's renderExperiments() (Harness
//        Quality / Recent Outcomes / Champion-vs-Challenger / Eval-Replay
//        Set) behind a "Seed baseline" action bar (POST /api/replay/seed),
//        lazy-mounted on first activation. The Evolution lens mounts the
//        same body as its Experiments tab.
// renderLoop(container, handlers) is the entry app.js's nav task
// mounts; `renderSubstrateLoop` is kept as a same-function alias so the
// CURRENT (pre-Task-8) app.js call site (`substrateLoopMod.
// renderSubstrateLoop(container, handlers)`) keeps working unmodified.
// `handlers.onOpenSession(id)` (already used by History/Dashboard) is reused
// so Ledger evidence links navigate in-SPA rather than a full page load.
//
// XSS discipline: all data reaches the DOM via textContent/createElement/
// setAttribute. innerHTML is not used; containers are emptied with clear().
// The chevron icon is inline SVG built via createElementNS (no emoji
// icons, no innerHTML).
import { setText, metricValue, evidenceLabel, clear } from '../shared/dom-util.js';
import { renderAlerts } from './alerts.js';
import { renderExperiments } from './experiments.js';
import { bindItem } from '../shared/interactive-item.js';
import { linkFor } from '../shared/deep-link.js';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) setText(node, text);
  return node;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
function svgChevron() {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '14');
  svg.setAttribute('height', '14');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'sl-chevron');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', 'M6 9l6 6 6-6');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '2');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(path);
  return svg;
}

function fmtPct(v) {
  const n = Number(v);
  return v == null || !Number.isFinite(n) ? '\u2014' : Math.round(n * 100) + '%';
}
function fmtNum(v, digits = 1) {
  const n = Number(v);
  return v == null || !Number.isFinite(n) ? '\u2014' : n.toFixed(digits);
}
function isPctMetric(key) {
  const k = key.toLowerCase();
  return k.includes('rate') || k.includes('usage');
}
const METRIC_LABEL = {
  medianTurns: 'median turns', verifierPassRate: 'verifier pass', firstTryRate: 'first-try rate',
  medianContextUsage: 'context usage',
};
function labelForMetric(key) { return METRIC_LABEL[key] || key; }

// hues (blue/gold/purple) for memory/guard/promotion, plus three loop-scoped
// hues (green/rose/coral) added for skill/measurable/research-candidate; dot
// is always paired with a printed label, never color alone. -----------------
const LOOP_LABEL = {
  memory: 'Memory', guard: 'Guardrail', promotion: 'Promotion',
  skill: 'Skill', measurable: 'Measurable', 'research-candidate': 'Research',
};
const LOOP_CLASS = {
  memory: 'sl-loop-memory', guard: 'sl-loop-guardrail', promotion: 'sl-loop-promotion',
  skill: 'sl-loop-skill', measurable: 'sl-loop-measurable', 'research-candidate': 'sl-loop-research-candidate',
};

function loopDot(type) {
  const dot = el('span', 'sl-dot ' + (LOOP_CLASS[type] || ''));
  dot.setAttribute('aria-hidden', 'true');
  return dot;
}

function loopTag(type) {
  const tag = el('span', 'sl-loop-tag');
  tag.appendChild(loopDot(type));
  tag.appendChild(document.createTextNode(LOOP_LABEL[type] || type));
  return tag;
}

// signal. 'applied' folds into the same visual treatment as 'measuring'
// (both mean "live, not yet a kept/reverted verdict"). ----------------------
const STATUS_LABEL = { proposed: 'Proposed', measuring: 'Measuring', applied: 'Measuring', kept: 'Kept', reverted: 'Reverted' };
// 'applied' visually folds into the same 'measuring' variant everywhere (badge,
// verdict box) - both mean "live, not yet a kept/reverted verdict" - so only
// four CSS variants (proposed/measuring/kept/reverted) are ever needed.
function statusVariant(status) { return status === 'applied' ? 'measuring' : (status || 'proposed'); }

function statusBadge(status) {
  const variant = statusVariant(status);
  const badge = el('span', 'sl-status sl-status--' + variant);
  const dot = el('span', 'sl-dot-sm');
  dot.setAttribute('aria-hidden', 'true');
  badge.appendChild(dot);
  badge.appendChild(document.createTextNode(STATUS_LABEL[status] || status));
  return badge;
}

// Replaces the old cumulative "Hero scoreboard" (raw all-time tracked/kept/
// reverted/pending counts - a vanity-accumulation shape the design spec
// explicitly rules out). Every number here is paired with its denominator
// (acceptance, regression) or is an explicit period count (guard hits,
// lifecycle) - see server/lib/evaluation/system-changes.js buildLoopMetrics().
const EMPTY_LOOP_METRICS = {
  acceptance: { accepted: 0, proposed: 0, rate: 0 },
  regression: { reverted: 0, adopted: 0, rate: 0, band: 'healthy' },
  guardHits: { count: 0 },
  lifecycle: { adopted: 0, deprecated: 0, retired: 0 },
};

// glmps-138 fix pass: mirrors server/lib/evaluation/system-changes.js's
// DEFAULT_WINDOW_DAYS (the rolling window buildLoopMetrics computes over,
// server.js's /api/changes handler pins guardHits to the same window). Not
// fetched from an API - there is no route exposing it - so this is a
// documented static fact about the backend, same precedent as capability-
// row.js's STALE_DAYS/RETIRE_DAYS mirroring guard-retire.js's staleness().
// Exists so the metrics strip can label guardHits/lifecycle/acceptance as
// an explicit "last 30 days" window instead of the bare "this period" wording
// that shipped without a caption (wave2-review.md Loop review Minor finding).
export const LOOP_WINDOW_DAYS = 30;

function fmtRatio(num, den) {
  const n = Number.isFinite(Number(num)) ? Number(num) : 0;
  const d = Number.isFinite(Number(den)) ? Number(den) : 0;
  return `${n} / ${d}`;
}

const BAND_LABEL = { low: 'Low', healthy: 'Healthy', high: 'High' };

// Band is a TARGET band, not a floor to minimize: healthy (5-20%) reads as
// good (success/cyan), while BOTH low (<5%) and high (>20%) are flagged -
// distinctly, so an operator can tell "not enough regressions caught" (low,
// warning/amber) from "too many regressions" (high, destructive/rust) at a
// glance. Falls back to 'healthy' for an unrecognized band string (fail-open,
// never invents a worse-looking state than the data supports).
function buildBandBadge(band) {
  const b = BAND_LABEL[band] ? band : 'healthy';
  const badge = el('span', 'sl-band-badge sl-band-badge--' + b);
  const dot = el('span', 'sl-dot-sm');
  dot.setAttribute('aria-hidden', 'true');
  badge.appendChild(dot);
  badge.appendChild(document.createTextNode(BAND_LABEL[b]));
  return badge;
}

function buildMetricTile(extraClass, value, label, sub, badge) {
  const tile = el('div', `an-stat sl-kpi ${extraClass}`);
  tile.appendChild(el('span', 'an-stat-value', value));
  tile.appendChild(el('span', 'an-stat-label', label));
  if (badge) tile.appendChild(badge);
  if (sub) tile.appendChild(el('span', 'sl-kpi-sub', sub));
  return tile;
}

function buildLifecycleTile(lifecycle) {
  const tile = el('div', 'an-stat sl-kpi sl-kpi--lifecycle');
  tile.appendChild(el('span', 'an-stat-label', 'Lifecycle this period'));
  const parts = el('div', 'sl-lifecycle-parts');
  const defs = [
    ['adopted', lifecycle.adopted, 'Adopted'],
    ['deprecated', lifecycle.deprecated, 'Deprecated'],
    ['retired', lifecycle.retired, 'Retired'],
  ];
  for (const [key, n, partLabel] of defs) {
    const part = el('div', `sl-lifecycle-part sl-lifecycle-part--${key}`);
    part.appendChild(el('span', 'sl-lifecycle-part-value', String(Number.isFinite(Number(n)) ? n : 0)));
    part.appendChild(el('span', 'sl-lifecycle-part-label', partLabel));
    parts.appendChild(part);
  }
  tile.appendChild(parts);
  return tile;
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
export function regressionWording(reg) {
  const r = Number.isFinite(Number(reg?.reverted)) ? Number(reg.reverted) : 0;
  const a = Number.isFinite(Number(reg?.adopted)) ? Number(reg.adopted) : 0;
  return `${plural(r, 'regression', 'regressions')} against ${plural(a, 'adoption', 'adoptions')}`;
}

export function buildMetricsStrip(loopMetricsIn) {
  const lm = loopMetricsIn || EMPTY_LOOP_METRICS;
  const acc = lm.acceptance || EMPTY_LOOP_METRICS.acceptance;
  const reg = lm.regression || EMPTY_LOOP_METRICS.regression;
  const gh = lm.guardHits || EMPTY_LOOP_METRICS.guardHits;
  const lc = lm.lifecycle || EMPTY_LOOP_METRICS.lifecycle;
  const band = BAND_LABEL[reg.band] ? reg.band : 'healthy';

  const strip = el('section', 'an-panel sl-metrics-strip');
  strip.setAttribute('aria-label', `Loop metrics, last ${LOOP_WINDOW_DAYS} days`);
  strip.appendChild(el('p', 'sl-panel-sub sl-metrics-period', `Last ${LOOP_WINDOW_DAYS} days`));

  const row = el('div', 'sl-kpi-row');
  row.setAttribute('role', 'group');
  row.setAttribute('aria-label', 'Loop metrics summary');

  row.appendChild(buildMetricTile('sl-kpi--acceptance',
    fmtRatio(acc.accepted, acc.proposed), 'Acceptance',
    fmtPct(acc.rate) + ' accepted'));

  // Phase 2 (AC-4): reverts and adoptions are counted over the same window but
  // a revert can undo a change adopted before it, so reverted / adopted is not
  // a share of anything (it ran to 400%). The tile states the two counts and
  // the target in counts, and never prints a percentage here.
  row.appendChild(buildMetricTile('sl-kpi--regression sl-kpi--band-' + band,
    regressionWording(reg), 'Regressions against adoptions',
    'target: at most 1 revert per 5 adoptions',
    buildBandBadge(band)));

  // glmps-138 Task 7 edge-triggered the underlying shadow write for NEW
  // recurrences: learning-store.js's upsertGap() now fires at most once per
  // (episode, code) transition instead of once per re-detection. But this
  // tile's count (server's firedCountInWindow) sums fired:true across THREE
  // writers, and only that one is episode-gated - learning-apply.js's
  // applyGuard fires once at first auto-apply (no episodeId, but honestly
  // singular by construction) and the alert-seen.js path fires once per
  // first-seen alert id (its own dedup, also no episodeId). A caption
  // asserting uniform "first fire per (episode, code)" semantics for the
  // whole number would be false today and stay false later, since two of
  // the three writers never carry episodeId at all - measured 2026-07-29:
  // 30,951 fired:true rows in the 30-day window, only 1,752 carrying one.
  // So the sub-label states only what is true of every row: a count of
  // fired events, not a claim about how (or whether) they were deduped.
  row.appendChild(buildMetricTile('sl-kpi--guardhits',
    String(Number.isFinite(Number(gh.count)) ? gh.count : 0), 'Guardrail hits',
    'fired events recorded in the window'));

  row.appendChild(buildLifecycleTile(lc));

  strip.appendChild(row);
  return strip;
}

// The weekly trend is drawn only when the scoreboard carries buckets; the
// server has no rollup source yet (northStar is null), and a standing
// placeholder says nothing. Returns null so the caller adds no node.
export function buildNorthStar(scoreboard) {
  const buckets = scoreboard?.northStar?.buckets;
  if (!Array.isArray(buckets) || !buckets.length) return null;
  const panel = el('section', 'an-panel sl-northstar');
  panel.appendChild(el('h2', 'an-panel-title', 'North-Star trend'));
  const list = el('ul', 'sl-northstar-list');
  for (const b of buckets) {
    const li = el('li', 'sl-northstar-row');
    li.appendChild(el('span', 'sl-northstar-label', b.label));
    li.appendChild(el('span', 'sl-northstar-value', fmtPct(b.value)));
    list.appendChild(li);
  }
  panel.appendChild(list);
  return panel;
}

// counterfactualRate is only ever real for skill-trial.js's sandboxed replay
// rows (its runTrial genuinely computes wouldFire) - every other shadow
// writer (guard-loop recurrence, alert-seen, applyGuard) never sets
// wouldFire, so shadow-arm.js's shadowRates() reports counterfactualRate:
// null for them (honestly absent, not a fabricated 0). A null here must
// render as the spec's 'not captured' absent state, never a 0%-width meter
// bar - a 0% bar would read as "observed and it never would-fire", which is
// a claim this codepath cannot support.
function buildMeter(label, n, fireRate, counterfactualRate) {
  const block = el('div', 'sl-meter-block');
  const head = el('div', 'sl-meter-head');
  head.appendChild(el('span', null, label));
  head.appendChild(el('span', 'sl-meter-val', `${n ?? 0} sample${n === 1 ? '' : 's'}`));
  block.appendChild(head);

  const fireTrack = el('div', 'an-rank-track');
  const fireFill = el('div', 'an-rank-fill an-rank-fill-gold');
  fireFill.style.width = (fireRate == null ? 0 : Math.round(fireRate * 100)) + '%';
  fireTrack.appendChild(fireFill);
  block.appendChild(fireTrack);
  block.appendChild(el('span', 'sl-meter-caption', 'fired: ' + fmtPct(fireRate)));

  if (counterfactualRate == null) {
    block.appendChild(el('span', 'sl-meter-caption', 'would-fire: not captured'));
  } else {
    const cfTrack = el('div', 'an-rank-track');
    const cfFill = el('div', 'an-rank-fill an-rank-fill-blue');
    cfFill.style.width = Math.round(counterfactualRate * 100) + '%';
    cfTrack.appendChild(cfFill);
    block.appendChild(cfTrack);
    block.appendChild(el('span', 'sl-meter-caption', 'would-fire: ' + fmtPct(counterfactualRate)));
  }

  return block;
}

function seqSentence(change) {
  const seq = change.measuredEffect?.sequential;
  const verdictWord = change.status === 'kept' ? 'Promoted' : change.status === 'reverted' ? 'Rejected' : 'Holding';
  if (!seq || !seq.available) {
    return `${verdictWord} on the aggregate comparison \u2014 not enough paired samples yet for the sequential (mSPRT) test (n=${seq?.n ?? 0}).`;
  }
  const side = seq.decision === 'B' ? 'the challenger' : seq.decision === 'A' ? 'the champion' : 'neither side conclusively';
  return `Sequential test currently favors ${side}, over ${seq.n} paired samples.`;
}

// Renders one side of an axis card: the evidence label ('not captured' /
// 'no variance (n=N)') when the metric is not a real measurement, otherwise
// the normal numeric formatter over the unwrapped value. Also accepts a bare
// (untagged) number for older/foreign callers.
function fmtTagged(tagged, fmt) {
  return evidenceLabel(tagged) ?? fmt(metricValue(tagged));
}

function buildPromotionDetail(change) {
  const inner = el('div', 'sl-detail-inner');
  const eff = change.measuredEffect || {};
  const dirs = eff.directions || {};
  const keys = Object.keys(dirs).filter(k => eff.champion?.[k] != null || eff.challenger?.[k] != null);

  if (keys.length) {
    const axes = el('div', 'sl-detail-axes');
    for (const k of keys) {
      const before = eff.champion?.[k];
      const after = eff.challenger?.[k];
      const fmt = isPctMetric(k) ? fmtPct : (v) => fmtNum(v, 1);
      const card = el('div', 'sl-axis-card');
      card.appendChild(el('span', 'sl-axis-name', labelForMetric(k)));
      const nums = el('span', 'sl-axis-nums');
      nums.appendChild(document.createTextNode(fmtTagged(before, fmt)));
      nums.appendChild(el('span', 'sl-arrow', '\u2192'));
      nums.appendChild(document.createTextNode(fmtTagged(after, fmt)));
      card.appendChild(nums);
      const verdict = eff.perMetric?.[k];
      const deltaCls = verdict === 'better' ? 'good' : verdict === 'worse' ? 'bad' : 'flat';
      const deltaWord = verdict === 'better' ? 'better' : verdict === 'worse' ? 'worse' : '\u2014';
      card.appendChild(el('span', 'sl-delta sl-delta--' + deltaCls, deltaWord));
      axes.appendChild(card);
    }
    inner.appendChild(axes);
  } else {
    inner.appendChild(el('p', 'an-empty', 'No per-axis data available for this comparison.'));
  }

  const side = el('div', 'sl-detail-side');
  const box = el('div', 'sl-verdict-box sl-verdict-box--' + statusVariant(change.status));
  box.appendChild(el('span', 'sl-verdict-lbl', 'mSPRT / Pareto verdict'));
  box.appendChild(el('p', null, seqSentence(change)));
  side.appendChild(box);
  inner.appendChild(side);

  return inner;
}

function buildGuardDetail(change) {
  const inner = el('div', 'sl-detail-inner sl-detail-inner--single');
  const side = el('div', 'sl-detail-side');
  const eff = change.measuredEffect;
  if (eff && eff.evidence === 'exercised') {
    const box = el('div', 'sl-verdict-box sl-verdict-box--' + statusVariant(change.status));
    box.appendChild(el('span', 'sl-verdict-lbl', 'Exercised (not a claim it helped)'));
    const episodesText = eff.episodes != null ? `, across ${eff.episodes} episode${eff.episodes === 1 ? '' : 's'}` : '';
    box.appendChild(el('p', null, `Fired ${eff.fireCount} time${eff.fireCount === 1 ? '' : 's'}${episodesText}.`));
    side.appendChild(box);
  } else {
    side.appendChild(el('p', 'an-empty', change.status === 'proposed'
      ? 'Not yet applied, nothing to measure until it goes live.'
      : 'Applied, but no fire data recorded for this guard yet.'));
  }
  inner.appendChild(side);
  return inner;
}

// The backend emits one guard SystemChange per (code, project) learning-store
// item (learning-store.js keys each item by sha1(code|project)), so without
// grouping the ledger shows the same rule title once per project it fired in
// (e.g. "ui without frontend design" x 7). groupGuardChanges() collapses that
// down to one row per distinct rule.
//
// Grouping key: change.title. Guard titles are derived 1:1 from the gap code
// (titleFromGap() in learning-store.js: code.replace(/-/g, ' ')), so same
// title == same rule; instance count is therefore honestly a project count.
//
// Pure, no DOM - independently testable; see
// server/test/web-substrate-loop-ledger.test.js.
export function groupGuardChanges(changes) {
  const list = Array.isArray(changes) ? changes : [];
  const order = [];
  const byTitle = new Map();
  for (const c of list) {
    if (!c || c.type !== 'guard') continue;
    const key = c.title || 'untitled change';
    if (!byTitle.has(key)) { byTitle.set(key, []); order.push(key); }
    byTitle.get(key).push(c);
  }
  return order.map((title) => {
    const instances = byTitle.get(title);
    const statusCounts = {};
    let maxTs = null;
    let sumFireCount = 0, sumEpisodes = 0, hasEffect = false;
    for (const inst of instances) {
      const status = inst.status || 'proposed';
      statusCounts[status] = (statusCounts[status] || 0) + 1;
      if (typeof inst.ts === 'number' && (maxTs === null || inst.ts > maxTs)) maxTs = inst.ts;
      const eff = inst.measuredEffect;
      if (eff && eff.evidence === 'exercised') {
        hasEffect = true;
        sumFireCount += Number(eff.fireCount) || 0;
        sumEpisodes += Number(eff.episodes) || 0;
      }
    }
    // Sums, not an average: fireCount/episodes are counts across distinct
    // (code, project) instances, not rates, summing is the honest rollup.
    const measuredEffect = hasEffect
      ? { fireCount: sumFireCount, episodes: sumEpisodes || null, evidence: 'exercised' }
      : null;
    return {
      type: 'guard',
      grouped: true,
      id: 'guard-group-' + title,
      title,
      count: instances.length,
      statusCounts,
      ts: maxTs,
      measuredEffect,
      instances,
    };
  });
}

const STATUS_ROLLUP_ORDER = ['kept', 'measuring', 'proposed', 'reverted'];

function statusRollupChip(status, count) {
  const chip = el('span', 'sl-status sl-status--' + statusVariant(status));
  const dot = el('span', 'sl-dot-sm');
  dot.setAttribute('aria-hidden', 'true');
  chip.appendChild(dot);
  chip.appendChild(document.createTextNode(`${count} ${STATUS_LABEL[status] || status}`));
  return chip;
}

// Status rollup - one chip per distinct status among the group's instances,
// reusing the exact .sl-status badge vocabulary (color is never the only
// signal; the count + label are always printed).
function buildStatusRollup(statusCounts) {
  const wrap = el('div', 'sl-status-rollup');
  const keys = Object.keys(statusCounts).sort(
    (a, b) => STATUS_ROLLUP_ORDER.indexOf(a) - STATUS_ROLLUP_ORDER.indexOf(b));
  for (const status of keys) wrap.appendChild(statusRollupChip(status, statusCounts[status]));
  return wrap;
}

function groupEffectSummary(group) {
  const eff = group.measuredEffect;
  if (!eff || eff.evidence !== 'exercised') return 'awaiting apply';
  const episodesText = eff.episodes != null ? `, ${eff.episodes} episode${eff.episodes === 1 ? '' : 's'}` : '';
  return `fired ${eff.fireCount} time${eff.fireCount === 1 ? '' : 's'}${episodesText}`;
}

function buildGuardInstanceRow(change, handlers) {
  const item = el('div', 'sl-instance');
  const head = el('div', 'sl-instance-head');
  head.appendChild(statusBadge(change.status));
  const sid = change.evidence?.sessionId;
  if (sid && sid !== 'unknown') {
    const evidBtn = el('button', 'sl-evidence-link', 'session ' + sid + ' >');
    evidBtn.type = 'button';
    evidBtn.addEventListener('click', (ev) => { ev.stopPropagation(); handlers?.onOpenSession?.(sid); });
    head.appendChild(evidBtn);
  } else {
    head.appendChild(el('span', 'sl-instance-sid', 'session unknown'));
  }
  head.appendChild(el('span', 'sl-row-effect', effectSummary(change)));
  item.appendChild(head);
  const detail = buildGuardDetail(change); // reuse the existing per-row detail renderer
  item.appendChild(detail);

  // D-surface Task 6: every rendered item opens and links (D17). This row had
  // no expand/collapse of its own (its detail was always shown); clicking the
  // row now toggles that same detail rather than changing what it shows.
  const toggle = () => { detail.hidden = !detail.hidden; };
  bindItem(item, {
    type: 'guard', id: change.id,
    link: linkFor({ lens: 'learning', tab: 'ledger', sel: { type: 'guard', id: change.id } }),
    open: toggle, label: `Guard instance: ${change.title}`,
  });
  return item;
}

function buildGroupDetail(group, detailId, handlers) {
  const wrap = el('div', 'sl-detail');
  wrap.id = detailId;
  wrap.hidden = true;
  // A rule can carry hundreds of instances; their rows are built the first
  // time the group opens, so a collapsed ledger page stays small.
  let filled = false;
  wrap.fill = () => {
    if (filled) return;
    filled = true;
    const inner = el('div', 'sl-group-instances');
    for (const inst of group.instances) inner.appendChild(buildGuardInstanceRow(inst, handlers));
    wrap.appendChild(inner);
  };
  return wrap;
}

// Collapsed one-row-per-rule ledger row for a group with 2+ instances. A
// group with exactly one instance is rendered via the plain
// buildLedgerRow()/buildGuardDetail() path instead - see buildLedgerSection().
function buildGuardGroupRow(group, idx, handlers) {
  const row = el('div', `sl-row sl-row--group ${LOOP_CLASS.guard}`);
  row.dataset.loop = 'guard';
  row.dataset.grouped = 'true';

  row.appendChild(loopTag('guard'));

  const nameWrap = el('div', 'sl-row-name');
  nameWrap.appendChild(el('span', 'sl-change-name', group.title));
  nameWrap.appendChild(el('span', 'sl-group-count', `${group.count} project${group.count === 1 ? '' : 's'}`));
  row.appendChild(nameWrap);

  row.appendChild(buildStatusRollup(group.statusCounts));
  row.appendChild(el('div', 'sl-row-effect', groupEffectSummary(group)));

  const detailId = `sl-detail-group-${idx}`;
  // The chevron stays purely decorative (aria-hidden, out of tab order): the
  // real interactive control is the row itself, bound below via bindItem, so
  // there is exactly one focusable, one accessible name, and one deep link
  // per rule (D17) instead of a role="button" row wrapping a nested <button>.
  const expandBtn = el('button', 'sl-expand-btn');
  expandBtn.type = 'button';
  expandBtn.tabIndex = -1;
  expandBtn.setAttribute('aria-hidden', 'true');
  expandBtn.appendChild(svgChevron());
  row.appendChild(expandBtn);

  const detail = buildGroupDetail(group, detailId, handlers);

  row.setAttribute('aria-expanded', 'false');
  row.setAttribute('aria-controls', detailId);
  const toggle = () => {
    const open = row.getAttribute('aria-expanded') === 'true';
    row.setAttribute('aria-expanded', String(!open));
    // .sl-expand-btn[aria-expanded="true"] drives the chevron's rotation/tint
    // (substrate-loop.css); mirrored here since the button no longer owns the
    // click that flips it.
    expandBtn.setAttribute('aria-expanded', String(!open));
    if (!open) detail.fill();
    detail.hidden = open;
  };
  bindItem(row, {
    type: 'guard', id: group.id,
    link: linkFor({ lens: 'learning', tab: 'ledger', sel: { type: 'guard', id: group.id } }),
    open: toggle, label: `Guard rule: ${group.title}, ${group.count} projects`,
  });

  return { row, detail };
}

function buildMemoryDetail() {
  const inner = el('div', 'sl-detail-inner sl-detail-inner--single');
  const side = el('div', 'sl-detail-side');
  side.appendChild(el('p', 'an-empty',
    'Staged for human review \u2014 not yet approved into the memory index, so there is nothing to measure yet.'));
  inner.appendChild(side);
  return inner;
}

// by `change.action` (adopt/archive/update); see system-changes.js's
// skillAdoptChangeFrom / skillArchiveChangeFrom / skillUpdateChangeFrom for
// the exact fields each action populates on measuredEffect. ----------------
function skillRefLine(ref) {
  if (!ref) return null;
  const parts = [ref.name || 'unnamed skill'];
  if (ref.plugin) parts.push('plugin: ' + ref.plugin);
  if (ref.source) parts.push('source: ' + ref.source);
  return parts.join(' \u00B7 ');
}

function buildSkillDetail(change) {
  const inner = el('div', 'sl-detail-inner sl-detail-inner--single');
  const side = el('div', 'sl-detail-side');

  const refLine = skillRefLine(change.skillRef);
  if (refLine) side.appendChild(el('p', 'sl-meter-caption', refLine));

  const eff = change.measuredEffect;
  const box = el('div', 'sl-verdict-box sl-verdict-box--' + statusVariant(change.status));
  if (change.action === 'adopt') {
    const s = eff?.shadowRates;
    if (s) side.appendChild(buildMeter('Shadow fire-rate (would-have vs did)', s.n, s.fireRate, s.counterfactualRate));
    box.appendChild(el('span', 'sl-verdict-lbl', 'Skill adoption'));
    // s.n counts shadow-log ROWS for this gapCode bucket (shadow-arm.js's
    // shadowRates), not sessions: a guard-loop recurrence contributes at
    // most one row per (episode, code) transition, but a skill-trial replay
    // contributes one row per replayed task - neither is "a session". The
    // would-fire clause is only ever real for skill-trial's sandboxed rows
    // (skill-trial.js's runTrial genuinely computes wouldFire); every other
    // writer leaves counterfactualRate null, so this states that plainly
    // instead of formatting a fabricated rate.
    const cfClause = s && s.counterfactualRate == null
      ? 'would-fire rate not captured'
      : `would have fired ${fmtPct(s?.counterfactualRate)} of the time`;
    box.appendChild(el('p', null, s
      ? `${s.n} shadow observation${s.n === 1 ? '' : 's'} recorded \u00B7 fired ${fmtPct(s.fireRate)} of the time \u00B7 ${cfClause}.`
      : (change.status === 'proposed'
        ? 'Not yet approved - nothing to measure until it goes live.'
        : 'Approved, but no shadow data recorded for this skill yet.')));
  } else if (change.action === 'archive') {
    const uses = eff?.uses ?? 0;
    const days = eff?.observedDays;
    box.appendChild(el('span', 'sl-verdict-lbl', 'Archival candidate'));
    box.appendChild(el('p', null,
      `${uses} use${uses === 1 ? '' : 's'} observed${days != null ? ` over ${days} day${days === 1 ? '' : 's'}` : ''} - proposed for archiving as unused.`));
  } else if (change.action === 'update') {
    const cur = eff?.currentVersion ?? '\u2013';
    const latest = eff?.latestVersion ?? '\u2013';
    box.appendChild(el('span', 'sl-verdict-lbl', 'Upstream update available'));
    box.appendChild(el('p', null, `installed ${cur} -> latest ${latest}${eff?.sourceRepo ? ` (source: ${eff.sourceRepo})` : ''}`));
  } else {
    box.appendChild(el('span', 'sl-verdict-lbl', 'Skill change'));
    box.appendChild(el('p', 'an-empty', 'No additional detail available for this skill change.'));
  }
  side.appendChild(box);

  inner.appendChild(side);
  return inner;
}

// field, an intentionally kind-specific payload (measurables-store.js: "never
// invented") - rendered generically as key/value cards rather than assuming
// any fixed shape. `status` reflects the latest human label (approve/reject/
// prune), same as buildPromotionDetail's verdict box. -----------------------
function buildMeasurableDetail(change) {
  const inner = el('div', 'sl-detail-inner');
  const metric = change.measuredEffect;
  const entries = metric && typeof metric === 'object' ? Object.entries(metric) : [];

  if (entries.length) {
    const axes = el('div', 'sl-detail-axes');
    for (const [k, v] of entries) {
      const card = el('div', 'sl-axis-card');
      card.appendChild(el('span', 'sl-axis-name', k));
      const valText = v == null ? '\u2013'
        : typeof v === 'number' ? (isPctMetric(k) ? fmtPct(v) : fmtNum(v))
        : typeof v === 'object' ? JSON.stringify(v)
        : String(v);
      card.appendChild(el('span', 'sl-axis-nums', valText));
      axes.appendChild(card);
    }
    inner.appendChild(axes);
  } else {
    inner.appendChild(el('p', 'an-empty', 'No metric data recorded for this measurable yet.'));
  }

  const side = el('div', 'sl-detail-side');
  const box = el('div', 'sl-verdict-box sl-verdict-box--' + statusVariant(change.status));
  box.appendChild(el('span', 'sl-verdict-lbl', 'Scoreboard decision'));
  box.appendChild(el('p', null, change.status === 'kept' ? 'Approved on the Scoreboard.'
    : change.status === 'reverted' ? 'Rejected or pruned on the Scoreboard.'
    : 'Awaiting a human decision on the Scoreboard.'));
  side.appendChild(box);
  inner.appendChild(side);

  return inner;
}

// evaluatePromotionSequential() output (promotion.js): {available, decision,
// n, ...}, the SAME shape seqSentence() already reads for promotion rows,
// just without a champion/challenger pair to name. --------------------------
function researchVerdictSentence(change) {
  const v = change.measuredEffect?.verifierResult;
  if (!v) {
    return change.status === 'measuring'
      ? 'Trial running - not enough data yet for a verdict.'
      : 'Not yet trialled.';
  }
  if (!v.available) {
    return `Not enough paired samples yet for the sequential (mSPRT) test (n=${v.n ?? 0}).`;
  }
  const word = v.decision === 'B' ? 'kept the candidate' : v.decision === 'A' ? 'retired the candidate' : 'is still undecided';
  return `Sequential test ${word}, over ${v.n} paired samples.`;
}

function buildResearchCandidateDetail(change) {
  const inner = el('div', 'sl-detail-inner sl-detail-inner--single');
  const side = el('div', 'sl-detail-side');

  if (change.sourceRef) side.appendChild(el('p', 'sl-meter-caption', 'source: ' + change.sourceRef));

  const box = el('div', 'sl-verdict-box sl-verdict-box--' + statusVariant(change.status));
  box.appendChild(el('span', 'sl-verdict-lbl', 'Trial verdict'));
  box.appendChild(el('p', null, researchVerdictSentence(change)));
  side.appendChild(box);

  inner.appendChild(side);
  return inner;
}

// Fallback for a type outside the known 6-member union - honest "nothing to
// show" rather than borrowing another type's (wrong) detail text.
function buildUnknownDetail() {
  const inner = el('div', 'sl-detail-inner sl-detail-inner--single');
  const side = el('div', 'sl-detail-side');
  side.appendChild(el('p', 'an-empty', 'No detail view available for this change type yet.'));
  inner.appendChild(side);
  return inner;
}

function buildDetail(change, detailId) {
  const wrap = el('div', 'sl-detail');
  wrap.id = detailId;
  wrap.hidden = true;
  const built = change.type === 'promotion' ? buildPromotionDetail(change)
    : change.type === 'guard' ? buildGuardDetail(change)
    : change.type === 'memory' ? buildMemoryDetail(change)
    : change.type === 'skill' ? buildSkillDetail(change)
    : change.type === 'measurable' ? buildMeasurableDetail(change)
    : change.type === 'research-candidate' ? buildResearchCandidateDetail(change)
    : buildUnknownDetail();
  wrap.appendChild(built);
  return wrap;
}

function effectSummary(change) {
  if (change.type === 'promotion' && change.measuredEffect) {
    const dirs = change.measuredEffect.directions || {};
    for (const k of Object.keys(dirs)) {
      // metricValue() unwraps an evidence-tagged envelope to its `.value` (or
      // passes a bare number through) - an 'absent' envelope unwraps to null,
      // same as the old bare-null used to skip this axis for the compact
      // one-line summary and move on to the next metric.
      const before = metricValue(change.measuredEffect.champion?.[k]);
      const after = metricValue(change.measuredEffect.challenger?.[k]);
      if (before != null && after != null) {
        const fmt = isPctMetric(k) ? fmtPct : (v) => fmtNum(v, 1);
        return `${labelForMetric(k)} ${fmt(before)} \u2192 ${fmt(after)}`;
      }
    }
    return 'awaiting comparable data';
  }
  if (change.type === 'guard') {
    const eff = change.measuredEffect;
    if (!eff || eff.evidence !== 'exercised') return 'awaiting apply';
    return `fired ${eff.fireCount} time${eff.fireCount === 1 ? '' : 's'}`;
  }
  if (change.type === 'skill') {
    if (change.action === 'adopt') {
      const s = change.measuredEffect?.shadowRates;
      return s ? `n=${s.n} \u00B7 fired ${fmtPct(s.fireRate)}` : 'awaiting apply';
    }
    if (change.action === 'archive') {
      const uses = change.measuredEffect?.uses ?? 0;
      return `${uses} use${uses === 1 ? '' : 's'} observed`;
    }
    if (change.action === 'update') {
      const latest = change.measuredEffect?.latestVersion;
      return latest ? `update available: ${latest}` : 'update available';
    }
    return 'awaiting apply';
  }
  if (change.type === 'measurable') {
    const metric = change.measuredEffect;
    const n = metric && typeof metric === 'object' ? Object.keys(metric).length : 0;
    return n ? `${n} metric${n === 1 ? '' : 's'} recorded` : 'no metric yet';
  }
  if (change.type === 'research-candidate') {
    const v = change.measuredEffect?.verifierResult;
    return v?.available ? `n=${v.n} \u00B7 decision ${v.decision}` : 'awaiting trial';
  }
  return 'awaiting apply'; // memory
}

function buildLedgerRow(change, idx, handlers) {
  const row = el('div', `sl-row ${LOOP_CLASS[change.type] || ''}`);
  row.dataset.loop = change.type;
  row.dataset.status = change.status;

  row.appendChild(loopTag(change.type));

  const nameWrap = el('div', 'sl-row-name');
  nameWrap.appendChild(el('span', 'sl-change-name', change.title));
  const sid = change.evidence?.sessionId;
  if (sid) {
    const evidBtn = el('button', 'sl-evidence-link', 'session ' + sid + ' >');
    evidBtn.type = 'button';
    evidBtn.addEventListener('click', () => { handlers?.onOpenSession?.(sid); });
    nameWrap.appendChild(evidBtn);
  }
  row.appendChild(nameWrap);

  row.appendChild(statusBadge(change.status));
  row.appendChild(el('div', 'sl-row-effect', effectSummary(change)));

  const detailId = `sl-detail-${idx}`;
  const expandBtn = el('button', 'sl-expand-btn');
  expandBtn.type = 'button';
  expandBtn.setAttribute('aria-expanded', 'false');
  expandBtn.setAttribute('aria-controls', detailId);
  expandBtn.setAttribute('aria-label', 'Expand measured-effect detail for ' + change.title);
  expandBtn.appendChild(svgChevron());
  row.appendChild(expandBtn);

  const detail = buildDetail(change, detailId);

  expandBtn.addEventListener('click', () => {
    const open = expandBtn.getAttribute('aria-expanded') === 'true';
    expandBtn.setAttribute('aria-expanded', String(!open));
    detail.hidden = open;
  });

  return { row, detail };
}

// Phase 2 (AC-3/AC-5): the ledger holds ~1,000 changes on live data, so it
// pages at LEDGER_PAGE_SIZE and builds only the visible rows; the kind chips
// carry their counts and filter the whole set, not just the page.
export const LEDGER_PAGE_SIZE = 50;

export function buildLedgerSection(changes, handlers) {
  const panel = el('section', 'an-panel');
  panel.setAttribute('aria-labelledby', 'sl-ledger-title');
  const title = el('h2', 'an-panel-title', 'Changes Ledger');
  title.id = 'sl-ledger-title';
  panel.appendChild(title);
  panel.appendChild(el('p', 'sl-panel-sub',
    'proposed, applied, measured, then kept or reverted. Every row is tied to its measured effect; nothing ships as "done" without one.'));

  if (!changes.length) {
    panel.appendChild(el('div', 'an-empty',
      'No changes tracked yet. As the memory, guardrail, promotion, skill, measurable, and research loops propose changes, they will appear here.'));
    return panel;
  }

  // Guard changes with 2+ instances of the same rule collapse into one row
  // (groupGuardChanges()); everything else renders as before. Re-sorted by ts
  // desc so the merged ledger still reads newest-first across all six loops.
  const nonGuard = changes.filter((c) => c.type !== 'guard');
  const guardGroups = groupGuardChanges(changes);
  const singletons = guardGroups.filter((g) => g.count === 1).map((g) => g.instances[0]);
  const rollups = guardGroups.filter((g) => g.count > 1);
  const renderItems = [...nonGuard, ...singletons, ...rollups]
    .sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));
  const loopOf = (item) => (item.grouped ? 'guard' : item.type);
  const kindCounts = {};
  for (const item of renderItems) kindCounts[loopOf(item)] = (kindCounts[loopOf(item)] ?? 0) + 1;

  // detail list below it. Counts are changes (instances); a guard kind also
  // says how many rules those collapse into, since that is what the list pages.
  const STAND_ORDER = ['kept', 'reverted', 'measuring', 'proposed'];
  const kindTable = el('table', 'sl-kinds');
  const kindHead = el('tr');
  for (const h of ['Kind', 'Changes', 'Where it stands']) {
    const th = el('th', null, h);
    th.setAttribute('scope', 'col');
    kindHead.appendChild(th);
  }
  const kindThead = el('thead');
  kindThead.appendChild(kindHead);
  kindTable.appendChild(kindThead);
  const kindBody = el('tbody');
  kindTable.appendChild(kindBody);
  const loopBtns = {};
  const kindRows = {};
  for (const type of Object.keys(LOOP_LABEL)) {
    const own = changes.filter((c) => c.type === type);
    const tr = el('tr', 'sl-kind-row ' + LOOP_CLASS[type]);
    tr.dataset.loop = type;
    const kindCell = el('td');
    const btn = el('button', 'sl-chip-toggle ' + LOOP_CLASS[type]);
    btn.type = 'button';
    btn.setAttribute('aria-pressed', 'false');
    btn.appendChild(loopDot(type));
    btn.appendChild(document.createTextNode(LOOP_LABEL[type]));
    kindCell.appendChild(btn);
    const countCell = el('td', 'sl-kind-cell');
    countCell.appendChild(el('span', 'sl-kind-count', String(own.length)));
    if (type === 'guard' && own.length) countCell.appendChild(el('span', 'sl-kind-rules', `in ${kindCounts.guard ?? 0} rules`));
    const standCell = el('td');
    const stand = el('span', 'sl-stand');
    const byStatus = {};
    for (const c of own) { const s = statusVariant(c.status); byStatus[s] = (byStatus[s] ?? 0) + 1; }
    for (const s of STAND_ORDER) {
      if (byStatus[s]) stand.appendChild(el('span', `sl-stand-chip sl-stand-chip--${s}`, `${s} ${byStatus[s]}`));
    }
    standCell.appendChild(stand);
    tr.appendChild(kindCell);
    tr.appendChild(countCell);
    tr.appendChild(standCell);
    kindBody.appendChild(tr);
    loopBtns[type] = btn;
    kindRows[type] = tr;
  }
  panel.appendChild(kindTable);

  const filters = el('div', 'sl-filters');
  filters.setAttribute('role', 'group');
  filters.setAttribute('aria-label', 'Filter the changes ledger');
  const statusSel = document.createElement('select');
  statusSel.className = 'hist-select sl-select';
  statusSel.setAttribute('aria-label', 'Filter by status');
  for (const [val, labelText] of [['', 'All statuses'], ['kept', 'Kept'], ['reverted', 'Reverted'], ['measuring', 'Measuring'], ['proposed', 'Proposed']]) {
    const opt = document.createElement('option');
    opt.value = val;
    opt.textContent = labelText;
    statusSel.appendChild(opt);
  }
  filters.appendChild(statusSel);
  panel.appendChild(filters);

  const ledger = el('div', 'sl-ledger');
  const emptyMsg = el('p', 'an-empty sl-ledger-empty', 'No changes match the current filters.');
  emptyMsg.hidden = true;
  panel.appendChild(ledger);
  panel.appendChild(emptyMsg);

  const pager = el('div', 'sl-pager');
  const prevBtn = el('button', 'sl-pager-btn', 'Previous');
  prevBtn.type = 'button';
  const nextBtn = el('button', 'sl-pager-btn', 'Next');
  nextBtn.type = 'button';
  const pagerInfo = el('span', 'sl-pager-info');
  pager.appendChild(pagerInfo);
  pager.appendChild(prevBtn);
  pager.appendChild(nextBtn);
  panel.appendChild(pager);

  let page = 1;
  let detailSeq = 0;
  const builtRows = new Map();

  function matching() {
    const activeLoops = Object.entries(loopBtns)
      .filter(([, b]) => b.getAttribute('aria-pressed') === 'true')
      .map(([type]) => type);
    const status = statusSel.value;
    return renderItems.filter((item) => {
      const okLoop = activeLoops.length === 0 || activeLoops.includes(loopOf(item));
      // A rule group matches a status filter if ANY of its instances do.
      const okStatus = !status || (item.grouped ? !!item.statusCounts[status] : item.status === status);
      return okLoop && okStatus;
    });
  }

  function paint() {
    const shown = matching();
    const pages = Math.max(1, Math.ceil(shown.length / LEDGER_PAGE_SIZE));
    if (page > pages) page = pages;
    const start = (page - 1) * LEDGER_PAGE_SIZE;
    const slice = shown.slice(start, start + LEDGER_PAGE_SIZE);
    ledger.textContent = '';
    builtRows.clear();
    for (const item of slice) {
      const idx = detailSeq++;
      const built = item.grouped ? buildGuardGroupRow(item, idx, handlers) : buildLedgerRow(item, idx, handlers);
      builtRows.set(item, built);
      ledger.appendChild(built.row);
      ledger.appendChild(built.detail);
    }
    emptyMsg.hidden = shown.length !== 0;
    // The line says what is on screen; the buttons only exist past one page.
    prevBtn.hidden = nextBtn.hidden = pages <= 1;
    prevBtn.disabled = page <= 1;
    nextBtn.disabled = page >= pages;
    setText(pagerInfo, shown.length ? `Showing ${start + 1}-${start + slice.length} of ${shown.length}` : 'Showing 0');
    for (const [type, tr] of Object.entries(kindRows)) {
      if (loopBtns[type].getAttribute('aria-pressed') === 'true') tr.classList.add('is-active'); else tr.classList.remove('is-active');
    }
  }

  Object.entries(loopBtns).forEach(([type, btn]) => {
    btn.addEventListener('click', () => {
      btn.setAttribute('aria-pressed', String(btn.getAttribute('aria-pressed') !== 'true'));
      page = 1;
      paint();
    });
    // The whole row is the target, not just the label.
    kindRows[type].addEventListener('click', (ev) => { if (!ev.target?.closest?.('button')) btn.click(); });
  });
  statusSel.addEventListener('change', () => { page = 1; paint(); });
  prevBtn.addEventListener('click', () => { page -= 1; paint(); });
  nextBtn.addEventListener('click', () => { page += 1; paint(); });
  paint();

  // A deep link (sel=guard:<id>) may name a row on a later page, behind a
  // filter, or an instance inside a collapsed rule group. reveal() pages to
  // it, clears the filters if they hide it, and opens the group, so the
  // caller can then find the element. Returns false when the id is unknown.
  panel.reveal = (id) => {
    const hit = (item) => item.id === id || (item.grouped && item.instances.some((i) => i.id === id));
    let at = matching().findIndex(hit);
    if (at < 0) {
      Object.values(loopBtns).forEach((b) => b.setAttribute('aria-pressed', 'false'));
      statusSel.value = '';
      at = matching().findIndex(hit);
    }
    if (at < 0) return false;
    const item = matching()[at];
    page = Math.floor(at / LEDGER_PAGE_SIZE) + 1;
    paint();
    const built = builtRows.get(item);
    if (built && item.grouped && item.id !== id) {
      built.row.setAttribute('aria-expanded', 'true');
      built.detail.fill?.();
      built.detail.hidden = false;
    }
    return true;
  };

  return panel;
}

// Full raw event-log spine is out of scope for this cut; this renders the one
// real signal we have today, each change's evidence session, as a collapsed,
// graceful drill-down rather than fabricating a raw event feed. The list is
// built on first open and capped, so a closed spine costs no nodes.
const SPINE_CAP = 50;
export function buildSpineSection(changes, handlers) {
  const panel = el('section', 'an-panel');
  const details = document.createElement('details');
  details.className = 'sl-spine';
  const summary = document.createElement('summary');
  summary.appendChild(svgChevron());
  summary.appendChild(el('span', 'an-panel-title sl-spine-title', 'Activity Spine'));
  details.appendChild(summary);

  const withEvidence = changes.filter((c) => c.evidence?.sessionId);
  let built = false;
  const build = () => {
    if (built) return;
    built = true;
    if (!withEvidence.length) {
      details.appendChild(el('p', 'an-empty',
        'No linked session evidence yet. This fills in as changes are traced back to the sessions that triggered them.'));
      return;
    }
    const list = el('div', 'sl-event-list');
    for (const c of withEvidence.slice(0, SPINE_CAP)) {
      const row = el('div', 'sl-event-row');
      row.appendChild(el('span', 'sl-event-kind ' + LOOP_CLASS[c.type], LOOP_LABEL[c.type] || c.type));
      row.appendChild(el('span', 'sl-event-label', c.title));
      const link = el('button', 'sl-evidence-link', 'session ' + c.evidence.sessionId + ' >');
      link.type = 'button';
      link.addEventListener('click', () => { handlers?.onOpenSession?.(c.evidence.sessionId); });
      row.appendChild(link);
      list.appendChild(row);
    }
    details.appendChild(list);
    if (withEvidence.length > SPINE_CAP) {
      details.appendChild(el('p', 'sl-panel-sub', `Showing the first ${SPINE_CAP} of ${withEvidence.length} linked sessions.`));
    }
  };
  details.addEventListener('toggle', () => { if (details.open) build(); });
  panel.appendChild(details);
  return panel;
}

// Segment state is in-view only (no pillar-nav change, no data-view change);
// Signals and Outcomes are lazy-mounted on first activation so a visit that
// never leaves Ledger never pays their /api/alerts /api/outcomes /api/replay
// /api/promotion* fetch cost. Ledger is eager since it is the default segment.
const LOOP_SEGMENTS = [
  { id: 'ledger', label: 'Ledger' },
  { id: 'signals', label: 'Signals' },
  { id: 'outcomes', label: 'Outcomes' },
];
const LOOP_SEGMENT_IDS = new Set(LOOP_SEGMENTS.map((s) => s.id));

function buildSegmentedControl(defaultId, onSelect) {
  const nav = el('div', 'sl-segmented');
  nav.setAttribute('role', 'tablist');
  nav.setAttribute('aria-label', 'Loop view section');
  const tabs = [];
  for (const seg of LOOP_SEGMENTS) {
    const btn = el('button', 'sl-segment-btn', seg.label);
    btn.type = 'button';
    btn.id = 'sl-tab-' + seg.id;
    btn.setAttribute('role', 'tab');
    const selected = seg.id === defaultId;
    btn.setAttribute('aria-selected', String(selected));
    btn.setAttribute('aria-controls', 'sl-panel-' + seg.id);
    btn.tabIndex = selected ? 0 : -1;
    btn.addEventListener('click', () => onSelect(seg.id));
    tabs.push(btn);
    nav.appendChild(btn);
  }
  // Roving arrow-key navigation between segments (standard tablist keyboard
  // pattern) - focus moves with the arrow key, activation follows focus.
  nav.addEventListener('keydown', (evt) => {
    if (evt.key !== 'ArrowRight' && evt.key !== 'ArrowLeft') return;
    const idx = tabs.findIndex((t) => t.getAttribute('aria-selected') === 'true');
    const dir = evt.key === 'ArrowRight' ? 1 : -1;
    const next = (idx + dir + tabs.length) % tabs.length;
    tabs[next].focus?.();
    onSelect(LOOP_SEGMENTS[next].id);
  });
  return { nav, tabs };
}

function setActiveSegment(tabs, panels, id) {
  for (const seg of LOOP_SEGMENTS) {
    const active = seg.id === id;
    panels[seg.id].hidden = !active;
  }
  for (const btn of tabs) {
    const active = btn.id === 'sl-tab-' + id;
    btn.setAttribute('aria-selected', String(active));
    btn.tabIndex = active ? 0 : -1;
  }
}

// experiments.js/outcomes.js are reused as-is (not modified - out of file
// ownership for this task); the "Seed baseline" affordance therefore mounts
// as an action bar above the reused render rather than inside its own
// Eval/Replay Set section (see FINDINGS in the task report for the follow-up
// this implies for experiments.js's own exports).
function buildSeedBar(onSeeded) {
  const bar = el('div', 'sl-seed-bar');
  const btn = el('button', 'sl-seed-btn', 'Seed baseline');
  btn.type = 'button';
  btn.title = 'Populate the Eval / Replay Set below from recent outcomes (POST /api/replay/seed)';
  const status = el('span', 'sl-seed-status');
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    setText(status, 'Seeding...');
    try {
      const r = await fetch('/api/replay/seed', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      });
      if (!r.ok) throw new Error('seed ' + r.status);
      const result = await r.json();
      const added = Number.isFinite(Number(result?.added)) ? result.added : 0;
      const total = Number.isFinite(Number(result?.total)) ? result.total : 0;
      setText(status, `Seeded ${added} new task${added === 1 ? '' : 's'} (${total} total in the set).`);
      await onSeeded();
    } catch {
      setText(status, 'Seed failed - try again.');
    } finally {
      btn.disabled = false;
    }
  });
  bar.appendChild(btn);
  bar.appendChild(status);
  return bar;
}

async function paintOutcomesBody(body) {
  try {
    await renderExperiments(body);
  } catch {
    clear(body);
    body.appendChild(el('div', 'an-empty', 'Outcomes unavailable - the improvements endpoints failed to respond.'));
  }
}

export async function mountOutcomes(panel) {
  const body = el('div', 'sl-outcomes-body');
  const seedBar = buildSeedBar(() => paintOutcomesBody(body));
  panel.appendChild(seedBar);
  panel.appendChild(body);
  await paintOutcomesBody(body);
}

export async function mountSignals(panel) {
  const wrap = el('div');
  panel.appendChild(wrap);
  try {
    await renderAlerts(wrap);
  } catch {
    clear(wrap);
    wrap.appendChild(el('div', 'an-empty', 'Signals unavailable - the alerts endpoint failed to respond.'));
  }
}

// `opts.segment` ('ledger' | 'signals' | 'outcomes', default 'ledger') lets a
// caller land directly on a non-default segment - app.js's VIEW_REDIRECTS
// uses this so an old Signals (alerts) deep-link opens on Loop > Signals and
// an old Improvements (experiments) deep-link opens on Loop > Outcomes,
// instead of always landing on Ledger and making the operator click again.
// An unrecognized/omitted segment falls open to 'ledger', never throws.
// The /api/changes fetch, shared with the Learning lens so the metrics strip
// and the ledger come from one request. Resolves null when it fails.
export async function fetchChanges() {
  try {
    const r = await fetch('/api/changes');
    if (!r.ok) throw new Error('changes ' + r.status);
    return await r.json();
  } catch {
    return null;
  }
}

export async function renderLoop(container, handlers, opts = {}) {
  if (!container) return;
  clear(container);
  container.classList.add('an-root', 'sl-root');

  const initialSegment = LOOP_SEGMENT_IDS.has(opts?.segment) ? opts.segment : 'ledger';

  const header = el('div', 'exp-header');
  header.appendChild(el('span', 'exp-header-title', 'Loop'));
  container.appendChild(header);

  const loading = el('div', 'an-empty', 'Loading...');
  container.appendChild(loading);

  let data;
  try {
    const r = await fetch('/api/changes');
    if (!r.ok) throw new Error('changes ' + r.status);
    data = await r.json();
  } catch {
    data = null;
  }
  loading.remove();

  if (!data) {
    container.appendChild(el('div', 'an-empty', 'Loop data unavailable - the /api/changes endpoint failed to respond.'));
    return;
  }

  const changes = Array.isArray(data.changes) ? data.changes : [];

  container.appendChild(buildMetricsStrip(data.loopMetrics));

  const ledgerPanel = el('div', 'sl-segment-panel');
  ledgerPanel.id = 'sl-panel-ledger';
  ledgerPanel.setAttribute('role', 'tabpanel');
  ledgerPanel.setAttribute('aria-labelledby', 'sl-tab-ledger');

  const signalsPanel = el('div', 'sl-segment-panel');
  signalsPanel.id = 'sl-panel-signals';
  signalsPanel.setAttribute('role', 'tabpanel');
  signalsPanel.setAttribute('aria-labelledby', 'sl-tab-signals');
  signalsPanel.hidden = true;

  const outcomesPanel = el('div', 'sl-segment-panel');
  outcomesPanel.id = 'sl-panel-outcomes';
  outcomesPanel.setAttribute('role', 'tabpanel');
  outcomesPanel.setAttribute('aria-labelledby', 'sl-tab-outcomes');
  outcomesPanel.hidden = true;

  const panels = { ledger: ledgerPanel, signals: signalsPanel, outcomes: outcomesPanel };
  const mounted = { ledger: false, signals: false, outcomes: false };

  function select(id) {
    setActiveSegment(tabs, panels, id);
    if (id === 'signals' && !mounted.signals) { mounted.signals = true; mountSignals(signalsPanel); }
    if (id === 'outcomes' && !mounted.outcomes) { mounted.outcomes = true; mountOutcomes(outcomesPanel); }
  }

  const { nav, tabs } = buildSegmentedControl(initialSegment, select);
  container.appendChild(nav);

  const panelsWrap = el('div', 'sl-segment-panels');
  panelsWrap.appendChild(ledgerPanel);
  panelsWrap.appendChild(signalsPanel);
  panelsWrap.appendChild(outcomesPanel);
  container.appendChild(panelsWrap);

  // Ledger's data (`changes`) is already in hand from the /api/changes fetch
  // above (needed for the metrics strip regardless of segment), so building
  // its section costs nothing extra - always do it eagerly, independent of
  // which segment starts active. Only Signals/Outcomes stay lazy.
  ledgerPanel.appendChild(buildLedgerSection(changes, handlers));
  ledgerPanel.appendChild(buildSpineSection(changes, handlers));
  mounted.ledger = true;

  // Apply the initial segment (default 'ledger', a no-op here since the
  // panels/tabs were already built in that state). For 'signals'/'outcomes'
  // this both flips visibility and triggers the same lazy-mount select()
  // itself performs on a click, so a redirect lands fully rendered.
  select(initialSegment);
}

// Backward-compatible alias: the pre-Task-8 app.js still calls
// `substrateLoopMod.renderSubstrateLoop(container, handlers)` (the nav/
// routing task, glmps-138 Task 8, is what switches the call site to
// `renderLoop`). Same function, two names - remove this alias once app.js
// is updated to call renderLoop directly.
export const renderSubstrateLoop = renderLoop;
