// server/test/tap-mirror-poll.test.js
// Per-client polling (server-and-client-tap task 10): the server runs its
// adapters over each client's mirror dir and namespaces every session id as
// <clientId>:<sessionId>. Local sessions are unchanged, and a client cannot
// steer a read onto the server's own disk.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openClientStore } from '../lib/kernel/clients.js';
import { clientMirrorDir } from '../lib/kernel/tap-mirror.js';
import { startServer } from '../server.js';
import { waitFor } from './helpers/wait-for.js';
import { dbFileFor } from '../lib/state-dir.js';

let sqliteOk = true;
try { if (!process.getBuiltinModule('node:sqlite')?.DatabaseSync) sqliteOk = false; } catch { sqliteOk = false; }
const SKIP = sqliteOk ? false : 'node:sqlite is unavailable on this Node, so kernel.db cannot open';

const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });
function mkEnv() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-tapmirrorpoll-')); tmpDirs.push(tmp);
  const claudeDir = path.join(tmp, 'claude');
  const projDir = path.join(claudeDir, 'projects', 'D--local');
  fs.mkdirSync(path.join(claudeDir, '.claude-manager'), { recursive: true });
  fs.mkdirSync(projDir, { recursive: true });
  fs.writeFileSync(path.join(projDir, 'local1.jsonl'), '');
  fs.writeFileSync(path.join(claudeDir, '.claude-manager', 'active-sessions.json'), '[]');
  return { tmp, env: { GLMPS_CLAUDE_DIR: claudeDir, GLMPS_ANTIGRAVITY_DIR: path.join(tmp, 'ag'), GLMPS_STATE_DIR: path.join(tmp, 'state'),
    GLMPS_GEMINI_TMP_DIR: path.join(tmp, 'gemini-tmp'), GLMPS_VSCODE_STORAGE_DIR: path.join(tmp, 'vscode-storage'),
    GLMPS_AGY_CLI_DIR: path.join(tmp, 'agy-cli'), GLMPS_CODEX_DIR: path.join(tmp, 'codex'), GLMPS_COPILOT_CLI_DIR: path.join(tmp, 'copilot-cli'),
    GLMPS_HERMES_DIR: path.join(tmp, 'hermes'), GLMPS_OPENCODE_DIR: path.join(tmp, 'opencode'), GLMPS_UNMERGED_SCAN: 'off' } };
}
const skillLine = (skill, ts = '2026-10-26T10:00:00Z') => JSON.stringify({ type: 'assistant', timestamp: ts, message: { content: [{ type: 'tool_use', id: `t-${skill}`, name: 'Skill', input: { skill } }] } }) + '\n';

// Resolves to the first truthy value, or undefined on timeout so the caller's assert names the miss.
async function until(fn, ms = 8000) {
  try { return await waitFor(fn, { timeoutMs: ms, intervalMs: 40 }); } catch { return undefined; }
}
async function withServer(fn) {
  const { tmp, env } = mkEnv();
  const srv = await startServer({ port: 0, pollMs: 50, env });
  const base = `http://127.0.0.1:${srv.port}`;
  const store = openClientStore({ dbFile: dbFileFor(env.GLMPS_STATE_DIR) });
  try { await fn({ srv, base, store, env, tmp }); } finally { store.closeDb(); await srv.close(); }
}
const mirrorFile = (env, clientId, rel) => path.join(clientMirrorDir(env.GLMPS_STATE_DIR, clientId), ...rel.split('/'));
const put = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const stateSessions = async (base) => (await (await fetch(`${base}/api/state`)).json()).sessions;
const sessionEvents = async (base, id) => (await (await fetch(`${base}/api/state?session=${encodeURIComponent(id)}`)).json()).events ?? [];

