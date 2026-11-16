// server/test/timer-cleanup.test.js
//
// glmps-8: startServer() registers several setInterval timers.
// Some were fire-and-forget (`setInterval(fn, ms).unref?.()` with no
// captured handle), so close() could never clearInterval them - every
// startServer() call (39-odd test files boot one) leaked one interval per
// tick forever.
//
// Detecting this via active-handle introspection (process._getActiveHandles /
// process.getActiveResourcesInfo) does NOT work here: those APIs are backed
// by libuv's ref-counted handle list, and every timer in question is
// deliberately `.unref()`'d (so it never blocks process exit) - unref'd
// timers are invisible to both APIs even while still registered and firing.
// Verified interactively: an unref'd setInterval never appears in
// getActiveResourcesInfo()'s 'Timeout' entries, before OR after clearing it.
//
// So this test spies on the global setInterval/clearInterval instead: every
// id startServer() creates must appear in the set of ids close() clears.
// That catches exactly the bug class this ticket fixes, regardless of unref
// state, and would have failed before the fix (5 ids created, never
// cleared).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server.js';
import { claudeTmp } from './fixtures/claude-dir.js';

function tmp(p) { return fs.mkdtempSync(path.join(os.tmpdir(), p)); }

test('startServer captures every setInterval it creates and close() clears all of them', async () => {
  const stateDir = tmp('mc-timer-');
  const claudeDir = claudeTmp();
  const configFile = path.join(stateDir, 'config.json');
  // memoryDistill + skillLifecycle default to enabled:true already.
  fs.writeFileSync(configFile, JSON.stringify({}));
  const env = { ...process.env, GLMPS_STATE_DIR: stateDir, GLMPS_CLAUDE_DIR: claudeDir };

  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  const created = new Set();
  const cleared = new Set();
  globalThis.setInterval = (...args) => {
    const t = realSetInterval(...args);
    created.add(t);
    return t;
  };
  globalThis.clearInterval = (...args) => {
    cleared.add(args[0]);
    return realClearInterval(...args);
  };

  // The spy must stay installed through close() too - close() is what's
  // under test (it makes the clearInterval calls), so unpatching before
  // calling it would make `cleared` empty regardless of whether the real
  // fix works.
  let h;
  try {
    h = await startServer({ port: 0, env, configFile });
    // Sanity check the spy actually observed background timers being made - 
    // otherwise a future refactor could remove them all and this test would
    // still pass having verified nothing. Expect at least: pollTimer,
    // agTimer, invTimer, runnerTimer, unmergedRefreshTimer (5, always on) +
    // memoryDistillTimer, skillLifecycleTimer, crossAgentMemoryTrialTimer
    // (3, defaulted on).
    assert.ok(created.size >= 8, `expected >=8 intervals created, saw ${created.size}`);
    await h.close();
  } finally {
    globalThis.setInterval = realSetInterval;
    globalThis.clearInterval = realClearInterval;
  }
  fs.rmSync(stateDir, { recursive: true, force: true });
  fs.rmSync(claudeDir, { recursive: true, force: true });

  const leaked = [...created].filter((t) => !cleared.has(t));
  assert.equal(leaked.length, 0, `close() left ${leaked.length} of ${created.size} interval(s) uncleared`);
});
