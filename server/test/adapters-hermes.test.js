// server/test/adapters-hermes.test.js
// Tests for the hermes adapter - reads the Hermes agent's SQLite store (state.db).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getPaths } from '../lib/paths.js';

// Load DatabaseSync - skip DB-backed tests if unavailable.
let DatabaseSync = null;
try { ({ DatabaseSync } = await import('node:sqlite')); } catch {}

import * as hermes from '../lib/adapters/hermes.js';
import { waitFor } from './helpers/wait-for.js';
import { dbFileFor } from '../lib/state-dir.js';

const tmpDirs = [];
process.on('exit', () => {
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
});
function mkTmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-hermes-'));
  tmpDirs.push(d);
  return d;
}

// Build a state.db with the columns the adapter reads.
function makeDb(dir) {
  const dbPath = path.join(dir, 'state.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE sessions (
    id TEXT PRIMARY KEY, source TEXT, model TEXT, title TEXT, cwd TEXT,
    started_at REAL, ended_at REAL, parent_session_id TEXT, archived INTEGER);`);
  db.exec(`CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT, content TEXT,
    tool_calls TEXT, tool_name TEXT, timestamp REAL, reasoning TEXT, active INTEGER DEFAULT 1);`);
  return { db, dbPath };
}
function addSession(db, sid, over = {}) {
  const s = { source: 'cli', model: 'anthropic/claude-opus-4.6', title: 'A session',
    cwd: 'D:\\work', started_at: 1781000000, ended_at: null, parent_session_id: null, archived: 0, ...over };
  db.prepare(`INSERT INTO sessions (id, source, model, title, cwd, started_at, ended_at, parent_session_id, archived)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(sid, s.source, s.model, s.title, s.cwd, s.started_at, s.ended_at, s.parent_session_id, s.archived);
}
// A tool call as persisted: { function: { name, arguments: <json string> } }
function tc(name, args) {
  return { id: 'call_' + name, type: 'function', function: { name, arguments: JSON.stringify(args ?? {}) } };
}
function addMsg(db, sid, m) {
  const row = { role: 'assistant', content: null, toolCalls: null, toolName: null, ts: 1781000001, reasoning: null, active: 1, ...m };
  db.prepare(`INSERT INTO messages (session_id, role, content, tool_calls, tool_name, timestamp, reasoning, active)
    VALUES (?,?,?,?,?,?,?,?)`).run(
      sid, row.role, row.content, row.toolCalls != null ? JSON.stringify(row.toolCalls) : null,
      row.toolName, row.ts, row.reasoning, row.active);
}
function skipIfNoSqlite(t) { if (!DatabaseSync) t.skip('node:sqlite not available'); }


test('paths: hermesDir honors HERMES_HOME', () => {
  const p = getPaths({ HERMES_HOME: 'D:\\work' });
  assert.equal(p.hermesDir, 'D:\\work');
});

test('paths: GLMPS_HERMES_DIR overrides HERMES_HOME', () => {
  const p = getPaths({ HERMES_HOME: 'D:\\work', GLMPS_HERMES_DIR: '/tmp/h' });
  assert.equal(p.hermesDir, '/tmp/h');
});


test('hermes detect: installed=false when state.db missing', () => {
  const tmp = mkTmp();
  const { installed, dataDirs } = hermes.detect({ hermesDir: tmp });
  assert.equal(installed, false);
  assert.deepEqual(dataDirs, [tmp]);
});

test('hermes detect: missing hermesDir -> installed false, no throw', () => {
  const { installed } = hermes.detect({});
  assert.equal(installed, false);
});

test('hermes detect: installed=true when state.db present', (t) => {
  skipIfNoSqlite(t); if (!DatabaseSync) return;
  const tmp = mkTmp();
  makeDb(tmp).db.close();
  const { installed } = hermes.detect({ hermesDir: tmp });
  assert.equal(installed, true);
});


test('hermes discover: empty when state.db missing', () => {
  const tmp = mkTmp();
  assert.deepEqual(hermes.discover({ hermesDir: tmp }), []);
});

