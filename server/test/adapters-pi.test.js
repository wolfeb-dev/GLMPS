// server/test/adapters-pi.test.js
// Discovery and drift tests for the Pi adapter. Replay of the committed sample
// session is covered by adapters-golden.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as pi from '../lib/adapters/pi.js';
import { adapterHealth, resetAdapterHealth } from '../lib/adapters/health.js';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'pi');
const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });
function mkTmp() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-pi-')); tmpDirs.push(d); return d; }
function put(p, text) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); }

const OMP_STAMP_DIR = '2026-05-01T10-00-00-000Z_7c1f2a90-3d1e-4b7a-9a55-0e6d2c4b8f11';

test('pi sessionsDirOf: PI_CODING_AGENT_DIR may name the agent dir, the .pi dir or the sessions dir', () => {
  assert.equal(pi.sessionsDirOf('/h/.pi/agent'), path.join('/h/.pi/agent', 'sessions'));
  assert.equal(pi.sessionsDirOf('/h/.pi/agent/sessions/'), '/h/.pi/agent/sessions');
  assert.equal(pi.sessionsDirOf('/h/.pi'), path.join('/h/.pi', 'agent', 'sessions'));
  const custom = mkTmp();
  assert.equal(pi.sessionsDirOf(custom), custom, 'unknown leaf without a sessions/ child is taken as the sessions dir itself');
  fs.mkdirSync(path.join(custom, 'sessions'));
  assert.equal(pi.sessionsDirOf(custom), path.join(custom, 'sessions'));
});

test('pi detect: installed only when the sessions dir exists; never scans without P.piDir', () => {
  assert.deepEqual(pi.detect({}), { installed: false, dataDirs: [] });
  assert.equal(pi.detect({ piDir: path.join(mkTmp(), 'absent', 'agent') }).installed, false);
  const base = mkTmp();
  fs.mkdirSync(path.join(base, 'sessions'));
  assert.deepEqual(pi.detect({ piDir: base }), { installed: true, dataDirs: [base] });
});

test('pi discover: jsonl under cwd buckets, cwd from the session header, OMP artifact dirs and OMP-written files skipped', () => {
  const base = mkTmp();
  const sessions = path.join(base, 'sessions');
  put(path.join(sessions, '--home-ada-proj--', '2026-05-01T10-00-00-000Z_abc.jsonl'), fs.readFileSync(path.join(FIX, 'session.jsonl')));
  put(path.join(sessions, '--home-ada-proj--', OMP_STAMP_DIR, 'task.jsonl'), '{"type":"session","id":"t","cwd":"/x"}\n');
  put(path.join(sessions, '--home-ada-omp--', 'omp.jsonl'), '{"type":"session","id":"o","cwd":"/omp"}\n{"type":"title","v":1,"title":"x"}\n');
  put(path.join(sessions, '--home-ada-omp--', 'omp2.jsonl'), '{"type":"session","id":"o2","cwd":"/omp","runtime":{"name":"omp"}}\n');
  const descs = pi.discover({ piDir: base });
  assert.equal(descs.length, 1);
  const d = descs[0];
  assert.equal(d.id, 'pi:7c1f2a90-3d1e-4b7a-9a55-0e6d2c4b8f11');
  assert.equal(d.tool, 'pi');
  assert.equal(d.kind, 'jsonl-tail');
  assert.equal(d.cwd, '/home/ada/proj');
  assert.equal(d.label, null);
});

test('pi discover: file without a readable header falls back to the file stem and null cwd', () => {
  const base = mkTmp();
  put(path.join(base, 'sessions', 'flat-1.jsonl'), '{"type":"message"}\n');
  const [d] = pi.discover({ piDir: base });
  assert.equal(d.id, 'pi:flat-1');
  assert.equal(d.cwd, null);
});

test('pi extractLine: unknown record types are ignored; a populated record without a type reports drift', () => {
  resetAdapterHealth();
  assert.deepEqual(pi.extractLine(JSON.stringify({ type: 'label', id: 'x' }), 's'), []);
  assert.deepEqual(pi.extractLine('{partial', 's'), []);
  assert.equal(adapterHealth().pi?.degraded, undefined);
  assert.deepEqual(pi.extractLine(JSON.stringify({ role: 'user' }), 's'), []);
  assert.ok(adapterHealth().pi);
});
