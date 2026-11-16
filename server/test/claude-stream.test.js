// The huddle's Claude client over `claude -p` stream-json (D28). Every test
// injects spawn; nothing here starts the real CLI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { streamArgs, userTurn, parseStreamLine, formatTurn, createClaudeStreamPool, claudeCliAvailable } from '../lib/plugins/claude-stream.js';
import { isClaudeModelName } from '../lib/plugins/claude-model.js';

const ev = (event) => JSON.stringify({ type: 'stream_event', event, session_id: 's', uuid: 'u' });
const text = (t) => ev({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: t } });
const result = (r, extra = {}) => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: r, stop_reason: 'end_turn', session_id: 's', ...extra });

// A fake claude: answers each stdin turn with the scripted lines for that turn.
function fakeSpawn(turns) {
  const spawned = [];
  const spawnImpl = (cmd, args, opts) => {
    const child = new EventEmitter();
    child.pid = 4242;
    child.stdout = new EventEmitter();
    child.stdout.setEncoding = () => {};
    child.stderr = new EventEmitter();
    child.writes = [];
    let n = 0;
    child.stdin = new EventEmitter();
    child.stdin.write = (s) => {
      child.writes.push(JSON.parse(s));
      const lines = turns[n++] ?? [];
      setImmediate(() => { for (const l of lines) child.stdout.emit('data', l + '\n'); });
      return true;
    };
    child.stdin.end = () => {};
    spawned.push({ cmd, args, opts, child });
    return child;
  };
  return { spawnImpl, spawned };
}
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mc-cs-test-'));
const killed = [];
const killTree = (child) => { killed.push(child.pid); setImmediate(() => child.emit('close', null)); };

test('isClaudeModelName is the shared check from claude-model.js', () => {
  assert.equal(isClaudeModelName('opus'), true);
  assert.equal(isClaudeModelName('claude-opus-5-5'), true);
  assert.equal(isClaudeModelName('opus & calc'), false);
});

test('streamArgs are the verified command: stream-json both ways, --verbose, partials, lean flags, quoted path on win32', () => {
  assert.deepEqual(streamArgs({ model: 'haiku', sysFile: 'C:/t/system.txt', effort: 'low', platform: 'win32' }), [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--model', 'haiku', '--no-session-persistence', '--tools=', '--system-prompt-file', '"C:/t/system.txt"',
    '--setting-sources=', '--strict-mcp-config', '--effort', 'low',
  ]);
  assert.equal(streamArgs({ model: 'haiku', sysFile: '/t/s.txt', platform: 'linux' }).includes('--effort'), false);
});

test('userTurn is one stream-json user message line', () => {
  assert.equal(userTurn('hi'), '{"type":"user","message":{"role":"user","content":"hi"}}\n');
});

test('parseStreamLine keeps text deltas and results, ignores thinking, system and junk', () => {
  assert.deepEqual(parseStreamLine(text('Hey')), { kind: 'text', text: 'Hey' });
  assert.deepEqual(parseStreamLine(ev({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '' } })), { kind: 'other' });
  assert.deepEqual(parseStreamLine('{"type":"system","subtype":"init"}'), { kind: 'other' });
  assert.deepEqual(parseStreamLine('not json'), { kind: 'other' });
  assert.deepEqual(parseStreamLine(result('Hey there', { usage: { output_tokens: 3 } })), { kind: 'result', text: 'Hey there', isError: false, stopReason: 'end_turn', usage: { output_tokens: 3 } });
  assert.equal(parseStreamLine(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'boom' })).isError, true);
});

