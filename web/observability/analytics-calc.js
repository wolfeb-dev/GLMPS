// web/observability/analytics-calc.js
// PURE helpers - NO DOM access. Safe to import in Node for unit tests.
// Consumes the /api/usage payload shapes:
//   perSession: [{ sid, model, costUsd, input, output, cacheRead, cacheCreate, ctxUsedPct, cwd, lastTs }]
//   heatmap:    [{ date, count }]
import { cwdLastSeg } from '../shared/dom-util.js';

export { cwdLastSeg };

// Normalize a model string to a coarse tier key: 'opus' | 'sonnet' | 'haiku' | other lowercased | 'unknown'.
export function modelKey(model) {
  if (!model || typeof model !== 'string') return 'unknown';
  const lower = model.toLowerCase();
  if (lower.includes('opus')) return 'opus';
  if (lower.includes('sonnet')) return 'sonnet';
  if (lower.includes('haiku')) return 'haiku';
  const cleaned = lower.replace(/\s*\([^)]*\)\s*$/, '').trim();
  return cleaned || 'unknown';
}

// Sum the four token figures of a per-session row into a single number.
export function rowTokens(row) {
  if (!row) return 0;
  return (row.input ?? 0) + (row.output ?? 0) + (row.cacheRead ?? 0) + (row.cacheCreate ?? 0);
}

// Largest value of key across arr (0 for empty / all-missing). key may be a string or accessor fn.
export function maxOf(arr, key) {
  if (!Array.isArray(arr) || arr.length === 0) return 0;
  const get = typeof key === 'function' ? key : (x) => x?.[key];
  let max = 0;
  for (const item of arr) {
    const v = Number(get(item)) || 0;
    if (v > max) max = v;
  }
  return max;
}

