// Scope migration for the graph stores (server/lib/observability/graph-scope-migrate.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { planScopeMigration, appendScopeArchive, SCOPE_ARCHIVE_KEY } from '../lib/observability/graph-scope-migrate.js';

const sync = (outcome, ts) => ({ outcome, nodes: 10, existingNodes: 10, reason: '', ts, consecutive: 1 });
const shape = (nodes, ts, extra = {}) => ({ last: { nodes, edges: 1, builtAtCommit: null, ts }, baseline: { nodes, edges: 1, builtAtCommit: null, ts }, collapsed: false, dropRatio: 0, ...extra });

const IN_SCOPE = ['D:/glmps-2.0-runtime', 'D:/glmps-2.0'];

test('slash and case variants of an in-scope root merge to one key, newest entry wins', () => {
  const plan = planScopeMigration({
    syncHealth: {
      'D:\\glmps-2.0-runtime': sync('updated', 200),
      'D:/glmps-2.0-runtime': sync('noop', 100),
      'd:/GLMPS-2.0/': sync('noop', 50),
    },
    inScope: IN_SCOPE,
  });
  assert.deepEqual(Object.keys(plan.syncHealth).sort(), ['D:/glmps-2.0', 'D:/glmps-2.0-runtime']);
  assert.equal(plan.syncHealth['D:/glmps-2.0-runtime'].outcome, 'updated');
  assert.deepEqual(plan.merged.syncHealth.find((m) => m.key === 'D:/glmps-2.0-runtime').from.sort(), ['D:/glmps-2.0-runtime', 'D:\\glmps-2.0-runtime']);
  assert.ok(plan.archive.syncHealth['D:/glmps-2.0-runtime'], 'the losing variant is archived, not dropped');
  assert.ok(plan.archive.syncHealth['d:/GLMPS-2.0/'], 'a renamed key keeps its raw form in the archive');
  assert.equal(plan.changed, true);
});

test('out-of-scope roots move to the archive; version keys and in-scope baselines stay', () => {
  const integrity = {
    'D:/glmps-2.0-runtime': shape(16405, 300, { verifiedAtCommit: 'abc', verifiedTs: 310 }),
    'C:/Users/x/.claude/worktrees/w1': shape(12000, 200),
    'D:/Harbor-App': shape(900, 100),
  };
  const plan = planScopeMigration({
    syncHealth: {
      'D:/glmps-2.0-runtime': sync('noop', 1),
      'C:/Users/x/.claude/worktrees/w1': sync('updated', 2),
      'graphify@0.9.95': sync('updated', 3),
      'graphify@pending-rollback': sync('noop', 4),
    },
    integrity,
    inScope: IN_SCOPE,
  });
  assert.deepEqual(Object.keys(plan.syncHealth).sort(), ['D:/glmps-2.0-runtime', 'graphify@0.9.95', 'graphify@pending-rollback']);
  assert.deepEqual(Object.keys(plan.archive.syncHealth), ['C:/Users/x/.claude/worktrees/w1']);
  assert.deepEqual(Object.keys(plan.integrity), ['D:/glmps-2.0-runtime']);
  assert.equal(plan.integrity['D:/glmps-2.0-runtime'], integrity['D:/glmps-2.0-runtime'], 'in-scope entry kept as is, baseline included');
  assert.deepEqual(Object.keys(plan.archive.integrity).sort(), ['C:/Users/x/.claude/worktrees/w1', 'D:/Harbor-App']);
});

test('merged integrity keeps the newest shape and the newest verified stamp', () => {
  const plan = planScopeMigration({
    integrity: {
      'D:\\glmps-2.0-runtime': shape(100, 50, { verifiedAtCommit: 'new', verifiedTs: 60 }),
      'D:/glmps-2.0-runtime': shape(16000, 400),
    },
    inScope: IN_SCOPE,
  });
  const e = plan.integrity['D:/glmps-2.0-runtime'];
  assert.equal(e.last.nodes, 16000);
  assert.equal(e.baseline.nodes, 16000);
  assert.equal(e.verifiedAtCommit, 'new');
});

test('a second plan over the migrated stores changes nothing', () => {
  const first = planScopeMigration({
    syncHealth: { 'D:\\glmps-2.0-runtime': sync('noop', 2), 'D:/glmps-2.0-runtime': sync('noop', 1), 'D:/other': sync('noop', 1) },
    integrity: { 'D:/other': shape(1, 1), 'D:/glmps-2.0': shape(5, 1) },
    inScope: IN_SCOPE,
  });
  assert.equal(first.changed, true);
  const second = planScopeMigration({ syncHealth: first.syncHealth, integrity: first.integrity, inScope: IN_SCOPE });
  assert.equal(second.changed, false);
  assert.deepEqual(second.syncHealth, first.syncHealth);
  assert.deepEqual(second.integrity, first.integrity);
});

test('appendScopeArchive keeps the task-1 captures and appends one record per call', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-scope-mig-'));
  try {
    const file = path.join(dir, 'migrations', 'graphify-settings.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ schema: 1, captures: [{ capturedAt: 'x', rows: {} }] }));
    const plan = planScopeMigration({ syncHealth: { 'D:/other': sync('noop', 1) }, inScope: IN_SCOPE });
    appendScopeArchive(file, plan, { inScope: IN_SCOPE, now: new Date('2026-10-26T00:00:00Z') });
    const doc = JSON.parse(fs.readFileSync(file, 'utf-8'));
    assert.equal(doc.captures.length, 1);
    assert.equal(doc[SCOPE_ARCHIVE_KEY].length, 1);
    assert.deepEqual(Object.keys(doc[SCOPE_ARCHIVE_KEY][0].syncHealth), ['D:/other']);
    assert.equal(doc[SCOPE_ARCHIVE_KEY][0].archivedAt, '2026-10-26T00:00:00.000Z');

    fs.writeFileSync(file, '{not json');
    assert.throws(() => appendScopeArchive(file, plan), /unreadable/);
    assert.equal(fs.readFileSync(file, 'utf-8'), '{not json', 'an unreadable snapshot is never overwritten');

    const fresh = path.join(dir, 'none', 'graphify-settings.json');
    appendScopeArchive(fresh, plan);
    assert.equal(JSON.parse(fs.readFileSync(fresh, 'utf-8'))[SCOPE_ARCHIVE_KEY].length, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
