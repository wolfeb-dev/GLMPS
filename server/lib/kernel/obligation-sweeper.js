// server/lib/kernel/obligation-sweeper.js
// The first openers (loop freshness) and the sweeper that turns a missed due
// time into an expiry, an alert, one diagnosis and an escalation ladder.
import { formatTime } from '../../../web/shared/time-format.js';
const HOUR = 3_600_000;

// The loop registry's own obligations adapter (Task 1's onRegister/onOk
// hooks). Every registered loop whose sla does not opt out (sla.obligation
// !== false) gets a standing 'loop.freshness' obligation, always due again
// the moment the previous one closes - the freshness promise is never
// allowed to lapse into "nothing is tracking this any more".
export function loopObligations(store, { now = Date.now } = {}) {
  const specs = new Map();
  const reopen = (name) => { const s = specs.get(name); if (s) store.open({ kind: 'loop.freshness', subject: name, openedBy: 'kernel', dueTs: now() + s.sla.maxAgeMs }); };
  return {
    // Phase K final review I2 (probe P2): a row this loop left open before a
    // restart keeps its old dueTs, so after overnight downtime every loop
    // would expire on the first sweep, before it had any chance to run.
    // An overdue, not-yet-expired row is re-based to now + the interval; an
    // expired row (a miss that happened while the process was still up) is
    // left exactly as it is.
    // A loop that registers with sla.obligation false (one that cannot run,
    // e.g. nightly-run while its actor is disabled) closes any row an
    // earlier boot left open, decision.cancelled with the reason, so it never
    // expires into a false alert.
    onRegister(name, spec) {
      if (spec.sla?.obligation === false) {
        const stale = store.findOpen({ kind: 'loop.freshness', subject: name });
        if (stale) store.close(stale.id, { closer: 'decision.cancelled', closedBy: 'kernel', verifierRef: `registered with sla.obligation: false (${name} cannot run on this instance)` });
        return;
      }
      specs.set(name, spec);
      reopen(name);
      const row = store.findOpen({ kind: 'loop.freshness', subject: name });
      if (row && row.escalationLevel === -1 && row.dueTs <= now()) store.rebaseDue(row.id, now() + spec.sla.maxAgeMs);
    },
    onOk(name, { outcome, verifierRef, ts }) {
      if (!specs.has(name)) return;
      const row = store.findOpen({ kind: 'loop.freshness', subject: name });
      if (row) {
        store.close(row.id, outcome === 'done'
          ? { closer: 'verified.done', closedBy: `checker:${name}`, verifierRef: verifierRef || `loops/${name}.json@${ts}` }
          : { closer: 'verified.done', closedBy: `classifier:${name}`, verifierRef: `loops/${name}.json@${ts}` });
      }
      reopen(name);
    },
  };
}

// glmps-2-0-64: a host sleep does not restart the process, so onRegister's
// rebase never runs and every row due inside the sleep expired on the first
// sweep after wake. check() is called by a short kernel heartbeat AND by the
// sweeper before it expires anything (after wake either timer can fire
// first). A wall-clock gap between calls longer than gapMs is a suspend.
// The sweeper's own cadence is not the signal: it backs off when failing,
// and that must never read as a sleep and hide a real miss. A long event
// loop stall reads as a suspend too, which is fair: no loop could run.
export function createSuspendDetector({ now = Date.now, gapMs, onSuspend }) {
  let last = null;
  return {
    check() {
      const t = now(); const from = last; last = t;
      if (from == null || t - from <= gapMs) return null;
      const s = { fromTs: from, toTs: t, gapMs: t - from };
      onSuspend(s);
      return s;
    },
  };
}

// Suspended time does not count against any due time: every open,
// not-yet-expired row due after the suspend began moves later by the
// suspend's length, so a row that was not overdue when the host slept is not
// overdue on wake. That covers every kind, not just loop.freshness
// (glmps-187): a gate verdict's judge job cannot run while the host sleeps
// either. A row already due before the suspend began was a miss while awake
// and is left for expireDue: a real miss stays a miss. Returns the rebased
// row ids.
export function rebaseForSuspend(store, { fromTs, toTs }) {
  const rebased = [];
  for (const row of store.listOpen()) {
    if (row.escalationLevel !== -1 || row.dueTs <= fromTs) continue;
    if (store.rebaseDue(row.id, row.dueTs + (toTs - fromTs))) rebased.push(row.id);
  }
  return rebased;
}

