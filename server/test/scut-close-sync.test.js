// Tests for the close reconciler's plan (server/lib/scut/close-sync.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planCloseSync, closedAtMs, planSessionGuard, ACTIVE_WINDOW_MS, SESSION_GRACE_MS, SUMMARY_WINDOW_MS, MAX_HIDES_PER_RUN, PROMOTED_NOTE } from '../lib/scut/close-sync.js';

const NOW = Date.parse('2026-10-24T23:30:00Z');
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();
const card = (id, state, msAgo, field = 'doneAt') => ({ id, state, [field]: msAgo == null ? null : iso(msAgo) });
const chan = (ticketId, extra = {}) => ({ channelId: `C_${ticketId}`, name: ticketId, ticketId, hiddenTs: null, archivedTs: null, ...extra });

test('a closed card with a visible channel is hidden; open and idle cards are left alone', () => {
  const items = [card('a', 'done', 60_000), card('b', 'in_progress', null), card('c', 'idle', 60_000, 'stateEnteredAt'), card('d', 'cancelled', 60_000, 'stateEnteredAt')];
  const r = planCloseSync({ items, channels: items.map((i) => chan(i.id)), now: NOW });
  assert.deepEqual(r.hides.map((h) => h.ticketId).sort(), ['a', 'd']);
});

test('an already hidden or legacy archived channel is not hidden again', () => {
  const items = [card('a', 'done', 1000), card('b', 'archived', 1000, 'stateEnteredAt')];
  const r = planCloseSync({ items, channels: [chan('a', { hiddenTs: 1 }), chan('b', { archivedTs: 1 })], now: NOW });
  assert.deepEqual(r.hides, []);
});

test('only a card closed within the summary window gets the closing post', () => {
  const items = [card('fresh', 'done', 60_000), card('old', 'archived', SUMMARY_WINDOW_MS + 1, 'stateEnteredAt')];
  const r = planCloseSync({ items, channels: items.map((i) => chan(i.id)), now: NOW });
  assert.deepEqual(r.hides, [{ ticketId: 'fresh', summary: true }, { ticketId: 'old', summary: false }]);
});

test('hides are capped per run, newest close first, and the rest are counted', () => {
  const items = Array.from({ length: MAX_HIDES_PER_RUN + 3 }, (_, n) => card(`c${n}`, 'archived', (n + 1) * 3_600_000 * 30, 'stateEnteredAt'));
  items.push(card('just-closed', 'done', 1000));
  const r = planCloseSync({ items, channels: items.map((i) => chan(i.id)), now: NOW });
  assert.equal(r.hides.length, MAX_HIDES_PER_RUN);
  assert.equal(r.hides[0].ticketId, 'just-closed');
  assert.equal(r.pendingHides, 4);
});

test('a held park poll is ended only for a closed card', () => {
  const items = [card('a', 'done', 1000), card('b', 'in_progress', null)];
  assert.deepEqual(planCloseSync({ items, channels: [], parked: new Set(['a', 'b', 'gone']), now: NOW }).parks, ['a']);
});

const withRun = (c) => ({ ...c, runSession: { sessionId: `S-${c.id}` } });
const sess = (pid, ticketId, sessionId = `s-${ticketId}`) => ({ pid, ticketId, sessionId });
// Every session quiet long enough unless a test says otherwise.
const quiet = (sessions) => new Map(sessions.filter((s) => s.sessionId).map((s) => [String(s.sessionId).toLowerCase(), NOW - SESSION_GRACE_MS]));

test('a session is closed only once its card has been closed for the grace period', () => {
  const items = [card('old', 'done', SESSION_GRACE_MS), card('new', 'done', SESSION_GRACE_MS - 1), card('open', 'in_progress', null), card('nodate', 'archived', null)].map(withRun);
  const sessions = [sess(1, 'old'), sess(2, 'new'), sess(3, 'open'), sess(4, 'nodate'), sess(5, 'unknown')];
  assert.deepEqual(planCloseSync({ items, channels: [], sessions, activity: quiet(sessions), now: NOW }).sessions, [{ ticketId: 'old', pid: 1, rootPid: 1 }]);
});

