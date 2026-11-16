// server/test/adapters-gemini.test.js
// Fixture-based tests for the deepened gemini-cli adapter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as gemini from '../lib/adapters/gemini-cli.js';

const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });
function mkTmp() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-gem-')); tmpDirs.push(d); return d; }
function makeP(geminiTmpDir) { return { geminiTmpDir }; }


test('gemini detect: installed=false when dir missing', () => {
  assert.equal(gemini.detect(makeP(path.join(os.tmpdir(), 'nope-gem-xyz'))).installed, false);
});

test('gemini detect: installed=false when dir empty', () => {
  assert.equal(gemini.detect(makeP(mkTmp())).installed, false);
});

test('gemini detect: installed=true with a subdir', () => {
  const tmp = mkTmp();
  fs.mkdirSync(path.join(tmp, 'some-project'));
  const { installed, dataDirs } = gemini.detect(makeP(tmp));
  assert.equal(installed, true);
  assert.deepEqual(dataDirs, [tmp]);
});


test('gemini mapToolName: known names map to common names', () => {
  assert.equal(gemini.mapToolName('read_file'), 'Read');
  assert.equal(gemini.mapToolName('write_file'), 'Write');
  assert.equal(gemini.mapToolName('replace'), 'Edit');
  assert.equal(gemini.mapToolName('run_shell_command'), 'Bash');
  assert.equal(gemini.mapToolName('search_file_content'), 'Grep');
  assert.equal(gemini.mapToolName('unknown_x'), 'unknown_x');
});


test('gemini discover: empty when tmp dir missing', () => {
  assert.deepEqual(gemini.discover(makeP(path.join(os.tmpdir(), 'nope-xyz'))), []);
});

test('gemini discover: .json -> json-snapshot, .jsonl -> jsonl-tail, ignores others', () => {
  const tmp = mkTmp();
  const chatsDir = path.join(tmp, 'proj', 'chats');
  fs.mkdirSync(chatsDir, { recursive: true });
  fs.writeFileSync(path.join(chatsDir, 'session-1.json'), '{}');
  fs.writeFileSync(path.join(chatsDir, 'session-2.jsonl'), '');
  fs.writeFileSync(path.join(chatsDir, 'readme.txt'), 'x');

  const descs = gemini.discover(makeP(tmp));
  assert.equal(descs.length, 2);
  const byKind = Object.fromEntries(descs.map(d => [d.kind, d]));
  assert.ok(byKind['json-snapshot'].file.endsWith('.json'));
  assert.ok(byKind['jsonl-tail'].file.endsWith('.jsonl'));
});

test('gemini discover: reads cwd from <hash>/.project_root', () => {
  const tmp = mkTmp();
  const projectDir = path.join(tmp, 'abc123');
  const chatsDir = path.join(projectDir, 'chats');
  fs.mkdirSync(chatsDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, '.project_root'), '/home/user/realproj\n');
  fs.writeFileSync(path.join(chatsDir, 'session-1.json'), '{}');

  const descs = gemini.discover(makeP(tmp));
  assert.equal(descs.length, 1);
  assert.equal(descs[0].cwd, '/home/user/realproj');
});


test('gemini extractLine: user message -> user feed event', () => {
  const line = JSON.stringify({ id: 'm1', timestamp: 't', type: 'user', content: [{ text: 'Hello Gemini' }] });
  const evs = gemini.extractLine(line, 'sid');
  assert.equal(evs.length, 1);
  assert.equal(evs[0].tool, 'user');
  assert.ok(evs[0].label.includes('Hello Gemini'));
});

test('gemini extractLine: gemini toolCalls map names + kinds (read/edit/shell)', () => {
  const line = JSON.stringify({
    id: 'm2', timestamp: 't', type: 'gemini', content: '',
    toolCalls: [
      { id: 'a', name: 'read_file', args: { absolute_path: '/x/a.js' } },
      { id: 'b', name: 'write_file', args: { file_path: '/x/b.js' } },
      { id: 'c', name: 'run_shell_command', args: { command: 'npm test' } },
    ],
  });
  const evs = gemini.extractLine(line, 'sid');
  assert.equal(evs.length, 3);

  const read = evs[0];
  assert.equal(read.kind, 'tool');
  assert.equal(read.tool, 'Read');
  assert.equal(read.path, '/x/a.js');

  const write = evs[1];
  assert.equal(write.kind, 'file-edit');
  assert.equal(write.tool, 'Write');
  assert.equal(write.path, '/x/b.js');

  const shell = evs[2];
  assert.equal(shell.kind, 'command');
  assert.equal(shell.tool, 'Bash');
  assert.ok(shell.label.includes('npm test'));
});

