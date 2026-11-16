// Routes under test: server/lib/routes/tap-routes.js
// server/test/tap-mirror-e2e.test.js
// The file mirror end to end (server-and-client-tap task 10): a real server on
// temp dirs, a paired client, and the real tap agent pointed at a fake client
// home. A Claude transcript on the client appears on the server as
// <clientId>:<sessionId> with events, appended lines follow, and a JSON file
// and a SQLite file arrive byte- and hash-correct.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { openClientStore } from '../lib/kernel/clients.js';
import { openTapMirror } from '../lib/kernel/tap-mirror-store.js';
import { clientMirrorDir } from '../lib/kernel/tap-mirror.js';
import { getPaths } from '../lib/paths.js';
import { startServer } from '../server.js';
import { startAgent } from '../../taps/tap-agent.js';
import { waitFor } from './helpers/wait-for.js';
import { dbFileFor } from '../lib/state-dir.js';

let sqlite = null;
try { sqlite = process.getBuiltinModule('node:sqlite'); } catch { sqlite = null; }
const SKIP = sqlite?.DatabaseSync ? false : 'node:sqlite is unavailable on this Node, so kernel.db and SQLite snapshots cannot run';

const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });
const mkTmp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); tmpDirs.push(d); return d; };
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const skillLine = (skill, ts) => JSON.stringify({ type: 'assistant', timestamp: ts, message: { content: [{ type: 'tool_use', id: `t-${skill}`, name: 'Skill', input: { skill } }] } }) + '\n';

function serverEnv() {
  const tmp = mkTmp('mc-mirror-e2e-srv-');
  const claudeDir = path.join(tmp, 'claude');
  fs.mkdirSync(path.join(claudeDir, '.claude-manager'), { recursive: true });
  fs.writeFileSync(path.join(claudeDir, '.claude-manager', 'active-sessions.json'), '[]');
  return { GLMPS_CLAUDE_DIR: claudeDir, GLMPS_ANTIGRAVITY_DIR: path.join(tmp, 'ag'), GLMPS_STATE_DIR: path.join(tmp, 'state'),
    GLMPS_GEMINI_TMP_DIR: path.join(tmp, 'gemini-tmp'), GLMPS_VSCODE_STORAGE_DIR: path.join(tmp, 'vscode-storage'),
    GLMPS_AGY_CLI_DIR: path.join(tmp, 'agy-cli'), GLMPS_CODEX_DIR: path.join(tmp, 'codex'), GLMPS_COPILOT_CLI_DIR: path.join(tmp, 'copilot-cli'),
    GLMPS_HERMES_DIR: path.join(tmp, 'hermes'), GLMPS_OPENCODE_DIR: path.join(tmp, 'opencode'), GLMPS_UNMERGED_SCAN: 'off' };
}
function clientPaths() {
  const base = mkTmp('mc-mirror-e2e-client-');
  return getPaths({ GLMPS_CLAUDE_DIR: path.join(base, '.claude'), GLMPS_ANTIGRAVITY_DIR: path.join(base, 'ag'), GLMPS_STATE_DIR: path.join(base, 'state'),
    GLMPS_GEMINI_TMP_DIR: path.join(base, 'gemini-tmp'), GLMPS_VSCODE_STORAGE_DIR: path.join(base, 'vscode'), GLMPS_AGY_CLI_DIR: path.join(base, '.gemini', 'antigravity-cli'),
    GLMPS_CODEX_DIR: path.join(base, '.codex'), GLMPS_COPILOT_CLI_DIR: path.join(base, '.copilot'), GLMPS_HERMES_DIR: path.join(base, 'hermes'), GLMPS_OPENCODE_DIR: path.join(base, 'opencode') });
}
const getJson = async (url) => (await fetch(url)).json();

