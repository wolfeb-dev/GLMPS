// Card glmps-2-0-runtime-36: the three hooks send their store writes to the
// server and fall back to the direct write only when the server is unreachable.
// Each hook runs as a real process; the "server" state dir and the hook's own
// local state dir differ, so where a row lands proves which path wrote it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startServer } from '../server.js';
import * as learningStore from '../lib/evaluation/learning-store.js';
import * as backlogStore from '../lib/orchestration/backlog-store.js';
import * as decisionStore from '../lib/observability/decision-log-store.js';
import { readQaTrends } from '../lib/observability/qa-trends-store.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const HOOKS = path.join(here, '..', '..', 'hooks');
const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });
const mkTmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-ihook-')); tmpDirs.push(d); return d; };

function serverEnv(tmp) {
  const claudeDir = path.join(tmp, 'claude');
  fs.mkdirSync(path.join(claudeDir, '.claude-manager'), { recursive: true });
  fs.writeFileSync(path.join(claudeDir, '.claude-manager', 'active-sessions.json'), '[]');
  return { GLMPS_CLAUDE_DIR: claudeDir, GLMPS_ANTIGRAVITY_DIR: path.join(tmp, 'ag'), GLMPS_STATE_DIR: path.join(tmp, 'state'),
    GLMPS_GEMINI_TMP_DIR: path.join(tmp, 'gemini-tmp'), GLMPS_VSCODE_STORAGE_DIR: path.join(tmp, 'vscode-storage'),
    GLMPS_AGY_CLI_DIR: path.join(tmp, 'agy-cli'), GLMPS_CODEX_DIR: path.join(tmp, 'codex'), GLMPS_COPILOT_CLI_DIR: path.join(tmp, 'copilot-cli'),
    GLMPS_HERMES_DIR: path.join(tmp, 'hermes'), GLMPS_OPENCODE_DIR: path.join(tmp, 'opencode'), GLMPS_UNMERGED_SCAN: 'off',
    GLMPS_ASSETS_DIR: path.join(tmp, 'assets') };
}

async function closedPort() {
  return new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}

// The hook's own world: a local state dir the server never sees.
function hookEnv(tmp, port) {
  const local = path.join(tmp, 'hook-local');
  fs.mkdirSync(path.join(local, 'home'), { recursive: true });
  return { local, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, GLMPS_PORT: String(port), GLMPS_STATE_DIR: path.join(local, 'state'),
    GLMPS_CLAUDE_DIR: path.join(local, 'claude'), GLMPS_ASSETS_DIR: path.join(local, 'assets'), HOME: path.join(local, 'home'), USERPROFILE: path.join(local, 'home'),
    GLMPS_SETTINGS_FILE: path.join(local, 'settings.json') } };
}

function runHook(script, input, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(HOOKS, script)], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out, err }));
    child.stdin.end(JSON.stringify(input));
  });
}

async function withServer(fn) {
  const tmp = mkTmp();
  const env = serverEnv(tmp);
  const srv = await startServer({ port: 0, pollMs: 1000, env });
  try { await fn({ tmp, port: srv.port, stateDir: env.GLMPS_STATE_DIR }); } finally { await srv.close(); }
}

