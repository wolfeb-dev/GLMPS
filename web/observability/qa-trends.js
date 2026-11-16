// web/observability/qa-trends.js
// QA Trends view (Observability pillar) - consumes GET /api/qa-trends and renders
// a time-series chart of the QA surface: test count / pass / fail (shared scale)
// plus open GitHub issues (own scale, plotted as a companion sparkline sharing the
// same x-axis - a dual-axis chart on ONE plot is a known anti-pattern: it invents
// a correlation from an arbitrary scale alignment, per the dataviz skill).
//
// Charting: the vendored Vega-Lite (web/vendor/vega*.js), the same convention
// already established in this codebase for the generated wiki docs
// (server/lib/observability/wiki-render.js: vega.min.js -> vega-lite.min.js ->
// vega-embed.min.js, then vegaEmbed(el, spec, {actions:false, theme:'dark'})).
// This is its first use in a *live* dashboard panel rather than a static doc, so
// the vendor scripts are lazy-loaded on demand instead of always paid for on boot.
//
// Panel scaffolding reuses the .an-panel / .an-stat / .an-empty / .an-row system
// established by web/observability/analytics.js + styles.css (see also
// web/evaluation/scoreboard.css for the precedent of extending .an-stat with a
// feature-scoped accent class rather than editing the shared file).
//
// XSS discipline: every value from the API goes through textContent / DOM
// construction, or into a plain JS object handed to vegaEmbed (never serialized
// through innerHTML). innerHTML is not used; containers are emptied with clear()
// or `textContent = ''`.
//
// CI vs local source (docs/superpowers/specs/2026-07-14-qa-trends-design.md
// "option C"): points now carry `source: 'ci' | 'local'` (a local point comes
// from hooks/qa-trends-local.js recording a full-suite `npm test` run, and
// has runId:null / openIssues:null - there's no CI run id or GitHub-issues
// signal for a local run). Both frontend-design (chart domain: "clear line
// patterns for colorblind users, add pattern overlays") and the dataviz skill
// (marks-and-anatomy: shape/texture are the CVD- and print-safe *secondary*
// channel; anti-patterns: never invent a false dual-axis, never reuse an
// already-claimed channel for a second meaning) were consulted before this
// edit. The color+dash channel on the primary chart already carries METRIC
// identity (Total tests/Passing/Failing) - reusing dash or color for SOURCE
// too would double-encode and conflict, and a source-faceted small-multiple
// would fragment the one continuous trend line the whole chart exists to show.
// So source gets its own, independent channel: a `shape` encoding (circle for
// CI, diamond for local) on a point-marker layer overlaid on the existing
// lines, with its own compact legend - never color alone, so identity survives
// a colorblind reader same as the metric legend above it. openIssues is a
// CI-only signal (a local run has no GitHub-issues data): the companion chart
// filters local points out via `datum.openIssues !== null` rather than
// coercing null to 0, which would otherwise fabricate a false dip to zero at
// every local-run timestamp.

import { bindItem } from '../shared/interactive-item.js';
import { linkFor } from '../shared/deep-link.js';
import { formatTime } from '../shared/time-format.js';

const VENDOR_SCRIPTS = ['/vendor/vega.min.js', '/vendor/vega-lite.min.js', '/vendor/vega-embed.min.js'];
let vegaLoadPromise = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Failed to load ' + src));
    document.head.appendChild(s);
  });
}

// Loads vega -> vega-lite -> vega-embed in order (vega-embed depends on both),
// once per page load. Cached so re-entering the view doesn't re-inject scripts.
function loadVegaEmbed() {
  if (typeof window.vegaEmbed === 'function') return Promise.resolve();
  if (!vegaLoadPromise) {
    vegaLoadPromise = VENDOR_SCRIPTS
      .reduce((chain, src) => chain.then(() => loadScript(src)), Promise.resolve())
      .catch(err => { vegaLoadPromise = null; throw err; });
  }
  return vegaLoadPromise;
}

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = String(text);
  return node;
}

function td(text) {
  const cell = document.createElement('td');
  cell.textContent = text;
  return cell;
}