test('a Claude transcript in a client mirror shows up as <clientId>:<sessionId> with events, and local sessions are unchanged', { skip: SKIP }, async () => {
  await withServer(async ({ base, store, env }) => {
    const { clientId } = store.pair({ name: 'laptop', actor: 'test' });
    const file = mirrorFile(env, clientId, 'claude/projects/D--remote/sess1.jsonl');
    put(file, skillLine('alpha:one'));
    const id = `${clientId}:sess1`;
    const row = await until(async () => (await stateSessions(base)).find((s) => s.id === id));
    assert.ok(row, 'the namespaced session appears');
    assert.equal(row.clientId, clientId);
    assert.equal(row.tool, 'claude-code');
    const local = (await stateSessions(base)).find((s) => s.id === 'local1');
    assert.ok(local, 'the local session is still listed under its plain id');
    assert.equal('clientId' in local, false);
    const evs = await until(async () => { const e = await sessionEvents(base, id); return e.some((x) => x.kind === 'skill') ? e : null; });
    assert.ok(evs, 'events arrive');
    assert.ok(evs.every((e) => e.sessionId === id), 'every event carries the namespaced id');
    // appending to the mirrored file is tailed
    fs.appendFileSync(file, skillLine('beta:two', '2026-10-26T10:00:05Z'));
    const more = await until(async () => { const e = await sessionEvents(base, id); return JSON.stringify(e).includes('beta:two') ? e : null; });
    assert.ok(more, 'appended lines are tailed');
    assert.equal((await sessionEvents(base, 'sess1')).length, 0, 'the plain id has no events');
  });
});

test('two clients with the same session id stay separate', { skip: SKIP }, async () => {
  await withServer(async ({ base, store, env }) => {
    const a = store.pair({ name: 'a', actor: 'test' });
    const b = store.pair({ name: 'b', actor: 'test' });
    put(mirrorFile(env, a.clientId, 'claude/projects/p/same.jsonl'), skillLine('only:a'));
    put(mirrorFile(env, b.clientId, 'claude/projects/p/same.jsonl'), skillLine('only:b'));
    const ids = [`${a.clientId}:same`, `${b.clientId}:same`];
    await until(async () => { const s = await stateSessions(base); return ids.every((i) => s.some((x) => x.id === i)); });
    const ea = await until(async () => { const e = await sessionEvents(base, ids[0]); return e.length ? e : null; });
    const eb = await until(async () => { const e = await sessionEvents(base, ids[1]); return e.length ? e : null; });
    assert.ok(JSON.stringify(ea).includes('only:a') && !JSON.stringify(ea).includes('only:b'));
    assert.ok(JSON.stringify(eb).includes('only:b') && !JSON.stringify(eb).includes('only:a'));
  });
});

test('a registry entry in a client mirror cannot point the server at a file outside the mirror', { skip: SKIP }, async () => {
  await withServer(async ({ base, store, env, tmp }) => {
    const { clientId } = store.pair({ name: 'laptop', actor: 'test' });
    const secret = path.join(tmp, 'server-private.jsonl');
    put(secret, skillLine('leaked:secret'));
    put(mirrorFile(env, clientId, 'claude/.claude-manager/active-sessions.json'), JSON.stringify([{ sessionId: 'evil', ppid: process.pid, cwd: '/x', transcriptPath: secret, ts: Date.now() }]));
    put(mirrorFile(env, clientId, 'claude/projects/p/good.jsonl'), skillLine('fine:one'));
    // `good` is in the same client mirror, so by the time it is listed the poll that read `evil` has run.
    assert.ok(await until(async () => (await stateSessions(base)).find((s) => s.id === `${clientId}:good`)));
    const sessions = await stateSessions(base);
    assert.equal(sessions.some((s) => s.id === `${clientId}:evil`), false, 'the escaping entry is not a session');
    assert.equal(JSON.stringify(await sessionEvents(base, `${clientId}:evil`)).includes('leaked:secret'), false);
  });
});

test('a client mirror\'s generic adapter sessions are namespaced and live by the mtime rule, not the server\'s process probe', { skip: SKIP }, async () => {
  await withServer(async ({ base, store, env }) => {
    const { clientId } = store.pair({ name: 'laptop', actor: 'test' });
    put(mirrorFile(env, clientId, 'codex/sessions/2026/10/rollout-2026-10-26T10-00-00-abc.jsonl'),
      JSON.stringify({ timestamp: '2026-10-26T10:00:00Z', type: 'session_meta', payload: { id: 'abc', cwd: '/home/x' } }) + '\n');
    const id = `${clientId}:codex:rollout-2026-10-26T10-00-00-abc`;
    const row = await until(async () => (await stateSessions(base)).find((s) => s.id === id));
    assert.ok(row, JSON.stringify((await stateSessions(base)).map((s) => s.id)));
    assert.equal(row.tool, 'codex-cli');
    assert.equal(row.clientId, clientId);
    assert.equal(row.live, true, 'just written, so inside the mtime window');
  });
});

