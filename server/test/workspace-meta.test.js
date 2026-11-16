import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { applyWorkspaceMeta } from '../lib/orchestration/workspace-meta.js';
import { readWorkspace } from '../lib/orchestration/workspace-store.js';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'mc-wsm-')); }

test('label:workspace meta event writes declared delta', () => {
  const sd = tmp();
  applyWorkspaceMeta(sd, 's1', [
    { kind: 'meta', label: 'workspace', change: { hypothesis: 'stop is the edge', nextStep: 'run backtest' }, ts: 7 },
    { kind: 'meta', label: 'cwd', path: '/x' },       // ignored
  ]);
  const ws = readWorkspace(sd, 's1');
  assert.equal(ws.declared.hypothesis, 'stop is the edge');
  assert.equal(ws.declared.nextStep, 'run backtest');
});

test('no workspace meta -> no write', () => {
  const sd = tmp();
  applyWorkspaceMeta(sd, 's1', [{ kind: 'meta', label: 'model', model: 'x' }]);
  assert.equal(readWorkspace(sd, 's1'), null);
});
