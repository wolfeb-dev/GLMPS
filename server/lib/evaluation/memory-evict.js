// server/lib/evaluation/memory-evict.js
//
// Pure: given the MEMORY.md index entries and accumulated usage telemetry,
// decide the MINIMUM set of index lines to drop so the index fits its context
// budget. No I/O, no clock, no randomness.
//
// Mirrors guard-retire.js's stance that absence of signal is not evidence,
// but the unit differs. A guard is evaluated every session, so "never fired
// across N observations" is directly meaningful. A memory fact is not
// evaluated; it just sits in the index. So the analogous guard here is
// EXPOSURE: how many memory-touching sessions have occurred since the fact
// existed.
//
// Why pressure-driven rather than threshold-driven
//
// A scheduled "retire anything with 0 reads after N sessions" rule throws away
// evidence for no benefit: while the index still fits, keeping a cold fact
// costs nothing and its read count keeps accumulating. Running as long as
// possible before evicting anything maximizes the evidence behind each
// decision. So evictionPlan() returns [] whenever the index is under budget,
// which is the expected steady state.
//
// Why reads alone must not decide
//
// The index is auto-inlined into every session, so a body-file read only
// happens when the one-line hook was INSUFFICIENT and the model drilled in. A
// perfectly written hook produces zero reads forever. Read count therefore
// measures drill-in demand, not value. Two mitigations follow:
//   - exposure normalization, so a fact written yesterday is not confused with
//     one ignored for months (measured: the never-read set on this corpus was
//     dominated by the most RECENT memories);
//   - pinning, so a fact whose entire purpose is to say "stop" is never
//     evicted for the crime of being self-sufficient.

import { inboundLinks } from './memory-working-set.js';

// Hard-warning vocabulary. A fact matching any of these is never evicted:
// these are the facts with zero reads (nobody drills into "stop") AND the
// highest cost of absence (pushing to a public repo, resuming a closed
// research line, sizing off unverified numbers).
//
// "never" is deliberately NOT a bare word match: it is common in ordinary
// prose ("built-but-never-fed", "so the user is never blocked"). It only
// counts when emphatic, i.e. all-caps NEVER.
const PIN_PATTERNS = [
  /do not resume/i,
  /do ?n[o']?t re-propose/i,
  /do not size/i,
  /do not record/i,
  /do not push/i,
  /push-gate/i,
  /\bNEVER\b/, // case-SENSITIVE: emphatic only
];

// Eval verdicts are pinned too. A verdict's whole value is preventing a
// re-evaluation that has already been paid for once: losing the record that
// RushDB was rejected or that the-library was declined causes no harm, but it
// does buy the same investigation a second time. Verdicts are also
// structurally cold, since nobody drills into a fact that says "we already
// looked at this" - so read count alone would evict them first.
//
// Matched case-SENSITIVELY on the emphatic all-caps form the corpus actually
// uses ("DECLINED 2026-07-12", "TRUSTWORTHY NULL", "SUPERSEDED 2026-07-22").
// Lowercase prose ("the null hypothesis", "we closed the branch") must not
// pin: over-pinning makes eviction unable to meet the budget, and this module
// deliberately stops short rather than evicting a pinned fact.
export const VERDICT_PATTERNS = [
  /\bDECLINED\b/,
  /\bREJECTED\b/,
  /\bABANDONED\b/,
  /\bSUPERSEDED\b/,
  /\bRETIRED\b/,
  /\bDISCARD(ED)?\b/,
  /\bCANCELLED\b/,
  /\bNULL\b/,
];

/**
 * True when `text` must never leave the index: either a hard warning (harm if
 * lost) or a settled eval verdict (wasted rework if lost).
 */
export function isPinned(text) {
  const s = String(text ?? '');
  if (!s) return false;
  return PIN_PATTERNS.some((re) => re.test(s)) || VERDICT_PATTERNS.some((re) => re.test(s));
}

// Eviction order: coldest first.
//   1. fewer reads wins (the primary signal)
//   2. tie -> MORE exposure wins (long-ignored beats newly written; this is
//      what stops a fact created yesterday from being evicted immediately)
//   3. tie -> fewer inbound [[wikilink]] connections wins (structural
//      salience, the mirror of the promotion path in memory-working-set.js:
//      a fact other facts depend on is less disposable, but only among
//      facts already tied on demand and recency; salience never outranks
//      reads or exposure)
//   4. tie -> target name ascending, so the plan never depends on input order
function compare(a, b, inbound) {
  if (a.reads !== b.reads) return a.reads - b.reads;
  if (a.exposureSessions !== b.exposureSessions) return b.exposureSessions - a.exposureSessions;
  const ai = inbound.get(a.target) ?? 0;
  const bi = inbound.get(b.target) ?? 0;
  if (ai !== bi) return ai - bi; // fewer inbound links evicted first
  return a.target < b.target ? -1 : a.target > b.target ? 1 : 0;
}

/**
 * Entries joined to their usage, sorted coldest-first. Exported for
 * inspection and for the API surface; callers wanting a decision should use
 * evictionPlan().
 *
 * A fact with no usage record is treated as zero reads with zero exposure
 * rather than skipped: an untracked fact is a cold fact, but its zero
 * exposure keeps it ranked behind long-observed cold facts.
 *
 * `bodies` is optional (defaults to `{}`): callers that do not pass it get
 * an empty inbound-link map, so every fact ties at 0 on the salience term
 * and behavior falls through to the pre-existing name tie-break unchanged.
 */
export function rankForEviction(entries, usage = {}, bodies = {}) {
  const inbound = inboundLinks(bodies);
  return (Array.isArray(entries) ? entries : [])
    .map((e) => {
      const u = usage[e.target] || {};
      return {
        ...e,
        reads: Number.isFinite(u.reads) ? u.reads : 0,
        exposureSessions: Number.isFinite(u.exposureSessions) ? u.exposureSessions : 0,
      };
    })
    .sort((a, b) => compare(a, b, inbound));
}

/**
 * @param {{
 *   entries: Array<{ target: string, line: string, bytes: number }>,
 *   usage?: Record<string, { reads?: number, exposureSessions?: number }>,
 *   budgetBytes: number,
 *   pinned?: Set<string>,
 *   bodies?: Record<string, string>,
 * }} input
 * @returns {Array<{ target, line, reads, exposureSessions, reason }>}
 *   the shortest coldest-first prefix whose removal brings the index under
 *   budget; [] when already under budget or when only pinned facts remain.
 */
export function evictionPlan({ entries, usage = {}, budgetBytes, pinned = new Set(), bodies = {} }) {
  const list = Array.isArray(entries) ? entries : [];
  let total = list.reduce((n, e) => n + (Number(e.bytes) || 0), 0);
  if (total <= budgetBytes) return [];

  const plan = [];
  for (const e of rankForEviction(list, usage, bodies)) {
    if (total <= budgetBytes) break;
    if (pinned.has(e.target)) continue; // pinned facts are not evictable, ever
    total -= Number(e.bytes) || 0;
    plan.push({
      target: e.target,
      line: e.line,
      reads: e.reads,
      exposureSessions: e.exposureSessions,
      reason: `${e.reads} reads across ${e.exposureSessions} exposed sessions`,
    });
  }
  return plan;
}
