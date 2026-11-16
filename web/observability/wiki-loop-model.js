// web/observability/wiki-loop-model.js
// Pure view model for the wiki view's loop status (D-W5). No DOM.
import { formatTime } from '../shared/time-format.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Absolute local date, e.g. "Jul 12, 2026". The one date formatter for the
// wiki view.
export function fmtDateAbs(ts) {
  if (typeof ts !== 'number' || !isFinite(ts)) return '?';
  const d = new Date(ts);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

// Compact, scannable relative age, e.g. "3d ago". Falls back to an absolute
// date past ~5 weeks so old timestamps read cleanly instead of "37d ago".
// The one relative-time helper for the wiki view: D-W5 fix round 1 removed a
// duplicate duration-only `ago()` that lived here separately from this
// timestamp-based version in wiki.js; wiki.js now imports this one instead
// of keeping its own copy.
export function relTime(ts, now = Date.now()) {
  if (typeof ts !== 'number' || !isFinite(ts)) return '';
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24); if (d < 7) return `${d}d ago`;
  const w = Math.floor(d / 7); if (w < 5) return `${w}w ago`;
  return `on ${fmtDateAbs(ts)}`;
}

export function wikiLoopChip(loop, now = Date.now(), { pending = false } = {}) {
  // A client-side rebuild poll gave up waiting (rebuildPollStep returned
  // 'timeout'). This is not a server-reported outcome -- the loop may well
  // still be mid-run server-side -- so it overrides whatever the last known
  // loop state says rather than reading as a fresh check or a failure.
  if (pending) {
    return {
      tone: 'pending',
      label: 'Still building\u2026',
      title: 'The build is taking longer than expected. It may still be running in the kernel service; refresh again to check.',
    };
  }
  if (!loop) {
    return { tone: 'none', label: 'Loop off here', title: 'The wiki loop runs in the kernel service. This server shows the last published build.' };
  }
  if (typeof loop.lastOutcome === 'string' && loop.lastOutcome.startsWith('failed')) {
    return { tone: 'fail', label: `Build failing (${loop.consecutiveFailures}x)`, title: loop.lastReason || loop.lastOutcome };
  }
  if (typeof loop.lastRunTs === 'number') {
    const next = typeof loop.nextRunTs === 'number' ? ` Next check ${formatTime(loop.nextRunTs)}.` : '';
    return { tone: 'ok', label: `Checked ${relTime(loop.lastRunTs, now)}`, title: `Last outcome: ${loop.lastOutcome}.${next}` };
  }
  return { tone: 'none', label: 'Not built yet', title: 'The wiki loop has not run yet.' };
}

export function rebuildPollStep({ before, after, startedTs, now, maxWaitMs = 35 * 60000 }) {
  const g0 = before?.manifest?.generatedAt ?? null;
  const g1 = after?.manifest?.generatedAt ?? null;
  if (g1 && g1 !== g0) return 'done';
  const r0 = before?.loop?.lastRunTs ?? 0;
  const r1 = after?.loop?.lastRunTs ?? 0;
  if (r1 > r0) {
    const o = String(after.loop.lastOutcome ?? '');
    if (o.startsWith('failed')) return 'failed';
    if (o === 'nothing-to-do') return 'unchanged';
    if (o === 'done') return 'done';
  }
  return now - startedTs > maxWaitMs ? 'timeout' : 'waiting';
}

// Awaits `bodyPromise` (a response's `.json()`), then re-checks `isStale()`
// -- not just before starting the parse. A project switch (or leaving the
// view) landing while the body is still being parsed must still discard the
// result, since checking only beforehand misses that window (D-W5 fix
// round 2). `null` means "stale, do not use this"; callers in this module
// never legitimately parse a literal `null` body, so it is an unambiguous
// sentinel.
export async function acceptIfNotStale(bodyPromise, isStale) {
  const body = await bodyPromise;
  return isStale() ? null : body;
}

// loop.retentionWarning is a structured { ts, message } signal, set and
// cleared by the loop's onRetention dependency. Surfaced verbatim
// as its own warning line rather than folded into the chip: the message is
// free text (old build names), not a short status word.
export function wikiRetentionLine(loop) {
  const w = loop && loop.retentionWarning;
  return w && typeof w.message === 'string' && w.message ? w.message : null;
}
