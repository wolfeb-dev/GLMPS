// server/test/paths-editor-storage.test.js
// glmps-50: vscodeStorageDirs must cover all VS Code-family editors on the
// current platform by default (no per-user env override needed); the single
// GLMPS_VSCODE_STORAGE_DIR test override still wins.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getPaths } from '../lib/paths.js';

// K Task 16 phase-end carry 1: isTestProcess() forced false (a real,
// non-test launch) simulates production, even though this assertion itself
// runs inside node --test - see paths.test.js's own `notTest` for the full
// rationale.
const notTest = { processEnv: {}, argv: ['node', 'server.js'] };

test('vscodeStorageDirs default enumerates every known editor for this platform', () => {
  const p = getPaths({}, null, notTest);
  assert.ok(Array.isArray(p.vscodeStorageDirs));
  assert.ok(p.vscodeStorageDirs.length >= 5, `expected >=5 editor storage dirs, got ${p.vscodeStorageDirs.length}`);
  const sep = (s) => s.split(path.sep);
  for (const name of ['Code', 'Cursor', 'Code - Insiders', 'VSCodium', 'Windsurf']) {
    assert.ok(p.vscodeStorageDirs.some(d => sep(d).includes(name)), `missing ${name} in ${JSON.stringify(p.vscodeStorageDirs)}`);
  }
  for (const d of p.vscodeStorageDirs) assert.ok(d.endsWith(path.join('User', 'workspaceStorage')), d);
});

test('GLMPS_VSCODE_STORAGE_DIR single override still wins (test isolation)', () => {
  const p = getPaths({ GLMPS_VSCODE_STORAGE_DIR: '/tmp/vs' });
  assert.deepEqual(p.vscodeStorageDirs, ['/tmp/vs']);
});

// K Task 16 phase-end carry 1: under test-process detection (the ambient
// case for every test in the suite), with no GLMPS_VSCODE_STORAGE_DIR override,
// vscodeStorageDirs must redirect off the real home dir - it used to default
// to the real %APPDATA%/<editor>/User/workspaceStorage paths regardless of
// GLMPS_STATE_DIR/GLMPS_CLAUDE_DIR, which is exactly what let a server-booting
// test read the operator's real Copilot Chat history at boot.
test('under test-process detection, vscodeStorageDirs defaults to a path that does not exist, never the real editor storage dirs', () => {
  const p = getPaths({}); // ambient test process, no GLMPS_VSCODE_STORAGE_DIR
  assert.ok(Array.isArray(p.vscodeStorageDirs) && p.vscodeStorageDirs.length > 0);
  for (const d of p.vscodeStorageDirs) {
    assert.ok(!fs.existsSync(d), `vscodeStorageDirs entry must not exist: ${d}`);
    assert.ok(path.resolve(d).startsWith(path.resolve(os.tmpdir())), `expected ${d} under the system tmp dir`);
  }
});
