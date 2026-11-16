// server/lib/evaluation/lens-outcome-metrics.js
// The Learning lens's four headline numbers (D6 borrow b, the AI-native SDLC
// playbook's outcome metrics that we can feed today). Each is a tagValue
// envelope with its sample size and a plain-words basis; at our volume they
// are trends, not A/B tests (D6 test 6). Computed on request from existing
// stores; no background job. A failed input becomes an 'absent' envelope with
// a reason, never a bare number or a silent zero.
import { tagValue } from './evidence.js';

const DAY = 86400000;
const MIN = 60000;
const REFS_MAX = 20;
const MERGED_GATES = new Set(['PASS']);

export const METRIC_IDS = Object.freeze(['first-pass-ci', 'merged-first-pass', 'time-to-first-review', 'breach-to-card']);

const toMs = (v) => (typeof v === 'number' ? (Number.isFinite(v) ? v : null) : typeof v === 'string' ? (Number.isNaN(Date.parse(v)) ? null : Date.parse(v)) : null);
function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b); const n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}
const round1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
const refsOf = (list) => list.sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0)).slice(0, REFS_MAX).map(({ kind, id, value }) => ({ kind, id, value }));
const absent = (reason) => ({ value: tagValue(null, [], { reason }), refs: [] });

// A merge-queue test failure. A single timeout is load (requeued, no round
// spent) and excused, but a second timeout on the same head the queue rules
// "the change, not load" ("... twice on <sha>"), so that one counts. A "tests
// error:" bounce is the queue's infra fault, not the change, so it is excused.
const TEST_FAIL_RE = /tests fail: (?!timed out)|tests fail: timed out\b.* twice on /i;

export function mergeQueueFirstTry({ items = [], since = 0 } = {}) {
  const kept = [];
  for (const it of items) {
    const m = it?.mergeRequest;
    if (m?.stage !== 'merged' || !Array.isArray(m.history)) continue;
    const mergedTs = Math.max(...m.history.filter((h) => h?.to === 'merged').map((h) => toMs(h.ts) ?? -Infinity));
    if (!(mergedTs >= since)) continue;
    const failed = m.history.some((h) => (h?.to === 'bounced' || h?.to === 'held') && TEST_FAIL_RE.test(String(h.reason ?? '')));
    kept.push({ kind: 'card', id: it.id, value: !failed, ts: mergedTs });
  }
  const samples = kept.map((k) => k.value);
  const value = samples.length ? samples.filter(Boolean).length / samples.length : null;
  return {
    value: tagValue(value, samples, samples.length ? {} : { reason: 'no merge request merged in the window' }),
    refs: refsOf(kept),
  };
}

// The runner records a card's session in runSession (the legacy sessionId
// field is null on almost every card), earliest first.
export function cardSessionIds(it) {
  const ids = [...(it?.runSession?.previousSessionIds ?? []), it?.runSession?.sessionId, it?.sessionId];
  return [...new Set(ids.filter((x) => typeof x === 'string' && x))];
}

export function firstPassMerged({ outcomes = [], items = [], since = 0 } = {}) {
  // Outcome rows are keyed 'session-<sid>'; older rows used the bare id.
  const bySession = new Map(outcomes.filter((r) => r && typeof r.id === 'string').map((r) => [r.id.replace(/^session-/, ''), r]));
  const kept = [];
  for (const it of items) {
    if (it?.state !== 'done' || !MERGED_GATES.has(it.gate?.status)) continue;
    if (!(toMs(it.doneAt) >= since)) continue;
    const sids = cardSessionIds(it);
    const rows = sids.map((sid) => bySession.get(sid)).filter((r) => r && r.firstTry != null);
    if (!rows.length) continue;
    // A relaunched card took more than one pass, whatever its last session did.
    kept.push({ kind: 'card', id: it.id, value: sids.length === 1 && rows[0].firstTry === true, ts: toMs(it.doneAt) });
  }
  const samples = kept.map((k) => k.value);
  const value = samples.length ? samples.filter(Boolean).length / samples.length : null;
  return { value: tagValue(value, samples, samples.length ? {} : { reason: 'no gated-done card with a first-try outcome in the window' }), refs: refsOf(kept) };
}

export function commitTsBySession(events = []) {
  const m = new Map();
  for (const e of events) {
    if (e?.gitOp !== 'commit' || !e.sessionId) continue;
    const t = toMs(e.ts);
    if (t == null) continue;
    if (!m.has(e.sessionId) || t < m.get(e.sessionId)) m.set(e.sessionId, t);
  }
  return m;
}

