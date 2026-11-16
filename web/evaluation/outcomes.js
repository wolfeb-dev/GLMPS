// web/evaluation/outcomes.js
// Harness Quality panel - fetches GET /api/outcomes/summary and renders one
// compact KPI card per taskClass with five quality metrics.
//
// XSS discipline: every piece of data reaches the DOM only via textContent or
// createElement. innerHTML is not used; containers are emptied with clear().

import { metricValue, evidenceLabel } from '../shared/dom-util.js';

/** @param {string} tag @param {string|null} cls @param {string|null} text */
function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = String(text);
  return node;
}

/** Formats a 0-1 rate as a rounded percentage string, or null if the value is null/undefined. */
function fmtPct(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) + '%' : null;
}

/** Formats a median-turns number to one decimal place, or null if the value is null/undefined. */
function fmtTurns(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(1) : null;
}

// Renders an evidence-tagged metric ({value, evidence, n, reason?} from
// server/lib/evaluation/evidence.js's tagValue()) as display text: the
// evidence label when the metric is not a real measurement ('constant' -
// zero variance, e.g. the old firstTryRate:1 - or 'absent' - the producing
// signal never ran), otherwise the normal numeric formatter over the
// unwrapped value. Also accepts a bare (untagged) number.
function fmtMetric(tagged, fmt) {
  return evidenceLabel(tagged) ?? fmt(metricValue(tagged));
}

// Canonical display order; any unexpected class from the server appends at the end.
const CLASS_ORDER = ['debug', 'feature', 'refactor', 'research', 'docs', 'ops', 'review', 'other'];

/**
 * Builds a single task-class KPI card.
 * @param {string} className
 * @param {{ n:number, medianTurns:object, verifierPassRate:object,
 *           firstTryRate:object, medianContextUsage:object }} stats
 *   Each metric is an evidence-tagged envelope from evidence.js's tagValue().
 * @returns {HTMLElement}
 */
function buildClassCard(className, stats) {
  const card = el('div', 'hq-card');

  // Class name - capitalized, bold header
  card.appendChild(el('div', 'hq-card-title', className));

  // Session count - n shown prominently in mono so the sample size is always visible
  const nRow = el('div', 'hq-card-n');
  const nNum = el('span', 'hq-card-n-num');
  nNum.textContent = String(stats.n ?? 0);
  nRow.appendChild(nNum);
  nRow.appendChild(document.createTextNode(' session' + (stats.n === 1 ? '' : 's')));
  card.appendChild(nRow);

  // Quality metrics - label left, value right, colored by semantic meaning
  // medianTurns -> info (blue, informational count)
  // verifierPassRate -> success (green, quality signal - good is high)
  // firstTryRate -> primary (gold, efficiency highlight)
  // medianContextUsage -> warning (amber, resource signal - high = expensive sessions)
  const defs = [
    { label: 'Median turns',   value: fmtMetric(stats.medianTurns, fmtTurns),        cls: 'hq-val-turns'  },
    { label: 'Verifier pass',  value: fmtMetric(stats.verifierPassRate, fmtPct),      cls: 'hq-val-verify' },
    { label: 'First-try rate', value: fmtMetric(stats.firstTryRate, fmtPct),          cls: 'hq-val-first'  },
    { label: 'Context usage',  value: fmtMetric(stats.medianContextUsage, fmtPct),    cls: 'hq-val-ctx'    },
  ];

  const metricsWrap = el('div', 'hq-metrics');
  for (const { label, value, cls } of defs) {
    const row = el('div', 'hq-metric-row');
    row.appendChild(el('span', 'hq-metric-label', label));
    const valEl = el('span', 'hq-metric-value ' + (value != null ? cls : 'hq-val-dash'));
    valEl.textContent = value != null ? value : '\u2014'; // em dash for no-data
    row.appendChild(valEl);
    metricsWrap.appendChild(row);
  }
  card.appendChild(metricsWrap);

  return card;
}

/**
 * Fetches /api/outcomes/summary and renders the Harness Quality panel into container.
 * Reuses .an-panel / .an-panel-title from the analytics design system.
 * @param {HTMLElement} container
 */
export async function renderOutcomes(container) {
  if (!container) return;

  const panel = el('div', 'an-panel');
  panel.appendChild(el('div', 'an-panel-title', 'Harness Quality'));

  let data;
  try {
    const res = await fetch('/api/outcomes/summary');
    if (!res.ok) throw new Error('outcomes ' + res.status);
    data = await res.json();
  } catch {
    panel.appendChild(el('div', 'an-empty', 'Could not load harness quality data.'));
    container.appendChild(panel);
    return;
  }

  const byClass = data?.byClass ?? {};

  // Classes in canonical order, then any extras the server returns (forward-compat).
  const keys = CLASS_ORDER.filter(k => k in byClass);
  for (const k of Object.keys(byClass)) {
    if (!keys.includes(k)) keys.push(k);
  }

  if (keys.length === 0) {
    panel.appendChild(el('div', 'an-empty',
      'No session outcomes recorded yet \u2014 outcomes are written when sessions close.'));
    container.appendChild(panel);
    return;
  }

  const grid = el('div', 'hq-grid');
  for (const k of keys) {
    grid.appendChild(buildClassCard(k, byClass[k]));
  }
  panel.appendChild(grid);
  container.appendChild(panel);
}
