// D6 borrow a (the playbook's Maintain stage): when a loop reaches three
// consecutive failures, ask the model once for a diagnosis and file a QUEUED
// card for the operator's triage. It never applies a fix.
import fs from 'node:fs';
import path from 'node:path';
import { CeilingError } from './registry.js';
import { isQuotaError } from '../orchestration/model-fallback.js';

const SYSTEM = 'You diagnose a failing background loop in a Node.js server. Reply in plain text, under 200 words: the most likely cause, the evidence for it, and one proposed fix. Do not use em-dashes.';

// A usage-limit failure is the account running out, not a fault in the loop:
// a diagnosis card for it can only be wrong and would spend a model call.
export function isUsageLimitFailure(record) {
  const recent = Array.isArray(record?.recentFailures) ? record.recentFailures : [];
  const newest = recent.length ? recent[recent.length - 1]?.reason : null;
  return [record?.lastReason, newest].some((r) => typeof r === 'string' && isQuotaError('claude', r));
}

export function streakTitle(record) { return `Loop ${record.name} failing: ${String(record.lastReason || 'failed').slice(0, 120)}`; }
export function loopStreakMessage(record) {
  return `Loop ${record.name} failed ${record.consecutiveFailures} times in a row: ${record.lastReason || 'failed'}. A diagnosis card is being filed for triage.`;
}

// `expiry`: set when the card is for a
// loop.freshness obligation that expired, not a failure streak. The opening
// line then names the expiry (a loop that simply never ran has 0
// consecutive failures; "has failed 0 consecutive runs" read as nonsense).
export async function diagnoseLoop({ record, logTail = '', chatCompletion, fileCard, now = Date.now, expiry = null }) {
  let diagnosis;
  try {
    const res = await chatCompletion({
      model: 'haiku',
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: `Loop state record:\n${JSON.stringify(record, null, 2)}\n\nLast three failure reasons:\n${(record.recentFailures || []).map((f) => `- ${f.reason}`).join('\n')}\n\nLog tail:\n${String(logTail).slice(-4000)}` },
      ],
    });
    diagnosis = String(res?.choices?.[0]?.message?.content || '').trim() || 'Diagnosis failed: empty model reply';
  } catch (e) {
    diagnosis = `Diagnosis failed: ${e?.message || e}`;
  }
  const iso = (ts) => (ts == null ? 'never' : new Date(ts).toISOString());
  const opening = expiry
    ? `Loop \`${record.name}\`: freshness obligation ${expiry.obligationId} expired, no successful run by its due time ${iso(expiry.dueTs)} (last successful run: ${iso(record.lastOkTs)}).`
    : `Loop \`${record.name}\` has failed ${record.consecutiveFailures} consecutive runs since ${iso(record.streakStartTs ?? now())}.`;
  const prompt = [
    opening,
    '', diagnosis, '',
    'Triage this card. Confirm the cause, then fix it on this card. File a separate card only if the fix belongs to a different repo or needs an operator decision.',
  ].join('\n');
  const { item, isNew } = await fileCard({
    title: streakTitle(record), prompt, source: 'loop-diagnosis', state: 'queued',
    origin: { via: 'loop-diagnosis', loop: record.name, streakStartTs: record.streakStartTs ?? null, ...(expiry ? { obligationId: expiry.obligationId } : {}) },
  });
  return { cardId: item.id, created: isNew };
}

// maxPerDay must survive a restart, so the counter lives
// on disk next to the loop registry's own per-loop state
// (<stateDir>/loops/<name>.json), not in a variable that resets to zero the
// moment the process does. Same atomic write (temp file + rename) as
// registry.js's own save(). A read failure (corrupt JSON, wrong shape) is
// logged and treated as a fresh budget, exactly like a missing file - never a
// crash, and never a reason to block the streak's own Slack post or card.
function budgetFile(stateDir) { return path.join(stateDir, 'loops', 'diagnosis-budget.json'); }

export function loadDiagnosisBudget(stateDir, { log = () => {} } = {}) {
  try {
    const raw = JSON.parse(fs.readFileSync(budgetFile(stateDir), 'utf8'));
    const day = typeof raw?.day === 'string' ? raw.day : '';
    const n = Number.isFinite(raw?.n) ? raw.n : 0;
    return { day, n };
  } catch (e) {
    // ENOENT (no budget filed yet, e.g. the very first streak ever) is the
    // expected steady state on a fresh install, not a failure worth logging;
    // anything else (corrupt JSON, an unreadable file) is.
    if (e.code !== 'ENOENT') log(`diagnosis-budget: read failed, treating as 0: ${e?.message || e}`);
    return { day: '', n: 0 };
  }
}