function numOr0(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

// Unlike numOr0, preserves null rather than coercing it to 0 - used for
// openIssues, where null means "no signal" (a local run), not "zero issues".
function numOrNull(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function fmtInt(n) {
  return (Number(n) || 0).toLocaleString();
}

function fmtDate(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n)) return '\u2014';
  return formatTime(n) || '\u2014';
}

// Resolve a design token to its computed value so it can be handed to a Vega-Lite
// spec (which cannot reference CSS custom properties directly).
function cssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

export async function fetchQaTrends() {
  const res = await fetch('/api/qa-trends');
  if (!res.ok) throw new Error('qa-trends ' + res.status);
  return res.json();
}

// Color decisions (dataviz skill, applied to this repo's ALREADY-SHIPPED tokens - 
// no new hexes invented):
// - Passing  -> var(--success) cyan - status-good; pass/fail are a real
//                 good/bad signal, so they wear status tokens, not "series N".
//   - Failing  -> var(--destructive)   - status-bad. The Surface palette's
//                 destructive clears the text-contrast floor on the
//                 panels, so the old literal red is no longer needed.
// - Total tests -> var(--muted-fg) - context, not identity: it's the ceiling
//                 pass+fail sit under, not itself a good/bad reading. Deliberately
//                 low-chroma ("de-emphasis gray") and additionally dashed, so it
//                 never competes with the two status colors for attention.
// - Open issues (companion) -> var(--warning) amber - single-series chart (its
//                 own title says what it is, so no legend needed), reusing the
//                 house token already meaning "needs attention".
function buildColors() {
  return {
    mutedFg: cssVar('--muted-fg', 'rgba(143,176,194,1)'),
    success: cssVar('--success', 'rgb(61,220,132)'),
    fail: cssVar('--destructive', 'rgb(255,91,91)'),
    warning: cssVar('--warning', 'rgb(245,165,36)'),
    border: cssVar('--border', 'rgba(94,168,214,0.34)'),
    fg: cssVar('--fg', 'rgb(219,234,242)'),
    // Point-marker surface ring: a flat stroke cannot use the translucent
    // --card wash, so the ground colour (--bg, what the panel sits on) stands in.
    surfaceRing: cssVar('--bg', 'rgb(5,7,12)'),
  };
}

