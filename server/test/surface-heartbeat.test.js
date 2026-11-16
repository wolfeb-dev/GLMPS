// Module under test: web/surface/heartbeat.js (pure; no DOM)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DIAL_TICKS, SPARK_BUCKETS, FAIL_MS, classifyEvent, providerFor, needsYou, createPulseStore } from '../../web/surface/heartbeat.js';

const NOW = 1_800_000_000_000;

test('an event is classified by what it did: commit and push are green, the rest blue', () => {
  assert.deepEqual(classifyEvent({ kind: 'git', gitOp: 'commit' }), { tone: 'ok', kind: 'commit', call: true });
  assert.deepEqual(classifyEvent({ kind: 'git', gitOp: 'push' }), { tone: 'ok', kind: 'push', call: true });
  assert.equal(classifyEvent({ kind: 'git', gitOp: 'pr' }).tone, 'info');
  assert.equal(classifyEvent({ kind: 'file-edit', add: 3, del: 1 }).tone, 'info');
  assert.equal(classifyEvent({ kind: 'command' }).call, true);
  assert.equal(classifyEvent({ kind: 'tokens' }).call, false, 'a token count is not a call');
  assert.equal(classifyEvent({ kind: 'thinking' }).call, false);
  assert.equal(classifyEvent(null).tone, 'info');
});

test('only Claude Code, Gemini and Antigravity sessions reach a provider', () => {
  assert.equal(providerFor('claude-code'), 'anthropic');
  assert.equal(providerFor('gemini-cli'), 'gcp');
  assert.equal(providerFor('antigravity'), 'gcp');
  assert.equal(providerFor('agy-cli'), 'gcp');
  assert.equal(providerFor('codex-cli'), null);
  assert.equal(providerFor(undefined), null);
});

test('the dial is 60 one-second ticks, newest first, with the strongest tone winning a tick', () => {
  const s = createPulseStore();
  s.push('a', [{ kind: 'tool', ts: NOW - 500 }, { kind: 'git', gitOp: 'commit', ts: NOW - 700 }, { kind: 'tool', ts: NOW - 5200 }], NOW);
  const t = s.ticks('a', NOW);
  assert.equal(t.length, DIAL_TICKS);
  assert.equal(t[0], 'ok', 'a commit and a tool call in the same second show the commit');
  assert.equal(t[5], 'info');
  assert.equal(t[1], null);
  s.mark('a', 'err', NOW - 2000);
  assert.equal(s.ticks('a', NOW)[2], 'err');
  assert.equal(s.ticks('a', NOW + 61_000).every((x) => x === null), true, 'after a minute the dial is empty');
});

test('an event with no usable time lands on arrival; a future time is clamped to now', () => {
  const s = createPulseStore();
  s.push('a', [{ kind: 'tool' }, { kind: 'tool', ts: NOW + 90_000 }, { kind: 'tool', ts: 'nope' }], NOW);
  assert.equal(s.ticks('a', NOW)[0], 'info');
  assert.equal(s.callsPerMinute('a', NOW), 3);
});

test('calls per minute counts calls in the last 60 s; the sparkline is 5 minutes in buckets, oldest first', () => {
  const s = createPulseStore();
  s.push('a', [{ kind: 'tool', ts: NOW - 10_000 }, { kind: 'command', ts: NOW - 20_000 }, { kind: 'tokens', ts: NOW - 5_000 }, { kind: 'tool', ts: NOW - 4 * 60_000 }], NOW);
  assert.equal(s.callsPerMinute('a', NOW), 2);
  const series = s.series('a', NOW);
  assert.equal(series.length, SPARK_BUCKETS);
  assert.equal(series.reduce((n, v) => n + v, 0), 3, 'three calls inside the five minutes');
  assert.ok(series.at(-1) >= 1, 'the newest bucket holds the recent call');
});

test('push reports what to animate: a ping per event, a turn per batch, a push flag', () => {
  const s = createPulseStore();
  const r = s.push('a', [{ kind: 'tool', ts: NOW }, { kind: 'git', gitOp: 'push', ts: NOW }], NOW);
  assert.deepEqual(r.pings, ['info', 'ok']);
  assert.equal(r.push, true);
  assert.equal(s.push('a', [{ kind: 'tool' }], NOW).push, false);
  assert.deepEqual(s.push('a', [], NOW).pings, []);
});

test('a failed gate marks the session failing for FAIL_MS, then clears', () => {
  const s = createPulseStore();
  s.mark('a', 'err', NOW);
  assert.equal(s.summary('a', NOW + FAIL_MS - 1).failing, true);
  assert.equal(s.summary('a', NOW + FAIL_MS + 1).failing, false);
  s.mark('b', 'ok', NOW);
  assert.equal(s.summary('b', NOW).failing, false);
});

test('status: waiting beats failing beats idle beats active', () => {
  const s = createPulseStore();
  const opts = { staleMs: 600_000 };
  s.push('a', [{ kind: 'tool', ts: NOW - 1000 }], NOW);
  assert.equal(s.status('a', NOW, opts), 'active');
  assert.equal(s.status('a', NOW + 700_000, opts), 'idle');
  assert.equal(s.status('a', NOW, { ...opts, lastTs: NOW - 900_000 }), 'active', 'the newer of the stream and the feed counts');
  assert.equal(s.status('x', NOW, { ...opts, lastTs: NOW - 900_000 }), 'idle');
  s.mark('a', 'err', NOW);
  assert.equal(s.status('a', NOW, opts), 'fail');
  s.setWaiting('a', { since: NOW - 5000, reason: 'held' });
  assert.equal(s.status('a', NOW, opts), 'waiting');
  assert.equal(s.summary('a', NOW).waiting.since, NOW - 5000);
  s.setWaiting('a', null);
  assert.equal(s.status('a', NOW, opts), 'fail');
});

test('summary carries the latest action, its time and the last git time', () => {
  const s = createPulseStore();
  s.push('a', [{ kind: 'tool', label: 'Edit web/a.js', ts: NOW - 4000 }, { kind: 'git', gitOp: 'commit', label: 'commit: x', ts: NOW - 3000 }, { kind: 'tool', label: 'Bash npm test', ts: NOW - 2000 }], NOW);
  const m = s.summary('a', NOW);
  assert.equal(m.lastLabel, 'Bash npm test');
  assert.equal(m.lastTs, NOW - 2000);
  assert.equal(m.lastGitTs, NOW - 3000);
  assert.equal(s.summary('nobody', NOW).lastTs, null);
});

test('a card needs you when it is held, or idle with a question as its last devlog line', () => {
  assert.equal(needsYou({ state: 'held' }), true);
  assert.equal(needsYou({ state: 'idle', devLog: [{ text: 'Should I rename it?' }] }), true);
  assert.equal(needsYou({ state: 'idle', devLog: [{ text: 'Done. Merged.' }] }), false);
  assert.equal(needsYou({ state: 'idle' }), false);
  assert.equal(needsYou({ state: 'in_progress', devLog: [{ text: 'Ready?' }] }), false);
  assert.equal(needsYou(null), false);
});

test('events are capped so a long session cannot grow the store without bound', () => {
  const s = createPulseStore();
  for (let i = 0; i < 20; i++) s.push('a', Array.from({ length: 100 }, () => ({ kind: 'tool', ts: NOW })), NOW);
  assert.ok(s.callsPerMinute('a', NOW) <= 600);
});