test('hermes discover: one descriptor per session, excludes archived and children', (t) => {
  skipIfNoSqlite(t); if (!DatabaseSync) return;
  const tmp = mkTmp();
  const { db, dbPath } = makeDb(tmp);
  addSession(db, 'sid_main', { title: 'Main work' });
  addSession(db, 'sid_arch', { archived: 1 });
  addSession(db, 'sid_child', { parent_session_id: 'sid_main' });
  addMsg(db, 'sid_main', { role: 'user', content: 'hi', ts: 1781000050 });
  db.close();

  const descs = hermes.discover({ hermesDir: tmp });
  assert.equal(descs.length, 1);
  const d = descs[0];
  assert.equal(d.id, 'hermes:sid_main');
  assert.equal(d.sessionId, 'sid_main');
  assert.equal(d.tool, 'hermes');
  assert.equal(d.kind, 'sqlite-steps');
  assert.ok(d.file.endsWith('state.db'));
  assert.equal(d.label, 'Main work');
  assert.equal(d.mtimeMs, 1781000050 * 1000); // last_active in ms
});


function oneEvent(dbPath, sid) {
  const r = hermes.extractSteps(dbPath, -1, { sessionId: sid });
  assert.equal(r.events.length, 1, 'exactly one event');
  return r.events[0];
}

test('hermes extractSteps: user message -> user/feed with ts in ms', (t) => {
  skipIfNoSqlite(t); if (!DatabaseSync) return;
  const tmp = mkTmp();
  const { db, dbPath } = makeDb(tmp);
  addSession(db, 's', { title: 'T' });
  addMsg(db, 's', { role: 'user', content: 'Deploy staging', ts: 1781000123 });
  db.close();
  const ev = oneEvent(dbPath, 's');
  assert.equal(ev.kind, 'user');
  assert.equal(ev.lane, 'feed');
  assert.equal(ev.tool, 'user');
  assert.ok(ev.label.includes('Deploy'));
  assert.equal(ev.ts, 1781000123 * 1000);
  assert.equal(ev.sessionId, 's');
});

test('hermes extractSteps: user array content concatenates text', (t) => {
  skipIfNoSqlite(t); if (!DatabaseSync) return;
  const tmp = mkTmp();
  const { db, dbPath } = makeDb(tmp);
  addSession(db, 's');
  addMsg(db, 's', { role: 'user', content: JSON.stringify([{ text: 'Run ' }, { text: 'tests' }]) });
  db.close();
  assert.ok(oneEvent(dbPath, 's').label.includes('Run'));
});

test('hermes extractSteps: skill_view -> skill/context', (t) => {
  skipIfNoSqlite(t); if (!DatabaseSync) return;
  const tmp = mkTmp();
  const { db, dbPath } = makeDb(tmp);
  addSession(db, 's');
  addMsg(db, 's', { role: 'assistant', toolCalls: [tc('skill_view', { name: 'hermes-agent' })] });
  db.close();
  const ev = oneEvent(dbPath, 's');
  assert.equal(ev.kind, 'skill');
  assert.equal(ev.lane, 'context');
  assert.equal(ev.label, 'hermes-agent');
});

test('hermes extractSteps: memory tool -> memory/context', (t) => {
  skipIfNoSqlite(t); if (!DatabaseSync) return;
  const tmp = mkTmp();
  const { db, dbPath } = makeDb(tmp);
  addSession(db, 's');
  addMsg(db, 's', { role: 'assistant', toolCalls: [tc('memory', { action: 'add', content: 'remember X' })] });
  db.close();
  const ev = oneEvent(dbPath, 's');
  assert.equal(ev.kind, 'memory');
  assert.equal(ev.lane, 'context');
});

test('hermes extractSteps: write_file -> file-edit/feed with path', (t) => {
  skipIfNoSqlite(t); if (!DatabaseSync) return;
  const tmp = mkTmp();
  const { db, dbPath } = makeDb(tmp);
  addSession(db, 's');
  addMsg(db, 's', { role: 'assistant', toolCalls: [tc('write_file', { path: 'D:/proj/main.py', content: 'x=1' })] });
  db.close();
  const ev = oneEvent(dbPath, 's');
  assert.equal(ev.kind, 'file-edit');
  assert.equal(ev.lane, 'feed');
  assert.equal(ev.path, 'D:/proj/main.py');
});

test('hermes extractSteps: read_file -> tool/feed with path', (t) => {
  skipIfNoSqlite(t); if (!DatabaseSync) return;
  const tmp = mkTmp();
  const { db, dbPath } = makeDb(tmp);
  addSession(db, 's');
  addMsg(db, 's', { role: 'assistant', toolCalls: [tc('read_file', { path: 'D:/proj/config.yaml' })] });
  db.close();
  const ev = oneEvent(dbPath, 's');
  assert.equal(ev.kind, 'tool');
  assert.equal(ev.lane, 'feed');
  assert.equal(ev.path, 'D:/proj/config.yaml');
});

