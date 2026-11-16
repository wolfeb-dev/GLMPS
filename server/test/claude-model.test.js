import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import {
  toClaudeCall, toOpenAIResponse, ModelError, runClaude, createSemaphore, createChatCompletion, getModelConfig, restrictModelForHttp,
} from '../lib/plugins/claude-model.js';

const models = { fast: 'haiku', strong: 'sonnet' };

test('system messages become the system prompt; one user message is the prompt', () => {
  const c = toClaudeCall({ model: 'gpt-5-mini', messages: [{ role: 'system', content: 'Be terse.' }, { role: 'user', content: 'Hi' }] }, { models });
  assert.equal(c.system, 'Be terse.'); assert.equal(c.prompt, 'Hi'); assert.equal(c.model, 'haiku'); assert.equal(c.structured, null);
});
test('claude model names pass through; others map to fast', () => {
  assert.equal(toClaudeCall({ model: 'sonnet', messages: [{ role: 'user', content: 'x' }] }, { models }).model, 'sonnet');
  assert.equal(toClaudeCall({ model: 'claude-opus-4-1', messages: [{ role: 'user', content: 'x' }] }, { models }).model, 'claude-opus-4-1');
  assert.equal(toClaudeCall({ model: 'openai:o3-mini', messages: [{ role: 'user', content: 'x' }] }, { models }).model, 'haiku');
});
// a model name carrying shell metacharacters
// must never reach spawn. toClaudeCall's job is to decide passthrough vs.
// fallback, so an unsafe-looking model name is simply treated the same as
// any other unrecognised model: fall back to models.fast.
test('a model name with shell metacharacters is not a recognised claude name; falls back to fast', () => {
  const c = toClaudeCall({ model: 'claude-x & echo INJECTED_%USERNAME% & rem', messages: [{ role: 'user', content: 'x' }] }, { models });
  assert.equal(c.model, 'haiku');
});
test('multi-turn and content parts render as a labelled transcript', () => {
  const c = toClaudeCall({ messages: [{ role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }, { role: 'assistant', content: 'c' }, { role: 'user', content: 'd' }] }, { models });
  assert.equal(c.prompt, 'USER:\na\nb\n\nASSISTANT:\nc\n\nUSER:\nd');
});
test('json_object, json_schema and a forced tool set structured mode; auto tools do not', () => {
  assert.equal(toClaudeCall({ messages: [{ role: 'user', content: 'x' }], response_format: { type: 'json_object' } }, { models }).structured.kind, 'json_object');
  const schema = { type: 'object', properties: { score: { type: 'boolean' } } };
  const b = toClaudeCall({ messages: [{ role: 'user', content: 'x' }], response_format: { type: 'json_schema', json_schema: { name: 's', schema } } }, { models });
  assert.deepEqual(b.structured.schema, schema); assert.match(b.system, /"score"/);
  const tools = [{ type: 'function', function: { name: 'grade', parameters: schema } }];
  assert.equal(toClaudeCall({ messages: [{ role: 'user', content: 'x' }], tools, tool_choice: { type: 'function', function: { name: 'grade' } } }, { models }).structured.toolName, 'grade');
  assert.equal(toClaudeCall({ messages: [{ role: 'user', content: 'x' }], tools, tool_choice: 'auto' }, { models }).structured, null);
});
test('responses: plain, fenced JSON, tool call, non-JSON', () => {
  const meta = { id: 'x', created: 1 };
  assert.equal(toOpenAIResponse({ model: 'haiku', structured: null }, 'hello', meta).choices[0].message.content, 'hello');
  assert.equal(toOpenAIResponse({ model: 'haiku', structured: { kind: 'json_object' } }, '```json\n{"a":1}\n```', meta).choices[0].message.content, '{"a":1}');
  const t = toOpenAIResponse({ model: 'haiku', structured: { kind: 'tool', toolName: 'grade' } }, '{"ok":true}', meta);
  assert.equal(t.choices[0].finish_reason, 'tool_calls'); assert.equal(t.choices[0].message.tool_calls[0].function.arguments, '{"ok":true}');
  assert.throws(() => toOpenAIResponse({ model: 'haiku', structured: { kind: 'json_object' } }, 'Sure!', meta), (e) => e instanceof ModelError && e.status === 502);
});
// valid JSON that is not a plain object (null,
// a bare number, an array) is not a usable structured response either.
test('structured responses: valid JSON that is not a plain object is a 502, same as non-JSON', () => {
  const meta = { id: 'x', created: 1 };
  for (const bad of ['null', '42', '[1]']) {
    assert.throws(() => toOpenAIResponse({ model: 'haiku', structured: { kind: 'json_object' } }, bad, meta), (e) => e instanceof ModelError && e.status === 502, bad);
  }
});

