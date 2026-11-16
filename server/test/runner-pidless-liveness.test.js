// Card glmps-2-0-runtime-69: the runner reads the session guard's process list
// for a pid-less ledger entry and frees the slot once that session is provably
// gone; while it is listed (waiting at its prompt included) the slot is kept.
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
const SID = '0a1b2c3d-1111-2222-3333-444455556666';

async function withServer(closeSync, fn, { transcript = false } = {}) {
  const stateDir = tmp('mc-pidless-');
  const claudeDir = claudeTmp();
  if (transcript) {
    const projDir = path.join(claudeDir, 'projects', 'D--proj');
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, `${SID}.jsonl`), JSON.stringify({ type: 'user', sessionId: SID, cwd: 'D:\\proj', timestamp: new Date().toISOString(), message: { role: 'user', content: 'hi' } }) + '\n');
  }
  const env = { ...process.env, GLMPS_STATE_DIR: stateDir, GLMPS_CLAUDE_DIR: claudeDir, GLMPS_RUNNER_DRYRUN: '1', GLMPS_SCUT: 'off', GLMPS_UNMERGED_SCAN: 'off' };
  const configFile = path.join(stateDir, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ closeSync: { enabled: closeSync }, pidlessLivenessMs: 1 }));
  backlogStore.save(stateDir, { items: [{ id: 'p-1', project: 'p', title: 't', prompt: 'x', devLog: [], activity: [], labels: [], state: 'in_progress', order: 1 }] });
  runnerStore.saveConfig(stateDir, { enabled: false });
  runnerStore.saveLedger(stateDir, { 'p-1': { pid: null, launchId: null, startedAt: Date.now() - 1000, target: 'antigravity', retries: 0, sessionId: SID } });
  const state = { listed: true, calls: 0 };
  const sessionCloser = {
    list: async () => { state.calls += 1; return state.listed ? [{ ticketId: 'p-1', sessionId: SID, pid: 42, rootPid: 41 }] : []; },
    close: async () => ({ ok: true }),
  };
  const h = await startServer({ port: 0, env, configFile, pollMs: 100000, restartFn: () => {}, sessionCloser, agAliveProbe: () => false });
  try { await fn({ h, stateDir, state }); }
  finally {
    await h.close?.();
    fs.rmSync(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    fs.rmSync(claudeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

const tickUntilListed = async (h, state, n) => {
  const target = state.calls + n;
  await waitFor(async () => { await h.runnerTick(); return state.calls >= target; }, { message: `${n} more process-list call(s)` });
  await h.runnerTick();
};

test('a pid-less session that stays listed keeps its slot; one that leaves the list is requeued', async () => {
  await withServer(true, async ({ h, stateDir, state }) => {
    await tickUntilListed(h, state, 3);
    assert.ok(runnerStore.loadLedger(stateDir)['p-1'].liveness?.seenAt, 'sighting recorded');
    assert.equal(backlogStore.load(stateDir).items[0].state, 'in_progress');

    state.listed = false;
    await tickUntilListed(h, state, 2);
    await waitFor(async () => { await h.runnerTick(); return runnerStore.loadLedger(stateDir)['p-1']?.retries === 1; }, { message: 'the ended session to be requeued' });
    await tickUntilListed(h, state, 2);
    assert.equal(runnerStore.loadLedger(stateDir)['p-1']?.retries, 1, 'requeued once, not again on later snapshots');
    const card = backlogStore.load(stateDir).items[0];
    assert.equal(card.state, 'queued');
    assert.match(card.devLog.map((d) => d.text).join('\n') + (card.activity ?? []).map((a) => a.text).join('\n'), /session ended/);
  });
});

test('a session writing its transcript is alive even when the process list misses it', async () => {
  await withServer(true, async ({ h, stateDir, state }) => {
    await tickUntilListed(h, state, 1);
    state.listed = false;
    await tickUntilListed(h, state, 3);
    const entry = runnerStore.loadLedger(stateDir)['p-1'];
    assert.equal(entry.retries, 0);
    assert.equal(entry.liveness.missedAt, null);
    assert.equal(backlogStore.load(stateDir).items[0].state, 'in_progress');
  }, { transcript: true });
});

test('with the session guard switched off the process list is never read', async () => {
  await withServer(false, async ({ h, stateDir, state }) => {
    for (let i = 0; i < 3; i++) await h.runnerTick();
    assert.equal(state.calls, 0);
    assert.equal(runnerStore.loadLedger(stateDir)['p-1'].retries, 0);
  });
});