test('hermes extractSteps: read SOUL.md -> context-file/context read', (t) => {
  skipIfNoSqlite(t); if (!DatabaseSync) return;
  const tmp = mkTmp();
  const { db, dbPath } = makeDb(tmp);
  addSession(db, 's');
  addMsg(db, 's', { role: 'assistant', toolCalls: [tc('read_file', { path: 'D:/work/SOUL.md' })] });
  db.close();
  const ev = oneEvent(dbPath, 's');
  assert.equal(ev.kind, 'context-file');
  assert.equal(ev.lane, 'context');
  assert.equal(ev.op, 'read');
});

test('hermes extractSteps: write to memories/ path -> memory/context write', (t) => {
  skipIfNoSqlite(t); if (!DatabaseSync) return;
  const tmp = mkTmp();
  const { db, dbPath } = makeDb(tmp);
  addSession(db, 's');
  addMsg(db, 's', { role: 'assistant', toolCalls: [tc('write_file', { path: 'D:/work/memories/notes.md', content: 'x' })] });
  db.close();
  const ev = oneEvent(dbPath, 's');
  assert.equal(ev.kind, 'memory');
  assert.equal(ev.lane, 'context');
  assert.equal(ev.op, 'write');
});

test('hermes extractSteps: terminal git command -> git event', (t) => {
  skipIfNoSqlite(t); if (!DatabaseSync) return;
  const tmp = mkTmp();
  const { db, dbPath } = makeDb(tmp);
  addSession(db, 's');
  addMsg(db, 's', { role: 'assistant', toolCalls: [tc('terminal', { command: 'git commit -m "feat: x"' })] });
  db.close();
  const ev = oneEvent(dbPath, 's');
  assert.equal(ev.kind, 'git');
});

test('hermes extractSteps: terminal non-git -> command/feed', (t) => {
  skipIfNoSqlite(t); if (!DatabaseSync) return;
  const tmp = mkTmp();
  const { db, dbPath } = makeDb(tmp);
  addSession(db, 's');
  addMsg(db, 's', { role: 'assistant', toolCalls: [tc('terminal', { command: 'npm test' })] });
  db.close();
  const ev = oneEvent(dbPath, 's');
  assert.equal(ev.kind, 'command');
  assert.equal(ev.tool, 'terminal');
  assert.ok(ev.label.includes('npm test'));
});

test('hermes extractSteps: execute_code -> command/feed', (t) => {
  skipIfNoSqlite(t); if (!DatabaseSync) return;
  const tmp = mkTmp();
  const { db, dbPath } = makeDb(tmp);
  addSession(db, 's');
  addMsg(db, 's', { role: 'assistant', toolCalls: [tc('execute_code', { code: 'import os\nprint(1)' })] });
  db.close();
  const ev = oneEvent(dbPath, 's');
  assert.equal(ev.kind, 'command');
  assert.equal(ev.tool, 'execute_code');
});

test('hermes extractSteps: delegate_task -> agent/context', (t) => {
  skipIfNoSqlite(t); if (!DatabaseSync) return;
  const tmp = mkTmp();
  const { db, dbPath } = makeDb(tmp);
  addSession(db, 's');
  addMsg(db, 's', { role: 'assistant', toolCalls: [tc('delegate_task', { goal: 'investigate flake' })] });
  db.close();
  const ev = oneEvent(dbPath, 's');
  assert.equal(ev.kind, 'agent');
  assert.equal(ev.lane, 'context');
  assert.ok(ev.label.toLowerCase().includes('investigate'));
});

test('hermes extractSteps: assistant reasoning -> thinking event', (t) => {
  skipIfNoSqlite(t); if (!DatabaseSync) return;
  const tmp = mkTmp();
  const { db, dbPath } = makeDb(tmp);
  addSession(db, 's');
  addMsg(db, 's', { role: 'assistant', reasoning: 'Thinking about the design here', toolCalls: [tc('read_file', { path: 'a.py' })] });
  db.close();
  const r = hermes.extractSteps(dbPath, -1, { sessionId: 's' });
  const think = r.events.find(e => e.kind === 'thinking');
  assert.ok(think, 'a thinking event is emitted');
  assert.ok(r.events.some(e => e.kind === 'tool'), 'tool event also emitted');
});

