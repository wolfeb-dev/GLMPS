// server/lib/scut/park-sweep-loop.js
// The park sweep under the program's loop contract (section 0; table row
// "Park sweep"). Maker: recover unacknowledged wake notes, then release every
// parked ticket the pure sweep() names and close every idle PASS card past the
// TTL. Checker: a different function that re-reads the stores and proves each
// decision landed as decided, that no live session was released as stale, and
// that the thread was told. All I/O is injected so the loop runs in tests with
// no server, no Slack and no clock.
import { sweep, recoverInFlight, idleClosures, STALE_MS, REOPEN_CONFIRM_MS } from './park.js';

export const PARK_SWEEP_LOOP = Object.freeze({
  name: 'scut-park-sweep',
  trigger: { everyMs: 60_000 },
  ceiling: { maxAttempts: 1, maxModelCalls: 0, timeoutMs: 30_000 },
  sla: { maxAgeMs: 5 * 60_000 },
});

export function createParkSweepLoop({ loadLedger, saveLedger, loadItems, activityTs, parkHours, release, closeIdle, now }) {
  async function maker(ctx) {
    const t = now();
    const ledger = loadLedger();
    let recovered = 0;
    for (const [id, entry] of Object.entries(ledger)) {
      const next = recoverInFlight(entry, t);
      if (next !== entry) { ledger[id] = next; recovered++; }
    }
    if (recovered) saveLedger(ledger);
    const items = loadItems();
    const itemsById = new Map(items.map((i) => [i.id, i]));
    const hours = parkHours();
    // Built once per sweep, not once per ledger entry: the real activityTs
    // walks every session summary and reloads the backlog, and sweep() used to
    // call it fresh for every single parked entry.
    const lookupActivity = activityTs(items);
    const candidates = sweep(ledger, itemsById, { parkHours: hours, now: t, activityTs: lookupActivity });
    const decisions = [];
    const skipped = [];
    const postFailures = [];
    for (const d of candidates) {
      if (ctx?.signal?.aborted) break;
      const r = await release(d.id, { kind: d.reason, to: d.to });
      // Another actor (an operator's chat `close`, a different release path)
      // can reach the SAME ticket while this sweep is mid-flight (review
      // scutReleasePark reports that as released:false, a
      // benign named reason to skip, not a run-failing post failure.
      if (r.released === false) { skipped.push({ id: d.id, reason: r.error ?? 'not released' }); continue; }
      decisions.push(d);
      if (!r.posted) postFailures.push({ id: d.id, error: r.error ?? 'not posted' });
    }
    const closed = [];
    for (const id of idleClosures(items, { parkHours: hours, now: t })) {
      if (ctx?.signal?.aborted) break;
      const r = await closeIdle(id);
      // A stale or overlapping sweep can reach an id another run (or an
      // operator reopening it) already changed:
      // closeIdle re-checks the card itself and reports closed:false rather
      // than acting, so the maker trusts that flag instead of its own
      // idleClosures() snapshot, which can be stale by the time this runs.
      if (!r.closed) continue;
      closed.push(id);
      if (!r.posted) postFailures.push({ id, error: r.error ?? 'not posted' });
    }
    if (!recovered && !decisions.length && !closed.length) return { outcome: 'nothing-to-do', result: { recovered, decisions, closed, postFailures, skipped } };
    return { outcome: 'done', result: { recovered, decisions, closed, postFailures, skipped } };
  }

  async function checker(result) {
    const items = loadItems();
    const ledger = loadLedger();
    const byId = new Map(items.map((i) => [i.id, i]));
    const t = now();
    const lookupActivity = activityTs(items);
    for (const d of result.decisions) {
      // The proof-of-life recheck runs first and independently of whatever
      // the maker's release actually did to the ledger or the card: a live
      // session released as stale is the exact silent-bug shape this checker
      // exists to catch (a different actor recomputing activityTs itself),
      // and it must be reported as that, not masked by a ledger/state check
      // that happens to fail first for an unrelated reason.
      if (d.reason === 'stale') {
        const act = Number(lookupActivity(d.id, {})) || 0;
        if (t - act <= STALE_MS) return { ok: false, reason: `${d.id} released as stale but showed activity ${Math.round((t - act) / 1000)}s ago` };
      }
      // the SAME independent recheck 'stale' gets above must
      // also cover 'reopen-unconfirmed' (D27) - a relaunched entry
      // released as unconfirmed despite fresh activity is exactly the
      // silent-release-of-a-live-session shape D27 was filed about. The
      // original ledger entry (with its own reopenedTs) is already gone by
      // checker time, so REOPEN_CONFIRM_MS against freshly recomputed
      // activity is the only signal left - the same bridge the maker itself
      // used (activityEntryFor falls back to the card's own runSession once
      // the ledger entry is gone).
      if (d.reason === 'reopen-unconfirmed') {
        const act = Number(lookupActivity(d.id, {})) || 0;
        if (t - act <= REOPEN_CONFIRM_MS) return { ok: false, reason: `${d.id} released as reopen-unconfirmed but showed activity ${Math.round((t - act) / 1000)}s ago` };
      }
      if (ledger[d.id]) return { ok: false, reason: `${d.id} still in the ledger after release` };
      const state = byId.get(d.id)?.state ?? 'missing';
      if (state !== d.to) return { ok: false, reason: `${d.id} is ${state}, expected ${d.to}` };
    }
    for (const id of result.closed) {
      const state = byId.get(id)?.state ?? 'missing';
      if (state !== 'done') return { ok: false, reason: `${id} is ${state} after the idle PASS close` };
    }
    if (result.postFailures.length) {
      // Every failed post is named, not only the first: a second silent post
      // failure hiding behind the first one is the same shape of bug D27 was
      // filed about.
      const reason = result.postFailures.map((f) => `${f.id}: ${f.error}`).join('; ');
      return { ok: false, reason };
    }
    return { ok: true, verifierRef: `park-sweep:${result.decisions.length}r:${result.closed.length}c` };
  }

  return { maker, checker };
}
