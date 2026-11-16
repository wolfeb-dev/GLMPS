// web/evaluation/experiments.js
// Experiments view (Evaluation pillar), top-end outcome/champion-challenger loop.
// renderExperiments(container) is called from app.js enterView.
//
// Sections:
//   1.  Harness Quality        - KPI rollup by task class (delegates to outcomes.js)
//   1b. Agent Routing Compliance - by-task-class rollup from the routing-compliance measurable
//   2.  Recent Outcomes        - compact table from /api/outcomes
//   3.  Champion vs Challenger - per-unit metric comparison (client-side grouping)
//   4.  Eval / Replay Set      - task list from /api/replay
//
// XSS discipline: all data reaches the DOM only via textContent/createElement.
// innerHTML is not used; containers are emptied with clear().

import { renderOutcomes } from './outcomes.js';
import { setText, metricValue, evidenceLabel, clear } from '../shared/dom-util.js';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = String(text);
  return node;
}

function fmtPct(v) {
  if (v == null) return '\u2014';
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) + '%' : '\u2014';
}

function fmtTurns(v) {
  if (v == null) return '\u2014';
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(1) : '\u2014';
}

// Renders an evidence-tagged metric ({value, evidence, n, reason?} from
// server/lib/evaluation/evidence.js's tagValue(), the shape /api/promotion's
// champion/challenger aggregates now carry) as display text: the evidence
// label when the metric is not a real measurement, otherwise the normal
// numeric formatter over the unwrapped value. Also accepts a bare number.
function fmtMetric(tagged, fmt) {
  return evidenceLabel(tagged) ?? fmt(metricValue(tagged));
}

function buildPanel(title) {
  const panel = el('div', 'an-panel');
  panel.appendChild(el('div', 'an-panel-title', title));
  return panel;
}

// Delegates entirely to outcomes.js which fetches /api/outcomes/summary.
async function buildHarnessQuality() {
  const wrap = el('div');
  await renderOutcomes(wrap);
  return wrap;
}

function buildOutcomesTable(outcomes) {
  const panel = buildPanel('Recent Outcomes');

  if (!outcomes.length) {
    panel.appendChild(el('div', 'an-empty',
      'No outcome records yet \u2014 records are written when sessions close.'));
    return panel;
  }

  const wrap = el('div', 'exp-table-wrap');
  const table = el('table', 'exp-table');

  // thead
  const thead = el('thead');
  const hrow = el('tr');
  for (const col of ['Class', 'Turns', '1st try', 'Verifier', 'Reverted', 'Committed', 'Ctx%']) {
    hrow.appendChild(el('th', null, col));
  }
  thead.appendChild(hrow);
  table.appendChild(thead);

  // tbody - most recent rows first, capped at 60
  const tbody = el('tbody');
  const rows = [...outcomes].reverse().slice(0, 60);

  for (const row of rows) {
    const tr = el('tr');

    // taskClass
    const tdClass = el('td');
    setText(tdClass, row.taskClass ?? '\u2014');
    tr.appendChild(tdClass);

    // turns
    const tdTurns = el('td', 'exp-val-mono');
    setText(tdTurns, row.turns != null ? String(row.turns) : '\u2014');
    tr.appendChild(tdTurns);

    // firstTry
    const tdFirst = el('td', row.firstTry ? 'exp-val-yes' : 'exp-val-no');
    setText(tdFirst, row.firstTry ? 'Y' : 'N');
    tr.appendChild(tdFirst);

    // verifier exitOk
    const exitOk = row.verifier?.exitOk;
    const verifyClass = exitOk === true ? 'exp-val-yes' : exitOk === false ? 'exp-val-no' : 'exp-val-dash';
    const tdVerify = el('td', verifyClass);
    setText(tdVerify, exitOk === true ? 'pass' : exitOk === false ? 'fail' : '\u2014');
    tr.appendChild(tdVerify);

    // revertedLater
    const tdReverted = el('td', row.revertedLater ? 'exp-val-warn' : '');
    setText(tdReverted, row.revertedLater ? 'Y' : 'N');
    tr.appendChild(tdReverted);

    // committed
    const tdCommitted = el('td', row.committed ? 'exp-val-yes' : '');
    setText(tdCommitted, row.committed ? 'Y' : 'N');
    tr.appendChild(tdCommitted);

    // contextUsageRatio
    const tdCtx = el('td', 'exp-val-mono exp-val-ctx');
    setText(tdCtx, fmtPct(row.contextUsageRatio));
    tr.appendChild(tdCtx);

    tbody.appendChild(tr);
  }

  table.appendChild(tbody);
  wrap.appendChild(table);
  panel.appendChild(wrap);
  return panel;
}