export function timeToFirstReview({ items = [], verdicts = [], commitTsBySession: commits = new Map(), since = 0 } = {}) {
  const kept = [];
  for (const it of items) {
    if (!it?.id || !(toMs(it.createdAt) >= since)) continue;
    const cs = cardSessionIds(it).map((sid) => commits.get(sid)).filter(Number.isFinite);
    if (!cs.length) continue;
    const c = Math.min(...cs);
    const reviews = [toMs(it.gate?.ts), ...verdicts.filter((v) => v?.ticketId === it.id).map((v) => toMs(v.ts))]
      .filter((t) => Number.isFinite(t) && t >= c);
    if (!reviews.length) continue;
    kept.push({ kind: 'card', id: it.id, value: round1((Math.min(...reviews) - c) / MIN), ts: c });
  }
  const samples = kept.map((k) => k.value);
  return { value: tagValue(round1(median(samples)), samples, samples.length ? {} : { reason: 'no card with both a commit and a later gate or judge verdict in the window' }), refs: refsOf(kept) };
}

export function breachToCard({ items = [], since = 0 } = {}) {
  const kept = [];
  for (const it of items) {
    if (it?.source !== 'loop-diagnosis') continue;
    const b = toMs(it.origin?.streakStartTs); const c = toMs(it.createdAt);
    if (b == null || c == null || c < b || c < since) continue;
    kept.push({ kind: 'card', id: it.id, value: round1((c - b) / MIN), ts: c });
  }
  const samples = kept.map((k) => k.value);
  return { value: tagValue(round1(median(samples)), samples, samples.length ? {} : { reason: 'no loop-diagnosis card in the window (K3 files them at 3 consecutive failures)' }), refs: refsOf(kept) };
}

export async function computeOutcomeMetrics({ stateDir, now = Date.now(), windowDays = 30, deps } = {}) {
  const since = now - windowDays * DAY;
  // every input must be a list; a malformed one (a backlog
  // whose items is an object) is that metric's absent reason, not a 500.
  const guard = (fn, what) => {
    try {
      const v = fn();
      return Array.isArray(v) ? { ok: true, v } : { ok: false, reason: `${what} failed: not a list` };
    } catch (e) { return { ok: false, reason: `${what} failed: ${e.message}` }; }
  };
  const outcomes = guard(() => deps.readOutcomes(stateDir), 'reading outcome rows');
  const backlog = guard(() => deps.loadBacklog(stateDir).items ?? [], 'reading the backlog');
  const events = guard(() => deps.readEvents(stateDir, { since }), 'reading the event log');
  const verdicts = guard(() => deps.readVerdicts(stateDir), 'reading judge verdicts');

  const pick = (...inputs) => inputs.find((x) => !x.ok);
  const ci = backlog.ok ? mergeQueueFirstTry({ items: backlog.v, since }) : absent(backlog.reason);
  const merged = pick(outcomes, backlog) ? absent(pick(outcomes, backlog).reason) : firstPassMerged({ outcomes: outcomes.v, items: backlog.v, since });
  const review = pick(backlog, events, verdicts) ? absent(pick(backlog, events, verdicts).reason)
    : timeToFirstReview({ items: backlog.v, verdicts: verdicts.v, commitTsBySession: commitTsBySession(events.v), since });
  const breach = backlog.ok ? breachToCard({ items: backlog.v, since }) : absent(backlog.reason);

  const m = (id, label, unit, r, basis) => ({ id, label, unit, value: r.value, basis, refs: r.refs });
  return {
    ts: now, windowDays,
    metrics: [
      m('first-pass-ci', 'Merge queue first-try test pass', 'ratio', ci,
        'Merge requests merged in the window, share that never bounced or held on a test failure (a timeout is load and does not count).'),
      m('merged-first-pass', 'Merged from the first implementation pass', 'ratio', merged,
        'Cards done with a PASS gate (no durable merge record exists), share whose session finished in one turn (outcome firstTry).'),
      m('time-to-first-review', 'Time to first review', 'minutes', review,
        'Median minutes from a card session\'s first commit to its first gate or judge verdict.'),
      m('breach-to-card', 'Time from breach to filed card', 'minutes', breach,
        'Median minutes from a loop\'s failure-streak start to its auto-diagnosis card (K3).'),
    ],
  };
}