test('gemini extractLine: shell toolCall with git -> git event', () => {
  const line = JSON.stringify({
    id: 'm3', timestamp: 't', type: 'gemini', content: '',
    toolCalls: [{ id: 'g', name: 'shell', args: { command: 'git commit -m "wip: stuff"' } }],
  });
  const evs = gemini.extractLine(line, 'sid');
  assert.equal(evs.length, 1);
  assert.equal(evs[0].kind, 'git');
  assert.equal(evs[0].gitOp, 'commit');
});

test('gemini extractLine: thoughts -> thinking events', () => {
  const line = JSON.stringify({
    id: 'm4', timestamp: 't', type: 'gemini', content: '',
    thoughts: [{ subject: 'Planning', description: 'read the file first' }],
  });
  const evs = gemini.extractLine(line, 'sid');
  assert.equal(evs.length, 1);
  assert.equal(evs[0].kind, 'thinking');
  assert.ok(evs[0].label.includes('Planning'));
});

test('gemini extractLine: tokens -> tokens event with change', () => {
  const line = JSON.stringify({
    id: 'm5', timestamp: 't', type: 'gemini', content: '',
    tokens: { input: 100, output: 50, cached: 10 },
  });
  const evs = gemini.extractLine(line, 'sid');
  assert.equal(evs.length, 1);
  assert.equal(evs[0].kind, 'tokens');
  assert.equal(evs[0].change.input, 100);
  assert.equal(evs[0].change.output, 50);
  assert.equal(evs[0].change.cached, 10);
});

test('gemini extractLine: gemini message with model -> emits model meta event (closes the model GAP)', () => {
  const line = JSON.stringify({
    id: 'm7', timestamp: 't', type: 'gemini', model: 'gemini-2.5-pro',
    toolCalls: [{ id: 'a', name: 'read_file', args: { file_path: '/x' } }],
  });
  const evs = gemini.extractLine(line, 'sid');
  const meta = evs.find(e => e.kind === 'meta' && e.label === 'model');
  assert.ok(meta, 'emits a model meta event');
  assert.equal(meta.model, 'gemini-2.5-pro');
});

test('gemini extractLine: gemini with no actionable content -> no events', () => {
  const line = JSON.stringify({ id: 'm6', timestamp: 't', type: 'gemini', content: 'Done.' });
  assert.equal(gemini.extractLine(line, 'sid').length, 0);
});

test('gemini extractLine: $set metadata line -> no events', () => {
  assert.equal(gemini.extractLine(JSON.stringify({ '$set': { x: 1 } }), 'sid').length, 0);
});

test('gemini extractLine: malformed JSON -> no throw, no events', () => {
  assert.doesNotThrow(() => assert.equal(gemini.extractLine('not json', 'sid').length, 0));
});


test('gemini extractSnapshot: parses messages + title from first user message', () => {
  const snap = JSON.stringify({
    sessionId: 'abc',
    messages: [
      { id: 'm1', timestamp: 't', type: 'user', content: [{ text: 'Set up the project' }] },
      { id: 'm2', timestamp: 't', type: 'gemini', content: '', toolCalls: [{ id: 'a', name: 'read_file', args: { file_path: '/x' } }] },
    ],
  });
  const r = gemini.extractSnapshot(snap, 'sid');
  assert.equal(r.title, 'Set up the project');
  assert.ok(r.events.some(e => e.tool === 'user'));
  assert.ok(r.events.some(e => e.tool === 'Read'));
});

test('gemini extractSnapshot: surfaces the model as a meta event', () => {
  const snap = JSON.stringify({
    messages: [
      { id: 'm1', timestamp: 't', type: 'user', content: 'hi' },
      { id: 'm2', timestamp: 't', type: 'gemini', model: 'gemini-2.5-flash', content: 'ok' },
    ],
  });
  const r = gemini.extractSnapshot(snap, 'sid');
  assert.ok(r.events.some(e => e.kind === 'meta' && e.label === 'model' && e.model === 'gemini-2.5-flash'));
});

test('gemini extractSnapshot: prefers explicit summary as title', () => {
  const snap = JSON.stringify({
    summary: 'Refactor auth flow',
    messages: [{ id: 'm1', timestamp: 't', type: 'user', content: 'do the thing' }],
  });
  assert.equal(gemini.extractSnapshot(snap, 'sid').title, 'Refactor auth flow');
});

test('gemini extractSnapshot: skips subagent session files entirely', () => {
  const snap = JSON.stringify({
    kind: 'subagent',
    messages: [{ id: 'm1', timestamp: 't', type: 'user', content: 'should be ignored' }],
  });
  const r = gemini.extractSnapshot(snap, 'sid');
  assert.deepEqual(r.events, []);
});