function transcript(tmp) {
  const read = { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't', name: 'Read', input: { file_path: 'D:/x/server/lib/foo.js' } }] } };
  const last = { type: 'assistant', message: { content: [{ type: 'text', text: "I'll defer the dependency fix until the next session." }] } };
  const file = path.join(tmp, 'transcript.jsonl');
  fs.writeFileSync(file, [...Array.from({ length: 9 }, () => read), last].map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

const stopInput = (tmp) => ({ transcript_path: transcript(tmp), cwd: path.join(tmp, 'repo-a'), session_id: 'sess-1' });

test('capability-feed: gaps and the deferral ticket land in the server stores, not the hook-local ones', async () => {
  await withServer(async ({ tmp, port, stateDir }) => {
    const h = hookEnv(tmp, port);
    const r = await runHook('capability-feed.js', stopInput(tmp), h.env);
    assert.equal(r.code, 0, r.err);
    assert.ok(learningStore.load(stateDir).items.some((i) => i.source === 'gap' && i.code === 'reread-loop'), 'gap on the server');
    const t = backlogStore.load(stateDir).items.find((i) => i.source === 'deferred');
    assert.ok(t, 'ticket on the server');
    assert.equal(t.state, 'held');
    assert.equal(t.sessionId, 'sess-1');
    assert.equal(fs.existsSync(h.env.GLMPS_STATE_DIR), false, 'nothing written locally');
  });
});

test('capability-feed: with the server down the hook writes the stores directly, as before', async () => {
  const tmp = mkTmp();
  const h = hookEnv(tmp, await closedPort());
  const r = await runHook('capability-feed.js', stopInput(tmp), h.env);
  assert.equal(r.code, 0, r.err);
  assert.ok(learningStore.load(h.env.GLMPS_STATE_DIR).items.some((i) => i.code === 'reread-loop'));
  assert.ok(backlogStore.load(h.env.GLMPS_STATE_DIR).items.some((i) => i.source === 'deferred' && i.state === 'held'));
});

test('capability-feed: an HTTP error answer does not fall back to a direct write', async () => {
  const tmp = mkTmp();
  const seen = [];
  const s = http.createServer((req, res) => { seen.push(req.url); req.resume(); res.writeHead(400, { 'content-type': 'application/json' }); res.end('{"error":"no"}'); });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  try {
    const h = hookEnv(tmp, s.address().port);
    const r = await runHook('capability-feed.js', stopInput(tmp), h.env);
    assert.equal(r.code, 0, r.err);
    assert.ok(seen.includes('/api/ingest/learning-gaps') && seen.includes('/api/ingest/backlog-ticket'), seen.join(','));
    assert.equal(fs.existsSync(h.env.GLMPS_STATE_DIR), false, 'the server got it, so no local copy');
  } finally { s.closeAllConnections?.(); s.close(); }
});

function writeSettings(file, hooks) {
  fs.writeFileSync(file, JSON.stringify({ hooks: { Stop: [{ hooks: hooks.map((c) => ({ command: c })) }] } }));
}

test('decision-log: the computed row goes to the server, the settings snapshot stays local', async () => {
  await withServer(async ({ tmp, port, stateDir }) => {
    const h = hookEnv(tmp, port);
    writeSettings(h.env.GLMPS_SETTINGS_FILE, ['node a.js']);
    assert.equal((await runHook('decision-log.js', { session_id: 's' }, h.env)).code, 0);   // baseline: snapshot only
    writeSettings(h.env.GLMPS_SETTINGS_FILE, ['node a.js', 'node b.js']);
    const r = await runHook('decision-log.js', { session_id: 's' }, h.env);
    assert.equal(r.code, 0, r.err);
    const rows = decisionStore.readAll(stateDir);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].source, 'config');
    assert.equal(decisionStore.readAll(h.env.GLMPS_STATE_DIR).length, 0, 'no local row');
    assert.ok(decisionStore.loadSnapshot(h.env.GLMPS_STATE_DIR), 'snapshot is local hook state');
    assert.equal(decisionStore.loadSnapshot(stateDir), null, 'the server never sees the snapshot');
  });
});

test('decision-log: with the server down the row is appended locally', async () => {
  const tmp = mkTmp();
  const h = hookEnv(tmp, await closedPort());
  writeSettings(h.env.GLMPS_SETTINGS_FILE, ['node a.js']);
  await runHook('decision-log.js', { session_id: 's' }, h.env);
  writeSettings(h.env.GLMPS_SETTINGS_FILE, ['node a.js', 'node b.js']);
  assert.equal((await runHook('decision-log.js', { session_id: 's' }, h.env)).code, 0);
  assert.equal(decisionStore.readAll(h.env.GLMPS_STATE_DIR).length, 1);
});

const BASH_INPUT = (cwd) => ({ tool_name: 'Bash', tool_input: { command: 'npm test' }, cwd,
  tool_response: { stdout: '# tests 12\n# pass 12\n# fail 0\n', stderr: '' } });

test('qa-trends-local: a full-suite run posts its point to the server', async () => {
  await withServer(async ({ tmp, port, stateDir }) => {
    const h = hookEnv(tmp, port);
    const r = await runHook('qa-trends-local.js', BASH_INPUT(tmp), h.env);
    assert.equal(r.code, 0, r.err);
    const pts = readQaTrends(stateDir);
    assert.equal(pts.length, 1);
    assert.equal(pts[0].testCount, 12);
    assert.equal(pts[0].source, 'local');
    assert.equal(fs.existsSync(path.join(h.env.GLMPS_STATE_DIR, 'qa-trends')), false, 'nothing local');
  });
});

test('qa-trends-local: with the server down the point is appended locally', async () => {
  const tmp = mkTmp();
  const h = hookEnv(tmp, await closedPort());
  const r = await runHook('qa-trends-local.js', BASH_INPUT(tmp), h.env);
  assert.equal(r.code, 0, r.err);
  assert.equal(readQaTrends(h.env.GLMPS_STATE_DIR).length, 1);
});