test('hermes extractSteps: role=tool result is skipped', (t) => {
  skipIfNoSqlite(t); if (!DatabaseSync) return;
  const tmp = mkTmp();
  const { db, dbPath } = makeDb(tmp);
  addSession(db, 's');
  addMsg(db, 's', { role: 'tool', content: '{"output":"ok"}', toolName: 'terminal' });
  db.close();
  assert.equal(hermes.extractSteps(dbPath, -1, { sessionId: 's' }).events.length, 0);
});

test('hermes extractSteps: filters by session and active=1, incremental on id', (t) => {
  skipIfNoSqlite(t); if (!DatabaseSync) return;
  const tmp = mkTmp();
  const { db, dbPath } = makeDb(tmp);
  addSession(db, 'a'); addSession(db, 'b');
  addMsg(db, 'a', { role: 'user', content: 'a-first' });          // id 1
  addMsg(db, 'b', { role: 'user', content: 'b-other' });          // id 2 (other session)
  addMsg(db, 'a', { role: 'user', content: 'a-undone', active: 0 }); // id 3 (inactive)
  addMsg(db, 'a', { role: 'user', content: 'a-second' });         // id 4
  db.close();

  const r1 = hermes.extractSteps(dbPath, -1, { sessionId: 'a' });
  assert.equal(r1.events.length, 2); // a-first, a-second (b + inactive excluded)
  assert.equal(r1.lastIdx, 4);

  const r2 = hermes.extractSteps(dbPath, 1, { sessionId: 'a' });
  assert.equal(r2.events.length, 1);
  assert.ok(r2.events[0].label.includes('a-second'));
});

test('hermes extractSteps: returns session title on first read', (t) => {
  skipIfNoSqlite(t); if (!DatabaseSync) return;
  const tmp = mkTmp();
  const { db, dbPath } = makeDb(tmp);
  addSession(db, 's', { title: 'Adding Google Gemini API Key' });
  addMsg(db, 's', { role: 'user', content: 'hi' });
  db.close();
  assert.equal(hermes.extractSteps(dbPath, -1, { sessionId: 's' }).title, 'Adding Google Gemini API Key');
});

test('hermes extractSteps: missing db -> empty, no throw', () => {
  const r = hermes.extractSteps('/nonexistent/state.db', -1, { sessionId: 'x' });
  assert.deepEqual(r.events, []);
  assert.equal(r.lastIdx, -1);
});

// A client mirror uploads state.db, so its schema is attacker-controlled: a VIEW
// named like a real table (or a trigger) can carry a recursive CTE that never ends
// and would freeze the poll loop. The adapter must refuse such a file before querying.
const RECURSIVE_SESSIONS_VIEW = `CREATE VIEW sessions AS
  WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r WHERE n < 3)
  SELECT 'evil' || n AS id, '/x' AS cwd, 't' AS title, 'm' AS model, 1781000000 AS started_at,
         NULL AS ended_at, NULL AS parent_session_id, 0 AS archived FROM r`;
