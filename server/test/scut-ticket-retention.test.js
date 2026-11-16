import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retainedJobIds, RETAIN_MS } from '../lib/scut/ticket-retention.js';
import { CLOSED_STATES } from '../lib/orchestration/backlog-store.js';

const DAY = 86_400_000;
const NOW = 100 * DAY;
const wt = { dir: 'W', branch: 'b', repo: 'R' };

test('idle cards and cards hidden under 30 days keep their worktree; nothing else does', () => {
  const items = [
    // idle is now bounded by its OWN stateEnteredAt
    // too (was unbounded) - 5 days idle is well inside RETAIN_MS.
    { id: 'a', state: 'idle', stateEnteredAt: NOW - 5 * DAY, runSession: { worktree: wt } },
    { id: 'b', state: 'done', runSession: { worktree: wt } },
    { id: 'c', state: 'done', runSession: { worktree: wt } },
    { id: 'd', state: 'done', runSession: { worktree: wt } },
    { id: 'e', state: 'idle', stateEnteredAt: NOW - 5 * DAY, runSession: { worktree: null } },
    { id: 'f', state: 'idle', stateEnteredAt: NOW - 5 * DAY, runSession: { worktree: wt, purgedTs: 5 } },
    { id: 'g', state: 'in_progress', runSession: { worktree: wt } },
  ];
  const hidden = { b: NOW - 29 * DAY, c: NOW - 31 * DAY };
  const kept = retainedJobIds({ items, hiddenTsOf: (id) => hidden[id] ?? null, now: NOW });
  assert.deepEqual([...kept].sort(), ['a', 'b']);
  assert.equal(RETAIN_MS, 30 * DAY);
});

// an idle card is
// retained for RETAIN_MS from its OWN stateEnteredAt (idleSince), not
// forever. A card with no entry stamp at all (stateEnteredAt missing, e.g. a
// legacy record) is not retained by this rule - unreadable data must never
// read as "safe to keep forever".
test('I3: an idle card is retained for RETAIN_MS from stateEnteredAt, not forever', () => {
  const items = [
    { id: 'a29', state: 'idle', stateEnteredAt: NOW - 29 * DAY, runSession: { worktree: wt } },
    { id: 'a30', state: 'idle', stateEnteredAt: NOW - 30 * DAY, runSession: { worktree: wt } },
    { id: 'a31', state: 'idle', stateEnteredAt: NOW - 31 * DAY, runSession: { worktree: wt } },
    { id: 'aNone', state: 'idle', runSession: { worktree: wt } },
  ];
  const kept = retainedJobIds({ items, now: NOW });
  assert.deepEqual([...kept].sort(), ['a29']);
});

// retention races the async Slack hide - a tick can
// run before hiddenTs lands (or after a hide attempt that never lands one at
// all). For a closed card that DOES have a bound ticket channel, the
// reference time falls back to the card's own stateEnteredAt (the Task 7
// entry stamp), so the worktree is not reclaimed out from under a hide
// still in flight.
test('I1: a closed card with a bound channel but no hiddenTs yet is retained from stateEnteredAt', () => {
  const items = [{ id: 'x', state: 'done', stateEnteredAt: NOW - 2 * DAY, runSession: { worktree: wt } }];
  const kept = retainedJobIds({
    items,
    hiddenTsOf: () => null, // channel bound, rename not confirmed / not yet run
    channelBoundOf: () => true,
    now: NOW,
  });
  assert.deepEqual([...kept], ['x']);
});

// Minor (fold): a closed card with NO ticket channel at all is not "a hide
// still in flight" - nothing will ever set its hiddenTs, so the
// stateEnteredAt fallback must not apply to it, even though its entry stamp
// is recent. Distinguishes "missing hiddenTs because racing" from "missing
// hiddenTs because there is no channel to hide at all".
test('a closed card with no ticket channel at all is never retained by the hidden-race fallback', () => {
  const items = [{ id: 'y', state: 'done', stateEnteredAt: NOW - 2 * DAY, runSession: { worktree: wt } }];
  const kept = retainedJobIds({
    items,
    hiddenTsOf: () => null,
    channelBoundOf: () => false,
    now: NOW,
  });
  assert.deepEqual([...kept], []);
});