test('formatTurn: a cold process gets the whole transcript; a warm one only what is new, never its own lines', () => {
  const t = [
    { speaker: 'operator', name: 'Operator', text: 'Builder, estimate this' },
    { speaker: 'bill', name: 'Builder', text: 'Two days.' },
    { speaker: 'operator', name: 'Operator', text: 'Critic?' },
    { speaker: 'medeiros', name: 'Critic', text: 'Too optimistic.', truncated: true },
  ];
  const cold = formatTurn({ body: { transcript: t.slice(0, 1), speakerId: 'bill' }, fedCount: 0 });
  assert.equal(cold.content, 'Transcript so far:\nOperator: Builder, estimate this\n\nSpeak your next line now.');
  assert.equal(cold.fedCount, 1);
  const warm = formatTurn({ body: { transcript: t, speakerId: 'bill' }, fedCount: 1 });
  assert.equal(warm.content, 'Since you last spoke:\nOperator: Critic?\nCritic: Too optimistic. [interrupted]\n\nSpeak your next line now.');
  assert.equal(warm.fedCount, 4);
  assert.equal(formatTurn({ body: { messages: [{ role: 'user', content: 'Summarise' }] }, fedCount: 3 }).content, 'Summarise');
});

test('streamMessage: one process per mind, turns reuse it, deltas stream, first-token time reported', async () => {
  const { spawnImpl, spawned } = fakeSpawn([[text('Two sentences. '), text('Done.'), result('Two sentences. Done.')], [text('Again.'), result('Again.')]]);
  let t = 1000;
  const pool = createClaudeStreamPool({ spawnImpl, platform: 'linux', tmpDir: tmpDir(), killTree, now: () => (t += 10) });
  const deltas = [];
  const body = { model: 'opus', system: 'You are Builder.', output_config: { effort: 'low' }, transcript: [{ speaker: 'operator', name: 'Operator', text: 'hi' }], speakerId: 'bill' };
  const a = await pool.streamMessage({ body, onText: (d) => deltas.push(d) });
  assert.equal(a.text, 'Two sentences. Done.');
  assert.equal(a.cold, true);
  assert.equal(typeof a.ttftMs, 'number');
  assert.deepEqual(deltas, ['Two sentences. ', 'Done.']);
  const b = await pool.streamMessage({ body: { ...body, transcript: [...body.transcript, { speaker: 'bill', name: 'Builder', text: a.text }, { speaker: 'operator', name: 'Operator', text: 'more' }] } });
  assert.equal(b.cold, false);
  assert.equal(spawned.length, 1, 'the same mind reuses its process');
  assert.equal(spawned[0].child.writes[1].message.content, 'Since you last spoke:\nOperator: more\n\nSpeak your next line now.');
  assert.ok(spawned[0].args.includes('--effort'));
  assert.equal(spawned[0].opts.env.GLMPS_MEMORY_DISTILL, '1');
  await pool.streamMessage({ body: { ...body, system: 'You are Critic.', speakerId: 'medeiros' } }).catch(() => {});
  assert.equal(spawned.length, 2, 'a different system prompt is a different mind');
  pool.close();
});

test('abort kills the process tree and rejects AbortError; the next turn starts cold with the full transcript', async () => {
  killed.length = 0;
  const { spawnImpl, spawned } = fakeSpawn([[text('First sentence. ')], [text('ok.'), result('ok.')]]);
  const pool = createClaudeStreamPool({ spawnImpl, platform: 'win32', tmpDir: tmpDir(), killTree });
  const ac = new AbortController();
  const body = { model: 'opus', system: 'S', transcript: [{ speaker: 'operator', name: 'Operator', text: 'go' }], speakerId: 'bill' };
  const p = pool.streamMessage({ body, signal: ac.signal, onText: () => ac.abort() });
  await assert.rejects(p, (e) => e.name === 'AbortError');
  assert.deepEqual(killed, [4242]);
  await new Promise((r) => setImmediate(r));
  const again = pool.streamMessage({ body }).catch(() => {});
  assert.equal(spawned.length, 2, 'the killed mind is respawned');
  assert.match(spawned[1].child.writes[0].message.content, /^Transcript so far:/);
  pool.close();
  await again;
});

