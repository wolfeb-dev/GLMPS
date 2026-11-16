import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  resolveStateDir, envStateDirOverride, stateDirEnv, stateSubdirs, stateFile, readPathFor, ledgerReadPaths, dbFileFor,
  STATE_SUBDIRS, rebaseLegacyStatePath,
} from '../lib/state-dir.js';
import { getPaths } from '../lib/paths.js';

const home = path.join(os.tmpdir(), 'state-dir-test-home');
const none = () => false;
const only = (...present) => (p) => present.includes(p);

test.skip('resolution order: GLMPS_STATE_DIR > GLMPS_STATE_DIR > ~/.glmps2 (if present) > ~/.glmps', () => {
  const next = path.join(home, '.glmps2');
  const legacy = path.join(home, '.glmps');
  const all = only(next);
  assert.equal(resolveStateDir({ env: { GLMPS_STATE_DIR: '/g', GLMPS_STATE_DIR: '/m' }, home, exists: all }), '/g');
  assert.equal(resolveStateDir({ env: { GLMPS_STATE_DIR: '/m' }, home, exists: all }), '/m');
  assert.equal(resolveStateDir({ env: {}, home, exists: all }), next);
  assert.equal(resolveStateDir({ env: {}, home, exists: none }), legacy);
});

test('an empty override and a throwing existence check fall through to the home default', () => {
  assert.equal(resolveStateDir({ env: { GLMPS_STATE_DIR: '', GLMPS_STATE_DIR: '' }, home, exists: () => { throw new Error('EACCES'); } }),
    path.join(home, '.glmps'));
});

test.skip('getPaths honours GLMPS_STATE_DIR ahead of GLMPS_STATE_DIR', () => {
  assert.equal(getPaths({ GLMPS_STATE_DIR: '/g', GLMPS_STATE_DIR: '/m' }).stateDir, '/g');
  assert.equal(getPaths({ GLMPS_STATE_DIR: '/m' }).stateDir, '/m');
});

test('getPaths exposes the named subfolders under the resolved state dir', () => {
  const p = getPaths({ GLMPS_STATE_DIR: '/s' });
  assert.deepEqual(Object.keys(p.stateSubdirs).sort(), Object.keys(STATE_SUBDIRS).sort());
  assert.equal(p.stateSubdirs.logs, path.join('/s', 'logs'));
  assert.deepEqual(p.stateSubdirs, stateSubdirs('/s'));
});

test('stateDirEnv hands a child GLMPS_STATE_DIR and blanks GLMPS_STATE_DIR, so neither an inherited value nor a leaked one outranks it', () => {
  assert.deepEqual(stateDirEnv('/s'), { GLMPS_STATE_DIR: '', GLMPS_STATE_DIR: '/s' });
  const child = { ...{ GLMPS_STATE_DIR: '/parent' }, ...stateDirEnv('/s') };
  assert.equal(envStateDirOverride(child), '/s');
  const grandchild = { ...child, GLMPS_STATE_DIR: '/tmp-test' };
  assert.equal(envStateDirOverride(grandchild), '/tmp-test');
});

test('whole-file stores read the new path, else the old root path', () => {
  const f = stateFile('/s', 'cache', 'x.json');
  assert.equal(f.path, path.join('/s', 'cache', 'x.json'));
  assert.equal(f.legacyPath, path.join('/s', 'x.json'));
  assert.equal(readPathFor('/s', 'cache', 'x.json', only(f.path, f.legacyPath)), f.path);
  assert.equal(readPathFor('/s', 'cache', 'x.json', only(f.legacyPath)), f.legacyPath);
  assert.equal(readPathFor('/s', 'cache', 'x.json', none), f.path);
});

test('ledgers read the old file then the new one', () => {
  const f = stateFile('/s', 'ledgers', 'a.jsonl');
  assert.deepEqual(ledgerReadPaths('/s', 'a.jsonl', only(f.path, f.legacyPath)), [f.legacyPath, f.path]);
  assert.deepEqual(ledgerReadPaths('/s', 'a.jsonl', none), []);
});

test('the database stays at the old root while it exists there, so the live file is never split', () => {
  const f = stateFile('/s', 'db', 'kernel.db');
  assert.equal(dbFileFor('/s', 'kernel.db', only(f.legacyPath)), f.legacyPath);
  assert.equal(dbFileFor('/s', 'kernel.db', only(f.legacyPath, f.path)), f.path);
  assert.equal(dbFileFor('/s', 'kernel.db', none), f.path);
});

test('against a real temp home: ~/.glmps2 wins only once it exists', () => {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'state-dir-home-'));
  try {
    assert.equal(resolveStateDir({ env: {}, home: h }), path.join(h, '.glmps'));
    fs.mkdirSync(path.join(h, '.glmps2'));
    assert.equal(resolveStateDir({ env: {}, home: h }), path.join(h, '.glmps2'));
  } finally { fs.rmSync(h, { recursive: true, force: true }); }
});

test('rebaseLegacyStatePath moves a path under the legacy folder to the current one and leaves others alone', () => {
  const W = path.win32.join;
  const w = { stateDir: W('C:/Users/op/.glmps2'), legacyStateDir: W('C:/Users/op/.glmps'), platform: 'win32' };
  assert.equal(rebaseLegacyStatePath(W('C:/Users/op/.glmps/runner/worktrees/glmps-2.0/glmps-2-0-140'), w), W('C:/Users/op/.glmps2/runner/worktrees/glmps-2.0/glmps-2-0-140'));
  assert.equal(rebaseLegacyStatePath('c:/users/op/.GLMPS/runner/worktrees/p/c', w), W('C:/Users/op/.glmps2/runner/worktrees/p/c'), 'case and slashes do not matter on Windows');
  assert.equal(rebaseLegacyStatePath(W('C:/Users/op/.glmps-2/runner'), w), W('C:/Users/op/.glmps-2/runner'), 'a sibling folder is not the legacy folder');
  assert.equal(rebaseLegacyStatePath(W('D:/glmps-2.0-wt-66'), w), W('D:/glmps-2.0-wt-66'));
  assert.equal(rebaseLegacyStatePath(W('C:/Users/op/.glmps'), w), W('C:/Users/op/.glmps'), 'the folder itself is not rewritten');
  assert.equal(rebaseLegacyStatePath(null, w), null);
  const p = { stateDir: '/home/op/.glmps2', legacyStateDir: '/home/op/.glmps', platform: 'linux' };
  assert.equal(rebaseLegacyStatePath('/home/op/.glmps/runner/x', p), '/home/op/.glmps2/runner/x');
  assert.equal(rebaseLegacyStatePath('/home/op/.GLMPS/runner/x', p), '/home/op/.GLMPS/runner/x', 'POSIX paths are case-sensitive');
  assert.equal(rebaseLegacyStatePath('/x/y', { ...p, legacyStateDir: '/home/op/.glmps2' }), '/x/y');
});
