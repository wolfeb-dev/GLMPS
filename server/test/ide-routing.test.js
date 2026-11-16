// server/test/ide-routing.test.js
// glmps-2-0-218: a session opens in whichever VS Code family IDE the operator
// picked, through that IDE's own request file; a closed IDE is started; one that
// cannot host it falls back to a native terminal with a devlog line. Request
// files, process probes, install detection and spawns are all seams here.
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
const HOME = 'C:\\h';
const detectOnly = (...names) => ({ home: HOME, programFiles: [], exists: (p) => names.some((n) => String(p).endsWith(n)), readdir: () => [] });
// The same installs, each IDE in `ides` also carrying the GLMPS companion.
const withCompanion = (ides, detect) => ({ ...detect, readdir: (dir) => (ides.some((id) => String(dir).includes(`.${id}\\`)) ? ['glmps.glmps-companion-2.0.0'] : []) });
const VSCODE = 'Microsoft VS Code\\bin\\code.cmd';
const CURSOR = 'cursor\\resources\\app\\bin\\cursor.cmd';

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

async function withServer(fn, { live = [], detect = detectOnly(), env: extraEnv = {}, spawn = fakeSpawn(), config = {} } = {}) {
  const stateDir = tmp('mc-iderouting-state-');
  const claudeDir = claudeTmp();
  const requestsDir = path.join(stateDir, 'companion');
  const env = { ...process.env, GLMPS_STATE_DIR: stateDir, GLMPS_CLAUDE_DIR: claudeDir, GLMPS_RUNNER_DRYRUN: '1', ...extraEnv };
  const configFile = path.join(stateDir, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ launchRoots: [os.tmpdir()], ...config }));
  const h = await startServer({
    port: 0, env, configFile, liveIdesProbe: () => live, editorDetect: detect, editorSpawnFn: spawn.fn,
    companionRequestsFile: path.join(requestsDir, 'resume.jsonl'),
  });
  const j = async (p, opt) => {
    const r = await fetch(`http://127.0.0.1:${h.port}${p}`, { ...opt, headers: { 'content-type': 'application/json', 'x-glmps-local-session': h.localSession } });
    return { status: r.status, body: await r.json() };
  };
  const post = (p, o) => j(p, { method: 'POST', body: JSON.stringify(o) });
  const records = (name) => {
    const f = path.join(requestsDir, name);
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  };
  try { await fn({ get: j, post, h, records, stateDir, spawn }); }
  finally {
    await h.close?.();
    fs.rmSync(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    fs.rmSync(claudeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

test('a live Cursor picked as the session target hosts Resume through its own request file', async () => {
  const cwd = tmp('mc-iderouting-cwd-');
  await withServer(async ({ post, records, spawn }) => {
    await post('/api/runner/config', { lastTarget: 'cursor' });
    const { status, body } = await post('/api/resume', { sessionId: SID, cwd });
    assert.equal(status, 200);
    assert.equal(body.launched, 'cursor');
    const recs = records('resume.cursor.jsonl');
    assert.equal(recs.length, 1);
    assert.equal(recs[0].target, 'cursor');
    assert.equal(recs[0].command, `claude --resume ${SID}`);
    assert.equal(records('resume.jsonl').length, 0, 'the antigravity queue is untouched');
    assert.equal(spawn.calls.length, 0, 'it is already running, nothing is started');
  }, { live: ['cursor'], detect: withCompanion(['cursor'], detectOnly()) });
  fs.rmSync(cwd, { recursive: true, force: true });
});

test('a closed VS Code that is installed is started and the request is queued first', async () => {
  const cwd = tmp('mc-iderouting-cwd-');
  await withServer(async ({ post, records, spawn }) => {
    await post('/api/runner/config', { lastTarget: 'vscode' });
    const { body } = await post('/api/resume', { sessionId: SID, cwd });
    assert.equal(body.launched, 'vscode');
    assert.equal(records('resume.vscode.jsonl').length, 1);
    assert.equal(spawn.calls.length, 1);
    assert.match(spawn.calls[0].file, /code\.cmd"?$/);
  }, { detect: withCompanion(['vscode'], detectOnly(VSCODE)) });
  fs.rmSync(cwd, { recursive: true, force: true });
});

test('a picked IDE that is not installed opens a native terminal and the runner card says why', async () => {
  await withServer(async ({ get, post, h, records }) => {
    await post('/api/runner/config', { lastTarget: 'cursor', enabled: true });
    await post('/api/backlog', { acceptanceCriteria: ['launches'], title: 'job-a', prompt: 'do a' });
    await h.runnerTick();
    assert.equal((await get('/api/runner')).body.ledger['glmps-1'].launcher, 'native-terminal');
    assert.equal(records('resume.cursor.jsonl').length, 0);
    const card = (await get('/api/backlog/glmps-1')).body;
    const lines = card.devLog.filter((d) => /^opened in a native terminal: /.test(d.text));
    assert.equal(lines.length, 1);
    assert.equal(lines[0].text, 'opened in a native terminal: Cursor is not installed');
  });
});

test('a runner card in an installed Cursor that is not running queues in its file, no devlog fallback line', async () => {
  await withServer(async ({ get, post, h, records, spawn }) => {
    await post('/api/runner/config', { lastTarget: 'cursor', enabled: true });
    await post('/api/backlog', { acceptanceCriteria: ['launches'], title: 'job-a', prompt: 'do a' });
    await h.runnerTick();
    const [rec] = records('resume.cursor.jsonl');
    assert.match(rec.command, /^claude --session-id \S+ "Read the task/);
    assert.equal(spawn.calls.length, 1, 'the closed IDE is started once');
    const card = (await get('/api/backlog/glmps-1')).body;
    assert.equal(card.devLog.some((d) => /opened in a native terminal/.test(d.text)), false);
  }, { detect: withCompanion(['cursor'], detectOnly(CURSOR)) });
});

test('a running VS Code without the GLMPS companion opens a native terminal and the card says why', async () => {
  await withServer(async ({ get, post, h, records, spawn }) => {
    await post('/api/runner/config', { lastTarget: 'vscode', enabled: true });
    await post('/api/backlog', { acceptanceCriteria: ['launches'], title: 'job-a', prompt: 'do a' });
    await h.runnerTick();
    assert.equal((await get('/api/runner')).body.ledger['glmps-1'].launcher, 'native-terminal');
    assert.equal(records('resume.vscode.jsonl').length, 0, 'nothing is queued where no companion drains it');
    assert.equal(spawn.calls.some((c) => /code\.cmd/.test(String(c.file))), false, 'VS Code is not started');
    const card = (await get('/api/backlog/glmps-1')).body;
    const lines = card.devLog.filter((d) => /^opened in a native terminal: /.test(d.text)).map((d) => d.text);
    assert.deepEqual(lines, ['opened in a native terminal: VS Code is missing the GLMPS companion']);
  }, { live: ['vscode'], detect: detectOnly(VSCODE) });
});

test('service mode queues an editor start for the desktop shell when the picked IDE is the Open-files IDE', async () => {
  const cwd = tmp('mc-iderouting-cwd-');
  await withServer(async ({ post, records, stateDir, spawn }) => {
    await post('/api/runner/config', { lastTarget: 'vscode', openTarget: 'vscode' });
    const { body } = await post('/api/resume', { sessionId: SID, cwd });
    assert.equal(body.launched, 'vscode');
    assert.equal(records('resume.vscode.jsonl').length, 1);
    const rows = JSON.parse(fs.readFileSync(path.join(stateDir, 'launches', 'queue.json'), 'utf8')).filter((q) => q.origin === 'editor');
    assert.equal(rows.length, 1);
    assert.equal(path.resolve(rows[0].path), path.resolve(cwd));
    assert.equal(spawn.calls.length, 0, 'session 0 never spawns an editor');
  }, { detect: withCompanion(['vscode'], detectOnly(VSCODE)), env: { GLMPS_SERVICE: '1' } });
  fs.rmSync(cwd, { recursive: true, force: true });
});

test('service mode cannot start a closed IDE the shell is not set up to open, so it falls back', async () => {
  await withServer(async ({ post, records }) => {
    await post('/api/runner/config', { lastTarget: 'vscode', openTarget: 'cursor' });
    const { body } = await post('/api/resume', { sessionId: SID });
    assert.equal(body.launched, 'queued', 'queued on the broker as a native launch');
    assert.equal(records('resume.vscode.jsonl').length, 0);
  }, { detect: withCompanion(['vscode', 'cursor'], detectOnly(VSCODE, CURSOR)), env: { GLMPS_SERVICE: '1' } });
});