function fakeSpawn({ stdout = '', code = 0, delayMs = 0 } = {}) {
  const calls = [];
  const impl = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const child = new EventEmitter(); child.pid = 4242; child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    // stdin is a real EventEmitter (not just a plain object with .end) so
    // runClaude can register an 'error' listener on it, matching a real
    // ChildProcess's stdin (a Writable stream, itself an EventEmitter).
    const stdin = new EventEmitter();
    stdin.end = (s) => { calls.at(-1).stdin = s; setTimeout(() => { child.stdout.emit('data', Buffer.from(stdout)); child.emit('close', code); }, delayMs); };
    child.stdin = stdin;
    child.kill = () => {}; return child;
  };
  return { impl, calls };
}
// A1 note (residual fix, structural): runClaude fails closed under
// node --test regardless of GLMPS_MODEL_RUNNER (see the guard's own comment),
// so every test below that drives a real (fake-spawnImpl-backed) call
// through runClaude now passes env: { GLMPS_MODEL_RUNNER: 'on' } - the one
// explicit escape hatch - rather than the old env: {}. They are already
// safe without the guard (spawnImpl is a fake, never a real spawn), so this
// is a deliberate, explicit opt-out; see the "unset, no override" tests
// further down for proof the guard itself still closes by default.
const RUNNER_ON = { GLMPS_MODEL_RUNNER: 'on' };
test('runClaude uses the lean flags, stdin, and the re-entrancy env', async () => {
  const f = fakeSpawn({ stdout: JSON.stringify({ result: 'OK', is_error: false }) });
  assert.equal(await runClaude({ model: 'haiku', system: 'S', prompt: 'P', spawnImpl: f.impl, tmpDir: os.tmpdir(), platform: 'linux', env: RUNNER_ON }), 'OK');
  const { cmd, args, opts, stdin } = f.calls[0];
  assert.equal(cmd, 'claude'); assert.equal(stdin, 'P'); assert.equal(opts.env.GLMPS_MEMORY_DISTILL, '1'); assert.equal(opts.shell, false);
  for (const a of ['-p', '--output-format', 'json', '--no-session-persistence', '--tools=', '--setting-sources=', '--strict-mcp-config', '--system-prompt-file']) assert.ok(args.includes(a), a);
});
test('runClaude quotes the system file and uses a shell on win32', async () => {
  const f = fakeSpawn({ stdout: JSON.stringify({ result: 'OK' }) });
  await runClaude({ model: 'haiku', system: 'S', prompt: 'P', spawnImpl: f.impl, tmpDir: os.tmpdir(), platform: 'win32', env: RUNNER_ON });
  assert.equal(f.calls[0].opts.shell, true);
  assert.match(f.calls[0].args[f.calls[0].args.indexOf('--system-prompt-file') + 1], /^".*"$/);
});
test('runClaude rejects 502 on is_error or garbage, 504 on timeout', async () => {
  const base = { model: 'haiku', system: '', prompt: 'P', tmpDir: os.tmpdir(), platform: 'linux', env: RUNNER_ON };
  await assert.rejects(runClaude({ ...base, spawnImpl: fakeSpawn({ stdout: JSON.stringify({ result: 'x', is_error: true }) }).impl }), (e) => e.status === 502);
  await assert.rejects(runClaude({ ...base, spawnImpl: fakeSpawn({ stdout: 'nope' }).impl }), (e) => e.status === 502);
  await assert.rejects(runClaude({ ...base, timeoutMs: 20, spawnImpl: fakeSpawn({ stdout: '{}', delayMs: 200 }).impl }), (e) => e.status === 504);
});
// valid JSON that parses to something other
// than an object (e.g. the bare literal `null`) must not throw a TypeError
// out of the close handler when the code goes to read `j.is_error` - it
// must reject 502 like any other unusable envelope.
test('runClaude rejects 502 when claude prints valid JSON that is not an object (e.g. null)', async () => {
  const base = { model: 'haiku', system: '', prompt: 'P', tmpDir: os.tmpdir(), platform: 'linux', env: RUNNER_ON };
  await assert.rejects(runClaude({ ...base, spawnImpl: fakeSpawn({ stdout: 'null' }).impl }), (e) => e.status === 502);
});
// runClaude is the last line of defense
// before spawn - even a caller-supplied model that never went through
// toClaudeCall's own check (e.g. a misconfigured plugins.model.models.fast
// in config.json) must be rejected, and spawnImpl must never be invoked.
test('runClaude refuses to spawn an unsafe model name, even one supplied directly (e.g. a misconfigured models.fast)', async () => {
  const f = fakeSpawn({ stdout: '{}' });
  await assert.rejects(
    runClaude({ model: 'haiku & calc', system: '', prompt: 'P', spawnImpl: f.impl, tmpDir: os.tmpdir(), platform: 'win32', env: RUNNER_ON }),
    (e) => e instanceof ModelError && e.status === 400,
  );
  assert.equal(f.calls.length, 0, 'spawnImpl must never be called for an invalid model name');
});
// on win32, killing only the shell
// (cmd.exe) leaves the real claude.exe grandchild running. The timeout path
// must use the injectable killTree seam (production default: `taskkill /pid
// <pid> /T /F`) instead of child.kill() directly, so the whole tree dies.
test('a win32 timeout kills the process tree via killTree, not just the shell, with the childs pid', async () => {
  const f = fakeSpawn({ stdout: '{}', delayMs: 500 });
  const killCalls = [];
  await assert.rejects(runClaude({
    model: 'haiku', system: '', prompt: 'P', spawnImpl: f.impl, tmpDir: os.tmpdir(), platform: 'win32', timeoutMs: 20, env: RUNNER_ON,
    killTree: (child, platform) => { killCalls.push({ pid: child.pid, platform }); },
  }), (e) => e.status === 504);
  assert.deepEqual(killCalls, [{ pid: 4242, platform: 'win32' }]);
});
// a child that exits before we finish
// writing a large prompt closes its end of the pipe, and Node surfaces that
// as an 'error' event on child.stdin (EPIPE) - not on the child itself.
// Without a listener that event is unhandled and crashes the process. The
// fake child here never emits 'close', so the only way this test can pass
// is if (a) the stdin 'error' didn't crash the test process and (b) the
// timeout path still settles the promise.
test('an EPIPE on stdin (early-exiting child) does not crash the process; the timeout path still settles it', async () => {
  const impl = (cmd, args, opts) => {
    const child = new EventEmitter(); child.pid = 111; child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    const stdin = new EventEmitter();
    stdin.end = () => { setTimeout(() => stdin.emit('error', new Error('EPIPE')), 0); };
    child.stdin = stdin; child.kill = () => {};
    return child;
  };
  await assert.rejects(
    runClaude({ model: 'haiku', system: '', prompt: 'x'.repeat(1000), spawnImpl: impl, tmpDir: os.tmpdir(), platform: 'linux', timeoutMs: 50, env: RUNNER_ON }),
    (e) => e.status === 504,
  );
});
// a temp-dir cleanup failure
// must be visible (console.error with the path), not silently swallowed -
// it stays best-effort (does not change the settled promise), but "best
// effort" is not "silent".
test('a temp-dir cleanup failure is logged via console.error with the path, not silently swallowed', async (t) => {
  const errSpy = t.mock.method(console, 'error', () => {});
  t.mock.method(fs, 'rmSync', () => { throw new Error('EBUSY'); });
  const f = fakeSpawn({ stdout: JSON.stringify({ result: 'OK' }) });
  assert.equal(await runClaude({ model: 'haiku', system: 'S', prompt: 'P', spawnImpl: f.impl, tmpDir: os.tmpdir(), platform: 'linux', env: RUNNER_ON }), 'OK');
  assert.equal(errSpy.mock.calls.length >= 1, true, 'console.error was called');
  assert.match(errSpy.mock.calls[0].arguments.join(' '), /mc-model-/);
});
// every test that starts the server must be
// guaranteed never to spawn a real `claude -p` - an env override read here,
// at the last line of defense before spawn, rejects instead. This is the
// unit-level proof; the suite-wide default-off wiring lives in test.env plus
// package.json's test script.
test('runClaude rejects 503 without spawning when GLMPS_MODEL_RUNNER=off', async () => {
  const f = fakeSpawn({ stdout: '{}' });
  await assert.rejects(
    runClaude({ model: 'haiku', system: '', prompt: 'P', spawnImpl: f.impl, tmpDir: os.tmpdir(), platform: 'linux', env: { GLMPS_MODEL_RUNNER: 'off' } }),
    (e) => e instanceof ModelError && e.status === 503 && /GLMPS_MODEL_RUNNER=off/.test(e.message),
  );
  assert.equal(f.calls.length, 0, 'spawnImpl must never be called when the model runner is disabled');
});
// Node's own
// test runner sets NODE_TEST_CONTEXT in every child process it runs. This is
// the premise the guard below relies on instead of GLMPS_MODEL_RUNNER alone -
// confirming it holds on this repo's actual Node floor (24.3) turns a
// silent assumption into something a version bump would fail loudly on.
test('process.env.NODE_TEST_CONTEXT is set under node --test (the premise runClaude\'s guard relies on)', () => {
  assert.ok(process.env.NODE_TEST_CONTEXT, `expected NODE_TEST_CONTEXT to be set, got ${process.env.NODE_TEST_CONTEXT}`);
});
// This replaces a prior test of the same name asserting the OPPOSITE
// premise ("unset spawns normally") - that was exactly the structural gap:
// unset (no explicit off, no process.env spread) used to reach spawnImpl
// unguarded whenever a test built its own env object by hand, which
// ~20 startServer tests do (see server/test/plugins-model-route.test.js's
// mkEnv() for a real example). Now it must reject even with a completely
// empty env, because it is running under node --test - deterministically so
// regardless of whether test.env happened to load (this file's own process
// carries GLMPS_MODEL_RUNNER=off in process.env when run via `npm test`, but
// NOT when run bare via `node --test server/test/claude-model.test.js`;
// process.env.GLMPS_MODEL_RUNNER is saved/cleared/restored around this one
// test so its assertion holds identically either way, proving the
// NODE_TEST_CONTEXT branch itself, not process.env's incidental state).
test('runClaude rejects 503 when GLMPS_MODEL_RUNNER is completely unset and env is not process.env (closed by default under node --test)', async () => {
  const saved = process.env.GLMPS_MODEL_RUNNER;
  delete process.env.GLMPS_MODEL_RUNNER;
  try {
    const f = fakeSpawn({ stdout: JSON.stringify({ result: 'OK' }) });
    await assert.rejects(
      runClaude({ model: 'haiku', system: 'S', prompt: 'P', spawnImpl: f.impl, tmpDir: os.tmpdir(), platform: 'linux', env: {} }),
      (e) => e instanceof ModelError && e.status === 503 && /disabled under node --test/.test(e.message),
    );
    assert.equal(f.calls.length, 0, 'spawnImpl must never be called');
  } finally {
    if (saved === undefined) delete process.env.GLMPS_MODEL_RUNNER; else process.env.GLMPS_MODEL_RUNNER = saved;
  }
});
// The one explicit escape hatch: GLMPS_MODEL_RUNNER=on wins over both the
// NODE_TEST_CONTEXT check and an explicit off, since a test asking for it by
// name is deliberately opting a FAKE spawnImpl back in (never a real spawn).
test('runClaude spawns normally when GLMPS_MODEL_RUNNER=on is explicitly set, even under node --test', async () => {
  const f = fakeSpawn({ stdout: JSON.stringify({ result: 'OK' }) });
  assert.equal(await runClaude({ model: 'haiku', system: 'S', prompt: 'P', spawnImpl: f.impl, tmpDir: os.tmpdir(), platform: 'linux', env: RUNNER_ON }), 'OK');
  assert.equal(f.calls.length, 1);
});
test('createChatCompletion forwards env to runImpl every call, so a per-server GLMPS_MODEL_RUNNER=off override reaches the real runClaude guard', async () => {
  const create = createChatCompletion({ models, env: { GLMPS_MODEL_RUNNER: 'off' } });
  await assert.rejects(
    create({ messages: [{ role: 'user', content: 'hi' }] }),
    (e) => e instanceof ModelError && e.status === 503 && /GLMPS_MODEL_RUNNER=off/.test(e.message),
  );
});
test('semaphore caps concurrency', async () => {
  const sem = createSemaphore(2); let live = 0; let peak = 0;
  await Promise.all(Array.from({ length: 7 }, () => sem.run(async () => { live++; peak = Math.max(peak, live); await new Promise((r) => setTimeout(r, 5)); live--; })));
  assert.equal(peak, 2);
});
// an unbounded wait queue lets any caller
// (HTTP or a runaway internal loop) pile up indefinitely behind a slow
// model. Once maxQueue callers are already waiting, run() rejects a new
// call immediately (503) instead of queuing a further one - the caller's
// own existing retry/error path (the HTTP route's catch, or a plugin's
// retry-queue push) handles it the same as any other model failure.
test('semaphore rejects immediately (no queueing) once maxQueue callers are already waiting', async () => {
  const sem = createSemaphore(1, 2); // 1 concurrent, 2 allowed waiting
  // Each hold() synchronously reserves either the one live slot or a queue
  // position by the time it returns (run()'s synchronous prefix, up to its
  // first await, always runs before the call site sees the returned
  // promise) - their own eventual resolution is irrelevant to what this
  // test checks, so they are deliberately never settled.
  const hold = () => sem.run(() => new Promise(() => {}));
  hold(); // takes the one live slot
  hold(); // 1st waiter
  hold(); // 2nd waiter
  await assert.rejects(
    sem.run(() => Promise.resolve('never')),
    (e) => e instanceof ModelError && e.status === 503,
    'a 4th caller with 2 already waiting must be rejected, not queued',
  );
});
test('semaphore with no maxQueue given behaves exactly as before (unbounded)', async () => {
  const sem = createSemaphore(1);
  let count = 0;
  await Promise.all(Array.from({ length: 10 }, () => sem.run(async () => { count++; })));
  assert.equal(count, 10);
});
test('chat completion end to end with an injected runner; config defaults and overrides', async () => {
  const create = createChatCompletion({ models, runImpl: async ({ model, prompt }) => `${model}:${prompt}`, now: () => 1000 });
  assert.equal((await create({ messages: [{ role: 'user', content: 'hi' }] })).choices[0].message.content, 'haiku:hi');
  assert.deepEqual(getModelConfig({}).models, models);
  assert.equal(getModelConfig({ plugins: { model: { maxConcurrent: 3 } } }).maxConcurrent, 3);
  assert.equal(getModelConfig({}).maxQueueDepth, 20);
  assert.equal(getModelConfig({ plugins: { model: { maxQueueDepth: 5 } } }).maxQueueDepth, 5);
});