test('an error result rejects the turn with its text; a timeout kills and rejects; close() kills every process', async () => {
  killed.length = 0;
  const err = fakeSpawn([[JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'overloaded' })]]);
  const p1 = createClaudeStreamPool({ spawnImpl: err.spawnImpl, platform: 'linux', tmpDir: tmpDir(), killTree });
  await assert.rejects(p1.streamMessage({ body: { model: 'haiku', system: 'S', messages: [{ role: 'user', content: 'x' }] } }), /claude error: overloaded/);
  const hang = fakeSpawn([[]]);
  const p2 = createClaudeStreamPool({ spawnImpl: hang.spawnImpl, platform: 'linux', tmpDir: tmpDir(), killTree, turnTimeoutMs: 20 });
  await assert.rejects(p2.streamMessage({ body: { model: 'haiku', system: 'S', messages: [{ role: 'user', content: 'x' }] } }), /timed out/);
  assert.equal(killed.length, 1);
  const p3 = createClaudeStreamPool({ spawnImpl: fakeSpawn([[text('a'), result('a')]]).spawnImpl, platform: 'linux', tmpDir: tmpDir(), killTree });
  await p3.streamMessage({ body: { model: 'haiku', system: 'S', messages: [{ role: 'user', content: 'x' }] } });
  p3.close();
  assert.equal(killed.length, 2);
  assert.equal(p3.size(), 0);
});

test('an unsafe model name never reaches spawn', async () => {
  let spawnedAny = false;
  const pool = createClaudeStreamPool({ spawnImpl: () => { spawnedAny = true; }, platform: 'win32', tmpDir: tmpDir(), killTree });
  await assert.rejects(pool.streamMessage({ body: { model: 'opus & calc', system: 'S', messages: [{ role: 'user', content: 'x' }] } }), /unsafe model name/);
  assert.equal(spawnedAny, false);
});

test('claudeCliAvailable asks `claude --version` asynchronously and needs exit 0 with the product name', async () => {
  const p = claudeCliAvailable({ probeImpl: async () => ({ status: 0, stdout: '2.1.281 (Claude Code)\n' }), platform: 'linux' });
  assert.equal(typeof p.then, 'function');
  assert.equal(await p, true);
  assert.equal(await claudeCliAvailable({ probeImpl: () => ({ status: 1, stdout: '' }), platform: 'linux' }), false);
  assert.equal(await claudeCliAvailable({ probeImpl: () => ({ error: new Error('ENOENT') }), platform: 'linux' }), false);
});

const oneTurn = { model: 'haiku', system: 'S', messages: [{ role: 'user', content: 'x' }] };

test('the real transports are refused in a test process: no process, no temp dir (K guard parity with runClaude)', async () => {
  const dir = tmpDir();
  // spawnImpl left null = the real spawn; the process signals are injected so the
  // outcome does not depend on how this file was launched (test.env sets GLMPS_MODEL_RUNNER=off).
  const pool = createClaudeStreamPool({ tmpDir: dir, killTree, env: {}, processEnv: { NODE_TEST_CONTEXT: 'child' }, argv: ['node', 'x.mjs'] });
  await assert.rejects(pool.streamMessage({ body: oneTurn }), /refused: test process/);
  assert.deepEqual(fs.readdirSync(dir), [], 'no temp dir was created');
  assert.equal(pool.size(), 0);
});

test('with no overrides, under node --test, the real spawn is refused whichever signal fires first', async () => {
  const pool = createClaudeStreamPool({ tmpDir: tmpDir(), killTree });
  await assert.rejects(pool.streamMessage({ body: oneTurn }), /claude stream (refused|disabled)/);
  assert.equal(await claudeCliAvailable({}), false, 'no probeImpl injected under node --test: false, without spawning');
});

test('GLMPS_MODEL_RUNNER=off is an operator kill switch for the real spawn', async () => {
  const pool = createClaudeStreamPool({ tmpDir: tmpDir(), killTree, env: { GLMPS_MODEL_RUNNER: 'off' }, processEnv: {}, argv: ['node', 'x.mjs'] });
  await assert.rejects(pool.streamMessage({ body: oneTurn }), /GLMPS_MODEL_RUNNER=off/);
});