function buildSpec(points, colors) {
  const rows = points.map(p => ({
    ts: new Date(numOr0(p.ts)),
    sha: String(p.sha ?? '\u2014'),
    conclusion: String(p.conclusion ?? '\u2014'),
    source: p.source === 'local' ? 'local' : 'ci', // defensive re-normalize; the store already defaults this server-side
    sourceLabel: p.source === 'local' ? 'Local run' : 'CI run',
    'Total tests': numOr0(p.testCount),
    Passing: numOr0(p.pass),
    Failing: numOr0(p.fail),
    // NOT numOr0 - null (a local run) must stay null, not become a fabricated
    // zero, so the companion chart can filter it out instead of drawing a
    // false dip. See the header comment.
    openIssues: numOrNull(p.openIssues),
  }));

  const domain = ['Total tests', 'Passing', 'Failing'];
  const range = [colors.mutedFg, colors.success, colors.fail];
  const dashRange = [[4, 3], [1, 0], [1, 0]]; // Total tests dashed; Passing/Failing solid
  const sourceDomain = ['ci', 'local'];
  const sourceShapeRange = ['circle', 'diamond']; // shape is the CVD-safe secondary channel - see header comment

  const axisBase = {
    domainColor: colors.border,
    tickColor: colors.border,
    labelColor: colors.mutedFg,
    titleColor: colors.mutedFg,
    labelFont: 'ui-monospace, monospace',
    titleFont: 'ui-monospace, monospace',
    labelFontSize: 11,
    titleFontSize: 11,
  };

  // Primary: shared-scale line chart (Total tests / Passing / Failing). A single
  // "nearest x" hover param drives a full-height rule + one combined tooltip
  // listing every series at that point in time (never make the reader hunt a
  // specific line to get a value).
  const primary = {
    width: 'container',
    height: 220,
    layer: [
      {
        mark: { type: 'line', interpolate: 'monotone', strokeWidth: 2, clip: true },
        transform: [{ fold: domain, as: ['metric', 'value'] }],
        encoding: {
          x: { field: 'ts', type: 'temporal', axis: { ...axisBase, grid: false, labels: false, ticks: false, title: null } },
          y: { field: 'value', type: 'quantitative', title: 'Tests', axis: { ...axisBase, grid: true, gridColor: colors.border } },
          color: {
            field: 'metric', type: 'nominal', sort: domain,
            scale: { domain, range },
            legend: { title: null, orient: 'top', direction: 'horizontal', symbolType: 'stroke', labelColor: colors.mutedFg, labelFontSize: 11 },
          },
          strokeDash: { field: 'metric', type: 'nominal', sort: domain, scale: { domain, range: dashRange } },
        },
      },
      {
        // Source (CI vs local) marker layer - shape only, no new color. Each
        // point already sits ON the line its metric/color identify; shape adds
        // provenance without touching the color/dash channel those lines
        // already use for metric identity (see header comment). `filled` +
        // an explicit `stroke` in the surface color gives every marker the
        // "surface ring" spec (marks-and-anatomy) so it stays legible where
        // it crosses its own or another series' line.
        mark: { type: 'point', filled: true, size: 70, strokeWidth: 1.5, opacity: 1, clip: true },
        transform: [{ fold: domain, as: ['metric', 'value'] }],
        encoding: {
          x: { field: 'ts', type: 'temporal' },
          y: { field: 'value', type: 'quantitative' },
          color: { field: 'metric', type: 'nominal', sort: domain, scale: { domain, range }, legend: null },
          stroke: { value: colors.surfaceRing },
          shape: {
            field: 'source', type: 'nominal', sort: sourceDomain,
            scale: { domain: sourceDomain, range: sourceShapeRange },
            legend: {
              title: 'Source', orient: 'top', direction: 'horizontal',
              labelExpr: "datum.label == 'local' ? 'Local run' : 'CI run'",
              symbolFillColor: colors.fg, symbolStrokeColor: colors.fg, symbolSize: 90,
              labelColor: colors.mutedFg, titleColor: colors.mutedFg, labelFontSize: 11,
            },
          },
        },
      },
      {
        mark: { type: 'rule' },
        // Layers don't share a transformed dataset - each sees the raw top-level
        // `data` unless it folds it itself, so this layer re-applies the same
        // fold before pivoting back to wide format for one combined tooltip.
        transform: [
          { fold: domain, as: ['metric', 'value'] },
          { pivot: 'metric', value: 'value', groupby: ['ts', 'sha', 'conclusion', 'sourceLabel'] },
        ],
        encoding: {
          x: { field: 'ts', type: 'temporal' },
          color: { value: colors.fg },
          opacity: { condition: { param: 'hoverPrimary', value: 0.35, empty: false }, value: 0 },
          tooltip: [
            { field: 'ts', type: 'temporal', title: 'Run date', format: '%b %d, %Y %H:%M' },
            { field: 'Total tests', type: 'quantitative' },
            { field: 'Passing', type: 'quantitative' },
            { field: 'Failing', type: 'quantitative' },
            { field: 'conclusion', type: 'nominal', title: 'Result' },
            { field: 'sourceLabel', type: 'nominal', title: 'Source' },
            { field: 'sha', type: 'nominal', title: 'Commit' },
          ],
        },
        params: [{ name: 'hoverPrimary', select: { type: 'point', fields: ['ts'], nearest: true, on: 'pointerover', clear: 'pointerout' } }],
      },
    ],
  };

  // Companion: open-issue count on its OWN scale, sharing the primary's x-axis
  // (resolve.scale.x = 'shared' below) - a small multiple, not a second y-axis.
  // openIssues is a CI-only signal (a local run has no GitHub-issues data, so
  // its point carries openIssues:null, not 0) - both layers filter those rows
  // out entirely rather than plotting a fabricated zero, so the line connects
  // only the real CI-sampled counts across whatever local runs fall between
  // them in time.
  const companion = {
    width: 'container',
    height: 64,
    layer: [
      {
        mark: { type: 'area', line: { strokeWidth: 2, color: colors.warning }, color: colors.warning, opacity: 0.12, interpolate: 'monotone', clip: true },
        transform: [{ filter: 'datum.openIssues !== null' }],
        encoding: {
          x: { field: 'ts', type: 'temporal', title: null, axis: { ...axisBase, grid: false, tickCount: 'day', formatType: 'time', format: '%b %d' } },
          y: {
            field: 'openIssues', type: 'quantitative', title: 'Open issues',
            scale: { zero: true, nice: true },
            axis: { ...axisBase, grid: true, gridColor: colors.border, tickMinStep: 1 },
          },
        },
      },
      {
        mark: { type: 'rule' },
        transform: [{ filter: 'datum.openIssues !== null' }],
        encoding: {
          x: { field: 'ts', type: 'temporal' },
          color: { value: colors.fg },
          opacity: { condition: { param: 'hoverCompanion', value: 0.35, empty: false }, value: 0 },
          tooltip: [
            { field: 'ts', type: 'temporal', title: 'Run date', format: '%b %d, %Y %H:%M' },
            { field: 'openIssues', type: 'quantitative', title: 'Open issues' },
          ],
        },
        params: [{ name: 'hoverCompanion', select: { type: 'point', fields: ['ts'], nearest: true, on: 'pointerover', clear: 'pointerout' } }],
      },
    ],
  };

  return {
    $schema: 'https://vega.github.io/schema/vega-lite/v5.json',
    // width:'container' only applies per-subview for a concatenated spec (Vega-Lite
    // warns and silently falls back to a fixed default width if set at this level
    // instead) - each of primary/companion carries its own width:'container' above.
    background: 'transparent',
    data: { values: rows },
    vconcat: [primary, companion],
    spacing: 4,
    resolve: { scale: { x: 'shared' } },
    config: { view: { stroke: 'transparent' }, axis: { grid: false } },
  };
}