// Expire every overdue row (escalationLevel -1, dueTs passed), diagnose each
// expiry once, then climb the escalation ladder on every row still open at
// least an hour after its last step (or its expiry, for the first step).
// notify() is awaited and NOT swallowed: a failed post is a real failure the
// caller (the obligation-sweeper loop's maker) must see, never silence.
//
// `ctx` is
// the registry's own per-run ctx, passed through unchanged from
// obligationSweeperLoop's maker straight into `diagnose(row, ctx)`. This
// function itself never calls ctx.countModelCall(): only the wiring knows
// which rows are actually eligible for a real diagnosis attempt (a
// 'loop.freshness' row whose loop still exists, in server.js's own
// wiring), so only the wiring can decide when a ceiling slot is genuinely
// spent - counting here, for every row regardless of kind or eligibility,
// would let six ineligible expiries alone exhaust a ceiling that never
// actually attempted a single diagnosis.
export async function sweepObligations({ store, now = Date.now, notify, diagnose, ctx = null }) {
  const expired = store.expireDue();
  for (const row of expired) await diagnose(row, ctx);
  const escalated = [];
  for (const row of store.listOpen()) {
    if (row.escalationLevel < 0 || row.escalationLevel >= 2) continue;
    const last = row.meta?.lastEscalatedTs ?? row.expiredTs;
    if (now() - last < HOUR) continue;
    // escalate() re-reads the row by id itself, so this never acts on a
    // stale escalationLevel even though `row` here comes from the snapshot
    // taken at the top of this sweep. K4 fix round 2, item 3: an earlier
    // row's own `await notify()` can let an unrelated concurrent write
    // close (or otherwise change) THIS row before its own turn comes -
    // `next` is escalate()'s own fresh read and is the only thing trusted
    // from here on:
    //   - !next: the row no longer exists (escalate() found nothing to
    //     read) - nothing to notify or record.
    //   - next.closedTs != null: it closed in the meantime - a real
    //     closure beats a stale "still open" assumption; posting an
    //     overdue notice for an obligation that is already resolved would
    //     be a false alarm.
    //   - next.escalationLevel === row.escalationLevel: escalate() itself
    //     declined to advance (either of the two cases above, or the
    //     ladder was already at its own top) - nothing changed, so nothing
    //     to notify.
    // setMeta below writes next.meta (escalate()'s own fresh read), never
    // the snapshot's row.meta, so a concurrent tag on this row's meta
    // (from that same earlier notify()) survives instead of being
    // silently reverted.
    const next = store.escalate(row.id);
    if (!next || next.closedTs != null || next.escalationLevel === row.escalationLevel) continue;
    store.setMeta(row.id, { ...(next.meta || {}), lastEscalatedTs: now() });
    await notify(next, next.escalationLevel);
    escalated.push(next.id);
  }
  return { expired: expired.map((r) => r.id), escalated };
}

// The sweeper as a loop: maker sweeps, checker (a different actor) asserts no
// overdue row was left unexpired. With no store it fails every run, visibly.
// `suspend` (a createSuspendDetector) is checked before every sweep.
export function obligationSweeperLoop({ store, sweep = sweepObligations, now = Date.now, notify = async () => {}, diagnose = async () => {}, suspend = null }) {
  return {
    // The registry (registry.js execute()) always calls `spec.maker(ctx)`;
    // threading it through to sweep() is what makes ctx reach the
    // `diagnose(row, ctx)` calls at all (K4 fix round 1, item 1; corrected
    // fix round 2, items 1 and 2 - see sweepObligations's own header).
    maker: async (ctx) => {
      if (!store) throw new Error('obligations store unavailable (kernel.db failed to open; see the kernel log)');
      suspend?.check();
      return { outcome: 'done', result: await sweep({ store, now, notify, diagnose, ctx }) };
    },
    checker: async () => {
      const bad = store.listOpen().filter((r) => r.escalationLevel < 0 && r.dueTs < now() - 5 * 60_000);
      return bad.length ? { ok: false, reason: `${bad.length} overdue rows not expired` } : { ok: true };
    },
  };
}

