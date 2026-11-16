// server/test/adapter-validation.test.js
// glmps-45: every capture adapter's extract boundary must treat upstream
// schema drift (renamed/removed field) as a validation miss - skip the record,
// report a per-adapter degraded health signal, never throw, never emit a
// bogus event. One drifted fixture + one valid control per adapter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { adapterHealth, resetAdapterHealth } from '../lib/adapters/health.js';

import * as gemini from '../lib/adapters/gemini-cli.js';
import * as codex from '../lib/adapters/codex-cli.js';
import * as copilot from '../lib/adapters/copilot-chat.js';
import * as hermes from '../lib/adapters/hermes.js';
import * as agyCli from '../lib/adapters/agy-cli.js';
import { extractClaudeEvents } from '../lib/observability/extract-claude.js';
import { extractAgEvents } from '../lib/observability/extract-antigravity.js';

let DatabaseSync = null;
try { ({ DatabaseSync } = await import('node:sqlite')); } catch {}

const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });
function mkTmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-adval-'));
  tmpDirs.push(d);
  return d;
}

function degraded(id) { return adapterHealth()[id]?.degraded === true; }


test('gemini-cli extractLine: message-shaped record missing id/type -> degraded, no event', () => {
  resetAdapterHealth();
  const drifted = JSON.stringify({ msgType: 'user', content: 'hello world', toolCalls: [] });
  const events = gemini.extractLine(drifted, 's1');
  assert.deepEqual(events, []);
  assert.equal(degraded('gemini-cli'), true);
});

test('gemini-cli extractLine: valid message -> event, not degraded', () => {
  resetAdapterHealth();
  const line = JSON.stringify({ id: 'm1', type: 'user', content: 'hello world', timestamp: 1 });
  const events = gemini.extractLine(line, 's1');
  assert.equal(events.length, 1);
  assert.equal(degraded('gemini-cli'), false);
});

test('gemini-cli extractLine: unparseable line stays silent (transient, not drift)', () => {
  resetAdapterHealth();
  assert.deepEqual(gemini.extractLine('{oops', 's1'), []);
  assert.equal(degraded('gemini-cli'), false);
});

test('gemini-cli extractSnapshot: messages array renamed -> degraded, no events', () => {
  resetAdapterHealth();
  const drifted = JSON.stringify({ msgs: [{ id: 'm1', type: 'user', content: 'hi' }] });
  const r = gemini.extractSnapshot(drifted, 's1');
  assert.deepEqual(r.events, []);
  assert.equal(degraded('gemini-cli'), true);
});

test('gemini-cli extractSnapshot: subagent skip + valid empty session are not drift', () => {
  resetAdapterHealth();
  gemini.extractSnapshot(JSON.stringify({ kind: 'subagent' }), 's1');
  gemini.extractSnapshot(JSON.stringify({ messages: [] }), 's1');
  assert.equal(degraded('gemini-cli'), false);
});



test('codex-cli extractLine: response_item payload lost its type -> degraded, no event', () => {
  resetAdapterHealth();
  const drifted = JSON.stringify({ type: 'response_item', payload: { role: 'user', content: [{ type: 'input_text', text: 'hi' }] } });
  const events = codex.extractLine(drifted, 's1');
  assert.deepEqual(events, []);
  assert.equal(degraded('codex-cli'), true);
});

test('codex-cli extractLine: token_count totals renamed -> degraded, no bogus tokens event', () => {
  resetAdapterHealth();
  codex.resetTokenState();
  const drifted = JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { usage_totals: { in: 5 } } } });
  const events = codex.extractLine(drifted, 's1');
  assert.deepEqual(events, []);
  assert.equal(degraded('codex-cli'), true);
});

