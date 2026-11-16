// Card glmps-2-0-107: two launches in flight at once must both land in the
// runner ledger. A launch awaits (the session guard, the launch itself) between
// reading the ledger and writing it back, so writing back the snapshot it read
// erased the other launch's entry: a card left in_progress that the runner no
// longer tracked (runtime-22), and a slot count that undercounted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server.js';
import * as backlogStore from '../lib/orchestration/backlog-store.js';
import * as runnerStore from '../lib/orchestration/runner-store.js';
import { claudeTmp } from './fixtures/claude-dir.js';
import { waitFor } from './helpers/wait-for.js';

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

test('two concurrent Run now launches both keep their ledger entry', async () => {
  const stateDir = tmp('mc-ledger-race-');
  const claudeDir = claudeTmp();
  const env = { ...process.env, GLMPS_STATE_DIR: stateDir, GLMPS_CLAUDE_DIR: claudeDir, GLMPS_RUNNER_DRYRUN: '1', GLMPS_ALLOW_ACT: '1', GLMPS_SCUT: 'off', GLMPS_UNMERGED_SCAN: 'off' };
  const configFile = path.join(stateDir, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ launchRoots: [os.tmpdir()], closeSync: { enabled: true } }));
  const base = { project: 'p', title: 't', prompt: 'x', devLog: [], state: 'queued' };
  backlogStore.save(stateDir, { items: [{ ...base, id: 'p-1', order: 1 }, { ...base, id: 'p-2', order: 2 }] });
  runnerStore.saveConfig(stateDir, { maxConcurrent: 3 });
  // The first launch's session-guard lookup is held open until the second
  // launch has finished, which is the window the live runner hit.
  let releaseFirst;
  const firstHeld = new Promise((r) => { releaseFirst = r; });
  let calls = 0;
  const sessionCloser = {
    list: async () => { calls += 1; if (calls === 1) await firstHeld; return []; },
    close: async () => ({ ok: true }),
  };
  const h = await startServer({ port: 0, env, configFile, pollMs: 100000, restartFn: () => {}, sessionCloser, agAliveProbe: () => false });
  try {
    const run = (id) => fetch(`http://127.0.0.1:${h.port}/api/runner/run/${id}`, { method: 'POST', headers: { 'x-glmps-local-session': h.localSession } });
    const first = run('p-1');
    await waitFor(() => calls >= 1, { message: 'the first launch to reach the session guard' });
    const second = await run('p-2');
    assert.equal(second.status, 200, await second.text());
    releaseFirst();
    assert.equal((await first).status, 200);
    const ledger = runnerStore.loadLedger(stateDir);
    assert.deepEqual(Object.keys(ledger).sort(), ['p-1', 'p-2']);
  } finally {
    releaseFirst();
    await h.close?.();
    fs.rmSync(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    fs.rmSync(claudeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