// Consumes /api/promotion payload. Server handles unit grouping + metric math.

// Renders verdict badge + two metric cards into `container`.
// Called from both the initial render and the picker's change handler.
// XSS: all data reaches DOM via textContent; class names are hardcoded literals.
function renderCCResults(container, promo, shadow) {
  // Class names are hardcoded literals keyed from server enum - never from data.
  const VERDICT_CLS = {
    promote: 'exp-verdict-badge--promote',
    hold:    'exp-verdict-badge--hold',
    reject:  'exp-verdict-badge--reject',
    'insufficient-evidence': 'exp-verdict-badge--hold',
  };
  const VERDICT_LABEL = {
    promote: 'Promote',
    hold:    'Hold',
    reject:  'Reject',
    'insufficient-evidence': 'Insufficient Evidence',
  };

  const vCls   = VERDICT_CLS[promo.verdict]   ?? 'exp-verdict-badge--hold';
  const vLabel = VERDICT_LABEL[promo.verdict] ?? String(promo.verdict ?? '\u2014');

  const bar = el('div', 'exp-verdict-bar');
  const badge = el('span', 'exp-verdict-badge ' + vCls);
  setText(badge, vLabel);
  bar.appendChild(badge);

  if (promo.rationale) {
    const ratEl = el('span', 'exp-verdict-rationale');
    setText(ratEl, promo.rationale);
    bar.appendChild(ratEl);
  }
  container.appendChild(bar);

  const METRICS = [
    { key: 'medianTurns',        label: 'Median Turns',   fmt: fmtTurns },
    { key: 'verifierPassRate',   label: 'Verifier Pass',  fmt: fmtPct   },
    { key: 'firstTryRate',       label: 'First-Try Rate', fmt: fmtPct   },
    { key: 'medianContextUsage', label: 'Context Usage',  fmt: fmtPct   },
  ];

  // Hardcoded class literals keyed from server enum - perMetric value is only
  // ever used as a lookup key, never concatenated into a class name directly.
  const DELTA_CLS  = {
    better: 'exp-cc-delta--better',
    worse:  'exp-cc-delta--worse',
    same:   'exp-cc-delta--same',
    na:     'exp-cc-delta--same',
  };
  const DELTA_WORD = { better: 'better', worse: 'worse', same: '=', na: '\u2014' };

  const grid = el('div', 'exp-cc-grid');

  const sides = [
    { role: 'Champion',   data: promo.champion,   cardCls: 'exp-cc-card exp-cc-card--champion',   isChallenger: false },
    { role: 'Challenger', data: promo.challenger, cardCls: 'exp-cc-card exp-cc-card--challenger', isChallenger: true  },
  ];

  for (const { role, data, cardCls, isChallenger } of sides) {
    const card = el('div', cardCls);

    const roleEl = el('div', 'exp-cc-role');
    setText(roleEl, role);
    card.appendChild(roleEl);

    const unitEl = el('div', 'exp-cc-unit');
    setText(unitEl, data.unit ?? '\u2014');
    card.appendChild(unitEl);

    const nEl = el('div', 'exp-cc-n');
    setText(nEl, (data.n ?? 0) + ' outcome' + (data.n === 1 ? '' : 's'));
    card.appendChild(nEl);

    const metricsWrap = el('div', 'exp-cc-metrics');

    for (const { key, label, fmt } of METRICS) {
      const metRow = el('div', 'exp-cc-metric-row');

      const labelEl = el('span', 'exp-cc-metric-label');
      setText(labelEl, label);
      metRow.appendChild(labelEl);

      const valEl = el('span', 'exp-cc-value');
      setText(valEl, fmtMetric(data[key], fmt));
      metRow.appendChild(valEl);

      // Challenger metrics get a delta annotation - color is not the only signal.
      if (isChallenger) {
        const deltaKey = promo.perMetric?.[key];
        const dCls  = DELTA_CLS[deltaKey]  ?? 'exp-cc-delta--same';
        const dWord = DELTA_WORD[deltaKey] ?? '\u2014';
        const deltaEl = el('span', 'exp-cc-delta ' + dCls);
        setText(deltaEl, dWord);
        metRow.appendChild(deltaEl);
      }

      metricsWrap.appendChild(metRow);
    }

    card.appendChild(metricsWrap);
    grid.appendChild(card);
  }

  container.appendChild(grid);

  container.appendChild(buildAnnex(promo.sequential, shadow));
}

