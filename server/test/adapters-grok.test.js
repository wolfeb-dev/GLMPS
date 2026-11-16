// server/test/adapters-grok.test.js
// Discovery and drift tests for the Grok adapter. Replay of the committed sample
// chat_history.jsonl is covered by adapters-golden.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as grok from '../lib/adapters/grok.js';
import { adapterHealth, resetAdapterHealth } from '../lib/adapters/health.js';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'grok');
const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });
function mkTmp() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-grok-')); tmpDirs.push(d); return d; }

function seed({ withHistory = true } = {}) {
  const base = mkTmp();
  const dir = path.join(base, 'sessions', '%2Fhome%2Fada%2Fproj', '0b9d7c1e-5a52-4c64-8d4e-2f1f0f7c9a10');
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(FIX, 'summary.json'), path.join(dir, 'summary.json'));
  if (withHistory) fs.copyFileSync(path.join(FIX, 'chat_history.jsonl'), path.join(dir, 'chat_history.jsonl'));
  return { base, dir };
}

test('grok detect: installed only when sessions/ exists; never scans without P.grokDir', () => {
  assert.deepEqual(grok.detect({}), { installed: false, dataDirs: [] });
  assert.equal(grok.detect({ grokDir: mkTmp() }).installed, false);
  const { base } = seed();
  assert.deepEqual(grok.detect({ grokDir: base }), { installed: true, dataDirs: [base] });
});

test('grok discover: one descriptor per summary.json tailing the chat_history.jsonl beside it', () => {
  const { base, dir } = seed();
  const descs = grok.discover({ grokDir: base });
  assert.equal(descs.length, 1);
  const d = descs[0];
  assert.equal(d.id, 'grok:0b9d7c1e-5a52-4c64-8d4e-2f1f0f7c9a10');
  assert.equal(d.tool, 'grok');
  assert.equal(d.kind, 'jsonl-tail');
  assert.equal(d.file, path.join(dir, 'chat_history.jsonl'));
  assert.equal(d.cwd, '/home/ada/proj');
  assert.equal(d.label, 'Fix i18n keys for the ko workspace');
});

test('grok discover: summary without a chat_history.jsonl is not capturable yet; malformed summary is skipped', () => {
  const { base } = seed({ withHistory: false });
  assert.deepEqual(grok.discover({ grokDir: base }), []);
  const bad = mkTmp();
  const dir = path.join(bad, 'sessions', 'x', 'y');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'summary.json'), '{not json');
  fs.writeFileSync(path.join(dir, 'chat_history.jsonl'), '{}\n');
  assert.deepEqual(grok.discover({ grokDir: bad }), []);
});

test('grok extractLine: bootstrap-only user rows are skipped, the user_query envelope is unwrapped, a missing closer keeps the ask', () => {
  const row = (content) => JSON.stringify({ type: 'user', content, timestamp: 't' });
  assert.deepEqual(grok.extractLine(row('<user_info>os: linux</user_info>'), 's'), []);
  assert.equal(grok.extractLine(row('<user_query>ship it'), 's')[0].label, 'User: ship it');
  assert.equal(grok.extractLine(row([{ type: 'text', text: 'plain ask' }]), 's')[0].label, 'User: plain ask');
});

test('grok extractLine: assistant rows yield no events; a populated record without a type reports drift', () => {
  resetAdapterHealth();
  assert.deepEqual(grok.extractLine(JSON.stringify({ type: 'assistant', content: 'hi' }), 's'), []);
  assert.deepEqual(grok.extractLine('{partial', 's'), []);
  assert.equal(adapterHealth().grok?.degraded, undefined);
  assert.deepEqual(grok.extractLine(JSON.stringify({ role: 'user', content: 'x' }), 's'), []);
  assert.ok(adapterHealth().grok);
});