// The judge closer (K4 Task 11's own brief left this deferred: "If Task 6
// has not landed, add this when it does, in the same commit as Task 6" -
// K Task 6 is the judge cutover as a registered loop). A landed verdict is
// the independent check gate.independent-verdict exists to prove happened,
// so any caller that just ran a real (non-skipped) judgeSession call for a
// session with a resolved ticketId closes it here - a no-op, not a throw,
// when that ticket was never gated, or its obligation already closed (an
// operator's own decision.deferred/decision.cancelled is never overwritten
// by a later verdict, since close() itself is a no-op past the first close).
// verdictTs: the judged session's own
// end/verdict timestamp. A verdict older than the CURRENT obligation's own
// openedTs is stale - e.g. a slow retry attempt for a session judged before
// this ticket's gate even passed again - and must not close a fresh
// obligation it has nothing to say about. Omitting verdictTs opts out of
// the freshness check entirely (closes unconditionally, matching this
// function's pre-existing callers).
//
// K Task 6 fix round 4 RULING. What verdictTs means: the judged SESSION's
// last event ts in epoch ms (the verdict row's stored `ts`, which the judge
// adapter injects as judgeSession's own `now` - plugin-adapters.js), NOT the
// time the judge ran. A gate PASS posted as the session's own last act opens
// its obligation at or slightly AFTER that last event, so a strict
// verdictTs < openedTs check would stop the session's own verdict from ever
// closing its own obligation, leaving it to expire into a false 24h alert.
// The verdict may close the obligation when verdictTs >= openedTs -
// FRESHNESS_TOLERANCE_MS; a genuinely earlier session (one judged before the
// ticket was reopened and gated again) is still refused.
export const FRESHNESS_TOLERANCE_MS = 5 * 60_000;

export function closeGateVerdict({ store, ticketId, rowId, closedBy = 'judge-plugin', verdictTs = null }) {
  if (!store || !ticketId) return null;
  const open = store.findOpen({ kind: 'gate.independent-verdict', subject: ticketId });
  if (!open) return null;
  if (verdictTs != null && verdictTs < open.openedTs - FRESHNESS_TOLERANCE_MS) return null;
  return store.close(open.id, { closer: 'verified.done', closedBy, verifierRef: `judge:${rowId}` });
}

// True when a verdict exists but predates the card's open gate obligation (the
// session was judged mid-run, then passed its gate later), i.e. exactly the case
// closeGateVerdict refuses. Callers re-judge instead of retrying the close.
export function isGateVerdictStale({ store, ticketId, verdictTs = null }) {
  if (!store || !ticketId || verdictTs == null) return false;
  const open = store.findOpen({ kind: 'gate.independent-verdict', subject: ticketId });
  return !!open && verdictTs < open.openedTs - FRESHNESS_TOLERANCE_MS;
}

// The operator's Slack line for one escalation step. A freshness row is said
// in plain words (glmps-2-0-112: the kind/subject form read as jargon); `record`
// is the loop registry's snapshot for the subject, when it still exists.
export function overdueNotice(row, level, record = null) {
  const step = `alert ${level + 1} of 3`;
  if (row.kind !== 'loop.freshness') return `Obligation ${row.kind} ${row.subject} is overdue (${step}).`;
  const since = record?.lastOkTs ? `since ${formatTime(record.lastOkTs)}` : 'since it was registered';
  const limit = record?.sla?.maxAgeMs ? ` (limit ${Math.round(record.sla.maxAgeMs / HOUR)}h)` : '';
  // The registry stores a failure as lastOutcome 'failed:<reason>' plus lastReason '<reason>'.
  const outcome = record?.lastOutcome ? record.lastOutcome.split(':')[0] : null;
  const last = outcome ? ` Last outcome: ${outcome}${record.lastReason ? `, ${record.lastReason}` : ''}.` : '';
  return `Loop ${row.subject} has not checked in ${since}${limit}.${last} (${step})`;
}

export function obligationAlerts(openRows) {
  return (openRows || []).filter((r) => r.escalationLevel >= 0).map((r) => ({
    source: 'obligation', severity: r.escalationLevel >= 1 ? 'critical' : 'warn',
    title: `Obligation expired: ${r.kind} ${r.subject}`,
    detail: `due ${formatTime(r.dueTs)}, opened by ${r.openedBy}; escalation step ${r.escalationLevel + 1} of 3`,
    target: { view: 'loops', loop: r.kind === 'loop.freshness' ? r.subject : null, obligation: r.id }, ts: r.expiredTs ?? r.dueTs,
  }));
}