function makeHostileDb(dir, ddl) {
  const dbPath = path.join(dir, 'state.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT, content TEXT,
    tool_calls TEXT, tool_name TEXT, timestamp REAL, reasoning TEXT, active INTEGER DEFAULT 1);`);
  db.exec(ddl);
  return { db, dbPath };
}

test('hermes discover: a sessions VIEW is rejected before querying', (t) => {
  skipIfNoSqlite(t);
  const tmp = mkTmp();
  const { db, dbPath } = makeHostileDb(tmp, RECURSIVE_SESSIONS_VIEW);
  db.close();
  assert.deepEqual(hermes.discover({ hermesDir: tmp }), []);
  assert.deepEqual(hermes.extractSteps(dbPath, -1, { sessionId: 'evil1' }).events, []);
});

test('hermes discover: an extra view beside real tables is rejected', (t) => {
  skipIfNoSqlite(t);
  const tmp = mkTmp();
  const { db } = makeDb(tmp);
  addSession(db, 's1');
  db.exec(`CREATE VIEW extra AS WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r) SELECT n FROM r`);
  db.close();
  assert.deepEqual(hermes.discover({ hermesDir: tmp }), []);
});

test('hermes discover: an unknown trigger is rejected', (t) => {
  skipIfNoSqlite(t);
  const tmp = mkTmp();
  const { db } = makeDb(tmp);
  addSession(db, 's1');
  db.exec(`CREATE TRIGGER evil AFTER INSERT ON sessions BEGIN
    SELECT COUNT(*) FROM (WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r) SELECT n FROM r); END`);
  db.close();
  assert.deepEqual(hermes.discover({ hermesDir: tmp }), []);
});

test('hermes discover: the real Hermes schema (FTS tables, indexes, sync triggers) is still read', (t) => {
  skipIfNoSqlite(t);
  const tmp = mkTmp();
  const { db } = makeDb(tmp);
  addSession(db, 's1');
  db.exec(`CREATE INDEX idx_messages_session ON messages(session_id);
    CREATE TABLE schema_version (version INTEGER);
    CREATE VIRTUAL TABLE messages_fts USING fts5(content);
    CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages BEGIN INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content); END;
    CREATE TRIGGER messages_fts_delete AFTER DELETE ON messages BEGIN DELETE FROM messages_fts WHERE rowid = old.id; END;
    CREATE TRIGGER messages_fts_update AFTER UPDATE ON messages BEGIN UPDATE messages_fts SET content = new.content WHERE rowid = new.id; END;`);
  addMsg(db, 's1', { role: 'user', content: 'hi' });
  db.close();
  const descs = hermes.discover({ hermesDir: tmp });
  assert.deepEqual(descs.map((d) => d.sessionId), ['s1']);
  assert.equal(hermes.extractSteps(descs[0].file, -1, descs[0]).events.length, 1);
});

test('a hostile hermes state.db in a client mirror is skipped and does not block the rest of the mirror poll', async (t) => {
  skipIfNoSqlite(t);
  const { startServer } = await import('../server.js');
  const { openClientStore } = await import('../lib/kernel/clients.js');
  const { clientMirrorDir } = await import('../lib/kernel/tap-mirror.js');
  const tmp = mkTmp();
  const env = { GLMPS_CLAUDE_DIR: path.join(tmp, 'claude'), GLMPS_ANTIGRAVITY_DIR: path.join(tmp, 'ag'), GLMPS_STATE_DIR: path.join(tmp, 'state'),
    GLMPS_GEMINI_TMP_DIR: path.join(tmp, 'gemini-tmp'), GLMPS_VSCODE_STORAGE_DIR: path.join(tmp, 'vscode-storage'),
    GLMPS_AGY_CLI_DIR: path.join(tmp, 'agy-cli'), GLMPS_CODEX_DIR: path.join(tmp, 'codex'), GLMPS_COPILOT_CLI_DIR: path.join(tmp, 'copilot-cli'),
    GLMPS_HERMES_DIR: path.join(tmp, 'hermes'), GLMPS_OPENCODE_DIR: path.join(tmp, 'opencode'), GLMPS_UNMERGED_SCAN: 'off' };
  fs.mkdirSync(path.join(env.GLMPS_CLAUDE_DIR, '.claude-manager'), { recursive: true });
  fs.writeFileSync(path.join(env.GLMPS_CLAUDE_DIR, '.claude-manager', 'active-sessions.json'), '[]');
  const srv = await startServer({ port: 0, pollMs: 50, env });
  const store = openClientStore({ dbFile: dbFileFor(env.GLMPS_STATE_DIR) });
  try {
    const { clientId } = store.pair({ name: 'laptop', actor: 'test' });
    const mirror = clientMirrorDir(env.GLMPS_STATE_DIR, clientId);
    const hermesDir = path.join(mirror, 'hermes');
    fs.mkdirSync(hermesDir, { recursive: true });
    makeHostileDb(hermesDir, RECURSIVE_SESSIONS_VIEW).db.close();
    // Codex is discovered after hermes in the same poll, so once it is listed the hermes file has been read.
    const codexFile = path.join(mirror, 'codex', 'sessions', '2026', '10', 'rollout-2026-10-26T10-00-00-abc.jsonl');
    fs.mkdirSync(path.dirname(codexFile), { recursive: true });
    fs.writeFileSync(codexFile, JSON.stringify({ timestamp: '2026-10-26T10:00:00Z', type: 'session_meta', payload: { id: 'abc', cwd: '/home/x' } }) + '\n');
    const base = `http://127.0.0.1:${srv.port}`;
    const codexId = `${clientId}:codex:rollout-2026-10-26T10-00-00-abc`;
    let ids = [];
    await waitFor(async () => {
      ids = (await (await fetch(`${base}/api/state`)).json()).sessions.map((s) => s.id);
      return ids.includes(codexId);
    }, { intervalMs: 40, message: 'the sibling codex session' }).catch(() => {});
    assert.ok(ids.includes(codexId), `the sibling session is listed: ${JSON.stringify(ids)}`);
    assert.equal(ids.some((id) => id.includes('evil')), false, 'no session comes out of the hostile view');
  } finally { store.closeDb(); await srv.close(); }
});