// Subordinate to the Pareto verdict above (quieter type, a top divider, no
// success/reject coloring) - both signals are informational only until the
// replay/eval set is seeded with real labeled cohorts (see the caveat line).
const SEQ_DECISION_LABEL = { A: 'Champion', B: 'Challenger', continue: 'Continue' };

function buildSequentialBlock(sequential) {
  const block = el('div', 'exp-annex-block');
  block.appendChild(el('div', 'exp-annex-label', 'Sequential test (mSPRT)'));

  const line = el('div', 'exp-annex-line');
  if (!sequential || !sequential.available) {
    const badge = el('span', 'exp-annex-badge exp-annex-badge--pending', 'Pending');
    line.appendChild(badge);
    const meta = el('span', 'exp-annex-meta');
    setText(meta, (sequential?.reason ?? 'not enough samples yet') + ` (n=${sequential?.n ?? 0})`);
    line.appendChild(meta);
    block.appendChild(line);
    return block;
  }

  const badge = el('span', 'exp-annex-badge');
  setText(badge, SEQ_DECISION_LABEL[sequential.decision] ?? String(sequential.decision));
  line.appendChild(badge);
  const meta = el('span', 'exp-annex-meta');
  setText(meta, `n=${sequential.n}`);
  line.appendChild(meta);
  block.appendChild(line);
  return block;
}

function buildShadowBlock(shadow) {
  const block = el('div', 'exp-annex-block');
  block.appendChild(el('div', 'exp-annex-label', 'Auto-apply shadow arm'));

  const classes = Object.entries(shadow?.byClass ?? {});
  if (!classes.length) {
    block.appendChild(el('div', 'exp-annex-meta', 'No shadow-arm data recorded yet.'));
    return block;
  }

  const list = el('div', 'exp-annex-shadow-list');
  for (const [taskClass, rates] of classes) {
    const item = el('div', 'exp-annex-shadow-item');
    const nameEl = el('span', 'exp-annex-shadow-class');
    setText(nameEl, taskClass);
    item.appendChild(nameEl);
    const ratesEl = el('span', 'exp-annex-meta');
    setText(ratesEl, `fired ${fmtPct(rates.fireRate)} \u00B7 would-fire ${fmtPct(rates.counterfactualRate)} (n=${rates.n ?? 0})`);
    item.appendChild(ratesEl);
    list.appendChild(item);
  }
  block.appendChild(list);
  return block;
}

function buildAnnex(sequential, shadow) {
  const annex = el('div', 'exp-cc-annex');
  annex.appendChild(buildSequentialBlock(sequential));
  annex.appendChild(buildShadowBlock(shadow));
  annex.appendChild(el('div', 'exp-annex-caveat',
    'Provisional \u2014 both signals gain real statistical power once the replay/eval set is seeded with labeled cohorts.'));
  return annex;
}

