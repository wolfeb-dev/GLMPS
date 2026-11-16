// server/lib/observability/morning-brief.js
//
// The morning brief (handoff Part B, B6): the SessionStart counterpart to the
// done-gate Stop hook. It answers one question at the top of a session: what
// happened overnight, and what is drifting: in at most ten lines.
//
// Design constraints taken straight from the spec, all of which are load-bearing:
//
//   * At most ~10 lines. A brief that scrolls is not a brief; it becomes
//     something a human learns to skip, which is worse than no brief at all.
//     When there is more to say than fits, `truncated` is true and the caller
//     can point at the dashboard. Content is dropped from the LEAST important
//     end, never the most.
//
//   * Degrades silently. If there is nothing to report, it returns zero lines
//     rather than a cheerful "all clear" banner. Every line printed at session
//     start is a tax on the operator's attention, so a line has to earn itself.
//
//   * Skipped gates are named. The spec is explicit that a skipped gate is a
//     monitored metric and not silence; the brief is where that surfaces daily.
//
// This module is pure: it takes already-read events and a clock, and returns
// strings. The I/O (reading the spine, the HTTP endpoint, the hook) lives in
// the caller, so the whole thing is testable without a server.
//
// Zero runtime dependencies.

export const MAX_BRIEF_LINES = 10;

const SEV_RANK = { critical: 3, warn: 2, info: 1 };

function toMs(ts) {
  if (typeof ts === 'number') return Number.isFinite(ts) ? ts : null;
  if (typeof ts === 'string') { const n = Date.parse(ts); return Number.isNaN(n) ? null : n; }
  return null;
}

function latest(events, kinds) {
  const set = new Set(kinds);
  let best = null;
  let bestTs = -Infinity;
  for (const e of events ?? []) {
    if (!e || !set.has(e.kind)) continue;
    const t = toMs(e.ts) ?? -Infinity;
    if (t >= bestTs) { best = e; bestTs = t; }
  }
  return best;
}

// Render a short list, collapsing the tail. Returns the omitted count too, so
// the caller can set `truncated` honestly: content folded into an "and N more"
// suffix has still been omitted from the brief, even though the line count
// stayed under the cap.
function list(items, max = 3) {
  const arr = (items ?? []).filter(Boolean);
  if (arr.length <= max) return { text: arr.join(', '), omitted: 0 };
  return { text: `${arr.slice(0, max).join(', ')} and ${arr.length - max} more`, omitted: arr.length - max };
}

/**
 * Build the morning brief.
 *
 * @param runEvents  spine events of kind run.completed / run.failed
 * @param reviews    optional spine events of kind review.completed
 * @param integrity  reconciliation findings [{ check_name, severity, details }]
 * @param now        epoch ms (injected; this module never reads the clock)
 * @returns { lines: string[], truncated: boolean }
 */
export function buildBrief({ runEvents = [], reviews = [], integrity = [], now = 0 } = {}) {
  // Candidate lines in priority order. Truncation drops from the tail, so the
  // order here IS the editorial judgement about what matters at 9am.
  const out = [];
  // Counts anything the brief chose not to show in full, whether that is a
  // dropped line or a collapsed list tail.
  let omitted = 0;

  // 1. Last night's run.
  const run = latest(runEvents, ['run.completed', 'run.failed']);
  if (run) {
    const p = run.payload ?? {};
    const runId = p.runId ?? 'nightly';
    if (run.kind === 'run.failed') {
      out.push(`nightly ${runId} FAILED at stage ${p.stage ?? 'unknown'}: ${p.error ?? 'no reason recorded'}`);
    } else {
      const done = (p.itemsDone ?? []).length;
      const prs = (p.prs ?? []).filter(Boolean);
      const cost = p.costActual?.usd;
      const costPart = typeof cost === 'number' ? `, $${cost.toFixed(2)}` : '';
      out.push(`nightly ${runId}: ${done} item(s) done, ${prs.length} PR(s) filed${costPart}`);
      if (prs.length) { const r = list(prs); omitted += r.omitted; out.push(`  awaiting review: ${r.text}`); }
    }
    const skipped = (p.gatesSkipped ?? []).filter(Boolean);
    if (skipped.length) { const r = list(skipped); omitted += r.omitted; out.push(`  gates skipped: ${r.text}`); }
    const blocked = (p.itemsBlocked ?? []).filter(Boolean);
    if (blocked.length) { const r = list(blocked); omitted += r.omitted; out.push(`  blocked: ${r.text}`); }
  }

  // 2. Integrity findings, most severe first. Only a couple of individual findings
  //    are worth a line; the rest collapse into a count so a noisy check
  //    cannot crowd out the run result.
  const drift = (integrity ?? []).filter(Boolean)
    .slice()
    .sort((a, b) => (SEV_RANK[b.severity] ?? 0) - (SEV_RANK[a.severity] ?? 0));
  for (const f of drift.slice(0, 2)) {
    const why = f.details ? `: ${f.details}` : '';
    out.push(`integrity [${f.severity ?? 'warn'}] ${f.check_name}${why}`);
  }
  if (drift.length > 2) {
    omitted += drift.length - 2;
    out.push(`  plus ${drift.length - 2} more integrity finding(s)`);
  }

  const truncated = out.length > MAX_BRIEF_LINES || omitted > 0;
  return { lines: out.slice(0, MAX_BRIEF_LINES), truncated };
}

