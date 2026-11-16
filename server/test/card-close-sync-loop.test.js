// The card-close-sync loop wired into a real server (card glmps-2-0-85): it
// closes a closed card's recorded Claude session, never an open card's, and
// says so on the card. The process lister and killer are injected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server.js';
import * as backlogStore from '../lib/orchestration/backlog-store.js';
import { waitFor } from './helpers/wait-for.js';

function mkEnv() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-close-sync-'));
  const claudeDir = path.join(tmp, 'claude');
  fs.mkdirSync(path.join(claudeDir, '.claude-manager'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'ag', 'brain'), { recursive: true });
  return {
    tmp,
    env: {
      ...process.env,
      GLMPS_CLAUDE_DIR: claudeDir,
      GLMPS_ANTIGRAVITY_DIR: path.join(tmp, 'ag'),
      GLMPS_STATE_DIR: path.join(tmp, 'state'),
      GLMPS_GEMINI_TMP_DIR: path.join(tmp, 'gemini-tmp'),
      GLMPS_VSCODE_STORAGE_DIR: path.join(tmp, 'vscode-storage'),
      GLMPS_AGY_CLI_DIR: path.join(tmp, 'agy-cli'),
      GLMPS_CODEX_DIR: path.join(tmp, 'codex'),
      GLMPS_COPILOT_CLI_DIR: path.join(tmp, 'copilot-cli'),
      GLMPS_HERMES_DIR: path.join(tmp, 'hermes'),
      GLMPS_OPENCODE_DIR: path.join(tmp, 'opencode'),
      GLMPS_UNMERGED_SCAN: 'off',
      GLMPS_SCUT: 'off',
    },
  };
}


test('the loop closes a closed card\'s recorded session and leaves an open card\'s alone', async () => {
  const { tmp, env } = mkEnv();
  const stateDir = env.GLMPS_STATE_DIR;
  fs.mkdirSync(stateDir, { recursive: true });
  const tenMinAgo = new Date(Date.now() - 10 * 60_000).toISOString();
  const base = { project: 'p', title: 't', prompt: 'x', devLog: [] };
  backlogStore.save(stateDir, { items: [
    { ...base, id: 'p-1', state: 'done', doneAt: tenMinAgo, runSession: { sessionId: 'aaaaaaaa-0000-0000-0000-000000000001' } },
    { ...base, id: 'p-2', state: 'in_progress', runSession: { sessionId: 'aaaaaaaa-0000-0000-0000-000000000002' } },
    { ...base, id: 'p-3', state: 'done', doneAt: tenMinAgo, runSession: { sessionId: 'aaaaaaaa-0000-0000-0000-000000000003' } },
  ] });
  // Transcripts: p-1's went quiet ten minutes ago, p-3's is still being written.
  const proj = path.join(env.GLMPS_CLAUDE_DIR, 'projects', 'C--work-p');
  fs.mkdirSync(proj, { recursive: true });
  for (const [n, ageMs] of [[1, 10 * 60_000], [3, 0]]) {
    const id = `aaaaaaaa-0000-0000-0000-00000000000${n}`;
    const f = path.join(proj, `${id}.jsonl`);
    fs.writeFileSync(f, `${JSON.stringify({ type: 'user', sessionId: id, cwd: 'C:\\work\\p', timestamp: new Date().toISOString(), message: { role: 'user', content: 'go' } })}\n`);
    const t = new Date(Date.now() - ageMs);
    fs.utimesSync(f, t, t);
  }
  const configFile = path.join(tmp, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ closeSync: { enabled: true } }));
  const closed = [];
  const sessionCloser = {
    list: async () => [
      { ticketId: 'p-1', sessionId: 'aaaaaaaa-0000-0000-0000-000000000001', pid: 11, rootPid: 10 },
      { ticketId: 'p-1', sessionId: 'bbbbbbbb-0000-0000-0000-000000000009', pid: 13, rootPid: 13 },
      { ticketId: 'p-2', sessionId: 'aaaaaaaa-0000-0000-0000-000000000002', pid: 21, rootPid: 20 },
      { ticketId: 'p-3', sessionId: 'aaaaaaaa-0000-0000-0000-000000000003', pid: 31, rootPid: 30 },
    ],
    close: async (s) => { closed.push(s.rootPid); return { ok: true }; },
  };
  const srv = await startServer({ port: 0, env, configFile, pollMs: 100000, restartFn: () => {}, sessionCloser });
  try {
    const url = `http://127.0.0.1:${srv.port}`;
    assert.equal((await fetch(`${url}/api/loops/card-close-sync/run`, { method: 'POST' })).status, 202);
    const loop = await waitFor(async () => {
      const l = await (await fetch(`${url}/api/loops/card-close-sync`)).json();
      return l?.lastOutcome ? l : null;
    }, { message: 'the loop to finish a run' });
    assert.equal(loop.lastOutcome, 'done');
    assert.deepEqual(closed, [10]);
    const card = backlogStore.load(stateDir).items.find((i) => i.id === 'p-1');
    assert.match(card.devLog.at(-1).text, /closed its Claude session \(pid 11\) because the card is closed/);
  } finally { await srv.close(); }
});

