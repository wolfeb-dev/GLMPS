// Tests for the SCUT relay text splitter + post queue (server/lib/scut/relay.js).
//
// Why this module exists: the facade that relays an agent's /devlog and /gate
// posts into its Slack thread used to do `body.slice(0, 1500)` - a silent
// mid-word cut that lost most of a long reply (8 of harbor-app-7's 10 agent
// devlogs were over that cap, the longest 6213 chars). Slack accepts 40,000
// characters, so the loss was entirely self-inflicted. The splitter turns a
// long body into ordered chunks; the queue keeps them in order.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitRelayText, createRelayQueue, RELAY_CHUNK_LIMIT, RELAY_MAX_CHUNKS } from '../lib/scut/relay.js';

// Everything the splitter emits, with any (i/n) marker removed, so a test can
// assert that no CHARACTER of the original was lost - the actual complaint.
function rejoin(chunks) {
  return chunks.map((c) => c.replace(/^\(\d+\/\d+\)\s/, '')).join('\n');
}

test('short text passes through untouched as a single chunk', () => {
  assert.deepEqual(splitRelayText('hello'), ['hello']);
  const exact = 'x'.repeat(RELAY_CHUNK_LIMIT);
  assert.deepEqual(splitRelayText(exact), [exact]);
});

test('empty / non-string input yields no chunks at all', () => {
  assert.deepEqual(splitRelayText(''), []);
  assert.deepEqual(splitRelayText('   \n '), []);
  assert.deepEqual(splitRelayText(null), []);
  assert.deepEqual(splitRelayText(undefined), []);
  assert.deepEqual(splitRelayText(42), []);
});

test('a long body is split into ordered chunks that keep every character', () => {
  const para = 'The agent narrates what it just did in a full paragraph. ';
  const body = Array.from({ length: 40 }, (_, i) => `${i}: ${para.repeat(3)}`).join('\n\n');
  assert.ok(body.length > RELAY_CHUNK_LIMIT, 'fixture must actually overflow');

  const chunks = splitRelayText(body);
  assert.ok(chunks.length > 1, 'it splits');
  for (const c of chunks) assert.ok(c.length <= RELAY_CHUNK_LIMIT, `chunk within limit: ${c.length}`);
  // Numbered so the reader can see nothing is missing.
  chunks.forEach((c, i) => assert.ok(c.startsWith(`(${i + 1}/${chunks.length}) `), `chunk ${i} is numbered`));
  // Nothing dropped: every word of the original survives, in order.
  const joined = rejoin(chunks).replace(/\s+/g, ' ').trim();
  assert.equal(joined, body.replace(/\s+/g, ' ').trim());
});

test('splits on a paragraph break when one is available in the window', () => {
  const a = 'A'.repeat(RELAY_CHUNK_LIMIT - 200);
  const body = `${a}\n\n${'B'.repeat(500)}`;
  const chunks = splitRelayText(body);
  assert.equal(chunks.length, 2);
  assert.ok(chunks[0].endsWith(a), 'first chunk ends at the paragraph break, not mid-run');
  assert.ok(chunks[1].endsWith('B'.repeat(500)));
});

test('never cuts mid-word when a space is available', () => {
  const word = 'sentence ';
  const body = word.repeat(Math.ceil((RELAY_CHUNK_LIMIT * 2) / word.length));
  const chunks = splitRelayText(body);
  assert.ok(chunks.length >= 2);
  for (const c of chunks) {
    const text = c.replace(/^\(\d+\/\d+\)\s/, '');
    assert.ok(/^sentence/.test(text), 'a chunk starts on a word boundary');
    assert.ok(/sentence$/.test(text.trim()), 'and ends on one');
  }
});

test('a single unbroken run longer than the window is hard-cut rather than dropped', () => {
  const body = 'z'.repeat(RELAY_CHUNK_LIMIT * 2 + 100);
  const chunks = splitRelayText(body);
  assert.ok(chunks.length >= 3);
  const zs = chunks.map((c) => c.replace(/^\(\d+\/\d+\)\s/, '')).join('').length;
  assert.equal(zs, body.length, 'every character still relayed');
});

test('past the chunk budget it says how much is missing instead of cutting silently', () => {
  const body = 'y'.repeat(RELAY_CHUNK_LIMIT * (RELAY_MAX_CHUNKS + 3));
  const chunks = splitRelayText(body);
  assert.equal(chunks.length, RELAY_MAX_CHUNKS, 'bounded');
  assert.match(chunks.at(-1), /\[\.\.\. \d+ more characters/, 'the loss is stated, not silent');
});

test('a custom limit and budget are honored', () => {
  const chunks = splitRelayText('a'.repeat(500), { limit: 100, maxChunks: 2 });
  assert.equal(chunks.length, 2);
  for (const c of chunks) assert.ok(c.length <= 100);
});


test('queue: work for one key runs strictly in order, even when the first is slower', async () => {
  const q = createRelayQueue();
  const order = [];
  const slow = () => new Promise((r) => setTimeout(r, 20)).then(() => { order.push('first'); });
  q.run('room-1', slow);
  q.run('room-1', async () => { order.push('second'); });
  await q.drain('room-1');
  assert.deepEqual(order, ['first', 'second']);
});

test('queue: a throwing job never breaks the ones behind it, and is reported', async () => {
  const errors = [];
  const q = createRelayQueue({ onError: (e) => errors.push(e?.message ?? String(e)) });
  const order = [];
  q.run('room-1', async () => { throw new Error('slack said no'); });
  q.run('room-1', async () => { order.push('after'); });
  await q.drain('room-1');
  assert.deepEqual(order, ['after']);
  assert.deepEqual(errors, ['slack said no']);
});

test('queue: different keys do not block each other and the map does not grow forever', async () => {
  const q = createRelayQueue();
  const done = [];
  q.run('a', async () => { done.push('a'); });
  q.run('b', async () => { done.push('b'); });
  await Promise.all([q.drain('a'), q.drain('b')]);
  assert.deepEqual(done.sort(), ['a', 'b']);
  assert.equal(q.size(), 0, 'settled chains are pruned');
});