// Group per-session rows by coarse model tier.
// -> [{ key, label, sessions, costUsd, tokens, input, output, cacheRead, cacheCreate }] sorted by costUsd desc.
export function groupByModel(perSession) {
  const rows = Array.isArray(perSession) ? perSession : [];
  const map = new Map();
  for (const r of rows) {
    const key = modelKey(r.model);
    let g = map.get(key);
    if (!g) {
      g = { key, label: key, sessions: 0, costUsd: 0, tokens: 0, input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
      map.set(key, g);
    }
    g.sessions += 1;
    g.costUsd += r.costUsd ?? 0;
    g.input += r.input ?? 0;
    g.output += r.output ?? 0;
    g.cacheRead += r.cacheRead ?? 0;
    g.cacheCreate += r.cacheCreate ?? 0;
    g.tokens += rowTokens(r);
  }
  return [...map.values()].sort((a, b) => b.costUsd - a.costUsd || b.tokens - a.tokens);
}

// Group per-session rows by project. Prefers a stamped `worktree.parent` (a
// session running in an isolated git worktree, glmps-71) over the cwd's last
// segment, which for a worktree cwd would be the worktree/session dir itself
// (e.g. "session-abc123") - fragmenting the session into its own bogus
// project instead of grouping it under the real one.
// -> [{ key, label, sessions, costUsd, tokens, input, output, cacheRead, cacheCreate }] sorted by costUsd desc.
export function groupByProject(perSession) {
  const rows = Array.isArray(perSession) ? perSession : [];
  const map = new Map();
  for (const r of rows) {
    const seg = (r.worktree && typeof r.worktree.parent === 'string' && r.worktree.parent) || cwdLastSeg(r.cwd);
    const key = seg || '(unknown)';
    let g = map.get(key);
    if (!g) {
      g = { key, label: key, sessions: 0, costUsd: 0, tokens: 0, input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
      map.set(key, g);
    }
    g.sessions += 1;
    g.costUsd += r.costUsd ?? 0;
    g.input += r.input ?? 0;
    g.output += r.output ?? 0;
    g.cacheRead += r.cacheRead ?? 0;
    g.cacheCreate += r.cacheCreate ?? 0;
    g.tokens += rowTokens(r);
  }
  return [...map.values()].sort((a, b) => b.costUsd - a.costUsd || b.tokens - a.tokens);
}

// Convert the /api/usage `byTool` map into ranked rows for the per-tool
// breakdown. Each entry: { costUsd, credits, inputTokens, outputTokens,
// cacheCreateTokens, avgLatencyMs, sessions, days }.
// -> [{ key, label, tokens, costUsd, credits, avgLatencyMs, sessions }] sorted by tokens desc.
export function perToolRows(byTool) {
  const src = byTool && typeof byTool === 'object' ? byTool : {};
  const rows = [];
  for (const [key, t] of Object.entries(src)) {
    if (!t || typeof t !== 'object') continue;
    const tokens = (t.inputTokens ?? 0) + (t.outputTokens ?? 0) + (t.cacheCreateTokens ?? 0);
    rows.push({
      key, label: key, tokens,
      costUsd: t.costUsd ?? 0,
      credits: t.credits ?? 0,
      avgLatencyMs: t.avgLatencyMs ?? null,
      sessions: t.sessions ?? 0,
    });
  }
  return rows.sort((a, b) => b.tokens - a.tokens || b.costUsd - a.costUsd);
}

// Polar-to-cartesian on a unit-ish circle. Angle 0 = 12 o'clock, clockwise.
function polar(cx, cy, r, angleDeg) {
  const a = ((angleDeg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
}

// Round to a fixed precision to keep generated path strings stable/compact.
function round(n) {
  return Math.round(n * 1000) / 1000;
}

// Build SVG donut arc segments for an input/output/cache(read+create) split.
// parts: { input, output, cacheRead, cacheCreate } (any missing => 0).
// opts: { cx=50, cy=50, radius=40, thickness=14 }
// -> [{ key, label, value, fraction, d }] where d is an SVG path 'd' string drawn as a
//    stroke-able arc band (outer arc forward, inner arc back, closed). Sized for a
//    100x100 viewBox by default. A single full-circle segment is split into two half
//    arcs so the path is always valid (SVG arcs cannot describe a 360deg sweep in one A).
export function donutArcs(parts, opts = {}) {
  const cx = opts.cx ?? 50;
  const cy = opts.cy ?? 50;
  const radius = opts.radius ?? 40;
  const thickness = opts.thickness ?? 14;
  const rOuter = radius;
  const rInner = Math.max(0, radius - thickness);

  const p = parts || {};
  const cacheTotal = (p.cacheRead ?? 0) + (p.cacheCreate ?? 0);
  const segs = [
    { key: 'input', label: 'Input', value: Math.max(0, p.input ?? 0) },
    { key: 'output', label: 'Output', value: Math.max(0, p.output ?? 0) },
    { key: 'cache', label: 'Cache', value: Math.max(0, cacheTotal) },
  ];

  const total = segs.reduce((s, x) => s + x.value, 0);
  if (total <= 0) {
    return segs.map((s) => ({ ...s, fraction: 0, d: '' }));
  }

  // Arc band path between two angles.
  function bandPath(startAngle, endAngle) {
    const full = endAngle - startAngle >= 359.999;
    if (full) {
      // Split into two halves to keep each A-sweep < 360deg.
      const mid = startAngle + 180;
      return bandPath(startAngle, mid) + ' ' + bandPath(mid, endAngle);
    }
    const largeArc = endAngle - startAngle > 180 ? 1 : 0;
    const oStart = polar(cx, cy, rOuter, startAngle);
    const oEnd = polar(cx, cy, rOuter, endAngle);
    const iEnd = polar(cx, cy, rInner, endAngle);
    const iStart = polar(cx, cy, rInner, startAngle);
    return [
      `M ${round(oStart.x)} ${round(oStart.y)}`,
      `A ${round(rOuter)} ${round(rOuter)} 0 ${largeArc} 1 ${round(oEnd.x)} ${round(oEnd.y)}`,
      `L ${round(iEnd.x)} ${round(iEnd.y)}`,
      `A ${round(rInner)} ${round(rInner)} 0 ${largeArc} 0 ${round(iStart.x)} ${round(iStart.y)}`,
      'Z',
    ].join(' ');
  }

  let angle = 0;
  const out = [];
  for (const s of segs) {
    const fraction = s.value / total;
    const sweep = fraction * 360;
    const d = s.value > 0 ? bandPath(angle, angle + sweep) : '';
    out.push({ key: s.key, label: s.label, value: s.value, fraction, d });
    angle += sweep;
  }
  return out;
}

// Estimate the tokens graphify saves on codebase orientation, from the
// /api/graph/status node counts. The premise (see CLAUDE.md): a graphify query
// returns a compact scoped subgraph instead of reading raw source, so for every
// indexed node the cost drops from ~a chunk of source to ~one graph line.
//
// input: an array of { nodes } graph-status rows, OR the raw payload { graphs: [...] }.
// opts:
//   tokensPerSourceNode - est. tokens of raw source one node represents (default 90,
//                          a node ~= a function/section; conservative - many are larger)
//   tokensPerGraphNode - est. tokens of a node's compact graph line, e.g.
//                          "NODE name [src=... loc=... community=...]" (default 12)
// -> { graphs, nodes, rawTokens, graphTokens, savedTokens, ratio }
//    where savedTokens = max(0, rawTokens - graphTokens) and ratio = savedTokens/rawTokens.
//    Savings are clamped at >= 0 so a (mis)configuration can never report negatives.
export function graphifySavings(graphs, opts = {}) {
  const rows = Array.isArray(graphs)
    ? graphs
    : (graphs && Array.isArray(graphs.graphs) ? graphs.graphs : []);

  const perSource = Number(opts.tokensPerSourceNode);
  const perGraph = Number(opts.tokensPerGraphNode);
  const tokensPerSourceNode = Number.isFinite(perSource) && perSource > 0 ? perSource : 90;
  const tokensPerGraphNode = Number.isFinite(perGraph) && perGraph >= 0 ? perGraph : 12;

  let count = 0;
  let nodes = 0;
  for (const g of rows) {
    const n = Number(g?.nodes);
    if (Number.isFinite(n) && n > 0) {
      count += 1;
      nodes += n;
    }
  }

  const rawTokens = nodes * tokensPerSourceNode;
  const graphTokens = nodes * tokensPerGraphNode;
  const savedTokens = Math.max(0, rawTokens - graphTokens);
  const ratio = rawTokens > 0 ? savedTokens / rawTokens : 0;

  return { graphs: count, nodes, rawTokens, graphTokens, savedTokens, ratio };
}

// Assign a heat level 0..4 to each heatmap day based on its count, using 4 thresholds
// derived from the max count (quartiles). 0 = no activity.
// -> [{ date, count, level }] preserving input order.
export function heatBuckets(heatmap) {
  const rows = Array.isArray(heatmap) ? heatmap : [];
  const max = maxOf(rows, 'count');
  // Thresholds at 25/50/75/100% of max.
  return rows.map((h) => {
    const count = h.count ?? 0;
    let level = 0;
    if (count > 0 && max > 0) {
      const ratio = count / max;
      if (ratio > 0.75) level = 4;
      else if (ratio > 0.5) level = 3;
      else if (ratio > 0.25) level = 2;
      else level = 1;
    }
    return { date: h.date, count, level };
  });
}

// GitHub Actions minutes card (card glmps-2-0-73), from GET /api/usage/actions.
// The meter level follows the alert thresholds: warn from the first, error from
// the last, so the bar and the alert center never disagree.
// -> null when there is nothing to show, else the strings and levels to render.
const ACTIONS_OS_LABEL = { ubuntu: 'Ubuntu', windows: 'Windows', macos: 'macOS', other: 'Other' };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function actionsMinutesView(a) {
  if (!a || !Number.isFinite(a.billed) || !Number.isFinite(a.allowance) || a.allowance <= 0) return null;
  const th = (Array.isArray(a.thresholds) ? a.thresholds : [75, 90]).map(Number).filter((n) => Number.isFinite(n) && n > 0).sort((x, y) => x - y);
  const pct = Number.isFinite(a.usedPercent) ? a.usedPercent : (a.billed / a.allowance) * 100;
  const level = th.length && pct >= th[th.length - 1] ? 'error' : th.length && pct >= th[0] ? 'warn' : 'normal';
  const [y, m] = String(a.month ?? '').split('-').map(Number);
  const monthLabel = y && m ? `${MONTHS[m - 1]} ${y}` : '';
  const resets = y && m ? `Resets ${MONTHS[m % 12]} 1` : null;
  const osLine = Object.keys(ACTIONS_OS_LABEL)
    .filter((k) => a.byOs?.[k]?.minutes > 0)
    .map((k) => {
      const o = a.byOs[k];
      return `${ACTIONS_OS_LABEL[k]} ${o.minutes}${o.multiplier > 1 ? ` x${o.multiplier} = ${o.billed}` : ''}`;
    })
    .join(' \u00B7 ');
  const repos = Array.isArray(a.byRepo) && a.byRepo.length > 1 ? a.byRepo.map((r) => ({ repo: r.repo, billed: r.billed })) : [];
  let refused = null;
  if (a.refusedSince) {
    const d = new Date(a.refusedSince);
    refused = Number.isNaN(d.getTime()) ? 'Jobs refused' : `Jobs refused since ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`;
  }
  return {
    level, monthLabel, resets, osLine, repos, refused,
    pctText: `${Math.round(pct)}%`,
    fillPct: Math.max(0, Math.min(100, pct)),
    summary: `${a.billed.toLocaleString('en-US')} of ${a.allowance.toLocaleString('en-US')} billed min`,
    measured: a.updatedTs != null,
    updatedTs: a.updatedTs ?? null,
  };
}
