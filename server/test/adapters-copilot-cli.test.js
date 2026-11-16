// server/test/adapters-copilot-cli.test.js
// GitHub Copilot CLI deep adapter (closes the capture-registry gap for
// copilot-cli). Data lives under ~/.copilot/session-state/<id>/events.jsonl
// (append-only JSONL of {type,data,id,timestamp,parentId}); cwd/title come from
// the sibling workspace.yaml. Extract mirrors codex-cli's jsonl-tail contract.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as copilot from '../lib/adapters/copilot-cli.js';
import { adapterHealth, resetAdapterHealth } from '../lib/adapters/health.js';

const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });
function mkTmp() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-copcli-')); tmpDirs.push(d); return d; }
function makeP(copilotCliDir) { return { copilotCliDir }; }

function degraded(id) { return adapterHealth()[id]?.degraded === true; }
function line(o) { return JSON.stringify(o); }


test('copilot-cli detect: installed=false when session-state missing', () => {
  const P = makeP(path.join(os.tmpdir(), 'nonexistent-copilot-xyz'));
  assert.equal(copilot.detect(P).installed, false);
});

test('copilot-cli detect: installed=true when session-state exists', () => {
  const base = mkTmp();
  fs.mkdirSync(path.join(base, 'session-state'), { recursive: true });
  const { installed, dataDirs } = copilot.detect(makeP(base));
  assert.equal(installed, true);
  assert.deepEqual(dataDirs, [base]);
});

test('copilot-cli detect: installed=false when copilotCliDir not a string', () => {
  assert.equal(copilot.detect({}).installed, false);
});


test('copilot-cli discover: returns [] when base missing', () => {
  assert.deepEqual(copilot.discover(makeP(path.join(os.tmpdir(), 'nope-xyz'))), []);
});

test('copilot-cli discover: finds events.jsonl as jsonl-tail with cwd from workspace.yaml', () => {
  const base = mkTmp();
  const sid = '49a9431b-b663-4a35-888d-45223d86bb40';
  const dir = path.join(base, 'session-state', sid);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'events.jsonl'), line({ type: 'session.start', data: {}, id: 'e1', timestamp: '2026-07-08T22:47:09.231Z' }) + '\n');
  fs.writeFileSync(path.join(dir, 'workspace.yaml'),
    'id: ' + sid + '\ncwd: D:\\glmps\nrepository: wolfeb-dev/glmps\nbranch: main\nname: Explore Free Plan Features\n');

  const descs = copilot.discover(makeP(base));
  assert.equal(descs.length, 1);
  const d = descs[0];
  assert.equal(d.id, `copilot-cli:${sid}`);
  assert.equal(d.tool, 'copilot-cli');
  assert.equal(d.kind, 'jsonl-tail');
  assert.equal(d.file, path.join(dir, 'events.jsonl'));
  assert.equal(d.cwd, 'D:\\glmps');
  assert.equal(d.label, 'Explore Free Plan Features');
  assert.equal(typeof d.mtimeMs, 'number');
});

test('copilot-cli discover: session dir without events.jsonl is skipped', () => {
  const base = mkTmp();
  const dir = path.join(base, 'session-state', 'no-events');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'workspace.yaml'), 'cwd: D:\\x\n');
  assert.deepEqual(copilot.discover(makeP(base)), []);
});

test('copilot-cli discover: missing workspace.yaml -> cwd null, still discovered', () => {
  const base = mkTmp();
  const dir = path.join(base, 'session-state', 's1');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'events.jsonl'), line({ type: 'session.start', data: {}, id: 'e', timestamp: 't' }) + '\n');
  const descs = copilot.discover(makeP(base));
  assert.equal(descs.length, 1);
  assert.equal(descs[0].cwd, null);
  assert.equal(descs[0].label, null);
});


test('extractLine session.start -> cwd meta event', () => {
  const ev = copilot.extractLine(line({
    type: 'session.start', id: 'e', timestamp: 't',
    data: { context: { cwd: 'D:\\glmps' } },
  }), 's1');
  assert.equal(ev.length, 1);
  assert.deepEqual({ kind: ev[0].kind, lane: ev[0].lane, label: ev[0].label, path: ev[0].path },
    { kind: 'meta', lane: 'feed', label: 'cwd', path: 'D:\\glmps' });
});

test('extractLine assistant.turn_start -> model meta event', () => {
  const ev = copilot.extractLine(line({ type: 'assistant.turn_start', id: 'e', timestamp: 't', data: { model: 'gpt-5-mini' } }), 's1');
  assert.equal(ev.length, 1);
  assert.equal(ev[0].kind, 'meta');
  assert.equal(ev[0].label, 'model');
  assert.equal(ev[0].model, 'gpt-5-mini');
});

test('extractLine session.model_change -> model meta event', () => {
  const ev = copilot.extractLine(line({ type: 'session.model_change', id: 'e', timestamp: 't', data: { newModel: 'auto' } }), 's1');
  assert.equal(ev.length, 1);
  assert.equal(ev[0].kind, 'meta');
  assert.equal(ev[0].model, 'auto');
});


