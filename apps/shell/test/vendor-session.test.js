// apps/shell/test/vendor-session.test.js
// AC-6: the Antigravity tab wrapper for a non-Claude card. Nothing here starts
// a real process or reaches a server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { runVendorSession, validateSession, taskInstructionFor } from '../src/lib/vendor-session.js';

const SESSION = {
  cardId: 'glmps-2-0-81', vendor: 'gemini', model: null, cwd: 'C:\\wt\\p\\glmps-2-0-81',
  promptFile: 'S\\runner\\glmps-2-0-81.prompt.md', doneFile: 'C:\\wt\\p\\glmps-2-0-81\\.glmps-vendor-done.md',
  port: 8123, nonce: 'a'.repeat(32),
};

function harness({ bin = 'C:\\b\\agy.exe', status = 202 } = {}) {
  const child = new EventEmitter();
  const h = { spawned: [], posts: [], logs: [], ticks: [], cleared: 0, done: false, child };
  h.deps = {
    spawn: (file, args, opts) => { h.spawned.push({ file, args, opts }); return child; },
    resolveBinary: () => bin,
    exists: () => h.done,
    post: async (url, body) => { h.posts.push({ url, body }); return { status, body: {} }; },
    log: (t) => h.logs.push(t),
    env: { PATH: 'p' },
    setIntervalImpl: (fn) => { h.ticks.push(fn); return 1; },
    clearIntervalImpl: () => { h.cleared += 1; },
  };
  return h;
}

const flush = () => new Promise((r) => setImmediate(r));

test('the tab runs agy interactively in the worktree, terminal attached, behind the push fence', async () => {
  const h = harness();
  const p = runVendorSession(SESSION, h.deps);
  const s = h.spawned[0];
  assert.equal(s.file, 'C:\\b\\agy.exe');
  assert.deepEqual(s.args, ['--model', 'Gemini 4 Argon (High)', '--sandbox', '-i', taskInstructionFor(SESSION.promptFile)]);
  assert.equal(s.opts.cwd, SESSION.cwd);
  assert.equal(s.opts.stdio, 'inherit');
  assert.equal(s.opts.env.GH_TOKEN, 'glmps-vendor-fence-no-github');
  assert.equal(s.opts.env.GIT_CONFIG_VALUE_0, 'glmps-fence://push-blocked');
  h.child.emit('exit', 0);
  const r = await p;
  assert.equal(r.event, 'exit');
  assert.deepEqual(h.posts, [{ url: 'http://127.0.0.1:8123/api/backlog/glmps-2-0-81/vendor-session', body: { nonce: SESSION.nonce, event: 'exit', exitCode: 0 } }]);
  assert.equal(h.cleared, 1);
});

// F4 (card glmps-2-0-172): each done file is one hand-off round, and the exit
// is reported too, so work done in the tab after a hand-off is not lost.
test('each done file signals one round while the agent stays open, and the exit is reported after them', async () => {
  const h = harness();
  const p = runVendorSession(SESSION, h.deps);
  h.ticks[0]();
  assert.equal(h.posts.length, 0);
  h.done = true;
  h.ticks[0]();
  h.ticks[0]();
  await flush();
  assert.equal(h.posts.length, 1, 'a done file not yet consumed is signalled once');
  assert.equal(h.posts[0].body.event, 'done');
  h.done = false;
  h.ticks[0]();
  h.done = true;
  h.ticks[0]();
  await flush();
  assert.equal(h.posts.length, 2, 'a done file written again after the runner consumed it is a new round');
  assert.equal(h.posts[1].body.event, 'done');
  h.done = false;
  h.child.emit('exit', 0);
  const r = await p;
  assert.equal(r.event, 'exit');
  assert.equal(r.rounds, 3);
  assert.deepEqual(h.posts.map((x) => x.body.event), ['done', 'done', 'exit']);
});

test('an exit with the done file already written reports done', async () => {
  const h = harness();
  const p = runVendorSession(SESSION, h.deps);
  h.done = true;
  h.child.emit('exit', 3);
  assert.equal((await p).event, 'done');
  assert.equal(h.posts[0].body.event, 'done');
});

test('a missing CLI is reported to the runner as an exit and nothing is spawned', async () => {
  const h = harness({ bin: null });
  const r = await runVendorSession(SESSION, h.deps);
  assert.equal(h.spawned.length, 0);
  assert.equal(r.exitCode, -1);
  assert.equal(h.posts[0].body.event, 'exit');
  assert.match(h.logs.join('\n'), /not found/);
});

test('a runner that refuses the signal is shown in the tab, not thrown', async () => {
  const h = harness({ status: 403 });
  const p = runVendorSession(SESSION, h.deps);
  h.child.emit('exit', 0);
  await p;
  assert.match(h.logs.at(-1), /did not take the finish signal \(403\)/);
});

test('validateSession refuses a session it cannot run', () => {
  assert.equal(validateSession(SESSION), null);
  assert.equal(validateSession(SESSION, { promptArg: SESSION.promptFile }), null);
  assert.match(validateSession(SESSION, { promptArg: 'other.prompt.md' }), /prompt/);
  assert.match(validateSession({ ...SESSION, nonce: 'x' }), /nonce/);
  assert.match(validateSession({ ...SESSION, cardId: 'A B' }), /card/);
  assert.match(validateSession({ ...SESSION, port: 0 }), /port/);
  assert.match(validateSession({ ...SESSION, doneFile: '' }), /doneFile/);
  assert.match(validateSession({ ...SESSION, vendor: 'grok' }), /interactive/);
  assert.match(validateSession(null), /JSON/);
});

test('a Gemini tab with no model opens on the newest model agy lists; an empty list keeps the pinned newest', async () => {
  const h = harness();
  h.deps.listModels = () => ['Gemini 5 Boron (High)', 'Gemini 4 Argon (High)'];
  const p = runVendorSession(SESSION, h.deps);
  assert.deepEqual(h.spawned[0].args.slice(0, 2), ['--model', 'Gemini 5 Boron (High)']);
  h.child.emit('exit', 0);
  await p;
  const e = harness();
  e.deps.listModels = () => [];
  const q = runVendorSession(SESSION, e.deps);
  assert.deepEqual(e.spawned[0].args.slice(0, 2), ['--model', 'Gemini 4 Argon (High)']);
  e.child.emit('exit', 0);
  await q;
});

test('a Gemini tab whose model agy no longer lists never opens agy and reports the newest to the runner', async () => {
  const h = harness();
  h.deps.listModels = () => ['Gemini 4 Argon (High)'];
  const r = await runVendorSession({ ...SESSION, model: 'Gemini 3.5 Flash (High)' }, h.deps);
  assert.equal(h.spawned.length, 0);
  assert.equal(r.exitCode, -1);
  assert.equal(h.posts[0].body.event, 'exit');
  assert.ok(h.posts[0].body.error.includes('"Gemini 4 Argon (High)"'), h.posts[0].body.error);
});