test('an idle mind is reaped after idleKillMs and its next turn starts cold with the full transcript', async () => {
  killed.length = 0;
  const { spawnImpl, spawned } = fakeSpawn([[text('a.'), result('a.')], [text('b.'), result('b.')]]);
  const pool = createClaudeStreamPool({ spawnImpl, platform: 'linux', tmpDir: tmpDir(), killTree, idleKillMs: 30 });
  const body = { model: 'haiku', system: 'S', transcript: [{ speaker: 'operator', name: 'Operator', text: 'hi' }], speakerId: 'bill' };
  await pool.streamMessage({ body });
  await new Promise((r) => setTimeout(r, 90));
  assert.deepEqual(killed, [4242], 'the idle process tree was killed');
  assert.equal(pool.size(), 0);
  const again = await pool.streamMessage({ body });
  assert.equal(again.cold, true);
  assert.equal(spawned.length, 2);
  assert.match(spawned[1].child.writes[0].message.content, /^Transcript so far:/);
  pool.close();
});

test('a mind with a turn in flight is never reaped as idle', async () => {
  killed.length = 0;
  const { spawnImpl } = fakeSpawn([[text('slow')]]); // no result line: the turn stays open
  const pool = createClaudeStreamPool({ spawnImpl, platform: 'linux', tmpDir: tmpDir(), killTree, idleKillMs: 20, turnTimeoutMs: 5000 });
  const p = pool.streamMessage({ body: { model: 'haiku', system: 'S', messages: [{ role: 'user', content: 'x' }] } }).catch(() => {});
  await new Promise((r) => setTimeout(r, 80));
  assert.deepEqual(killed, [], 'idle reaping does not touch a live turn');
  pool.close();
  await p;
});

test('after close() the pool refuses new turns: nothing is spawned that nobody would kill', async () => {
  const { spawnImpl, spawned } = fakeSpawn([[text('a'), result('a')]]);
  const pool = createClaudeStreamPool({ spawnImpl, platform: 'linux', tmpDir: tmpDir(), killTree });
  pool.close();
  await assert.rejects(pool.streamMessage({ body: oneTurn }), /pool closed/);
  assert.equal(spawned.length, 0);
});

test('a warm process whose fedCount exceeds the new transcript is killed and the turn starts cold with the full prompt', async () => {
  killed.length = 0;
  const { spawnImpl, spawned } = fakeSpawn([[text('a.'), result('a.')], [text('b.'), result('b.')]]);
  const pool = createClaudeStreamPool({ spawnImpl, platform: 'linux', tmpDir: tmpDir(), killTree });
  const u = (t) => ({ speaker: 'operator', name: 'Operator', text: t });
  const body = { model: 'haiku', system: 'S', speakerId: 'bill' };
  await pool.streamMessage({ body: { ...body, transcript: [u('1'), u('2'), u('3')] } });
  const r = await pool.streamMessage({ body: { ...body, transcript: [u('fresh')] } });
  assert.equal(r.cold, true);
  assert.equal(spawned.length, 2);
  assert.deepEqual(killed, [4242], 'the stale process was killed');
  assert.equal(spawned[1].child.writes[0].message.content, 'Transcript so far:\nOperator: fresh\n\nSpeak your next line now.');
  pool.close();
});

// D28: a key in the shell must never make the CLI bill the API instead of the plan.
test('every pool spawn strips ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN from the child env and keeps PATH', async () => {
  const { spawnImpl, spawned } = fakeSpawn([[text('a'), result('a')]]);
  const env = { PATH: '/usr/bin:/bin', ANTHROPIC_API_KEY: 'sk-test-not-real', ANTHROPIC_AUTH_TOKEN: 'tok-test-not-real' };
  const pool = createClaudeStreamPool({ spawnImpl, platform: 'linux', tmpDir: tmpDir(), killTree, env });
  await pool.streamMessage({ body: oneTurn });
  const childEnv = spawned[0].opts.env;
  assert.equal('ANTHROPIC_API_KEY' in childEnv, false);
  assert.equal('ANTHROPIC_AUTH_TOKEN' in childEnv, false);
  assert.equal(childEnv.PATH, '/usr/bin:/bin');
  assert.equal(childEnv.GLMPS_MEMORY_DISTILL, '1');
  pool.close();
});

