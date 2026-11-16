// server/lib/evaluation/guard-auto-approve.js
//
// Card glmps-2-0-201, ADR 0003: age-out of stale guard proposals and
// evidence-based auto-approval with a probation that can take a guard back.
// The bar, the caps and the probation rule were settled with the operator;
// docs/specs/2026-11-13-glmps-2-0-201-guard-auto-approve.md has the record.
//
// Everything that touches the guard file or the ledger is injected (land,
// unland), so this module decides and the server's landGuard/unlandGuard
// wiring acts. Zero runtime dependencies.
import fs from 'node:fs';
import path from 'node:path';
import * as learningStore from './learning-store.js';

const DAY = 86400000;

export const POLICY = Object.freeze({
  name: 'guard-auto-approve',
  windowDays: 7,
  minSessions: 5,
  minRepos: 2,
  probationDays: 14,
  perDayMs: DAY,
  maxLive: 10,
});

const LIVE = new Set(['probation', 'kept']);
// A code with a row in any of these already has its guard live or in flight.
const SETTLED_ROW = new Set(['covered', 'applied', 'dispatched']);
const EVENTS_KEEP_MS = 30 * DAY;

// Distinct sessions and repos that showed `code` in [from, to).
export function sightingsFor(items, code, from, to) {
  const sessions = new Set();
  const repos = new Set();
  for (const i of items) {
    if (i.source !== 'gap' || i.code !== code) continue;
    for (const s of Array.isArray(i.sightings) ? i.sightings : []) {
      if (!s || typeof s.ts !== 'number' || s.ts < from || s.ts >= to) continue;
      sessions.add(s.sid);
      repos.add(i.project);
    }
  }
  return { sessions, repos };
}

/**
 * autoApproveCandidate({ items, records, templates, now, policy, scan })
 *   -> { candidate: { code, rule, itemId, evidence } } | { reason }
 *
 * At most one candidate, the code seen in the most sessions. `templates` is
 * the reviewed code -> rule map; a code without one is never a candidate.
 */
export function autoApproveCandidate({ items = [], records = [], templates = {}, now = Date.now(), policy = POLICY, scan = null } = {}) {
  const live = records.filter((r) => LIVE.has(r.status));
  if (live.length >= policy.maxLive) return { reason: `${policy.maxLive} live auto-approved guards already` };
  if (records.some((r) => typeof r.approvedTs === 'number' && now - r.approvedTs < policy.perDayMs)) {
    return { reason: 'already auto-approved 1 per day' };
  }
  const tried = new Set(records.map((r) => r.code));
  const from = now - policy.windowDays * DAY;
  const options = [];
  for (const [code, rule] of Object.entries(templates)) {
    if (tried.has(code) || typeof rule !== 'string' || !rule) continue;
    const rows = items.filter((i) => i.source === 'gap' && i.code === code);
    if (rows.some((i) => SETTLED_ROW.has(i.status))) continue;
    const pending = rows.filter((i) => i.status === 'pending');
    if (!pending.length) continue;
    const { sessions, repos } = sightingsFor(items, code, from, now + 1);
    if (sessions.size < policy.minSessions || repos.size < policy.minRepos) continue;
    if (scan && scan(rule)?.clean !== true) continue;
    const item = [...pending].sort((a, b) => (b.lastSeenTs ?? 0) - (a.lastSeenTs ?? 0))[0];
    options.push({ code, rule, itemId: item.id, evidence: { sessions: sessions.size, repos: repos.size, windowDays: policy.windowDays } });
  }
  if (!options.length) return { reason: 'no gap meets the bar' };
  options.sort((a, b) => b.evidence.sessions - a.evidence.sessions || a.code.localeCompare(b.code));
  return { candidate: options[0] };
}

export function newRecord({ candidate, items, now, lessonId, commit = null, policy = POLICY }) {
  const baseline = sightingsFor(items, candidate.code, now - policy.probationDays * DAY, now).sessions.size;
  return {
    code: candidate.code, itemId: candidate.itemId, lessonId, rule: candidate.rule, evidence: candidate.evidence,
    status: 'probation', approvedTs: now, baseline, probationEndsTs: now + policy.probationDays * DAY, commit,
  };
}

// Revert when the gap showed up in at least as many sessions during probation
// as in the same span before approval: the guard did not change behavior.
export function probationVerdict(record, items) {
  const probation = sightingsFor(items, record.code, record.approvedTs, record.probationEndsTs).sessions.size;
  const verdict = record.baseline > 0 && probation >= record.baseline ? 'revert' : 'kept';
  return { verdict, probation, baseline: record.baseline };
}

export function digestText(events) {
  if (!events.length) return '';
  const of = (t) => events.filter((e) => e.type === t);
  const approved = of('approved'); const reverted = of('reverted'); const kept = of('kept'); const aged = of('aged-out');
  const lines = [`Guard auto-approval, last day: ${approved.length} approved, ${reverted.length} reverted, ${kept.length} kept, ${aged.length} aged out.`];
  for (const e of approved) lines.push(`Approved on 14-day probation: ${e.code}, seen in ${e.evidence?.sessions} sessions across ${e.evidence?.repos} repos.`);
  for (const e of reverted) lines.push(`Reverted: ${e.code} (${e.reason || 'probation failed'}).`);
  for (const e of kept) lines.push(`Kept after probation: ${e.code}.`);
  if (aged.length) lines.push(`Aged out: ${aged.length} proposal(s) unseen for 30 days.`);
  if (approved.length || kept.length) lines.push('Any of these can be reverted from the learning queue.');
  return lines.join('\n');
}

const stateFile = (stateDir) => path.join(stateDir, 'guard-auto-approve.json');

