// server/test/adapters-droid.test.js
// Discovery and drift tests for the Factory Droid adapter. Replay of the committed
// sample session is covered by adapters-golden.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as droid from '../lib/adapters/droid.js';
import { adapterHealth, resetAdapterHealth } from '../lib/adapters/health.js';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'droid');
const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });
function mkTmp() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-droid-')); tmpDirs.push(d); return d; }
function put(p, text) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); }

test('droid detect: installed when sessions/ or projects/ exists; never scans without P.factoryDir', () => {
  assert.deepEqual(droid.detect({}), { installed: false, dataDirs: [] });
  assert.equal(droid.detect({ factoryDir: mkTmp() }).installed, false);
  const base = mkTmp();
  fs.mkdirSync(path.join(base, 'projects'));
  assert.deepEqual(droid.detect({ factoryDir: base }), { installed: true, dataDirs: [base] });
});

test('droid discover: jsonl under sessions/ and projects/, id and cwd from session_start, label from its title', () => {
  const base = mkTmp();
  put(path.join(base, 'sessions', '-home-ada-proj', 'a.jsonl'), fs.readFileSync(path.join(FIX, 'session.jsonl')));
  put(path.join(base, 'sessions', '-home-ada-proj', 'a.settings.json'), '{}');
  put(path.join(base, 'projects', 'p', 'b.jsonl'), '{"type":"message","role":"user","text":"hi"}\n');
  const descs = droid.discover({ factoryDir: base }).sort((x, y) => x.id.localeCompare(y.id));
  assert.deepEqual(descs.map(d => d.id), ['droid:5e0c8b2a-9a4d-4d52-b1c7-3f8a6d1e7b22', 'droid:b']);
  const a = descs[0];
  assert.equal(a.tool, 'droid');
  assert.equal(a.kind, 'jsonl-tail');
  assert.equal(a.cwd, '/home/ada/proj');
  assert.equal(a.label, 'Add a health check endpoint');
  assert.equal(descs[1].cwd, null);
  assert.equal(descs[1].label, null);
});

test('droid extractLine: system record yields cwd and model meta; message text prefers the flat text field', () => {
  const sys = droid.extractLine(JSON.stringify({ type: 'system', cwd: '/w', model: 'm1' }), 's');
  assert.deepEqual(sys.map(e => e.label), ['cwd', 'model']);
  const msg = droid.extractLine(JSON.stringify({ type: 'message', role: 'user', text: 'flat', message: { role: 'user', content: 'nested' } }), 's');
  assert.equal(msg[0].label, 'User: flat');
});

test('droid extractLine: unknown record types are ignored; a populated record without a type reports drift', () => {
  resetAdapterHealth();
  assert.deepEqual(droid.extractLine(JSON.stringify({ type: 'completion', finalText: 'x' }), 's'), []);
  assert.deepEqual(droid.extractLine('{partial', 's'), []);
  assert.equal(adapterHealth().droid?.degraded, undefined);
  assert.deepEqual(droid.extractLine(JSON.stringify({ role: 'user', text: 'x' }), 's'), []);
  assert.ok(adapterHealth().droid);
});