// the shared model route is reachable from any
// local process; an HTTP caller may only ever request haiku or sonnet
// through it - opus and any other claude-* name are downgraded to
// models.fast instead of honored, even though CLAUDE_NAME already treats
// them as safe-to-spawn names. Internal plugin callers (mem0, judge, GEPA)
// call chatCompletion() directly, in-process, never through this function -
// it is an HTTP-boundary policy, not a spawn-safety one.
test('restrictModelForHttp downgrades any model other than haiku/sonnet, leaving haiku/sonnet/no-model untouched', () => {
  assert.equal(restrictModelForHttp({ model: 'opus', messages: [] }).model, undefined);
  assert.equal(restrictModelForHttp({ model: 'claude-opus-4-1', messages: [] }).model, undefined);
  assert.equal(restrictModelForHttp({ model: 'haiku', messages: [] }).model, 'haiku');
  assert.equal(restrictModelForHttp({ model: 'sonnet', messages: [] }).model, 'sonnet');
  assert.equal(restrictModelForHttp({ messages: [] }).model, undefined);
});

// the fixed haiku/sonnet allowlist
// silently downgraded a plugin's own CONFIGURED strong model (e.g. GEPA
// running with plugins.model.models.strong set to a real opus id) the
// moment it went through this HTTP-boundary check - so a caller asking for
// exactly the model the operator configured got a different, weaker one
// with no error. A configured models.fast/strong value is now honoured in
// addition to haiku/sonnet; anything else still downgrades.
test('restrictModelForHttp also allows a configured models.fast/strong value, but still downgrades anything else', () => {
  const configuredModels = { fast: 'haiku', strong: 'claude-opus-4-1' };
  assert.equal(restrictModelForHttp({ model: 'claude-opus-4-1', messages: [] }, configuredModels).model, 'claude-opus-4-1', 'the configured strong model passes through');
  assert.equal(restrictModelForHttp({ model: 'haiku', messages: [] }, configuredModels).model, 'haiku', 'the configured fast model (also haiku) still passes through');
  assert.equal(restrictModelForHttp({ model: 'opus', messages: [] }, configuredModels).model, undefined, 'a DIFFERENT, non-configured claude-* name is still downgraded');
  assert.equal(restrictModelForHttp({ model: 'claude-x-9', messages: [] }, configuredModels).model, undefined, 'an arbitrary model outside both the allowlist and config is still downgraded');
});