test('a client with no mirror dir adds nothing, and a mirror dir with no files adds nothing', { skip: SKIP }, async () => {
  await withServer(async ({ base, store, env }) => {
    const a = store.pair({ name: 'a', actor: 'test' });
    store.pair({ name: 'b', actor: 'test' });
    const c = store.pair({ name: 'c', actor: 'test' });
    fs.mkdirSync(clientMirrorDir(env.GLMPS_STATE_DIR, a.clientId), { recursive: true });
    // c is polled in the same tick as the empty a and the dir-less b, so once c's session is listed the others have been read.
    put(mirrorFile(env, c.clientId, 'claude/projects/p/only.jsonl'), skillLine('c:one'));
    assert.ok(await until(async () => (await stateSessions(base)).find((s) => s.id === `${c.clientId}:only`)));
    assert.deepEqual((await stateSessions(base)).map((s) => s.id).sort(), ['local1', `${c.clientId}:only`].sort());
  });
});

test('a client session\'s cwd never sends the server looking for guiding files on its own disk', { skip: SKIP }, async () => {
  await withServer(async ({ base, store, env, tmp }) => {
    const { clientId } = store.pair({ name: 'laptop', actor: 'test' });
    // The cwd is client-written, so it can name any server path (or a UNC share, which Windows would dial with the service's credentials).
    const serverDir = path.join(tmp, 'server-repo');
    put(path.join(serverDir, 'CLAUDE.md'), 'server-only guidance\n');
    put(mirrorFile(env, clientId, 'codex/sessions/2026/10/rollout-2026-10-26T10-00-00-cwd.jsonl'),
      JSON.stringify({ timestamp: '2026-10-26T10:00:00Z', type: 'session_meta', payload: { id: 'cwd', cwd: serverDir } }) + '\n');
    const id = `${clientId}:codex:rollout-2026-10-26T10-00-00-cwd`;
    const row = await until(async () => (await stateSessions(base)).find((s) => s.id === id));
    assert.ok(row, 'the client session is listed');
    assert.equal(row.cwd, serverDir, 'the planted cwd reached the session row');
    const body = await (await fetch(`${base}/api/state?session=${encodeURIComponent(id)}`)).json();
    assert.ok(Array.isArray(body.guiding));
    assert.equal(body.guiding.some((g) => String(g.path).startsWith(serverDir)), false, JSON.stringify(body.guiding));
    assert.equal(body.guiding.some((g) => g.scope === 'global'), false, 'the server\'s own global CLAUDE.md does not guide a client session');
  });
});

test('finalizing a client session never reads acceptance.md or CLAUDE.md from its cwd on the server disk', { skip: SKIP }, async () => {
  await withServer(async ({ base, store, env, tmp }) => {
    const { clientId } = store.pair({ name: 'laptop', actor: 'test' });
    const serverDir = path.join(tmp, 'server-repo');
    put(path.join(serverDir, 'acceptance.md'), '- [x] one\n- [ ] two\n');
    put(path.join(serverDir, 'CLAUDE.md'), 'server-only guidance\n');
    put(path.join(env.GLMPS_CLAUDE_DIR, 'CLAUDE.md'), 'server global guidance\n');
    put(mirrorFile(env, clientId, 'codex/sessions/2026/10/rollout-2026-10-26T10-00-00-fin.jsonl'),
      JSON.stringify({ timestamp: '2026-10-26T10:00:00Z', type: 'session_meta', payload: { id: 'fin', cwd: serverDir } }) + '\n');
    const id = `${clientId}:codex:rollout-2026-10-26T10-00-00-fin`;
    const listed = await until(async () => (await stateSessions(base)).find((s) => s.id === id));
    assert.equal(listed?.cwd, serverDir, 'the planted cwd reached the session row');
    const res = await fetch(`${base}/api/outcomes/finalize`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session: id }) });
    assert.equal(res.status, 200);
    const { row } = await res.json();
    assert.deepEqual(row.acceptance, { stated: null, met: null }, 'acceptance counts would be an existence/size oracle for the server path');
    assert.equal(row.unit, 'prompt-none', 'the prompt-version hash would fingerprint server CLAUDE.md files');
  });
});
