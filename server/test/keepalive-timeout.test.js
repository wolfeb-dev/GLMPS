// server/test/keepalive-timeout.test.js
//
// Regression test for glmps-75: `npm test` intermittently failed
// with `TypeError: fetch failed` / `[cause]: read ECONNRESET` on server-
// booting test files under `--test-concurrency=4`, always transport-level
// (no assertion ever ran).
//
// Root cause: Node's http.Server default `keepAliveTimeout` (5000ms)
// destroys an idle keep-alive socket that long after its last response. This
// server legitimately blocks its own event loop for multi-second stretches
// doing synchronous subprocess work on the queue-runner's tick
// (createWorktree/removeWorktree's execFileSync git calls, ticket-enrich's
// spawnSync graphify call) -- by design, not a bug in themselves. Under
// concurrent load those stretches get long enough to blow through the
// stock 5s window; when the loop frees up, Node processes the overdue
// keepAliveTimeout and destroy()s a socket a client has already reused for
// its next request, which surfaces client-side as ECONNRESET with no
// server-side error (a timed-out idle-socket destroy is normal Node
// behavior, not an exception -- which is why nothing showed up in the run
// output).
//
// Proven causal, not just correlated: a throwaway load harness ran the
// exact runner-worktree.test.js request sequence against 4 concurrent
// server instances (same shape as `--test-concurrency=4`, production-
// default 5000ms runner tick). With the stock 5000ms keepAliveTimeout it
// failed 51/60 runs (85%); with keepAliveTimeout raised, 0/60 failed --
// toggled back and forth, same load, same code, only this one value
// changed.
//
// Why this test asserts the CONFIG VALUE rather than reproducing the race:
// the failure is a genuine OS/libuv scheduling race (idle-socket destroy
// racing a reused connection's already-in-flight write) that only showed
// up reliably under real multi-process contention (real `git`/`graphify`
// subprocesses across several concurrent Node processes). Two separate
// attempts at forcing it deterministically in a single process (a plain
// synchronous busy-wait between requests, and firing a second request's
// write before blocking) both failed to reproduce it even with the fix
// reverted -- the actual race needs OS-level, cross-process timing this
// suite cannot fabricate on demand without reintroducing exactly the kind
// of slow, load-dependent flakiness this fix removes. The config assertion
// below is the deterministic, fast seam: it pins the value that was proven
// (via the toggle above) to eliminate the failure, so a future change that
// drops keepAliveTimeout back to Node's 5000ms default is caught
// immediately instead of resurfacing as an intermittent, hard-to-bisect
// `ECONNRESET` days or weeks later.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server.js';
import { claudeTmp } from './fixtures/claude-dir.js';

const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });
function mkTmp() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-keepalive-')); tmpDirs.push(d); return d; }

test('server keepAliveTimeout is raised well above Node\'s 5000ms default (glmps-75)', async () => {
  const stateDir = mkTmp();
  const claudeDir = claudeTmp();
  tmpDirs.push(claudeDir);
  const srv = await startServer({ port: 0, pollMs: 100000, env: { ...process.env, GLMPS_STATE_DIR: stateDir, GLMPS_CLAUDE_DIR: claudeDir } });
  try {
    // Must clear Node's stock 5000ms default by a wide margin: this server's
    // own synchronous git/graphify subprocess calls can legitimately block
    // the event loop for several seconds under load, and the timeout must
    // outlast that or an idle keep-alive socket gets destroyed mid-race.
    assert.ok(srv.keepAliveTimeoutMs >= 60_000,
      `keepAliveTimeout regressed to ${srv.keepAliveTimeoutMs}ms -- this is exactly the glmps-75 ECONNRESET race`);
    // headersTimeout must stay >= keepAliveTimeout (Node's own default
    // ordering: 60000 > 5000) or the two timers contradict each other.
    assert.ok(srv.headersTimeoutMs >= srv.keepAliveTimeoutMs,
      'headersTimeout must be >= keepAliveTimeout');
  } finally {
    await srv.close();
  }
});