// Phase K final review, SHARED HELPER ruling: runClaude's guard used to check
// only process.env.NODE_TEST_CONTEXT. A test process carrying a different
// signal (GLMPS_TEST=1 from test.env, or a direct `node x.test.js` run) with no
// NODE_TEST_CONTEXT reached spawnImpl. Proven in a child process whose env
// has GLMPS_TEST=1 and deliberately no NODE_TEST_CONTEXT and no GLMPS_MODEL_RUNNER;
// its spawnImpl is a fake that only throws a marker, so nothing real runs.
test('runClaude refuses to spawn in a test process detected by GLMPS_TEST=1 alone (shared isTestProcess helper)', async () => {
  const { execFileSync } = await import('node:child_process');
  const { pathToFileURL } = await import('node:url');
  const path = (await import('node:path')).default;
  const modUrl = pathToFileURL(path.join(import.meta.dirname, '..', 'lib', 'plugins', 'claude-model.js')).href;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-cm-child-'));
  const script = `
    const { runClaude } = await import(${JSON.stringify(modUrl)});
    try {
      await runClaude({ model: 'haiku', system: 'S', prompt: 'P', platform: 'linux', tmpDir: process.env.TMP_FOR_TEST, env: {},
        spawnImpl: () => { throw new Error('SPAWNED'); } });
      console.log('RESOLVED');
    } catch (e) { console.log(String(e.status) + ' ' + e.message); }`;
  const childEnv = { GLMPS_TEST: '1', HOME: home, USERPROFILE: home, GLMPS_CLAUDE_DIR: home, GLMPS_STATE_DIR: home, TMP_FOR_TEST: home, PATH: process.env.PATH, SystemRoot: process.env.SystemRoot };
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { env: childEnv, encoding: 'utf8' }).trim();
  assert.doesNotMatch(out, /SPAWNED/, 'spawnImpl must never be reached in a test process');
  assert.match(out, /^503 .*disabled/, `expected a 503 disabled refusal, got: ${out}`);
});