export function saveDiagnosisBudget(stateDir, budget) {
  const f = budgetFile(stateDir);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(budget, null, 2));
  fs.renameSync(tmp, f);
}

// the peek half of the budget check, with no write
// at all - today's count against the ceiling, day-rollover already
// applied. Split out of nextDiagnosisBudget so a caller that also has its
// own gate to check in between (diagnosisStubReason's ctx.countModelCall())
// can look at the budget WITHOUT spending a slot on a row it may still
// reject for an unrelated reason.
function peekDiagnosisBudget({ stateDir, cfg, now = Date.now, log = () => {} }) {
  const day = new Date(now()).toISOString().slice(0, 10);
  const loaded = loadDiagnosisBudget(stateDir, { log });
  const n = loaded.day === day ? loaded.n : 0;
  return { day, n, overCeiling: n >= cfg.maxPerDay };
}

// The consume half: the caller has already confirmed there is room (via
// peekDiagnosisBudget, above) - this just persists the incremented count
// for that day. Never re-checks the ceiling itself, so it must only ever
// be called once a caller's own gates have all passed.
function consumeDiagnosisBudget({ stateDir, day, n, label = '', log = () => {} }) {
  try { saveDiagnosisBudget(stateDir, { day, n: n + 1 }); }
  catch (e) { log(`diagnosis budget save failed${label ? ` ${label}` : ''}: ${e?.message || e}`); }
}

// the same peek-then-consume step
// handleLoopStreak already does below, extracted so a SECOND caller (the
// obligation-sweeper's own expiry diagnosis, server.js - via
// diagnosisStubReason, below) draws from the exact same persisted counter
// (<stateDir>/loops/diagnosis-budget.json) rather than a duplicate one that
// could drift out of sync with it. Every caller sharing this one function
// is what makes "the same persisted daily budget" true rather than
// aspirational.
//
// Returns { overCeiling }. The counter only ever advances when NOT already
// over ceiling, so a burst of many calls in the same tick (ten expired
// obligations at once, say) correctly consumes one slot per call up to the
// cap and reports true for every call past it - never negative, never
// double-counted. A save failure is logged (with the caller's own label,
// for a message worth grepping) and never thrown: losing the persisted
// counter for one write must not block the diagnosis itself, exactly like
// every other budget-adjacent failure in this module.
export function nextDiagnosisBudget({ stateDir, cfg, now = Date.now, label = '', log = () => {} }) {
  const peek = peekDiagnosisBudget({ stateDir, cfg, now, log });
  if (!peek.overCeiling) consumeDiagnosisBudget({ stateDir, day: peek.day, n: peek.n, label, log });
  return { overCeiling: peek.overCeiling };
}

// the
// shared decision for whether a diagnosis attempt gets a real model call
// or a stub, in three independent gates, checked in order and each
// short-circuiting the rest:
//
//   1. disabled (cfg.enabled === false) - no ctx interaction, no budget
//      interaction, at all: this mirrors handleLoopStreak's own
//      `if (!cfg?.enabled) return` exactly, just returning a stub reason
//      here instead of skipping the card entirely, since an obligation
//      expiry is already the operator-facing signal and a silently-missing
//      diagnosis on top of it would read as "nothing is wrong" rather than
//      "diagnosis is turned off".
//   2. the persisted daily budget - PEEKED, not consumed, before the run
//      ceiling is even touched. Fix round 3, item 1: the previous order
//      called ctx.countModelCall() first and only checked the budget
//      after, so a row already over the daily budget still spent a
//      run-ceiling slot for a diagnosis that was never going to make a
//      real call - a burst of budget-exhausted rows alone could fail the
//      run on ceiling:model-calls with zero real model calls made. Peeking
//      first means an over-budget row returns its stub without ever
//      reaching ctx.countModelCall() at all.
//   3. this run's own per-attempt ceiling (ctx.countModelCall()) - only
//      reached once the peek shows room. A CeilingError stubs; anything
//      else is NOT a budget signal and propagates unchanged. Never a bare
//      catch: ctx's real implementation (registry.js) is a plain counter
//      that only ever throws CeilingError, so anything else reaching here
//      is a bug worth surfacing loudly, not one more silently-absorbed
//      diagnosis.
//
// The daily budget slot is consumed ONLY after both gates 2 and 3 have
// passed - auto-diagnosis.test.js's own coverage pins this: a ceiling
// breach must never spend a budget slot on a call that was never made.
//
// Callers decide WHETHER to call this at all (e.g. the obligation-sweeper's
// wiring only calls it for a row it has already decided is eligible for
// diagnosis) - that eligibility gate is what keeps an ineligible row from
// ever touching ctx.countModelCall() or the budget, not anything inside
// this function.
export function diagnosisStubReason({ ctx, stateDir, cfg, now = Date.now, label = '', log = () => {} }) {
  if (!cfg?.enabled) return 'diagnosis disabled (cfg.kernel.diagnosis.enabled is false)';
  const peek = peekDiagnosisBudget({ stateDir, cfg, now, log });
  if (peek.overCeiling) return 'diagnosis skipped: daily ceiling reached';
  if (ctx) {
    try { ctx.countModelCall(); }
    catch (e) {
      if (e instanceof CeilingError) return 'diagnosis skipped: this run\'s model-call ceiling reached';
      throw e;
    }
  }
  consumeDiagnosisBudget({ stateDir, day: peek.day, n: peek.n, label, log });
  return null;
}