export function readAutoApproveState(stateDir) {
  try {
    const s = JSON.parse(fs.readFileSync(stateFile(stateDir), 'utf8'));
    return { records: Array.isArray(s.records) ? s.records : [], events: Array.isArray(s.events) ? s.events : [], lastDigestTs: s.lastDigestTs ?? null };
  } catch {
    return { records: [], events: [], lastDigestTs: null };
  }
}

export function writeAutoApproveState(stateDir, s) {
  const f = stateFile(stateDir);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
  fs.renameSync(tmp, f);
}

// Marks every applied row of a reverted code discarded, so a reverted guard's
// own row never looks live again.
function discardApplied(store, code, now) {
  let changed = false;
  const items = store.items.map((i) => {
    if (i.source !== 'gap' || i.code !== code || i.status !== 'applied') return i;
    changed = true;
    return { ...i, status: 'discarded', discardReason: 'auto-reverted', updatedTs: now };
  });
  return changed ? { ...store, items } : store;
}

/**
 * revertRecord({ state, code, reason, actor, now, unland, loadStore, saveStore })
 *   -> the reverted record
 * Shared by the probation step and the operator's revert route.
 */
export function revertRecord({ state, code, reason, actor, now, unland, loadStore, saveStore }) {
  const rec = state.records.find((r) => r.code === code && LIVE.has(r.status));
  if (!rec) throw new Error(`no live auto-approved guard for ${code}`);
  unland(rec, { reason, actor });
  Object.assign(rec, { status: 'reverted', revertedTs: now, revertedBy: actor, revertReason: reason });
  const store = loadStore();
  const next = discardApplied(store, code, now);
  if (next !== store) saveStore(next);
  state.events.push({ type: 'reverted', code, reason, by: actor, ts: now });
  return rec;
}

/**
 * runAutoApproveTick(deps) -> { outcome, result }
 *
 * deps: { now, enabled, canAct, templates, scan, loadStore, saveStore,
 *         readState, writeState, land(candidate), unland(record, { reason, actor }) }
 * result: { aged, kept, reverted, approved, skipped, errors, digest }
 *
 * Errors are collected rather than thrown so one failed step does not hide
 * the others; the loop's checker turns any error into a failed run.
 */
export async function runAutoApproveTick({
  now = Date.now(), enabled = true, canAct = true, templates = {}, scan = null, policy = POLICY,
  loadStore, saveStore, readState, writeState, land, unland,
} = {}) {
  const result = { aged: [], kept: [], reverted: [], approved: null, skipped: null, errors: [], digest: null };
  if (!enabled) return { outcome: 'nothing-to-do', result: { ...result, skipped: 'off' } };

  const state = readState();
  const events = state.events;

  const aging = learningStore.ageOutPending(loadStore(), now);
  if (aging.aged.length) {
    saveStore(aging.state);
    for (const i of aging.aged) {
      result.aged.push(i.id);
      events.push({ type: 'aged-out', itemId: i.id, code: i.code ?? null, ts: now });
    }
  }

  for (const rec of state.records.filter((r) => r.status === 'probation' && now >= r.probationEndsTs)) {
    const v = probationVerdict(rec, loadStore().items);
    if (v.verdict === 'kept') {
      Object.assign(rec, { status: 'kept', keptTs: now, probationSessions: v.probation });
      result.kept.push(rec.code);
      events.push({ type: 'kept', code: rec.code, ts: now });
      continue;
    }
    if (!canAct) { result.errors.push(`${rec.code}: revert due but the act gate is closed`); continue; }
    try {
      revertRecord({ state, code: rec.code, reason: `gap recurred in ${v.probation} sessions vs ${v.baseline} before`, actor: 'auto-approver',
        now, unland, loadStore, saveStore });
      rec.probationSessions = v.probation;
      result.reverted.push(rec.code);
    } catch (e) {
      result.errors.push(`${rec.code}: revert failed: ${e?.message || e}`);
    }
  }

  const pick = autoApproveCandidate({ items: loadStore().items, records: state.records, templates, now, policy, scan });
  if (!pick.candidate) {
    result.skipped = pick.reason;
  } else if (!canAct) {
    result.skipped = 'act gate closed';
  } else {
    const c = pick.candidate;
    try {
      const landed = land(c);
      const store = loadStore();
      saveStore(learningStore.markApplied(store, c.itemId, landed?.result?.commit ?? null, landed?.result?.pushed).state);
      state.records.push(newRecord({ candidate: c, items: store.items, now, lessonId: landed?.lessonId ?? null, commit: landed?.result?.commit ?? null, policy }));
      result.approved = c.code;
      events.push({ type: 'approved', code: c.code, evidence: c.evidence, ts: now });
    } catch (e) {
      // The freeze is the operator's deliberate pause, not a fault: failing on
      // it every hour would raise loop alerts and file a diagnosis card.
      if (e?.name === 'LearningWriteFrozenError') result.skipped = 'learning-write freeze';
      else result.errors.push(`${c.code}: auto-approval refused: ${e?.message || e}`);
    }
  }

  state.events = events.filter((e) => now - (e.ts ?? 0) < EVENTS_KEEP_MS);
  writeState(state);

  const digestDue = state.lastDigestTs == null || now - state.lastDigestTs >= DAY;
  const unsent = state.events.filter((e) => (e.ts ?? 0) > (state.lastDigestTs ?? -1));
  result.digest = digestDue && unsent.length ? digestText(unsent) : null;

  const acted = result.aged.length || result.kept.length || result.reverted.length || result.approved || result.errors.length || result.digest;
  return { outcome: acted ? 'done' : 'nothing-to-do', result };
}
