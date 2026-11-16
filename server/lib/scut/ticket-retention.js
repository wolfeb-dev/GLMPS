// server/lib/scut/ticket-retention.js
// D27: a closed ticket keeps its worktree while the card is idle or its
// channel is hidden, so a reply can resume the session in place. After 30
// days (3 once its worktree outcome is recorded) the checkout becomes
// reclaimable again by the sweep, which records the outcome and refuses a
// dirty or unpushed tree.
import { CLOSED_STATES } from '../orchestration/backlog-store.js';

export const RETAIN_MS = 30 * 86_400_000;
// Once the worktree outcome record is on the card, reopen-by-reply can recreate
// the checkout from the recorded branch, so it need not be kept for the full lease.
export const RECORDED_RETAIN_MS = 3 * 86_400_000;

// A reference time accepts either a numeric epoch-ms value or an ISO string
// (backlog-store.js's own stateEnteredAt/idleSince format), normalised the
// same way park.js's ticketActivityMs normalises a session's lastTs. A
// reference in the future (clock skew, a bad write) is clamped to `now` -
// "just entered", never a negative elapsed time nobody asked for. Unreadable
// or absent counts as "no reference" - never "safe to keep forever".
function withinRetain(ref, now, retainMs) {
  const r = typeof ref === 'number' ? ref : (typeof ref === 'string' ? Date.parse(ref) : NaN);
  return Number.isFinite(r) && now - Math.min(r, now) < retainMs;
}

/**
 * @param opts.hiddenTsOf - when a ticket's channel was hidden, or null if it
 *   has a channel that is not hidden yet (racing the async hide, or a hide
 *   that never landed one). Fix round 1, I1: NOT the same as "no channel at
 *   all" - see channelBoundOf.
 * @param opts.channelBoundOf - does this ticket have a ticket channel bound
 *   at all? Only a bound channel can ever get a hiddenTs, so only a bound
 *   channel's missing hiddenTs falls back to the card's own stateEnteredAt
 *   below; a card with no channel is simply not on this plan, not "a hide
 *   still in flight".
 * @param opts.items[].stateEnteredAt - when the card entered its CURRENT
 *   state (backlog-store.js's own field, covers idle/done/cancelled/
 *   archived uniformly - the Task 7 entry stamp). Fix round 1: idle's own
 *   retention reference, and a
 *   closed-but-not-yet-hidden card's fallback, so a tick landing
 *   before the async hide, or a hide that never sets hiddenTs at all, does
 *   not reclaim a worktree the operator has not even seen close yet.
 */
export function retainedJobIds({
  items = [], hiddenTsOf = () => null, channelBoundOf = () => false, now, retainMs = RETAIN_MS, recordedRetainMs = RECORDED_RETAIN_MS,
} = {}) {
  const out = new Set();
  for (const i of items) {
    const rs = i?.runSession;
    if (!rs?.worktree?.dir || rs.purgedTs) continue;
    const keepMs = rs.outcome ? Math.min(retainMs, recordedRetainMs) : retainMs;
    if (i.state === 'idle') {
      // stateEnteredAt covers every REOPENABLE_STATES
      // member uniformly, but only since that ruling landed - a card idled
      // before it still only ever got idleSince. Falls back to it rather
      // than reading as "no reference, not retained".
      if (withinRetain(i.stateEnteredAt ?? i.idleSince, now, keepMs)) out.add(i.id);
      continue;
    }
    if (!CLOSED_STATES.has(i.state)) continue;
    const h = hiddenTsOf(i.id);
    if (typeof h === 'number') {
      if (withinRetain(h, now, keepMs)) out.add(i.id);
      continue;
    }
    // Not hidden yet. A card with no ticket channel at all will never get a
    // hiddenTs - it is not racing anything, so the entry-stamp fallback does
    // not apply to it.
    if (!channelBoundOf(i.id)) continue;
    if (withinRetain(i.stateEnteredAt, now, keepMs)) out.add(i.id);
  }
  return out;
}