// Phase K final review minor: one outage, one card. A failure streak and a
// freshness expiry of the same loop are usually the same outage seen twice;
// whichever reaches a card first records it here (per loop, on disk so a
// restart does not forget it), and the other skips its card and its model
// call while the record is younger than cfg.dedupeWindowMs (default 24h).
// A read failure other than ENOENT is logged and treated as "no recent card"
// (fail open: a duplicate card beats a missing one); a write failure is
// logged, never thrown.
export const DEFAULT_DEDUPE_WINDOW_MS = 24 * 3_600_000;
function recentFile(stateDir) { return path.join(stateDir, 'loops', 'diagnosis-recent.json'); }
function loadRecent(stateDir, log) {
  try {
    const raw = JSON.parse(fs.readFileSync(recentFile(stateDir), 'utf8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch (e) {
    if (e.code !== 'ENOENT') log(`diagnosis-recent: read failed, treating as empty: ${e?.message || e}`);
    return {};
  }
}
export function recentDiagnosisCard({ stateDir, loop, cfg, now = Date.now, log = () => {} }) {
  const windowMs = Number.isFinite(cfg?.dedupeWindowMs) ? cfg.dedupeWindowMs : DEFAULT_DEDUPE_WINDOW_MS;
  const hit = loadRecent(stateDir, log)[loop];
  return hit && Number.isFinite(hit.ts) && now() - hit.ts < windowMs ? hit : null;
}
export function recordDiagnosisCard({ stateDir, loop, cardId, via, now = Date.now, log = () => {} }) {
  try {
    const all = loadRecent(stateDir, log);
    all[loop] = { ts: now(), cardId, via };
    const f = recentFile(stateDir);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = `${f}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(all, null, 2));
    fs.renameSync(tmp, f);
  } catch (e) { log(`diagnosis-recent: save failed for ${loop}: ${e?.message || e}`); }
}

// Phase K final review I2 and minors: the obligation-sweeper's own expiry
// diagnosis, extracted from server.js so it is unit-testable. In order:
//   1. dedupe: a card for this loop inside the window ends it here, with no
//      model call and no budget spent;
//   2. the one-real-diagnosis-per-sweep cap (RULING: cap, not a longer
//      sweeper timeout). The sweeper's ceiling is 60 s-class while one
//      claude -p call can take 120 s, so a sweep that diagnosed several
//      expiries in sequence could never finish inside it. A second eligible
//      row in the same sweep (the same ctx) files a stub card with no model
//      call; its obligation keeps climbing the escalation ladder;
//   3. diagnosisStubReason's own gates (disabled, daily budget, run ceiling);
//   4. the card, whose opening names the expiry, and the dedupe record.
const realDiagnosesThisSweep = new WeakMap();
export async function handleFreshnessExpiry({ row, record, ctx = null, stateDir, cfg, chatCompletion, fileCard, now = Date.now, log = () => {} }) {
  if (isUsageLimitFailure(record)) {
    log(`diagnosis card skipped ${record.name}: Claude usage limit, not a loop fault`);
    return { deduped: false, skipped: 'usage-limit' };
  }
  const hit = recentDiagnosisCard({ stateDir, loop: record.name, cfg, now, log });
  if (hit) {
    log(`diagnosis deduped ${record.name}: card ${hit.cardId} already filed for this outage (${hit.via})`);
    return { deduped: true, cardId: hit.cardId };
  }
  let stubReason = null;
  if (ctx && (realDiagnosesThisSweep.get(ctx) ?? 0) >= 1) {
    stubReason = 'diagnosis deferred: one model diagnosis per sweep (this expiry still climbs the escalation ladder)';
  } else {
    stubReason = diagnosisStubReason({ ctx, stateDir, cfg, now, label: record.name, log });
    if (!stubReason && ctx) realDiagnosesThisSweep.set(ctx, (realDiagnosesThisSweep.get(ctx) ?? 0) + 1);
  }
  const out = await diagnoseLoop({
    record: { ...record, lastReason: `freshness obligation expired ${row.id}` },
    expiry: { obligationId: row.id, dueTs: row.dueTs },
    logTail: '', now,
    chatCompletion: stubReason ? async () => { throw new Error(stubReason); } : chatCompletion,
    // Same configured column as the streak path below; without it a
    // freshness card fell through to the board's 'default' project.
    fileCard: (input) => fileCard({ project: cfg?.project, ...input }),
  });
  recordDiagnosisCard({ stateDir, loop: record.name, cardId: out.cardId, via: `freshness ${row.id}`, now, log });
  return { deduped: false, ...out };
}

// onLoopStreak's own logic (server.js), extracted so it
// is unit-testable without booting a server or touching Slack/the model.
// Two independent, best-effort actions per streak; neither can make the
// other's failure invisible, and neither ever throws back to the caller (the
// loop registry calls onStreak synchronously and only catches a synchronous
// throw - see registry.js record()).
//
// `cfg` is this server's `cfg.kernel.diagnosis` ({ enabled, maxPerDay,
// project }) - fix round 1, item 1: `project` is now configured (default
// 'glmps-2.0-runtime'), not derived from the running checkout's own directory
// name, which is 'glmps2-k' in this worktree and would be some other name
// again on the 2.0 runtime - neither is where an operator watches the board.
export async function handleLoopStreak({
  name, record, stateDir, cfg, chatCompletion, fileCard, postToOperator,
  log = () => {}, now = Date.now,
}) {
  // 1. One Slack post to the operator channel per streak. `postToOperator`
  // absent means SCUT has no credentials or is disabled - a named, logged
  // no-op, never a crash. A post that is attempted but rejects (no channel,
  // a Slack API failure) is caught here too, for the same reason.
  if (typeof postToOperator !== 'function') {
    log(`streak post skipped ${name}: SCUT not configured`);
  } else {
    try { await postToOperator(loopStreakMessage(record)); }
    catch (e) { log(`streak post failed ${name}: ${e?.message || e}`); }
  }

  // 2. One diagnosis card per streak (D6a: queued, never auto-applied),
  // capped at cfg.maxPerDay model calls. Past the ceiling, diagnoseLoop
  // still runs, fed a chatCompletion stub that throws immediately -
  // diagnoseLoop's own catch turns that into the card's body, so the breach
  // is recorded, never silent.
  if (!cfg?.enabled) return;
  if (isUsageLimitFailure(record)) { log(`diagnosis card skipped ${name}: Claude usage limit, not a loop fault`); return; }
  const hit = recentDiagnosisCard({ stateDir, loop: name, cfg, now, log });
  if (hit) { log(`diagnosis deduped ${name}: card ${hit.cardId} already filed for this outage (${hit.via})`); return; }
  const { overCeiling } = nextDiagnosisBudget({ stateDir, cfg, now, label: name, log });

  try {
    const out = await diagnoseLoop({
      record, logTail: '', now,
      chatCompletion: overCeiling
        ? async () => { throw new Error('diagnosis skipped: daily ceiling reached'); }
        : chatCompletion,
      fileCard: (input) => fileCard({ project: cfg.project, ...input }),
    });
    recordDiagnosisCard({ stateDir, loop: name, cardId: out.cardId, via: 'failure streak', now, log });
  } catch (e) { log(`diagnosis card failed ${name}: ${e?.message || e}`); }
}
