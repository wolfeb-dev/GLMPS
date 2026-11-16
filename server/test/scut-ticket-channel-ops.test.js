// Tests for the pure plans behind a ticket channel's Slack side-effects
// (server/lib/scut/ticket-channel-ops.js). No network, no Slack client.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { visibilityAction, hiddenChannelName, closingSummary, ticketChannelPlan, openChannelPlan } from '../lib/scut/ticket-channel-ops.js';
import { CLOSED_STATES } from '../lib/orchestration/backlog-store.js';

const base = {
  ticketId: 'glmps-92',
  title: 'move the bobiverse naming one level higher',
  project: 'glmps',
  origin: { channel: 'C_PROJ', thread_ts: '1788045059.234869', user: 'U1' },
  operatorUserId: 'U1',
  permalink: 'https://x.slack.com/archives/C_PROJ/p1788045059234869',
};

test('the plan names the channel after the ticket', () => {
  const p = ticketChannelPlan(base);
  assert.ok(p.name.startsWith('glmps-92-'));
  assert.match(p.name, /^[a-z0-9-]{1,80}$/);
});

test('the operator is invited, and nobody else', () => {
  assert.equal(ticketChannelPlan(base).invite, 'U1');
  assert.equal(ticketChannelPlan({ ...base, operatorUserId: null }).invite, null);
});

test('the welcome carries the ticket id and a link home so the channel stands alone', () => {
  const w = ticketChannelPlan(base).welcome;
  assert.match(w, /glmps-92/);
  assert.match(w, /p1788045059234869/);
});

test('the welcome degrades gracefully when no permalink could be fetched', () => {
  const w = ticketChannelPlan({ ...base, permalink: null }).welcome;
  assert.match(w, /glmps-92/);
  assert.ok(!/undefined|null/.test(w));
});

test('the index line points the doorway at the new channel', () => {
  const p = ticketChannelPlan(base);
  assert.match(p.indexLine, /glmps-92/);
  assert.ok(p.indexLine.includes(`#${p.name}`));
});

test('a missing project is omitted rather than printed as null', () => {
  const w = ticketChannelPlan({ ...base, project: null }).welcome;
  assert.ok(!/project:/.test(w));
  assert.ok(!/undefined|null/.test(w));
});

test('visibilityAction: closed states hide, open states unhide, matching state is a no-op', () => {
  for (const state of ['done', 'cancelled', 'archived']) {
    assert.equal(visibilityAction({ state, hiddenTs: null }), 'hide', state);
    assert.equal(visibilityAction({ state, hiddenTs: 5 }), null, state);
  }
  for (const state of ['queued', 'in_progress', 'held', 'in_review', 'idle']) {
    assert.equal(visibilityAction({ state, hiddenTs: 5 }), 'unhide', state);
    assert.equal(visibilityAction({ state, hiddenTs: null }), null, state);
  }
  assert.equal(visibilityAction({ state: 'weird', hiddenTs: null }), null);
  assert.equal(visibilityAction({ state: undefined, hiddenTs: 5 }), null);
});

// Phase C final review, I1: visibilityAction must read the SAME CLOSED_STATES
// Set backlogStore exports, not a locally duplicated copy - a diverged set
// would silently stop hiding a closed ticket's channel. Proven by mutating
// the shared Set object itself (restored in `finally`): a duplicated local
// set is a different object and can never see this mutation.
test('I1: a state added only to the shared CLOSED_STATES set is hidden, proving this reads the live export', () => {
  const SYNTHETIC_CLOSED_STATE = 'synthetic-closed-for-i1-test';
  CLOSED_STATES.add(SYNTHETIC_CLOSED_STATE);
  try {
    assert.equal(visibilityAction({ state: SYNTHETIC_CLOSED_STATE, hiddenTs: null }), 'hide');
    assert.equal(visibilityAction({ state: SYNTHETIC_CLOSED_STATE, hiddenTs: 5 }), null);
  } finally {
    CLOSED_STATES.delete(SYNTHETIC_CLOSED_STATE);
  }
});

test('hiddenChannelName prefixes closed-, stays within 80 characters, and is idempotent', () => {
  assert.equal(hiddenChannelName('mc-7-fix-the-thing'), 'closed-mc-7-fix-the-thing');
  const long = `mc-7-${'a'.repeat(73)}`;
  assert.equal(long.length, 78);
  const h = hiddenChannelName(long);
  assert.ok(h.length <= 80);
  assert.ok(h.startsWith('closed-mc-7-'));
  assert.equal(hiddenChannelName(h), h);
  assert.equal(hiddenChannelName('mc-7-ab-'.padEnd(80, '-')).endsWith('-'), false);
});

test('closingSummary: gate status plus a one-line outcome, and how to reopen', () => {
  const s = closingSummary({ ticketId: 'mc-7', title: 'Fix it', gate: { status: 'PASS' }, outcome: 'Shipped the fix.\nDetails: many lines' });
  assert.equal(s, 'Closed *mc-7* - Fix it\nGate: PASS. Outcome: Shipped the fix.\nThis channel is now hidden but searchable. Reply here to reopen the ticket in its own session.');
  assert.match(closingSummary({ ticketId: 'mc-8', title: 't', gate: null, outcome: '' }), /Gate: none recorded\. Outcome: no summary recorded\./);
});