// D28: a key in the shell must never make the CLI bill the API instead of the plan.
test('runClaude strips ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN from the child env and keeps PATH', async () => {
  const saved = { k: process.env.ANTHROPIC_API_KEY, t: process.env.ANTHROPIC_AUTH_TOKEN };
  process.env.ANTHROPIC_API_KEY = 'sk-test-not-real';
  process.env.ANTHROPIC_AUTH_TOKEN = 'tok-test-not-real';
  try {
    const f = fakeSpawn({ stdout: JSON.stringify({ result: 'OK' }) });
    await runClaude({ model: 'haiku', system: 'S', prompt: 'P', spawnImpl: f.impl, tmpDir: os.tmpdir(), platform: 'linux', env: RUNNER_ON });
    const childEnv = f.calls[0].opts.env;
    assert.equal('ANTHROPIC_API_KEY' in childEnv, false);
    assert.equal('ANTHROPIC_AUTH_TOKEN' in childEnv, false);
    const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH');
    assert.equal(childEnv[pathKey], process.env[pathKey], 'PATH is kept');
    assert.equal(childEnv.GLMPS_MEMORY_DISTILL, '1');
  } finally {
    if (saved.k === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = saved.k;
    if (saved.t === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN; else process.env.ANTHROPIC_AUTH_TOKEN = saved.t;
  }
});
