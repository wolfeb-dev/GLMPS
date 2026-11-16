// server/test/huddle-bench-api-stream.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createSseParser, streamMessage } from '../../scripts/lib/messages-api-stream.mjs';

const sse = (type, obj) => `event: ${type}\ndata: ${JSON.stringify({ type, ...obj })}\n\n`;

function fakeRequest(chunks, { statusCode = 200 } = {}) {
  const calls = [];
  const request = (opts, onRes) => {
    const req = new EventEmitter();
    req.write = (payload) => { calls.push({ opts, payload: JSON.parse(payload) }); };
    req.end = () => {
      const res = new EventEmitter();
      res.statusCode = statusCode;
      res.setEncoding = () => {};
      onRes(res);
      setImmediate(() => { for (const c of chunks) res.emit('data', c); res.emit('end'); });
    };
    return req;
  };
  return { request, calls };
}

test('createSseParser reassembles events split across chunks', () => {
  const seen = [];
  const feed = createSseParser((event, json) => seen.push([event, json.type]));
  const whole = sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Hi' } });
  feed(whole.slice(0, 20));
  assert.equal(seen.length, 0);
  feed(whole.slice(20));
  assert.deepEqual(seen, [['content_block_delta', 'content_block_delta']]);
});

test('streamMessage concatenates text deltas, reports ttft and stop reason, sends stream:true', async () => {
  const chunks = [
    sse('message_start', { message: { id: 'm1' } }),
    sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Two sentences. ' } }),
    sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Done.' } }),
    sse('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 6 } }),
    sse('message_stop', {}),
  ];
  const { request, calls } = fakeRequest(chunks);
  let t = 1000; const now = () => { t += 100; return t; };
  const deltas = [];
  const out = await streamMessage({ apiKey: 'k', body: { model: 'claude-opus-5', max_tokens: 50, messages: [] }, onText: (d) => deltas.push(d), request, now, fallbacks: true });
  assert.equal(out.text, 'Two sentences. Done.');
  assert.equal(out.stopReason, 'end_turn');
  assert.equal(out.usage.output_tokens, 6);
  assert.equal(typeof out.ttftMs, 'number');
  assert.deepEqual(deltas, ['Two sentences. ', 'Done.']);
  assert.equal(calls[0].payload.stream, true);
  assert.equal(calls[0].payload.fallbacks, 'default');
  assert.equal(calls[0].opts.headers['anthropic-beta'], 'server-side-fallback-2026-07-01');
  assert.equal(calls[0].opts.headers['x-api-key'], 'k');
});

test('streamMessage strips the huddle-only fields before calling the API', async () => {
  const { request, calls } = fakeRequest([sse('message_delta', { delta: { stop_reason: 'end_turn' } })]);
  await streamMessage({ apiKey: 'k', body: { model: 'claude-haiku-4-5', max_tokens: 5, messages: [], transcript: [], speakerId: 'bill', instruction: 'x' }, request });
  for (const k of ['transcript', 'speakerId', 'instruction', 'fallbacks']) assert.equal(k in calls[0].payload, false, k);
  assert.equal('anthropic-beta' in calls[0].opts.headers, false);
});

test('streamMessage rejects on a non-200 status with the body excerpt, and without a key before any request', async () => {
  const { request } = fakeRequest(['{"error":{"message":"bad key"}}'], { statusCode: 401 });
  await assert.rejects(() => streamMessage({ apiKey: 'k', body: { messages: [] }, request }), /anthropic 401: .*bad key/);
  let called = false;
  await assert.rejects(() => streamMessage({ apiKey: '', body: {}, request: () => { called = true; } }), /no api key/);
  assert.equal(called, false);
});

test('streamMessage marks a refusal stop', async () => {
  const { request } = fakeRequest([sse('message_delta', { delta: { stop_reason: 'refusal' } })]);
  const out = await streamMessage({ apiKey: 'k', body: { messages: [] }, request });
  assert.equal(out.refusal, true);
});