// Pre-warm (operator limit: a reply in under 5 s): POST /api/huddle starts each
// mind's process without a turn, keyed exactly as streamMessage keys it.
test('prewarm spawns once per key; the first real turn reuses it as warm and sends the full transcript once', async () => {
  const { spawnImpl, spawned } = fakeSpawn([[text('a.'), result('a.')], [text('b.'), result('b.')]]);
  const pool = createClaudeStreamPool({ spawnImpl, platform: 'linux', tmpDir: tmpDir(), killTree });
  const target = { model: 'opus', effort: 'low', system: 'You are Builder.' };
  assert.equal(await pool.prewarm(target), true);
  assert.equal(await pool.prewarm(target), false, 'already warm: a no-op');
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].child.writes.length, 0, 'no turn is sent while warming');
  assert.ok(spawned[0].args.includes('--effort'));
  const body = { model: 'opus', system: 'You are Builder.', output_config: { effort: 'low' }, transcript: [{ speaker: 'operator', name: 'Operator', text: 'hi' }], speakerId: 'bill' };
  const a = await pool.streamMessage({ body });
  assert.equal(spawned.length, 1, 'streamMessage reused the prewarmed process');
  assert.equal(a.cold, false, 'a prewarmed process is warm');
  assert.equal(spawned[0].child.writes[0].message.content, 'Transcript so far:\nOperator: hi\n\nSpeak your next line now.');
  await pool.streamMessage({ body: { ...body, transcript: [...body.transcript, { speaker: 'bill', name: 'Builder', text: 'a.' }, { speaker: 'operator', name: 'Operator', text: 'more' }] } });
  assert.equal(spawned[0].child.writes[1].message.content, 'Since you last spoke:\nOperator: more\n\nSpeak your next line now.', 'the full transcript went once');
  await pool.prewarm({ model: 'haiku', system: 'Lead.' });
  assert.equal(spawned.length, 2, 'a different key is a different process');
  pool.close();
});

test('prewarm after close() spawns nothing', async () => {
  const { spawnImpl, spawned } = fakeSpawn([]);
  const pool = createClaudeStreamPool({ spawnImpl, platform: 'linux', tmpDir: tmpDir(), killTree });
  pool.close();
  assert.equal(await pool.prewarm({ model: 'opus', system: 'S' }), false);
  assert.equal(spawned.length, 0);
  assert.equal(pool.size(), 0);
});

test('a prewarmed mind is reaped when idle like any other', async () => {
  killed.length = 0;
  const { spawnImpl } = fakeSpawn([]);
  const pool = createClaudeStreamPool({ spawnImpl, platform: 'linux', tmpDir: tmpDir(), killTree, idleKillMs: 20 });
  await pool.prewarm({ model: 'opus', system: 'S' });
  await new Promise((r) => setTimeout(r, 70));
  assert.deepEqual(killed, [4242]);
  assert.equal(pool.size(), 0);
  pool.close();
});

test('a failed warm-up rides on the next failed turn for that mind as prewarmError, and never on a good one', async () => {
  const refused = createClaudeStreamPool({ tmpDir: tmpDir(), killTree, env: { GLMPS_MODEL_RUNNER: 'off' }, processEnv: {}, argv: ['node', 'x.mjs'] });
  await assert.rejects(refused.prewarm({ model: 'haiku', system: 'S' }), /GLMPS_MODEL_RUNNER=off/);
  await assert.rejects(refused.streamMessage({ body: oneTurn }), (e) => /GLMPS_MODEL_RUNNER=off/.test(e.prewarmError ?? ''));
  // an early exit of a warming process is remembered too; a later good turn clears it
  const { spawnImpl, spawned } = fakeSpawn([[text('ok.'), result('ok.')]]);
  const pool = createClaudeStreamPool({ spawnImpl, platform: 'linux', tmpDir: tmpDir(), killTree });
  await pool.prewarm({ model: 'haiku', system: 'S' });
  spawned[0].child.emit('close', 1);
  const r = await pool.streamMessage({ body: oneTurn });
  assert.equal(r.text, 'ok.');
  assert.equal(r.prewarmError, undefined);
  pool.close();
});