test('gemini extractSnapshot: malformed JSON -> empty events, no throw', () => {
  assert.doesNotThrow(() => assert.deepEqual(gemini.extractSnapshot('{bad', 'sid').events, []));
});

// The session JSON's per-message tokens {input,output,cached,thoughts,tool,total}
// are per-turn; the adapter must accumulate per-session cumulative totals so the
// server's tool-agnostic status synthesis + usage bridge pick Gemini up, and set
// lastTurnTokens (= tokens.total) + contextWindow for the ctx% chip.

function tokMsg(id, tokens, model = 'gemini-2.5-pro') {
  return { id, timestamp: 't', type: 'gemini', model, content: 'ok', tokens };
}

test('gemini extractSnapshot: tokens events carry cumulative totals across turns', () => {
  const snap = JSON.stringify({ messages: [
    tokMsg('m1', { input: 100, output: 10, cached: 0, thoughts: 5, tool: 0, total: 115 }),
    tokMsg('m2', { input: 220, output: 30, cached: 80, thoughts: 0, tool: 0, total: 250 }),
  ] });
  const r = gemini.extractSnapshot(snap, 'sid');
  const toks = r.events.filter(e => e.kind === 'tokens');
  assert.equal(toks.length, 2);
  assert.equal(toks[0].change.totalInput, 100);
  assert.equal(toks[0].change.totalOutput, 10);
  assert.equal(toks[1].change.totalInput, 320);
  assert.equal(toks[1].change.totalOutput, 40);
  assert.equal(toks[1].change.totalCached, 80);
  // per-turn deltas preserved
  assert.equal(toks[1].change.input, 220);
  assert.equal(toks[1].change.output, 30);
});

test('gemini extractSnapshot: lastTurnTokens = tokens.total; contextWindow from the model', () => {
  const snap = JSON.stringify({ messages: [
    tokMsg('m1', { input: 6258, output: 79, cached: 5294, thoughts: 1891, tool: 0, total: 8228 }),
  ] });
  const r = gemini.extractSnapshot(snap, 'sid');
  const tok = r.events.find(e => e.kind === 'tokens');
  assert.equal(tok.change.lastTurnTokens, 8228);
  assert.equal(tok.change.contextWindow, 1048576); // published 1M window for gemini models
});

test('gemini extractSnapshot: totals are recomputed fresh per parse (snapshot replaces log)', () => {
  const snap = JSON.stringify({ messages: [
    tokMsg('m1', { input: 100, output: 10, cached: 0, total: 110 }),
  ] });
  const first = gemini.extractSnapshot(snap, 'sid-repeat');
  const second = gemini.extractSnapshot(snap, 'sid-repeat');
  const t1 = first.events.find(e => e.kind === 'tokens');
  const t2 = second.events.find(e => e.kind === 'tokens');
  assert.equal(t1.change.totalInput, 100);
  assert.equal(t2.change.totalInput, 100, 'no double-count across repeated snapshot parses');
});

test('gemini extractLine (legacy jsonl): cumulative state per session, resettable', () => {
  gemini.resetTokenState();
  const line = (tokens) => JSON.stringify(tokMsg('m' + Math.random(), tokens));
  const e1 = gemini.extractLine(line({ input: 50, output: 5, cached: 0, total: 55 }), 'jl1');
  const e2 = gemini.extractLine(line({ input: 70, output: 15, cached: 20, total: 105 }), 'jl1');
  const other = gemini.extractLine(line({ input: 9, output: 1, cached: 0, total: 10 }), 'jl2');
  assert.equal(e1.find(e => e.kind === 'tokens').change.totalInput, 50);
  assert.equal(e2.find(e => e.kind === 'tokens').change.totalInput, 120);
  assert.equal(e2.find(e => e.kind === 'tokens').change.totalOutput, 20);
  assert.equal(other.find(e => e.kind === 'tokens').change.totalInput, 9, 'sessions isolated');
  gemini.resetTokenState('jl1');
  const e3 = gemini.extractLine(line({ input: 1, output: 1, cached: 0, total: 2 }), 'jl1');
  assert.equal(e3.find(e => e.kind === 'tokens').change.totalInput, 1, 'reset restarts accumulation');
});

test('gemini: unknown model -> no contextWindow claim (null-safe)', () => {
  const snap = JSON.stringify({ messages: [
    tokMsg('m1', { input: 10, output: 2, cached: 0, total: 12 }, 'some-future-model'),
  ] });
  const tok = gemini.extractSnapshot(snap, 'sid').events.find(e => e.kind === 'tokens');
  assert.equal(tok.change.contextWindow, undefined);
  assert.equal(tok.change.totalInput, 10);
});