test('a session whose id the card never recorded is left alone (GLMPS 1.0 shares the runner folder)', () => {
  const items = [withRun(card('a', 'done', SESSION_GRACE_MS)), { ...card('b', 'done', SESSION_GRACE_MS), sessionId: 'LEGACY' }, card('c', 'done', SESSION_GRACE_MS)];
  const sessions = [sess(1, 'a', 'other'), sess(2, 'a', null), sess(3, 'b', 'legacy'), sess(4, 'c', 'anything'), { pid: 5, ticketId: 'a', sessionId: 's-a', rootPid: 9 }];
  assert.deepEqual(planCloseSync({ items, channels: [], sessions, activity: quiet(sessions), now: NOW }).sessions, [{ ticketId: 'b', pid: 3, rootPid: 3 }, { ticketId: 'a', pid: 5, rootPid: 9 }]);
});

test('a session still writing its transcript, or with no transcript found, is left alone', () => {
  const items = [withRun(card('busy', 'done', 60 * 60_000)), withRun(card('unseen', 'done', 60 * 60_000)), withRun(card('idle', 'done', 60 * 60_000))];
  const sessions = [sess(1, 'busy', 'S-busy'), sess(2, 'unseen', 'S-unseen'), sess(3, 'idle', 'S-idle')];
  const activity = new Map([['s-busy', NOW - SESSION_GRACE_MS + 1], ['s-idle', NOW - SESSION_GRACE_MS]]);
  assert.deepEqual(planCloseSync({ items, channels: [], sessions, activity, now: NOW }).sessions, [{ ticketId: 'idle', pid: 3, rootPid: 3 }]);
});

// Card glmps-2-0-runtime-89: on 2026-10-28 card 118's session was closed while
// it was still building the two cards it had filed (87, 88).
test('a session is kept while a card filed under its card is in progress or in review', () => {
  const items = [
    withRun(card('p1', 'done', 60 * 60_000)), { ...card('c1', 'in_progress', null), parentId: 'p1' },
    withRun(card('p2', 'done', 60 * 60_000)), { ...card('c2', 'in_review', null), parentId: 'p2' },
    withRun(card('p3', 'done', 60 * 60_000)), { ...card('c3', 'held', null), parentId: 'p3' }, { ...card('c3b', 'done', 60_000), parentId: 'p3' },
  ];
  const sessions = [sess(1, 'p1'), sess(2, 'p2'), sess(3, 'p3')];
  const plan = planCloseSync({ items, channels: [], sessions, activity: quiet(sessions), now: NOW });
  assert.deepEqual(plan.sessions, [{ ticketId: 'p3', pid: 3, rootPid: 3 }], 'only the card whose children are held or done is closed');
  assert.deepEqual(plan.keptForChildren, ['p1', 'p2']);
});

// glmps-2-0-163 AC-2: a child whose host is closed is promoted, not only logged.
test('an open child whose host is closed and that nobody is on is promoted once; one being worked is requeued', () => {
  const items = [
    withRun(card('p', 'done', 60 * 60_000)),
    { ...card('lost', 'in_progress', null), parentId: 'p' },
    { ...card('held', 'held', null), parentId: 'p' },
    { ...card('idle', 'idle', null), parentId: 'p' },
    { ...card('queued', 'queued', null), parentId: 'p' },
    { ...card('told', 'in_progress', null), parentId: 'p', devLog: [{ by: 'runner', text: `${PROMOTED_NOTE} earlier` }] },
    { ...card('already', 'held', null), parentId: 'p', promoted: { from: 'p', at: iso(1) } },
    { ...card('finished', 'done', 5), parentId: 'p' },
    { ...card('worked', 'in_progress', null), parentId: 'p' },
    { ...card('headless', 'in_progress', null), parentId: 'p' },
    { ...card('pinned', 'held', null), parentId: 'p', mode: 'headless' },
    { ...card('openparent', 'in_progress', null), parentId: 'q' }, card('q', 'held', null),
  ];
  const plan = planCloseSync({ items, channels: [], sessions: [sess(1, 'worked')], running: ['headless'], now: NOW });
  assert.deepEqual(plan.promotions, [
    { id: 'lost', host: 'p', requeue: true },
    { id: 'held', host: 'p', requeue: false },
    { id: 'idle', host: 'p', requeue: false },
    { id: 'queued', host: 'p', requeue: false },
  ]);
  assert.deepEqual(planCloseSync({ items, channels: [], sessions: [sess(2, 'p')], now: NOW }).promotions, [], 'a live session on the host still owns its children');
});

test('closedAtMs falls back from doneAt to stateEnteredAt to updatedAt', () => {
  assert.equal(closedAtMs({ doneAt: iso(5), stateEnteredAt: iso(9) }), NOW - 5);
  assert.equal(closedAtMs({ doneAt: null, stateEnteredAt: iso(9) }), NOW - 9);
  assert.equal(closedAtMs({ updatedAt: iso(7) }), NOW - 7);
  assert.equal(closedAtMs({}), null);
});