test('extractLine user.message -> feed user event with clean content (not transformedContent)', () => {
  const ev = copilot.extractLine(line({
    type: 'user.message', id: 'e', timestamp: 't',
    data: { content: 'what can I do with this free plan?', transformedContent: '<current_datetime>...</current_datetime> junk' },
  }), 's1');
  assert.equal(ev.length, 1);
  assert.equal(ev[0].kind, 'tool');
  assert.equal(ev[0].lane, 'feed');
  assert.equal(ev[0].tool, 'user');
  assert.match(ev[0].label, /^User: what can I do with this free plan\?/);
});

test('extractLine user.message with empty content -> [] (no event)', () => {
  assert.deepEqual(copilot.extractLine(line({ type: 'user.message', id: 'e', timestamp: 't', data: { content: '' } }), 's1'), []);
});


test('extractLine tool.execution_start web_fetch -> tool event (named tool, no path)', () => {
  const ev = copilot.extractLine(line({
    type: 'tool.execution_start', id: 'e', timestamp: 't',
    data: { toolName: 'web_fetch', arguments: { url: 'https://docs.github.com/x', max_length: 8000 } },
  }), 's1');
  assert.equal(ev.length, 1);
  assert.equal(ev[0].kind, 'tool');
  assert.equal(ev[0].tool, 'web_fetch');
  assert.equal(ev[0].path, null);
});

test('extractLine tool.execution_start shell git command -> git event via classifyGit', () => {
  const ev = copilot.extractLine(line({
    type: 'tool.execution_start', id: 'e', timestamp: 't',
    data: { toolName: 'bash', arguments: { command: 'git commit -m "x"' } },
  }), 's1');
  assert.equal(ev.length, 1);
  assert.equal(ev[0].tool, 'Bash');
  assert.equal(ev[0].kind, 'git');
});

test('extractLine tool.execution_start shell non-git -> command event', () => {
  const ev = copilot.extractLine(line({
    type: 'tool.execution_start', id: 'e', timestamp: 't',
    data: { toolName: 'shell', arguments: { command: 'npm test' } },
  }), 's1');
  assert.equal(ev.length, 1);
  assert.equal(ev[0].kind, 'command');
  assert.equal(ev[0].tool, 'Bash');
  assert.match(ev[0].label, /npm test/);
});

test('extractLine tool.execution_start file-editing tool -> tool event carrying path', () => {
  const ev = copilot.extractLine(line({
    type: 'tool.execution_start', id: 'e', timestamp: 't',
    data: { toolName: 'str_replace_editor', arguments: { path: 'D:\\glmps\\server\\server.js' } },
  }), 's1');
  assert.equal(ev.length, 1);
  assert.equal(ev[0].kind, 'tool');
  assert.equal(ev[0].tool, 'str_replace_editor');
  assert.equal(ev[0].path, 'D:\\glmps\\server\\server.js');
});


test('extractLine assistant.message -> [] (tool calls dedup via tool.execution_start)', () => {
  assert.deepEqual(copilot.extractLine(line({
    type: 'assistant.message', id: 'e', timestamp: 't',
    data: { content: 'Proceeding...', toolRequests: [{ name: 'web_fetch' }] },
  }), 's1'), []);
});

test('extractLine tool.execution_complete / turn_end / hook / permission / system / session.info -> []', () => {
  for (const type of ['tool.execution_complete', 'assistant.turn_end', 'hook.start', 'hook.end',
    'permission.requested', 'permission.completed', 'system.message', 'session.info']) {
    assert.deepEqual(copilot.extractLine(line({ type, id: 'e', timestamp: 't', data: {} }), 's1'), [], `${type} should be dropped`);
  }
});


test('extractLine: object record missing string type -> degraded, no event', () => {
  resetAdapterHealth();
  const ev = copilot.extractLine(line({ data: { content: 'hi' }, id: 'e', timestamp: 't' }), 's1');
  assert.deepEqual(ev, []);
  assert.equal(degraded('copilot-cli'), true);
});

test('extractLine: valid record -> event, not degraded', () => {
  resetAdapterHealth();
  const ev = copilot.extractLine(line({ type: 'user.message', id: 'e', timestamp: 't', data: { content: 'hi' } }), 's1');
  assert.equal(ev.length, 1);
  assert.equal(degraded('copilot-cli'), false);
});

test('extractLine: unparseable line stays silent (transient, not drift)', () => {
  resetAdapterHealth();
  assert.deepEqual(copilot.extractLine('{oops', 's1'), []);
  assert.equal(degraded('copilot-cli'), false);
});

test('extractLine: empty object -> [] silent (not drift)', () => {
  resetAdapterHealth();
  assert.deepEqual(copilot.extractLine('{}', 's1'), []);
  assert.equal(degraded('copilot-cli'), false);
});