// "rejoin it" is only true when the operator has wired
// rejoin-reopens - otherwise the hint promises something that does nothing.
test('closingSummary mentions rejoining only when rejoinEnabled is true', () => {
  assert.doesNotMatch(closingSummary({ ticketId: 'mc-7', title: 't', gate: null, outcome: 'x' }), /rejoin/);
  assert.match(closingSummary({ ticketId: 'mc-7', title: 't', gate: null, outcome: 'x', rejoinEnabled: true }), /Reply here, or rejoin it, to reopen/);
});

test('the welcome text says the channel is hidden, not archived, when the card closes', () => {
  const plan = ticketChannelPlan({ ticketId: 'mc-9', title: 'x', origin: {} });
  assert.match(plan.welcome, /hidden when the card closes; a reply here reopens it/);
  assert.doesNotMatch(plan.welcome, /archived/);
});

// a ticket's title is untrusted (Slack user text, or a
// filename). Unescaped, `<!channel>` in a title pings the whole channel the
// moment the welcome or the closing summary posts it.
test('the welcome and index line escape Slack mrkdwn in an untrusted title', () => {
  const p = ticketChannelPlan({ ...base, title: 'fix <!channel> & <http://x|y> outage' });
  assert.doesNotMatch(p.welcome, /<!channel>/);
  assert.doesNotMatch(p.welcome, /<http:\/\/x\|y>/);
  assert.match(p.welcome, /&lt;!channel&gt;/);
  assert.match(p.welcome, /&amp;/);
  assert.doesNotMatch(p.indexLine, /<!channel>/);
  assert.match(p.indexLine, /&lt;!channel&gt;/);
});

test('closingSummary escapes Slack mrkdwn in an untrusted title and outcome', () => {
  const s = closingSummary({ ticketId: 'mc-7', title: 'fix <!channel> outage', gate: null, outcome: 'done & <http://x|y> fixed' });
  assert.doesNotMatch(s, /<!channel>/);
  assert.doesNotMatch(s, /<http:\/\/x\|y>/);
  assert.match(s, /&lt;!channel&gt;/);
  assert.match(s, /&amp;/);
});

// Slack's Events API delivers inbound text with its OWN
// incidental &, < and > already entity-escaped - only markup SLACK itself
// generates (mentions, links, <!channel>) arrives with literal brackets. A
// title is stored from that already-escaped text (router.js's titleFor), so
// escaping it again doubles the ampersand: "A &amp; B" -> "A &amp;amp; B".
// These use the EXACT form Slack actually delivers, not a hand-typed one.
test('the welcome does not double-escape text Slack already delivered entity-escaped', () => {
  const p1 = ticketChannelPlan({ ...base, title: 'fix A &amp; B' });
  assert.match(p1.welcome, /fix A &amp; B/);
  assert.doesNotMatch(p1.welcome, /&amp;amp;/);

  const p2 = ticketChannelPlan({ ...base, title: 'x &lt; y' });
  assert.match(p2.welcome, /x &lt; y/);
  assert.doesNotMatch(p2.welcome, /&amp;lt;/);

  // A user who typed the literal characters "<!channel>" (not the real
  // special-mention markup) has that arrive from Slack ALREADY escaped -
  // it must stay inert (never decode back to a live channel-wide mention)
  // and must not be escaped a second time either.
  const p3 = ticketChannelPlan({ ...base, title: '&lt;!channel&gt;' });
  assert.match(p3.welcome, /&lt;!channel&gt;/);
  assert.doesNotMatch(p3.welcome, /&amp;lt;/);
  assert.doesNotMatch(p3.welcome, /<!channel>/); // never decodes back to a live mention
});

// decoding &amp; before &lt;/&gt; let a decoded
// &amp; manufacture a fresh &lt;/&gt; substring that a later step then
// over-decoded, turning a user's literally-typed "&lt;" into a bare "<".
// Slack only ever escapes the ampersand IT did not put there, so a typed
// "&lt;" arrives here as "&amp;lt;" - it must survive as "&amp;lt;" (which
// Slack renders back to the user's own literal "&lt;"), not collapse to
// "&lt;" (which Slack would render as a bare "<" the user never typed).
test('the welcome preserves a typed literal &lt; instead of over-decoding it to a bare <', () => {
  const p = ticketChannelPlan({ ...base, title: 'x &amp;lt; y' });
  assert.match(p.welcome, /x &amp;lt; y/);
  assert.doesNotMatch(p.welcome, /x < y/);
});

