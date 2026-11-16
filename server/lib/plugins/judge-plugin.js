// server/lib/plugins/judge-plugin.js
//
// Classification and an independent verdict for every finished session, from
// the judge plugin (D23/D24 cutover, glmps-159 task 8): a different actor
// from the session that did the work, replacing the dead-in-production
// heuristic classifyTask() call that used to run inside session-outcome.js.
// No fallback: a judge failure never runs the old heuristic instead, it
// stays queued on retryQueue and shows as a loop failure (K Task 6: the
// registered session-judge / plugin-retry loops, server/lib/loops/plugin-loops.js).
//
// The judge never writes item.gate - that stays an operator/critic action
// (server.js's POST /api/backlog/:id/gate); this only ever appends a devlog
// line through the SAME store call that route uses.
import fs from 'node:fs';
import path from 'node:path';
import { updateOutcome } from '../evaluation/outcome-store.js';
import { tagValue } from '../evaluation/evidence.js';

const verdictFile = (stateDir) => path.join(stateDir, 'judge', 'verdicts.ndjson');

// judge on quiescence. A finalize ping
// fires on every Stop, not just the session's true end, so judging inline on
// the first ping judged an almost-empty trajectory and never revisited it.
// `idleMs` is how long a session must go without another ping before the
// judge actually runs (server.js's finalize route upserts one durable
// judge.session job per session, pushing notBefore forward on every ping,
// instead of calling the judge inline). `enabled: false` means no judge job
// is ever created - the judge is off, not merely delayed.
export const JUDGE_DEFAULTS = Object.freeze({ enabled: true, idleMs: 20 * 60 * 1000 });
export function getJudgeConfig(configJson) {
  const o = configJson?.plugins?.judge && typeof configJson.plugins.judge === 'object' ? configJson.plugins.judge : {};
  return {
    enabled: o.enabled !== false,
    idleMs: Number.isInteger(o.idleMs) && o.idleMs >= 0 ? o.idleMs : JUDGE_DEFAULTS.idleMs,
  };
}

// Turns the session's event log into an openevals-shaped trajectory: a
// prompt (or any event tagged tool:'user') is a user turn, everything else
// with a label is an assistant action line. Capped to the last maxMessages
// so a very long session does not blow the judge's context.
export function eventsToTrajectory(events, { maxMessages = 60 } = {}) {
  const out = [];
  for (const e of events || []) {
    if (e.kind === 'prompt' || e.tool === 'user') out.push({ role: 'user', content: String(e.label || '') });
    else if (e.label) out.push({ role: 'assistant', content: `${e.tool || e.kind} ${e.label}`.trim() });
  }
  return out.slice(-maxMessages);
}

// Classifies and judges one finished session, updates its outcome row, and
// records the verdict. Throws on a plugin failure (bad model output, a
// rejected chatCompletion, ...) - by design: the caller (runRetryTick's
// judge.session handling, memory-plugin.js - the only caller since B4) is
// what queues and alerts, this stays a plain propagate-on-failure function
// so it changes NOTHING on a partial failure (no update, no verdict line,
// no devlog) rather than leaving a half-written record behind.
export async function judgeSession({
  judge, stateDir, row, events, firstPrompt, ticketId = null, update = updateOutcome, appendDevlog = null, now = Date.now,
}) {
  const trajectory = eventsToTrajectory(events);
  // No events to judge - a session that genuinely produced nothing, OR
  // (post-B4) any judge.session job whose rebuild from the persisted log
  // came back empty (there is no separate "already-confirmed-nonempty"
  // attempt ahead of this one any more; runRetryTick hands events through
  // unconditionally). Fix round 1, finding 1: this used to return early
  // WITHOUT calling update(), so the row's initial 'pending' taskClass (set
  // at finalizeSession time) was never revisited - a resolved promise reads
  // as success (the loop's checker sees a verdict-less "ok", no retry
  // queued), so nothing was ever going to come back and fix it. update()
  // marks the row 'other'/'abandoned' with a judge record that says WHY
  // (skipped: 'no-events'), same as any other judged row, and no verdict
  // line is written - there is nothing to independently verdict.
  if (!trajectory.length) {
    const record = { skipped: 'no-events', ts: now() };
    update(stateDir, row.id, { taskClass: 'other', extra: { outcomeClass: 'abandoned', judge: record } });
    return { taskClass: 'other', outcome: 'abandoned', pass: false, skipped: true };
  }
  const summary = trajectory.slice(-20).map((m) => `${m.role}: ${m.content}`).join('\n');
  const [cls, ver] = await Promise.all([
    judge.classify({ firstPrompt, summary }),
    judge.verdict({ trajectory }),
  ]);
  // classify()'s own coercion of an
  // out-of-enum taskClass/outcome stays, but coerced:true plus the raw
  // (rejected) values ride along into both the row's extra.judge and the
  // verdict ledger line, so a garbage classification is never
  // indistinguishable from a genuine 'other'/'partial' one.
  const record = {
    by: ver.by, pass: !!ver.pass, comment: String(ver.comment || ''), reason: String(cls.reason || ''), ts: now(),
    ...(cls.coerced ? { coerced: true, raw: cls.raw } : {}),
  };
  update(stateDir, row.id, { taskClass: cls.taskClass, extra: { outcomeClass: cls.outcome, judge: record } });
  fs.mkdirSync(path.dirname(verdictFile(stateDir)), { recursive: true });
  fs.appendFileSync(verdictFile(stateDir), JSON.stringify({
    rowId: row.id, ticketId, taskClass: cls.taskClass, outcome: cls.outcome, ...record,
  }) + '\n');
  // Best-effort: a devlog write failing (e.g. the ticket was archived between
  // the session starting and finishing) must not turn an already-recorded
  // verdict into a retried judge.session job that would re-run the model for
  // nothing (the retry tick's double-judge guard would ack it as a no-op
  // anyway, but there is no reason to alert plugin health over a devlog
  // mirror that was never the verdict's source of truth).
  if (ticketId && appendDevlog) {
    try {
      appendDevlog(ticketId, `Independent review (${record.by}): ${record.pass ? 'PASS' : 'CONCERNS'}. ${record.comment}`.trim());
    } catch { /* best-effort mirror, see comment above */ }
  }
  return { taskClass: cls.taskClass, outcome: cls.outcome, pass: record.pass };
}

export function readVerdicts(stateDir) {
  try {
    return fs.readFileSync(verdictFile(stateDir), 'utf8')
      .split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch {
    return [];
  }
}

// { n, passRate: evidence-tagged (evidence.js) } - "no verdicts yet" reports
// as absent, never as a fabricated 0% pass rate.
export function judgeSummary(stateDir) {
  const v = readVerdicts(stateDir);
  const samples = v.map((x) => !!x.pass);
  const rate = samples.length ? samples.filter(Boolean).length / samples.length : null;
  return { n: v.length, passRate: tagValue(rate, samples) };
}

// judgeSessionAsync (the finalize route's old
// inline-then-queue-on-failure wiring) is gone - the finalize route now
// only ever upserts a durable judge.session job (retryQueue.upsert, pushing
// notBefore forward on every ping); the retry tick's existing judge.session
// handling below is the ONLY place a judge call is ever made, for both the
// first attempt and any retry.