function buildChampionChallenger(promo, shadow) {
  const panel = buildPanel('Champion vs Challenger');

  // Fetch failed or endpoint not present yet
  if (!promo) {
    panel.appendChild(el('div', 'an-empty', 'Promotion data unavailable.'));
    return panel;
  }

  // Fewer than two units - show server reason; no picker until we have units
  if (!promo.available) {
    panel.appendChild(el('div', 'an-empty',
      promo.reason ?? 'Need at least two units to compare.'));
    return panel;
  }

  // Uses .hist-select for select styling (already defined); layout via
  // .exp-cc-picker / .exp-cc-picker-group / .exp-cc-picker-label.
  const picker = el('div', 'exp-cc-picker');

  // Champion group
  const champGroup = el('div', 'exp-cc-picker-group');
  const champLabel = el('label', 'exp-cc-picker-label', 'Champion');
  champLabel.htmlFor = 'exp-cc-sel-champ';
  const champSel = document.createElement('select');
  champSel.id        = 'exp-cc-sel-champ';
  champSel.className = 'hist-select exp-cc-picker-select';
  champGroup.appendChild(champLabel);
  champGroup.appendChild(champSel);

  // Challenger group
  const chalGroup = el('div', 'exp-cc-picker-group');
  const chalLabel = el('label', 'exp-cc-picker-label', 'Challenger');
  chalLabel.htmlFor = 'exp-cc-sel-chal';
  const chalSel = document.createElement('select');
  chalSel.id        = 'exp-cc-sel-chal';
  chalSel.className = 'hist-select exp-cc-picker-select';
  chalGroup.appendChild(chalLabel);
  chalGroup.appendChild(chalSel);

  // Populate options from promo.units - textContent only, .value set directly
  for (const u of (promo.units ?? [])) {
    const optC = document.createElement('option');
    optC.textContent = u.unit;
    optC.value = u.unit;
    champSel.appendChild(optC);

    const optH = document.createElement('option');
    optH.textContent = u.unit;
    optH.value = u.unit;
    chalSel.appendChild(optH);
  }

  // Pre-select the server's default champion / challenger
  champSel.value = promo.champion.unit;
  chalSel.value  = promo.challenger.unit;

  picker.appendChild(champGroup);
  picker.appendChild(chalGroup);
  panel.appendChild(picker);

  const resultsContainer = el('div', 'exp-cc-results');
  renderCCResults(resultsContainer, promo, shadow);
  panel.appendChild(resultsContainer);

  async function onPickerChange() {
    const champ = champSel.value;
    const chal  = chalSel.value;

    // Guard: same unit selected for both roles
    if (champ === chal) {
      clear(resultsContainer);
      resultsContainer.appendChild(
        el('div', 'an-empty', 'Pick two different units to compare.')
      );
      return;
    }

    // Loading state
    clear(resultsContainer);
    resultsContainer.appendChild(el('div', 'an-empty', 'Loading\u2026'));

    let newPromo;
    try {
      const r = await fetch(
        '/api/promotion?champion=' + encodeURIComponent(champ) +
        '&challenger=' + encodeURIComponent(chal)
      );
      if (!r.ok) throw new Error('promotion ' + r.status);
      newPromo = await r.json();
    } catch (_) {
      clear(resultsContainer);
      resultsContainer.appendChild(
        el('div', 'an-empty', 'Failed to load comparison.')
      );
      return;
    }

    clear(resultsContainer);
    renderCCResults(resultsContainer, newPromo, shadow);
  }

  champSel.addEventListener('change', onPickerChange);
  chalSel.addEventListener('change', onPickerChange);

  return panel;
}

// Reads the `routing-compliance` measurable (server/lib/evaluation/routing-
// compliance.js, written on the measurables tick from GET /api/measurables) -
// whether a routed card's session actually dispatched the agent the queue
// runner named for it. This is a pre-registered escalation read: if
// compliance lands under the threshold by the decision date, the plan
// escalates from a named directive to hard dispatch. An absence of data must
// never render as a measured 0% (see the empty-state guard below), and
// `unmeasurable` cards (no worktree to check) are always shown as their own
// count, never folded into the denominator as misses.
function buildRoutingCompliance(measurables) {
  const panel = buildPanel('Agent Routing Compliance');

  const m = (measurables ?? []).find(x => x?.kind === 'routing-compliance');
  if (!m || !m.metric || !m.metric.routed) {
    panel.appendChild(el('div', 'an-empty', 'No routed cards yet.'));
    return panel;
  }

  const { routed, complied, unmeasurable, byClass, threshold, decisionDate } = m.metric;
  const measured = routed - unmeasurable;
  const rate = measured > 0 ? complied / measured : null;

  const summary = el('div', 'exp-annex-line');
  summary.appendChild(el('span', 'exp-annex-badge', `${complied}/${measured} complied`));
  const meta = el('span', 'exp-annex-meta',
    `${fmtPct(rate)} vs ${fmtPct(threshold)} threshold` + (decisionDate ? ` \u00B7 decision date ${decisionDate}` : ''));
  summary.appendChild(meta);
  panel.appendChild(summary);

  if (unmeasurable > 0) {
    panel.appendChild(el('div', 'exp-annex-meta',
      `${unmeasurable} routed card(s) had no worktree and are unmeasurable, not counted as misses.`));
  }

  const entries = Object.entries(byClass ?? {});
  if (entries.length) {
    const list = el('div', 'exp-annex-shadow-list');
    for (const [cls, v] of entries) {
      const item = el('div', 'exp-annex-shadow-item');
      item.appendChild(el('span', 'exp-annex-shadow-class', cls));
      item.appendChild(el('span', 'exp-annex-meta', `${v.complied}/${v.routed}`));
      list.appendChild(item);
    }
    panel.appendChild(list);
  }

  return panel;
}