test('closingSummary does not double-escape text Slack already delivered entity-escaped', () => {
  const s1 = closingSummary({ ticketId: 'mc-7', title: 'fix A &amp; B', gate: null, outcome: 'x' });
  assert.match(s1, /fix A &amp; B/);
  assert.doesNotMatch(s1, /&amp;amp;/);

  const s2 = closingSummary({ ticketId: 'mc-7', title: 't', gate: null, outcome: 'done &amp; &lt;http://x|y&gt; fixed' });
  assert.match(s2, /done &amp; &lt;http:\/\/x\|y&gt; fixed/);
  assert.doesNotMatch(s2, /&amp;amp;|&amp;lt;|&amp;gt;/);
});

// glmps-2-0-runtime-11: POST /api/backlog/<id>/channel decides here, then acts.
const visible = { channelId: 'C9', name: 'glmps-2-0-88-thing', ticketId: 'glmps-2-0-88', hiddenTs: null, archivedTs: null };
const hidden = { ...visible, name: 'closed-glmps-2-0-88-thing', hiddenTs: 1700000000000 };

test('open-channel: a card with no channel gets one created', () => {
  assert.deepEqual(openChannelPlan({ item: { state: 'queued' }, entry: null }), { action: 'create' });
  assert.deepEqual(openChannelPlan({ item: { state: 'done' }, entry: null, reopen: true }), { action: 'create' });
});

test('open-channel: an existing visible channel is returned and nothing else happens', () => {
  assert.deepEqual(openChannelPlan({ item: { state: 'queued' }, entry: visible }), { action: 'existing' });
  assert.deepEqual(openChannelPlan({ item: { state: 'queued' }, entry: visible, reopen: true }), { action: 'existing' });
});

test('open-channel: a hidden channel stays hidden unless reopen is asked for', () => {
  assert.deepEqual(openChannelPlan({ item: { state: 'done' }, entry: hidden }), { action: 'existing' });
  assert.deepEqual(openChannelPlan({ item: { state: 'held' }, entry: hidden, reopen: true }), { action: 'unhide' });
  // A legacy archived channel counts as hidden too, but Slack cannot unhide it.
  const legacy = { ...visible, archivedTs: 1 };
  assert.deepEqual(openChannelPlan({ item: { state: 'held' }, entry: legacy }), { action: 'existing' });
  assert.equal(openChannelPlan({ item: { state: 'held' }, entry: legacy, reopen: true }).action, 'refuse');
});

test('open-channel: reopen on a closed card is refused, since the close reconciler would hide it again', () => {
  for (const state of CLOSED_STATES) {
    const p = openChannelPlan({ item: { state }, entry: hidden, reopen: true });
    assert.equal(p.action, 'refuse');
    assert.match(p.reason, new RegExp(state));
  }
});

test('open-channel: reopen on a card in a state with no channel rule is refused rather than silently ignored', () => {
  const p = openChannelPlan({ item: { state: 'backlog' }, entry: hidden, reopen: true });
  assert.equal(p.action, 'refuse');
});

test('glmps-2-0-104: closingSummary prefers the gate summary, shows risk and a bare https PR link', () => {
  const s = closingSummary({
    ticketId: 'mc-7', title: 'Fix it', outcome: 'Released, signing off.',
    gate: { status: 'PASS', risk: 'P2', summary: 'Shipped the fix.\nOne flaky test left <!channel>.' },
    prUrl: 'https://github.com/o/r/pull/9',
  });
  assert.match(s, /Gate: PASS \(risk P2\)\. Outcome: Shipped the fix\. One flaky test left &lt;!channel&gt;\./);
  assert.doesNotMatch(s, /signing off/);
  assert.match(s, /\nPR: https:\/\/github\.com\/o\/r\/pull\/9\n/);
  assert.doesNotMatch(closingSummary({ ticketId: 'mc-7', title: 't', gate: null, outcome: 'x', prUrl: 'https://x|<!here>' }), /PR:/);
  assert.doesNotMatch(closingSummary({ ticketId: 'mc-7', title: 't', gate: null, outcome: 'x', prUrl: 'javascript:alert(1)' }), /PR:/);
});

test('glmps-2-0-104: closingSummary for the main channel points at the hidden channel', () => {
  const s = closingSummary({ ticketId: 'mc-7', title: 't', gate: { status: 'PASS' }, outcome: 'x', channelId: 'C1' });
  assert.match(s, /Its channel <#C1> is now hidden but searchable; reply there to reopen/);
  assert.doesNotMatch(s, /This channel/);
});

test('glmps-2-0-185: closingSummary shows how many checks the gate recorded', () => {
  const s = closingSummary({ ticketId: 'mc-7', title: 'Fix it', gate: { status: 'PASS', risk: 'P2', evidence: ['AC-1 ok', 'tests 12 pass', ' '] }, outcome: 'x' });
  assert.match(s, /Gate: PASS \(risk P2\), 2 checks recorded\./);
  const one = closingSummary({ ticketId: 'mc-7', title: 'Fix it', gate: { status: 'PASS', evidence: ['AC-1 ok'] }, outcome: 'x' });
  assert.match(one, /Gate: PASS, 1 check recorded\./);
  const none = closingSummary({ ticketId: 'mc-7', title: 'Fix it', gate: { status: 'PASS' }, outcome: 'x' });
  assert.match(none, /Gate: PASS\. /);
});