test('a run requested while the card\'s session is alive adopts it instead of starting a second', async () => {
  const { tmp, env } = mkEnv();
  env.GLMPS_ALLOW_ACT = '1';
  const stateDir = env.GLMPS_STATE_DIR;
  fs.mkdirSync(stateDir, { recursive: true });
  const sid = 'cccccccc-0000-0000-0000-000000000003';
  backlogStore.save(stateDir, { items: [
    { project: 'p', title: 't', prompt: 'x', devLog: [], id: 'p-3', state: 'queued', runSession: { sessionId: sid } },
  ] });
  const configFile = path.join(tmp, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ closeSync: { enabled: true } }));
  const closed = [];
  const sessionCloser = {
    list: async () => [{ ticketId: 'p-3', sessionId: sid, pid: 31, rootPid: 30 }],
    close: async (s) => { closed.push(s.rootPid); return { ok: true }; },
  };
  const srv = await startServer({ port: 0, env, configFile, pollMs: 100000, restartFn: () => {}, sessionCloser });
  try {
    const r = await fetch(`http://127.0.0.1:${srv.port}/api/runner/run/p-3`, { method: 'POST' });
    const body = await r.json();
    assert.equal(r.status, 409, JSON.stringify(body));
    assert.match(body.error, /still running, so no second one was started/);
    assert.deepEqual(closed, [], 'an active session is never closed');
    const runner = await (await fetch(`http://127.0.0.1:${srv.port}/api/runner`)).json();
    assert.equal(runner.ledger['p-3'].pid, 31);
    assert.equal(runner.ledger['p-3'].adopted, true);
    const card = backlogStore.load(stateDir).items.find((i) => i.id === 'p-3');
    assert.equal(card.state, 'in_progress');
    assert.match(card.devLog.at(-1).text, /still running \(pid 31\), so no second one was started/);
  } finally { await srv.close(); }
});

// An idle session: its transcript (whose mtime is the session's last write)
// was last touched two hours ago.
function idleTranscript(env, sid) {
  const dir = path.join(env.GLMPS_CLAUDE_DIR, 'projects', 'D--p');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sid}.jsonl`);
  fs.writeFileSync(file, JSON.stringify({ type: 'user', sessionId: sid, cwd: 'D:\p', timestamp: new Date().toISOString(), message: { role: 'user', content: 'x' } }) + '\n');
  const old = new Date(Date.now() - 2 * 3600 * 1000);
  fs.utimesSync(file, old, old);
}

async function runIdleCase({ closeResult }) {
  const { tmp, env } = mkEnv();
  env.GLMPS_RUNNER_DRYRUN = '1';
  const stateDir = env.GLMPS_STATE_DIR;
  fs.mkdirSync(stateDir, { recursive: true });
  const sid = 'dddddddd-0000-0000-0000-000000000004';
  idleTranscript(env, sid);
  backlogStore.save(stateDir, { items: [
    { project: 'p', title: 't', prompt: 'x', devLog: [], id: 'p-4', state: 'queued', runSession: { sessionId: sid } },
  ] });
  const configFile = path.join(tmp, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ closeSync: { enabled: true } }));
  const closed = [];
  const sessionCloser = {
    list: async () => [{ ticketId: 'p-4', sessionId: sid, pid: 41, rootPid: 40 }],
    close: async (s) => { closed.push(s.rootPid); return closeResult; },
  };
  const srv = await startServer({ port: 0, env, configFile, pollMs: 100000, restartFn: () => {}, sessionCloser });
  try {
    const r = await fetch(`http://127.0.0.1:${srv.port}/api/runner/run/p-4`, { method: 'POST' });
    const runner = await (await fetch(`http://127.0.0.1:${srv.port}/api/runner`)).json();
    return { status: r.status, closed, entry: runner.ledger['p-4'] ?? null, devLog: backlogStore.load(stateDir).items.find((i) => i.id === 'p-4').devLog };
  } finally { await srv.close(); }
}