function buildStatCard({ label, value, delta, accent }) {
  const card = el('div', `an-stat qat-stat-${accent}`);
  const valueRow = el('div', 'qat-stat-value-row');
  valueRow.appendChild(el('span', 'an-stat-value', value));
  if (delta != null && delta !== 0) {
    const sign = delta > 0 ? '+' : '\u2212';
    valueRow.appendChild(el('span', 'qat-stat-delta', `${sign}${fmtInt(Math.abs(delta))}`));
  }
  card.appendChild(valueRow);
  card.appendChild(el('div', 'an-stat-label', label));
  return card;
}

// Makes rate-of-growth legible without requiring a hover: a signed delta on the
// latest run vs the prior one, plus a computed pass rate.
function buildStatStrip(points) {
  const latest = points[points.length - 1];
  const prev = points.length > 1 ? points[points.length - 2] : null;

  const strip = el('div', 'an-totals');

  // "Total tests" doubles as the strip's provenance cue for the latest point - 
  // same "label - qualifier" pattern the Passing card already uses for its
  // pass-rate percentage.
  const latestSourceLabel = latest.source === 'local' ? 'Local' : 'CI';
  const testDelta = prev ? numOr0(latest.testCount) - numOr0(prev.testCount) : null;
  strip.appendChild(buildStatCard({ label: `Total tests \u00B7 ${latestSourceLabel}`, value: fmtInt(latest.testCount), delta: testDelta, accent: 'plain' }));

  const total = numOr0(latest.testCount);
  const passRate = total > 0 ? Math.round((numOr0(latest.pass) / total) * 100) : null;
  strip.appendChild(buildStatCard({ label: passRate != null ? `Passing \u00B7 ${passRate}%` : 'Passing', value: fmtInt(latest.pass), accent: 'good' }));

  const failing = numOr0(latest.fail);
  strip.appendChild(buildStatCard({ label: 'Failing', value: fmtInt(latest.fail), accent: failing > 0 ? 'bad' : 'good' }));

  // openIssues is null for a local point (no GitHub-issues signal locally) - 
  // show " - ", never a fabricated 0, and never the "needs attention" warn accent.
  const openIssues = numOrNull(latest.openIssues);
  strip.appendChild(buildStatCard({
    label: 'Open GitHub issues',
    value: openIssues == null ? '\u2014' : fmtInt(openIssues),
    accent: openIssues != null && openIssues > 0 ? 'warn' : 'plain',
  }));

  return strip;
}