test('session guard: no live session launches; an active one is adopted; an idle one is replaced', () => {
  const card = { id: 'c', state: 'queued', runSession: { sessionId: 'S-1' } };
  const live = { pid: 7, rootPid: 6, ticketId: 'c', sessionId: 's-1' };
  assert.deepEqual(planSessionGuard({ card, sessions: [], now: NOW }), { action: 'launch' });
  assert.deepEqual(planSessionGuard({ card, sessions: [{ ...live, sessionId: 'other' }, { ...live, ticketId: 'd' }], now: NOW }), { action: 'launch' }, 'only the card\'s recorded session counts');
  const active = planSessionGuard({ card, sessions: [live], activity: new Map([['s-1', NOW - ACTIVE_WINDOW_MS]]), now: NOW });
  assert.deepEqual(active, { action: 'adopt', session: live, extra: [] });
  assert.equal(planSessionGuard({ card, sessions: [live], now: NOW }).action, 'adopt', 'an unknown last write counts as active');
  const idle = planSessionGuard({ card, sessions: [live, { ...live, pid: 9, rootPid: 9 }], activity: new Map([['s-1', NOW - ACTIVE_WINDOW_MS - 1]]), now: NOW });
  assert.deepEqual(idle, { action: 'replace', sessions: [live, { ...live, pid: 9, rootPid: 9 }] });
});

test('session guard: a second live copy is reported as extra, never adopted twice', () => {
  const card = { id: 'c', sessionId: 'S-1' };
  const a = { pid: 7, rootPid: 6, ticketId: 'c', sessionId: 's-1' };
  const b = { pid: 8, ticketId: 'c', sessionId: 's-1' };
  assert.deepEqual(planSessionGuard({ card, sessions: [a, b], now: NOW }), { action: 'adopt', session: a, extra: [{ ...b, rootPid: 8 }] });
});

// Card glmps-2-0-109: Claude Code's own registry status outranks the
// transcript clock, and names windows the process list cannot tie to the card.
test('session guard: a window Claude reports idle is replaced even when it wrote a minute ago', () => {
  const card = { id: 'c', runSession: { sessionId: 'S-1' } };
  const live = { pid: 7, rootPid: 6, ticketId: 'c', sessionId: 's-1' };
  const windows = new Map([['S-1', { pid: 7, status: 'idle' }]]);
  const plan = planSessionGuard({ card, sessions: [live], activity: new Map([['s-1', NOW - 60_000]]), windows, now: NOW });
  assert.deepEqual(plan, { action: 'replace', sessions: [live] });
});

test('session guard: a window Claude reports busy is adopted, never closed, even when its transcript is old', () => {
  const card = { id: 'c', runSession: { sessionId: 'S-1' } };
  const live = { pid: 7, rootPid: 6, ticketId: 'c', sessionId: 's-1' };
  const windows = new Map([['s-1', { pid: 7, status: 'busy' }]]);
  const plan = planSessionGuard({ card, sessions: [live], activity: new Map([['s-1', NOW - ACTIVE_WINDOW_MS - 1]]), windows, now: NOW });
  assert.deepEqual(plan, { action: 'adopt', session: live, extra: [] });
});

test('session guard: a registry window for the card the process list missed is a candidate, ended by its own pid', () => {
  const card = { id: 'c', runSession: { sessionId: 'S-1' } };
  const windows = new Map([['s-1', { pid: 41012, status: 'idle' }], ['s-other', { pid: 5, status: 'idle' }]]);
  assert.deepEqual(planSessionGuard({ card, sessions: [], windows, now: NOW }), { action: 'replace', sessions: [{ ticketId: 'c', sessionId: 's-1', pid: 41012, rootPid: 41012 }] });
  const listed = { pid: 7, rootPid: 6, ticketId: 'c', sessionId: 's-1' };
  assert.deepEqual(planSessionGuard({ card, sessions: [listed], windows, now: NOW }).sessions, [listed], 'a listed session is not added twice');
});

test('session guard: no registry status falls back to the transcript clock', () => {
  const card = { id: 'c', runSession: { sessionId: 'S-1' } };
  const live = { pid: 7, rootPid: 6, ticketId: 'c', sessionId: 's-1' };
  const windows = new Map([['s-1', { pid: 7, status: null }]]);
  assert.equal(planSessionGuard({ card, sessions: [live], activity: new Map([['s-1', NOW - 60_000]]), windows, now: NOW }).action, 'adopt');
});