// Per-task scorecard (glmps-24): "did THIS frozen task regress vs
// its OWN baseline" - a different question from the champion/challenger
// section above (which groups by `unit`, cohort vs cohort). Fetched per task
// from GET /api/replay/:id/score, one call per task that has a baseline.
async function fetchReplayScore(taskId) {
  try {
    const r = await fetch(`/api/replay/${encodeURIComponent(taskId)}/score`);
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

// glmps-26: /score (above) only ever surfaces the single
// most-recent run. This fetches the FULL per-task series (oldest to newest)
// from GET /api/replay/:id/history so buildReplayTrend below can render it
// as a trend, not just a snapshot.
async function fetchReplayHistory(taskId) {
  try {
    const r = await fetch(`/api/replay/${encodeURIComponent(taskId)}/history`);
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

// Renders "^{improved} v{regressed}" once a run exists, or a plain
// not-run-yet note. Never stringifies the raw baseline/score object.
function buildReplayScorecard(data) {
  const wrap = el('span', 'exp-replay-score');

  if (!data || !data.hasRun || !data.score) {
    wrap.classList.add('exp-replay-baseline');
    setText(wrap, 'baseline set \u2014 not run yet');
    return wrap;
  }

  const up = el('span', 'exp-cc-delta exp-cc-delta--better');
  setText(up, '\u25B2' + data.score.improved.length);
  const down = el('span', 'exp-cc-delta exp-cc-delta--worse');
  setText(down, '\u25BC' + data.score.regressed.length);
  wrap.appendChild(up);
  wrap.appendChild(down);
  return wrap;
}

function classifyTrendPoint(score) {
  const improved = score?.improved?.length ?? 0;
  const regressed = score?.regressed?.length ?? 0;
  if (improved > regressed) return 'better';
  if (regressed > improved) return 'worse';
  return 'same';
}

function trendGlyph(cls) {
  if (cls === 'better') return '\u25B2';
  if (cls === 'worse') return '\u25BC';
  return '\u2022';
}

// Renders the run-history trend (glmps-26) as a compact sequence
// of marks, oldest to newest, one per past run scored against the task's
// baseline. Only rendered once there is more than one run - a single point
// would just duplicate the scorecard badge above with no new information.
// The accessible name (aria-label, not just the native `title`) carries the
// same counts a sighted user reads off the marks, and glyph shape (not
// color alone) distinguishes better/worse/unchanged for colorblind users.
function buildReplayTrend(historyData) {
  const points = historyData?.history ?? [];
  if (points.length < 2) return null;

  const counts = { better: 0, worse: 0, same: 0 };
  const wrap = el('span', 'exp-replay-trend');

  for (const point of points) {
    const cls = classifyTrendPoint(point.score);
    counts[cls]++;
    const mark = el('span', `exp-replay-trend-mark exp-replay-trend-mark--${cls}`, trendGlyph(cls));
    mark.setAttribute('aria-hidden', 'true'); // decorative; the group's aria-label below is the accessible name
    wrap.appendChild(mark);
  }

  const summary = `Run history (${points.length}): ${counts.better} better, ${counts.worse} worse, ${counts.same} unchanged`;
  wrap.setAttribute('title', summary);
  wrap.setAttribute('aria-label', summary);
  return wrap;
}

async function buildReplaySet(tasks) {
  const panel = buildPanel('Eval / Replay Set');

  if (!tasks.length) {
    panel.appendChild(el('div', 'an-empty', 'No replay tasks registered yet.'));
    return panel;
  }

  // Fetch every task's scorecard AND history in parallel (best-effort - a
  // failed fetch just falls back to the not-run-yet note / no trend, same as
  // the other /api/replay* calls in renderExperiments below).
  const [scores, histories] = await Promise.all([
    Promise.all(tasks.map((task) => (task.baseline ? fetchReplayScore(task.id) : null))),
    Promise.all(tasks.map((task) => (task.baseline ? fetchReplayHistory(task.id) : null))),
  ]);

  const list = el('div', 'exp-replay-list');

  tasks.forEach((task, i) => {
    const row = el('div', 'exp-replay-row');

    const idEl = el('span', 'exp-replay-id');
    setText(idEl, task.id ?? '?');
    row.appendChild(idEl);

    const projEl = el('span', 'exp-replay-project');
    setText(projEl, task.project ?? '\u2014');
    row.appendChild(projEl);

    if (task.baseline) {
      row.appendChild(buildReplayScorecard(scores[i]));
      const trend = buildReplayTrend(histories[i]);
      if (trend) row.appendChild(trend);
    }

    list.appendChild(row);
  });

  panel.appendChild(list);
  return panel;
}

export async function renderExperiments(container) {
  if (!container) return;
  clear(container);
  // Add layout class without clobbering the structural `view` class that
  // showView() toggles. Same pattern as lrn-root in learning.js.
  container.classList.add('an-root');

  // Page header
  const header = el('div', 'exp-header');
  header.appendChild(el('span', 'exp-header-title', 'Experiments'));
  container.appendChild(header);

  // Loading indicator while we fetch
  const loading = el('div', 'an-empty', 'Loading\u2026');
  container.appendChild(loading);

  // Fetch /api/outcomes, /api/replay, /api/promotion, /api/promotion/shadow,
  // and /api/measurables in parallel. All but /api/outcomes are best-effort;
  // failures fall back to null.
  let outcomesData, replayData, promotionData, shadowData, measurablesData;
  [outcomesData, replayData, promotionData, shadowData, measurablesData] = await Promise.allSettled([
    fetch('/api/outcomes').then(r => {
      if (!r.ok) throw new Error('outcomes ' + r.status);
      return r.json();
    }),
    fetch('/api/replay').then(r => {
      if (!r.ok) throw new Error('replay ' + r.status);
      return r.json();
    }),
    fetch('/api/promotion').then(r => {
      if (!r.ok) throw new Error('promotion ' + r.status);
      return r.json();
    }),
    fetch('/api/promotion/shadow').then(r => {
      if (!r.ok) throw new Error('promotion/shadow ' + r.status);
      return r.json();
    }),
    fetch('/api/measurables').then(r => {
      if (!r.ok) throw new Error('measurables ' + r.status);
      return r.json();
    }),
  ]).then(([o, r, p, s, me]) => [
    o.status === 'fulfilled' ? o.value : null,
    r.status === 'fulfilled' ? r.value : null,
    p.status === 'fulfilled' ? p.value : null,
    s.status === 'fulfilled' ? s.value : null,
    me.status === 'fulfilled' ? me.value : null,
  ]);

  loading.remove();

  const outcomes = outcomesData?.outcomes ?? [];
  const replayTasks = replayData?.tasks ?? [];
  const measurables = measurablesData?.measurables ?? [];

  // 1) Harness Quality - delegates to outcomes.js (fetches /api/outcomes/summary)
  container.appendChild(await buildHarnessQuality());

  // 1b) Agent Routing Compliance, beside Harness Quality (also a by-task-class rollup)
  container.appendChild(buildRoutingCompliance(measurables));

  // 2) Outcomes table
  container.appendChild(buildOutcomesTable(outcomes));

  // 3) Champion vs Challenger - uses /api/promotion verdict + /api/promotion/shadow rates
  container.appendChild(buildChampionChallenger(promotionData, shadowData));

  // 4) Eval / Replay Set
  container.appendChild(await buildReplaySet(replayTasks));
}