test('a run on a card whose session is idle closes that session and launches its replacement', async () => {
  const r = await runIdleCase({ closeResult: { ok: true } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.closed, [40]);
  assert.ok(r.entry && !r.entry.adopted, 'a fresh launch, not an adoption');
  assert.ok(r.devLog.some((d) => /closed this card's idle Claude session \(pid 41\) so the new launch replaces it/.test(d.text)));
});

test('an idle session that will not close blocks the launch, and the card says why', async () => {
  const r = await runIdleCase({ closeResult: { ok: false, error: 'Access is denied.' } });
  assert.equal(r.status, 409);
  assert.deepEqual(r.closed, [40]);
  assert.equal(r.entry, null, 'nothing launched beside it');
  assert.match(r.devLog.at(-1).text, /not started: its idle Claude session \(pid 41\) would not close: Access is denied\./);
});

// Card glmps-2-0-runtime-89, the 2026-10-28 shape: card 118 closed, its
// session's own transcript quiet, still building the cards it filed through
// background helpers. Nothing of that may be closed; a child nobody is on is
// promoted once (glmps-2-0-163): interactive from then on and requeued.
test('the loop keeps a session building child cards or running helpers, and promotes an orphaned child once', async () => {
  const { tmp, env } = mkEnv();
  const stateDir = env.GLMPS_STATE_DIR;
  fs.mkdirSync(stateDir, { recursive: true });
  const tenMinAgo = new Date(Date.now() - 10 * 60_000).toISOString();
  const base = { project: 'p', title: 't', prompt: 'x', devLog: [] };
  const sid = (n) => `eeeeeeee-0000-0000-0000-00000000000${n}`;
  backlogStore.save(stateDir, { items: [
    { ...base, id: 'par', state: 'done', doneAt: tenMinAgo, runSession: { sessionId: sid(1) } },
    { ...base, id: 'kid', state: 'in_progress', parentId: 'par' },
    { ...base, id: 'helped', state: 'done', doneAt: tenMinAgo, runSession: { sessionId: sid(2) } },
    { ...base, id: 'gone', state: 'done', doneAt: tenMinAgo },
    { ...base, id: 'orphan', state: 'in_progress', parentId: 'gone' },
  ] });
  const proj = path.join(env.GLMPS_CLAUDE_DIR, 'projects', 'C--work-p');
  fs.mkdirSync(proj, { recursive: true });
  const old = new Date(Date.now() - 10 * 60_000);
  for (const n of [1, 2]) {
    const f = path.join(proj, `${sid(n)}.jsonl`);
    fs.writeFileSync(f, `${JSON.stringify({ type: 'user', sessionId: sid(n), cwd: 'C:\work\p', timestamp: new Date().toISOString(), message: { role: 'user', content: 'go' } })}\n`);
    fs.utimesSync(f, old, old);
  }
  // 'helped' has no children but a helper wrote just now.
  fs.mkdirSync(path.join(proj, sid(2), 'subagents'), { recursive: true });
  fs.writeFileSync(path.join(proj, sid(2), 'subagents', 'agent-x.jsonl'), '{}\n');
  const configFile = path.join(tmp, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ closeSync: { enabled: true } }));
  const closed = [];
  const sessionCloser = {
    list: async () => [
      { ticketId: 'par', sessionId: sid(1), pid: 11, rootPid: 10 },
      { ticketId: 'helped', sessionId: sid(2), pid: 21, rootPid: 20 },
    ],
    close: async (s) => { closed.push(s.rootPid); return { ok: true }; },
  };
  const srv = await startServer({ port: 0, env, configFile, pollMs: 100000, restartFn: () => {}, sessionCloser });
  try {
    const url = `http://127.0.0.1:${srv.port}`;
    const runOnce = async (prev) => {
      assert.equal((await fetch(`${url}/api/loops/card-close-sync/run`, { method: 'POST' })).status, 202);
      return waitFor(async () => {
        const l = await (await fetch(`${url}/api/loops/card-close-sync`)).json();
        return l?.lastOutcome && l.lastRunTs !== prev ? l : null;
      }, { message: 'the loop to finish a run' });
    };
    const first = await runOnce(undefined);
    assert.deepEqual(closed, [], 'neither the parent of a working child nor a session with a busy helper is closed');
    const devLogOf = (id) => backlogStore.load(stateDir).items.find((i) => i.id === id).devLog.map((d) => d.text);
    const cardOf = (id) => backlogStore.load(stateDir).items.find((i) => i.id === id);
    assert.equal(devLogOf('orphan').length, 1);
    assert.match(devLogOf('orphan')[0], /^promoted: its host card gone is closed .*opens interactively with no Slack channel \(Slack is not connected\)\. It was being worked, so it is requeued\./);
    assert.equal(cardOf('orphan').mode, 'interactive');
    assert.equal(cardOf('orphan').promoted.from, 'gone');
    assert.equal(cardOf('orphan').state, 'queued');
    assert.deepEqual(devLogOf('kid'), [], 'a child whose parent session is live is not promoted');
    assert.equal(cardOf('kid').mode ?? null, null);
    const second = await runOnce(first.lastRunTs);
    assert.equal(devLogOf('orphan').length, 1, 'promoted once, not every sweep');
    // The child finishes: the parent's session is now closable.
    backlogStore.save(stateDir, { items: backlogStore.load(stateDir).items.map((i) => (i.id === 'kid' ? { ...i, state: 'done', doneAt: tenMinAgo } : i)) });
    await runOnce(second.lastRunTs);
    await waitFor(() => closed.includes(10), { message: 'the parent session to close once its child is done' });
    assert.equal(closed.includes(20), false);
  } finally { await srv.close(); }
});

// Card glmps-2-0-175: a run whose only news is a failure used to report
// nothing-to-do, and the registry skips the checker for nothing-to-do, so the
// failure never raised a loop alert or counted toward the diagnosis card.
test('a run that fails with nothing else to do is a loop failure, not nothing-to-do', async () => {
  const { tmp, env } = mkEnv();
  const stateDir = env.GLMPS_STATE_DIR;
  fs.mkdirSync(stateDir, { recursive: true });
  backlogStore.save(stateDir, { items: [] });
  const configFile = path.join(tmp, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ closeSync: { enabled: true } }));
  const sessionCloser = {
    list: async () => { throw new Error('process list unavailable'); },
    close: async () => ({ ok: true }),
  };
  const srv = await startServer({ port: 0, env, configFile, pollMs: 100000, restartFn: () => {}, sessionCloser });
  try {
    const url = `http://127.0.0.1:${srv.port}`;
    assert.equal((await fetch(`${url}/api/loops/card-close-sync/run`, { method: 'POST' })).status, 202);
    const loop = await waitFor(async () => {
      const l = await (await fetch(`${url}/api/loops/card-close-sync`)).json();
      return l?.lastOutcome ? l : null;
    }, { message: 'the loop to finish a run' });
    assert.equal(loop.lastOutcome, 'failed:checker:process list unavailable');
    assert.equal(loop.consecutiveFailures, 1);
    const alerts = await (await fetch(`${url}/api/alerts`)).json();
    const list = Array.isArray(alerts) ? alerts : (alerts.alerts ?? alerts.items ?? []);
    assert.ok(list.some((a) => a.source === 'loop' && a.title === 'Loop failing: card-close-sync'), `a loop alert for card-close-sync: ${JSON.stringify(list).slice(0, 400)}`);
  } finally { await srv.close(); }
});
