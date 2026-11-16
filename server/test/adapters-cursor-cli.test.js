// server/test/adapters-cursor-cli.test.js
// Discovery and drift tests for the Cursor CLI adapter. Replay of the committed
// sample transcript is covered by adapters-golden.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as cursorCli from '../lib/adapters/cursor-cli.js';
import { adapterHealth, resetAdapterHealth } from '../lib/adapters/health.js';

const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });
function mkTmp() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-cursor-cli-')); tmpDirs.push(d); return d; }
function write(p, text) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); }

function seed() {
  const base = mkTmp();
  const line = JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: '<user_query>fix the bug</user_query>' }] } }) + '\n';
  write(path.join(base, 'projects', 'home-ada-proj', 'agent-transcripts', 'chat-1', 'chat-1.jsonl'), line);
  write(path.join(base, 'projects', 'home-ada-proj', 'other', 'not-a-transcript.jsonl'), line);
  write(path.join(base, 'chats', 'hashA', 'chat-1', 'meta.json'), JSON.stringify({ cwd: '/home/ada/proj', title: 'Fix the bug' }));
  return base;
}

test('cursor-cli detect: installed only when projects/ exists; never scans without P.cursorDir', () => {
  assert.deepEqual(cursorCli.detect({}), { installed: false, dataDirs: [] });
  assert.equal(cursorCli.detect({ cursorDir: mkTmp() }).installed, false);
  const base = seed();
  assert.deepEqual(cursorCli.detect({ cursorDir: base }), { installed: true, dataDirs: [base] });
});

test('cursor-cli discover: agent-transcripts jsonl only, cwd and label from chats/<hash>/<chat>/meta.json', () => {
  const base = seed();
  const descs = cursorCli.discover({ cursorDir: base });
  assert.equal(descs.length, 1);
  const d = descs[0];
  assert.equal(d.id, 'cursor-cli:chat-1');
  assert.equal(d.tool, 'cursor-cli');
  assert.equal(d.kind, 'jsonl-tail');
  assert.equal(d.cwd, '/home/ada/proj');
  assert.equal(d.label, 'Fix the bug');
  assert.ok(d.file.endsWith('chat-1.jsonl'));
  assert.equal(typeof d.mtimeMs, 'number');
});

test('cursor-cli discover: no chats meta -> cwd and label null; missing root -> []', () => {
  const base = mkTmp();
  write(path.join(base, 'projects', 'p', 'agent-transcripts', 'c2', 'c2.jsonl'), '{}\n');
  const [d] = cursorCli.discover({ cursorDir: base });
  assert.equal(d.cwd, null);
  assert.equal(d.label, null);
  assert.deepEqual(cursorCli.discover({ cursorDir: path.join(base, 'nope') }), []);
});

test('cursor-cli extractLine: junk and partial lines are ignored; a populated record without a role reports drift', () => {
  resetAdapterHealth();
  assert.deepEqual(cursorCli.extractLine('{partial', 's'), []);
  assert.deepEqual(cursorCli.extractLine('{}', 's'), []);
  assert.deepEqual(cursorCli.extractLine('[1]', 's'), []);
  assert.equal(adapterHealth()['cursor-cli']?.degraded, undefined);
  assert.deepEqual(cursorCli.extractLine(JSON.stringify({ kind: 'user', body: 'x' }), 's'), []);
  assert.ok(adapterHealth()['cursor-cli']);
});

test('cursor-cli extractLine: user bootstrap-only text and empty prompts yield no event', () => {
  const ev = cursorCli.extractLine(JSON.stringify({ role: 'user', message: { content: '<user_query>   </user_query>' } }), 's');
  assert.deepEqual(ev, []);
});