test('a transcript, a JSON file and a SQLite file on a fake client arrive on a real server, and appended lines follow', { skip: SKIP }, async () => {
  const env = serverEnv();
  const srv = await startServer({ port: 0, pollMs: 50, env });
  const base = `http://127.0.0.1:${srv.port}`;
  const store = openClientStore({ dbFile: dbFileFor(env.GLMPS_STATE_DIR) });
  const inspect = openTapMirror({ dbFile: dbFileFor(env.GLMPS_STATE_DIR), stateDir: env.GLMPS_STATE_DIR });
  const P = clientPaths();
  const home = mkTmp('mc-mirror-e2e-home-');
  let agent;
  try {
    const { clientId, token } = store.pair({ name: 'laptop', actor: 'test' });
    fs.writeFileSync(path.join(home, 'tap-config.json'), JSON.stringify({ server: base, clientId, name: 'laptop' }));

    const transcript = path.join(P.claudeDir, 'projects', 'D--client-proj', 'sessE.jsonl');
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    fs.writeFileSync(transcript, skillLine('alpha:one', '2026-10-26T10:00:00Z'));
    const registry = path.join(P.claudeDir, '.claude-manager', 'active-sessions.json');
    fs.mkdirSync(path.dirname(registry), { recursive: true });
    fs.writeFileSync(registry, JSON.stringify([{ sessionId: 'sessE', ppid: 1, cwd: 'C:\\client\\proj', ts: 1 }]));
    fs.writeFileSync(path.join(P.claudeDir, '.credentials.json'), '{"claudeAiOauth":{"accessToken":"never-leaves-the-client"}}');
    const dbFile = path.join(P.agyCliDir, 'conversations', 'c1.db');
    fs.mkdirSync(path.dirname(dbFile), { recursive: true });
    const live = new sqlite.DatabaseSync(dbFile);
    live.exec('PRAGMA journal_mode = WAL; CREATE TABLE steps (idx INTEGER, body TEXT);');
    for (let i = 0; i < 20; i++) live.prepare('INSERT INTO steps VALUES (?, ?)').run(i, `step ${i}`);

    agent = await startAgent({ home, port: 0, homeDir: mkTmp('mc-mirror-e2e-user-'), intervalMs: 3_600_000, log: () => {}, readToken: () => token, paths: () => P, mirrorTickMs: 40 });
    await agent.ready;

    const id = `${clientId}:sessE`;
    const events = await waitFor(async () => {
      const ev = (await getJson(`${base}/api/state?session=${encodeURIComponent(id)}`)).events ?? [];
      return ev.some((e) => e.kind === 'skill') ? ev : null;
    }, { timeoutMs: 20_000 });
    assert.ok(events.every((e) => e.sessionId === id));
    const row = (await getJson(`${base}/api/state`)).sessions.find((s) => s.id === id);
    assert.equal(row.clientId, clientId);

    fs.appendFileSync(transcript, skillLine('beta:two', '2026-10-26T10:00:09Z'));
    await waitFor(async () => {
      const ev = (await getJson(`${base}/api/state?session=${encodeURIComponent(id)}`)).events ?? [];
      return JSON.stringify(ev).includes('beta:two');
    }, { timeoutMs: 20_000 });
    const mirrored = path.join(clientMirrorDir(env.GLMPS_STATE_DIR, clientId), 'claude', 'projects', 'D--client-proj', 'sessE.jsonl');
    assert.deepEqual(fs.readFileSync(mirrored), fs.readFileSync(transcript), 'transcript is byte-identical');

    const man = () => inspect.manifest(clientId).files;
    await waitFor(() => man()['agy-cli/conversations/c1.db'] && man()['claude/.claude-manager/active-sessions.json'], { timeoutMs: 20_000 });
    const jsonCopy = fs.readFileSync(path.join(clientMirrorDir(env.GLMPS_STATE_DIR, clientId), 'claude', '.claude-manager', 'active-sessions.json'));
    assert.deepEqual(jsonCopy, fs.readFileSync(registry), 'JSON snapshot is byte-identical');
    assert.equal(man()['claude/.claude-manager/active-sessions.json'].sha256, sha(jsonCopy));
    const dbCopyFile = path.join(clientMirrorDir(env.GLMPS_STATE_DIR, clientId), 'agy-cli', 'conversations', 'c1.db');
    const dbCopy = fs.readFileSync(dbCopyFile);
    assert.equal(man()['agy-cli/conversations/c1.db'].sha256, sha(dbCopy), 'manifest hash matches the stored SQLite bytes');
    const check = new sqlite.DatabaseSync(dbCopyFile, { readOnly: true });
    try { assert.equal(check.prepare('SELECT COUNT(*) AS n FROM steps').get().n, 20); } finally { check.close(); }
    live.close();

    assert.equal(fs.existsSync(path.join(clientMirrorDir(env.GLMPS_STATE_DIR, clientId), 'claude', '.credentials.json')), false, 'credentials never leave the client');
    assert.deepEqual(Object.keys(man()).filter((p) => /credentials/.test(p)), []);

    await agent.heartbeatOnce();
    assert.ok(store.get(clientId).dataRoots.includes('claude'), 'the heartbeat names the roots the client has');
    assert.ok(store.get(clientId).dataRoots.includes('agy-cli'));
    const status = await getJson(`http://127.0.0.1:${agent.address.port}/tap/status`);
    assert.equal(status.mirror.state, 'ok');
    assert.ok(status.mirror.shippedBytes > 0);
    assert.equal(JSON.stringify(status).includes(token), false);
  } finally {
    await agent?.close();
    inspect.closeDb(); store.closeDb(); await srv.close();
  }
});

test('close waits for a mirror pass that is still in flight', { skip: SKIP }, async () => {
  const env = serverEnv();
  const srv = await startServer({ port: 0, pollMs: 1000, env });
  const store = openClientStore({ dbFile: dbFileFor(env.GLMPS_STATE_DIR) });
  const P = clientPaths();
  const home = mkTmp('mc-mirror-e2e-home-');
  try {
    const { clientId, token } = store.pair({ name: 'laptop', actor: 'test' });
    fs.writeFileSync(path.join(home, 'tap-config.json'), JSON.stringify({ server: `http://127.0.0.1:${srv.port}`, clientId, name: 'laptop' }));
    fs.mkdirSync(path.join(P.claudeDir, 'projects', 'p'), { recursive: true });
    fs.writeFileSync(path.join(P.claudeDir, 'projects', 'p', 's.jsonl'), 'x\n');
    let release; let started = false;
    const gate = new Promise((r) => { release = r; });
    const slow = async (url, init) => { if (String(url).endsWith('/api/tap/mirror/append')) { started = true; await gate; } return fetch(url, init); };
    const agent = await startAgent({ home, port: 0, homeDir: mkTmp('mc-mirror-e2e-user-'), intervalMs: 3_600_000, log: () => {}, readToken: () => token, paths: () => P, mirrorTickMs: 20, fetch: slow });
    await agent.ready;
    await waitFor(() => started, { timeoutMs: 15_000 });
    let closed = false;
    const closing = agent.close().then(() => { closed = true; });
    for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
    assert.equal(closed, false, 'close returned while the mirror pass was in flight');
    release();
    await closing;
  } finally { store.closeDb(); await srv.close(); }
});