// Narrowed agent test runs never join the chart series (a 40-test run would
// read as a suite collapse), so their failure rate is a card of its own.
export function agentRunsStat(affected) {
  const runs = Number(affected?.runs);
  if (!Number.isInteger(runs) || runs <= 0) return null;
  const failed = Number.isInteger(affected.failedRuns) ? affected.failedRuns : 0;
  const days = Number.isInteger(affected.windowDays) ? affected.windowDays : 7;
  return { label: `Agent test runs \u00B7 ${days}d \u00B7 ${fmtInt(failed)} failed`, value: fmtInt(runs), accent: failed > 0 ? 'bad' : 'good' };
}

function buildTableView(points) {
  const wrap = el('div', 'an-panel qat-table-panel');
  const details = document.createElement('details');
  details.className = 'qat-table-details';

  const summary = document.createElement('summary');
  summary.className = 'qat-table-summary';
  summary.textContent = `Raw data (${points.length} run${points.length === 1 ? '' : 's'})`;
  details.appendChild(summary);

  const scroller = el('div', 'qat-table-scroll');
  const table = document.createElement('table');
  table.className = 'qat-table';

  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const h of ['Run date', 'Source', 'Commit', 'Tests', 'Passing', 'Failing', 'Result', 'Open issues']) {
    const th = document.createElement('th');
    th.textContent = h;
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (const p of [...points].reverse()) {
    const row = document.createElement('tr');
    // bindItem on the <tr> itself set role="button",
    // overriding the row's own implicit table-row role (a screen reader
    // navigating this table by row/cell loses that structure). The run
    // date becomes a button instead - bindItem's own button/a branch just
    // adds a click listener and an aria-label, no role override needed.
    const dateCell = document.createElement('td');
    const dateBtn = document.createElement('button');
    dateBtn.type = 'button';
    dateBtn.className = 'qat-row-toggle';
    dateBtn.textContent = fmtDate(p.ts);
    dateCell.appendChild(dateBtn);
    row.appendChild(dateCell);
    row.appendChild(td(p.source === 'local' ? 'Local' : 'CI'));
    row.appendChild(td(p.sha ?? '\u2014'));
    row.appendChild(td(fmtInt(p.testCount)));
    row.appendChild(td(fmtInt(p.pass)));

    const failCell = td(fmtInt(p.fail));
    if (numOr0(p.fail) > 0) failCell.classList.add('qat-cell-bad');
    row.appendChild(failCell);

    const concCell = td(p.conclusion ?? '\u2014');
    if (p.conclusion === 'failure') concCell.classList.add('qat-cell-bad');
    else if (p.conclusion === 'success') concCell.classList.add('qat-cell-good');
    row.appendChild(concCell);

    // openIssues is null for a local point (no GitHub-issues signal locally) - show " - ", not a fabricated 0.
    const openIssues = numOrNull(p.openIssues);
    row.appendChild(td(openIssues == null ? '\u2014' : fmtInt(openIssues)));
    tbody.appendChild(row);

    // Every run is clickable and linkable (D17): a local point has no CI run
    // id, so it gets a stable synthetic one from its timestamp instead. The
    // row's own detail (sha, pass/fail/total, conclusion, source) toggles
    // open in a second, full-width row right below it - one <td colspan>,
    // since a bare <div> can't sit between <tr> siblings in a <table>.
    const runKey = p.runId ?? `local-${p.ts}`;
    const detail = document.createElement('div');
    detail.className = 'qat-row-detail';
    detail.textContent = `sha ${p.sha ?? 'none'}, ${p.pass ?? '?'} passed, ${p.fail ?? '?'} failed of ${p.testCount ?? '?'}, ${p.conclusion ?? 'no conclusion'}, source ${p.source}`;
    const detailRow = document.createElement('tr');
    detailRow.className = 'qat-row-detail-tr';
    detailRow.hidden = true;
    const detailCell = document.createElement('td');
    detailCell.colSpan = 8;
    detailCell.appendChild(detail);
    detailRow.appendChild(detailCell);
    row.after?.(detailRow) ?? row.parentNode?.insertBefore(detailRow, row.nextSibling);
    bindItem(dateBtn, {
      type: 'ci-run', id: runKey,
      link: linkFor({ lens: 'work', band: 'gates', sel: { type: 'ci-run', id: runKey } }),
      open: () => { detailRow.hidden = !detailRow.hidden; }, label: `CI run ${runKey}`,
    });
  }
  table.appendChild(tbody);
  scroller.appendChild(table);
  details.appendChild(scroller);
  wrap.appendChild(details);
  return wrap;
}