// Minor (fold): the 30-day boundary is exclusive for both reference times -
// exactly 30 days elapsed is no longer retained (pins the existing `<`
// comparison rather than leaving it implicit).
test('the 30-day boundary is exclusive: exactly 30 days elapsed is no longer retained', () => {
  const items = [
    { id: 'idle30', state: 'idle', stateEnteredAt: NOW - 30 * DAY, runSession: { worktree: wt } },
    { id: 'hidden30', state: 'done', runSession: { worktree: wt } },
  ];
  const kept = retainedJobIds({
    items,
    hiddenTsOf: (id) => (id === 'hidden30' ? NOW - 30 * DAY : null),
    now: NOW,
  });
  assert.deepEqual([...kept], []);
});

// Minor (fold): a reference time in the future (clock skew, a bad write) is
// clamped to `now` - treated as "just entered", not as a negative elapsed
// time that happens to still compute retained, and never a crash either way.
test('a hiddenTs or stateEnteredAt in the future is clamped to now, not treated as already expired', () => {
  const items = [
    { id: 'futureHidden', state: 'done', runSession: { worktree: wt } },
    { id: 'futureIdle', state: 'idle', stateEnteredAt: NOW + 5 * DAY, runSession: { worktree: wt } },
  ];
  const kept = retainedJobIds({
    items,
    hiddenTsOf: (id) => (id === 'futureHidden' ? NOW + 5 * DAY : null),
    now: NOW,
  });
  assert.deepEqual([...kept].sort(), ['futureHidden', 'futureIdle']);
});

// a legacy idle card whose stateEnteredAt was never
// backfilled (round 3 ruling in backlog-store.js added stateEnteredAt to
// EVERY reopenable state uniformly - a card idled before that still only
// ever got idleSince) falls back to idleSince, not straight to "not
// retained". A card missing BOTH is still not retained.
test('the idle branch falls back to idleSince when stateEnteredAt is missing (legacy idle cards)', () => {
  const items = [
    { id: 'legacy', state: 'idle', idleSince: NOW - 5 * DAY, runSession: { worktree: wt } },
    { id: 'legacyExpired', state: 'idle', idleSince: NOW - 31 * DAY, runSession: { worktree: wt } },
    { id: 'neitherStamp', state: 'idle', runSession: { worktree: wt } },
  ];
  const kept = retainedJobIds({ items, now: NOW });
  assert.deepEqual([...kept], ['legacy']);
});

// Minor (fold): stateEnteredAt round-trips through backlog-store.js's own
// ISO-string format too, not just a raw epoch number (park.js's
// ticketActivityMs normalises a session's lastTs the same way).
test('stateEnteredAt as an ISO string (backlog-store.js\'s real format) is honored', () => {
  const items = [{ id: 'iso', state: 'idle', stateEnteredAt: new Date(NOW - DAY).toISOString(), runSession: { worktree: wt } }];
  const kept = retainedJobIds({ items, now: NOW });
  assert.deepEqual([...kept], ['iso']);
});

// Phase C final review, I1: retainedJobIds must read the SAME CLOSED_STATES
// Set backlogStore exports, not a locally duplicated copy - a diverged set
// would silently stop retaining (and the live hide path would stop hiding)
// a closed ticket's worktree. Proven by mutating the shared Set object
// itself (restored in `finally`): a duplicated local set is a different
// object and can never see this mutation, so this only passes when the
// wiring reads the live export.
test('I1: a state added only to the shared CLOSED_STATES set is retained, proving this reads the live export', () => {
  const SYNTHETIC_CLOSED_STATE = 'synthetic-closed-for-i1-test';
  CLOSED_STATES.add(SYNTHETIC_CLOSED_STATE);
  try {
    const items = [{ id: 'z', state: SYNTHETIC_CLOSED_STATE, runSession: { worktree: wt } }];
    const kept = retainedJobIds({ items, hiddenTsOf: () => NOW - 2 * DAY, now: NOW });
    assert.deepEqual([...kept], ['z']);
  } finally {
    CLOSED_STATES.delete(SYNTHETIC_CLOSED_STATE);
  }
});