test('codex-cli extractLine: valid user response_item -> event, not degraded', () => {
  resetAdapterHealth();
  const line = JSON.stringify({ type: 'response_item', timestamp: 1,
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello world' }] } });
  const events = codex.extractLine(line, 's1');
  assert.equal(events.length, 1);
  assert.equal(degraded('codex-cli'), false);
});


test('copilot-chat extractSnapshot: requests array renamed -> degraded, no events', () => {
  resetAdapterHealth();
  const r = copilot.extractSnapshot(JSON.stringify({ turns: [{ message: { text: 'hi' } }] }), 's1');
  assert.deepEqual(r.events, []);
  assert.equal(degraded('copilot-chat'), true);
});

test('copilot-chat extractSnapshot: valid session -> event, not degraded', () => {
  resetAdapterHealth();
  const r = copilot.extractSnapshot(JSON.stringify({ requests: [{ message: { text: 'hi there' } }] }), 's1');
  assert.equal(r.events.length, 1);
  assert.equal(degraded('copilot-chat'), false);
});



test('hermes extractSteps: messages table renamed -> degraded, empty result, no throw', (t) => {
  if (!DatabaseSync) return t.skip('node:sqlite not available');
  resetAdapterHealth();
  const dir = mkTmp();
  const dbPath = path.join(dir, 'state.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, model TEXT);`);
  db.exec(`CREATE TABLE msgs (id INTEGER PRIMARY KEY, session_id TEXT);`); // drifted: was `messages`
  db.close();
  const r = hermes.extractSteps(dbPath, -1, { sessionId: 'h1' });
  assert.deepEqual(r.events, []);
  assert.equal(r.lastIdx, -1);
  assert.equal(degraded('hermes'), true);
});

test('hermes extractSteps: valid schema -> events, not degraded', (t) => {
  if (!DatabaseSync) return t.skip('node:sqlite not available');
  resetAdapterHealth();
  const dir = mkTmp();
  const dbPath = path.join(dir, 'state.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, model TEXT);`);
  db.exec(`CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT,
    content TEXT, tool_calls TEXT, tool_name TEXT, timestamp REAL, reasoning TEXT, active INTEGER DEFAULT 1);`);
  db.prepare(`INSERT INTO sessions (id, title, model) VALUES (?,?,?)`).run('h1', 'T', 'm');
  db.prepare(`INSERT INTO messages (session_id, role, content, timestamp) VALUES (?,?,?,?)`)
    .run('h1', 'user', 'hello', 1781000001);
  db.close();
  const r = hermes.extractSteps(dbPath, -1, { sessionId: 'h1' });
  assert.equal(r.events.length, 1);
  assert.equal(degraded('hermes'), false);
});


test('agy-cli extractSteps: steps table missing/renamed -> degraded, empty result, no throw', (t) => {
  if (!DatabaseSync) return t.skip('node:sqlite not available');
  resetAdapterHealth();
  const dir = mkTmp();
  const dbPath = path.join(dir, 'conv.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE turns (idx INTEGER PRIMARY KEY, step_type INTEGER, step_payload BLOB);`); // drifted: was `steps`
  db.close();
  const r = agyCli.extractSteps(dbPath, -1);
  assert.deepEqual(r.events, []);
  assert.equal(degraded('agy-cli'), true);
});

test('agy-cli extractSteps: valid steps schema -> not degraded', (t) => {
  if (!DatabaseSync) return t.skip('node:sqlite not available');
  resetAdapterHealth();
  const dir = mkTmp();
  const dbPath = path.join(dir, 'conv.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, step_payload BLOB);`);
  db.prepare(`INSERT INTO steps (idx, step_type, step_payload) VALUES (?,?,?)`)
    .run(1, 15, Buffer.from('hello'));
  db.close();
  const r = agyCli.extractSteps(dbPath, -1);
  assert.equal(r.lastIdx, 1);
  assert.equal(degraded('agy-cli'), false);
});


test('claude-code extract: assistant record with message field renamed -> degraded, no event', () => {
  resetAdapterHealth();
  const drifted = JSON.stringify({ type: 'assistant', msg: { content: [{ type: 'tool_use', name: 'Bash', input: {} }] } });
  const events = extractClaudeEvents(drifted, 's1');
  assert.deepEqual(events, []);
  assert.equal(degraded('claude-code'), true);
});

test('claude-code extract: valid assistant tool_use -> event; unknown line types ignored silently', () => {
  resetAdapterHealth();
  const line = JSON.stringify({ type: 'assistant', timestamp: 1,
    message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } });
  assert.equal(extractClaudeEvents(line, 's1').length, 1);
  // A type neither 'assistant' nor 'user' (summary/system/etc.) is not a
  // shape this adapter claims to understand at all -> silently skipped, not drift.
  assert.deepEqual(extractClaudeEvents(JSON.stringify({ type: 'summary', summary: 'x' }), 's1'), []);
  assert.equal(degraded('claude-code'), false);
});

test('claude-code extract: user record with message.content missing -> degraded, no event', () => {
  resetAdapterHealth();
  const events = extractClaudeEvents(JSON.stringify({ type: 'user', message: {} }), 's1');
  assert.deepEqual(events, []);
  assert.equal(degraded('claude-code'), true);
});

test('claude-code extract: valid user prompt (string content) -> event, not degraded', () => {
  resetAdapterHealth();
  const line = JSON.stringify({ type: 'user', timestamp: 1, message: { content: 'hello world' } });
  const events = extractClaudeEvents(line, 's1');
  assert.equal(events.length, 1);
  assert.equal(events[0].tool, 'user');
  assert.equal(degraded('claude-code'), false);
});


test('antigravity extract: tool_call name field renamed -> degraded, no bogus event', () => {
  resetAdapterHealth();
  const drifted = JSON.stringify({ created_at: 1, tool_calls: [{ toolName: 'view_file', args: {} }] });
  const events = extractAgEvents(drifted, 's1');
  assert.deepEqual(events, []);
  assert.equal(degraded('antigravity'), true);
});

test('antigravity extract: valid tool_call -> event, not degraded', () => {
  resetAdapterHealth();
  const line = JSON.stringify({ created_at: 1, tool_calls: [{ name: 'run_command', args: { CommandLine: '"ls"' } }] });
  assert.equal(extractAgEvents(line, 's1').length, 1);
  assert.equal(degraded('antigravity'), false);
});