function buildEmptyState() {
  const wrap = el('div', 'an-panel qat-empty-panel');
  wrap.appendChild(el('div', 'an-panel-title', 'Test results over time'));
  const body = el('div', 'an-panel-body');
  body.appendChild(el('div', 'an-empty', 'No QA trend data yet \u2014 the first sampled CI run will appear here.'));
  wrap.appendChild(body);
  return wrap;
}

// The CI chip's numbers: the latest sampled run's passing count over its
// total, so the header can say "CI 6,839 / 6,854" without drawing the chart.
export function ciSummary(points) {
  const list = Array.isArray(points) ? points : [];
  const latest = list[list.length - 1];
  if (!latest) return null;
  const total = numOr0(latest.testCount);
  const pass = numOr0(latest.pass);
  const fail = numOr0(latest.fail);
  return {
    pass, total, fail,
    ok: fail === 0 && latest.conclusion !== 'failure',
    source: latest.source === 'local' ? 'Local' : 'CI',
    text: `${latest.source === 'local' ? 'Local' : 'CI'} ${fmtInt(pass)} / ${fmtInt(total)}`,
  };
}

// `opts.data` lets the Work header hand over the response it already fetched
// for the chip, so revealing the chart costs no second request.
export async function renderQaTrends(container, opts = {}) {
  if (!container) return;
  container.textContent = '';
  container.appendChild(el('div', 'an-empty', 'Loading QA trends...'));

  let data = opts.data ?? null;
  let loadError = null;
  if (!data) {
    try {
      data = await fetchQaTrends();
    } catch (err) {
      loadError = err;
    }
  }

  container.textContent = '';
  const root = el('div', 'an-root qat-root');

  if (loadError) {
    root.appendChild(el('div', 'an-empty', 'Failed to load QA trends data.'));
    container.appendChild(root);
    return;
  }

  const points = Array.isArray(data?.points) ? data.points : [];
  if (points.length === 0) {
    root.appendChild(buildEmptyState());
    container.appendChild(root);
    return;
  }

  const strip = buildStatStrip(points);
  const agent = agentRunsStat(data?.affected);
  if (agent) strip.appendChild(buildStatCard(agent));
  root.appendChild(strip);

  const chartPanel = el('div', 'an-panel qat-chart-panel');
  chartPanel.appendChild(el('div', 'an-panel-title', 'Test results over time'));
  const chartBody = el('div', 'an-panel-body qat-chart-body');
  chartPanel.appendChild(chartBody);
  root.appendChild(chartPanel);

  root.appendChild(buildTableView(points));
  container.appendChild(root);

  // Chart is mounted after the shell is in the DOM (reserves layout space - 
  // no content jump once vega-embed resolves) and after the vendor scripts,
  // which are lazy-loaded on first use rather than paid for on every page load.
  try {
    await loadVegaEmbed();
    const colors = buildColors();
    const spec = buildSpec(points, colors);
    await window.vegaEmbed(chartBody, spec, { actions: false, theme: 'dark', renderer: 'svg' });
  } catch {
    chartBody.textContent = '';
    chartBody.appendChild(el('div', 'an-empty', 'Chart failed to render \u2014 see the raw data table below.'));
  }
}
