// server/test/antigravity-launch.test.js
// glmps-2-0-30 (D20 reopened): every AI session opens in an Antigravity editor
// terminal through the companion's request file when Antigravity can host it,
// and in a native terminal otherwise. The request file is always the
// companionRequestsFile seam here, never the real one under the home dir.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { startServer } from '../server.js';
import { claudeTmp } from './fixtures/claude-dir.js';

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const SID = '3f2a9b1c-1111-4222-8333-444455556666';

async function withServer(fn, { extraEnv = { GLMPS_RUNNER_DRYRUN: '1' }, alive = true, seam = true, config = {}, editorSpawnFn = null } = {}) {
  const stateDir = tmp('mc-aglaunch-state-');
  const claudeDir = claudeTmp();
  const requests = path.join(stateDir, 'companion', 'resume.jsonl');
  const env = { ...process.env, GLMPS_STATE_DIR: stateDir, GLMPS_CLAUDE_DIR: claudeDir, ...extraEnv };
  const configFile = path.join(stateDir, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ launchRoots: [os.tmpdir()], ...config }));
  const h = await startServer({ port: 0, env, configFile, agAliveProbe: () => alive, ...(editorSpawnFn ? { editorSpawnFn } : {}), ...(seam ? { companionRequestsFile: requests } : {}) });
  const j = async (p, opt) => {
    const r = await fetch(`http://127.0.0.1:${h.port}${p}`, { ...opt, headers: { 'content-type': 'application/json', 'x-glmps-local-session': h.localSession } });
    return { status: r.status, body: await r.json() };
  };
  const get = (p) => j(p);
  const post = (p, o) => j(p, { method: 'POST', body: JSON.stringify(o) });
  const records = () => (fs.existsSync(requests) ? fs.readFileSync(requests, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  try { await fn({ get, post, h, records, stateDir }); }
  finally {
    await h.close?.();
    fs.rmSync(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    fs.rmSync(claudeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

test('Resume with Antigravity live queues `claude --resume <id>` for the companion, no native terminal', async () => {
  const cwd = tmp('mc-aglaunch-cwd-');
  await withServer(async ({ post, h, records }) => {
    const { status, body } = await post('/api/resume', { sessionId: SID, cwd });
    assert.equal(status, 200);
    assert.equal(body.launched, 'antigravity');
    const recs = records();
    assert.equal(recs.length, 1);
    assert.equal(recs[0].type, 'terminal');
    assert.equal(recs[0].location, 'editor');
    assert.equal(recs[0].command, `claude --resume ${SID}`);
    assert.equal(path.resolve(recs[0].cwd), path.resolve(cwd));
    assert.equal(h.dryRunLaunches.length, 0);
  });
  fs.rmSync(cwd, { recursive: true, force: true });
});

test('Resume with Antigravity closed and no antigravityCommand opens a native terminal', async () => {
  await withServer(async ({ post, h, records }) => {
    const { status, body } = await post('/api/resume', { sessionId: SID });
    assert.equal(status, 200);
    assert.equal(body.launched, true);
    assert.equal(records().length, 0);
    assert.equal(h.dryRunLaunches.at(-1).command, `claude --resume ${SID}`);
  }, { alive: false });
});

test('a test process without the request-file seam never routes to the companion', async () => {
  await withServer(async ({ post, h }) => {
    const { body } = await post('/api/resume', { sessionId: SID });
    assert.equal(body.launched, true);
    assert.equal(h.dryRunLaunches.at(-1).command, `claude --resume ${SID}`);
  }, { seam: false });
});

test('New terminal with Antigravity live queues the configured command for the companion', async () => {
  const cwd = tmp('mc-aglaunch-term-');
  await withServer(async ({ post, h, records }) => {
    const { status, body } = await post('/api/terminal', { terminal: 'Claude', cwd });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.launched, 'antigravity');
    assert.equal(records().at(-1).command, 'claude');
    assert.equal(h.dryRunLaunches.length, 0);
  });
  fs.rmSync(cwd, { recursive: true, force: true });
});

test('service mode with Antigravity closed queues on the broker and writes no companion record', async () => {
  await withServer(async ({ post, records }) => {
    const { status, body } = await post('/api/resume', { sessionId: SID });
    assert.equal(status, 200);
    assert.equal(body.launched, 'queued');
    assert.equal(records().length, 0);
  }, { extraEnv: { GLMPS_SERVICE: '1' }, alive: false, config: { antigravityCommand: 'antigravity' } });
});

test('a runner job with no target preference launches in Antigravity when it is live', async () => {
  await withServer(async ({ get, post, h }) => {
    await post('/api/backlog', { acceptanceCriteria: ['launches'], title: 'job-a', prompt: 'do a' });
    await post('/api/runner/config', { enabled: true });
    await h.runnerTick();
    const launch = h.lastDryRunLaunch();
    assert.ok(launch, 'the runner launched the job');
    assert.equal(launch.target, 'antigravity');
    assert.match(launch.seeded, /--session-id \S+/);
    const ledger = (await get('/api/runner')).body.ledger;
    assert.equal(ledger['glmps-1'].launcher, 'antigravity');
  });
});

// editorSpawnFn runs launchSession's real (non-dry-run) branch against a fake;
// nothing real is ever spawned.
function fakeSpawn() {
  const calls = [];
  const fn = (file, args, options) => {
    calls.push({ file, args, options });
    const child = new EventEmitter();
    child.pid = 424242;
    child.unref = () => {};
    return child;
  };
  return { fn, calls };
}

test('a live Antigravity hosts the runner job: the seeded command is queued for the companion and nothing spawns', async () => {
  const fake = fakeSpawn();
  await withServer(async ({ get, post, h, records }) => {
    await post('/api/backlog', { acceptanceCriteria: ['launches'], title: 'job-a', prompt: 'do a' });
    await post('/api/runner/config', { enabled: true });
    await h.runnerTick();
    const recs = records();
    assert.equal(recs.length, 1);
    assert.match(recs[0].command, /^claude --session-id \S+ "Read the task described in this file/);
    assert.equal(recs[0].name, 'claude glmps-1', 'the tab names the card so a session can be tied to its ticket (card glmps-2-0-174)');
    assert.equal(fake.calls.length, 0);
    const entry = (await get('/api/runner')).body.ledger['glmps-1'];
    assert.equal(entry.launcher, 'antigravity');
    assert.equal(entry.pid, null, 'a companion-hosted session has no pid to probe');
  }, { editorSpawnFn: fake.fn });
});

test('Antigravity closed but launchable: the job is queued and the IDE is started once', async () => {
  const fake = fakeSpawn();
  await withServer(async ({ post, h, records }) => {
    await post('/api/backlog', { acceptanceCriteria: ['launches'], title: 'job-a', prompt: 'do a' });
    await post('/api/runner/config', { enabled: true });
    await h.runnerTick();
    assert.equal(records().length, 1);
    assert.equal(fake.calls.length, 1);
    assert.equal(fake.calls[0].file, 'antigravity-ide');
  }, { editorSpawnFn: fake.fn, alive: false, config: { antigravityCommand: 'antigravity-ide' } });
});

// glmps-2-0-156: a launch line the companion never drained flags its card once
// (a devlog naming the stall) and is never relaunched natively.
test('companion-launch-watch flags a launch the IDE has not picked up, once', async () => {
  const fake = fakeSpawn();
  await withServer(async ({ get, post, h, records, stateDir }) => {
    assert.equal((await h.loopRegistry.runNow('companion-launch-watch')).outcome, 'nothing-to-do', 'no request file');
    await post('/api/backlog', { acceptanceCriteria: ['launches'], title: 'job-a', prompt: 'do a' });
    await post('/api/runner/config', { enabled: true });
    await h.runnerTick();
    const [rec] = records();
    assert.equal((await h.loopRegistry.runNow('companion-launch-watch')).outcome, 'nothing-to-do', 'a fresh line is not stale');
    const requests = path.join(stateDir, 'companion', 'resume.jsonl');
    fs.writeFileSync(requests, JSON.stringify({ ...rec, ts: Date.now() - 5 * 60_000 }) + '\n');
    const run = await h.loopRegistry.runNow('companion-launch-watch');
    assert.equal(run.outcome, 'done', JSON.stringify(run));
    const card = (await get('/api/backlog/glmps-1')).body;
    const flagged = card.devLog.filter((d) => /has not opened this session/.test(d.text));
    assert.equal(flagged.length, 1);
    assert.match(flagged[0].text, /Restart Antigravity/);
    assert.equal((await h.loopRegistry.runNow('companion-launch-watch')).outcome, 'nothing-to-do', 'flagged once');
    assert.equal(records().length, 1, 'the line stays queued for the companion');
    assert.equal(fake.calls.length, 0, 'no native fallback launch');
  }, { editorSpawnFn: fake.fn });
});
