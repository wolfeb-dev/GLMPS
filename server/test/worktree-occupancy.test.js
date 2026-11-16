import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { dirInUse, reclaimMarkerPath, writeReclaimMarker, clearReclaimMarker } from '../lib/orchestration/worktree-occupancy.js';

const probed = process.platform === 'win32' || process.platform === 'linux';
function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'mc-occ-')); }

// A process that sits with its cwd in `dir` until killed, like an idle agent
// session waiting on the operator.
async function occupant(dir) {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { cwd: dir, stdio: 'ignore', windowsHide: true });
  await new Promise((r) => child.once('spawn', r));
  await new Promise((r) => setTimeout(r, 200));
  return child;
}
async function stop(child) {
  const gone = new Promise((r) => child.once('exit', r));
  child.kill();
  await gone;
}

test('a directory nobody is in is free, and survives the probe intact', () => {
  const base = tmp();
  const dir = path.join(base, 'wt');
  fs.mkdirSync(path.join(dir, 'server'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'server', 'a.js'), 'x');
  const v = dirInUse(dir);
  assert.equal(v.inUse, false);
  assert.ok(fs.existsSync(path.join(dir, 'server', 'a.js')), 'the probe puts the directory back');
  assert.deepEqual(fs.readdirSync(base), ['wt'], 'no probe leftovers beside it');
});

test('a missing directory is not in use', () => {
  assert.equal(dirInUse(path.join(tmp(), 'gone')).inUse, false);
});

test('a process with its cwd in the directory makes it in use', { skip: !probed && 'no occupancy probe on this platform' }, async () => {
  const dir = path.join(tmp(), 'wt');
  fs.mkdirSync(dir);
  const child = await occupant(dir);
  try {
    const v = dirInUse(dir);
    assert.equal(v.inUse, true, `expected in use, got ${JSON.stringify(v)}`);
    assert.ok(fs.existsSync(dir));
  } finally { await stop(child); }
  assert.equal(dirInUse(dir).inUse, false, 'free again once the occupant exits');
});

test('a process with its cwd in a subdirectory makes the worktree in use', { skip: !probed && 'no occupancy probe on this platform' }, async () => {
  const dir = path.join(tmp(), 'wt');
  fs.mkdirSync(path.join(dir, 'server', 'lib'), { recursive: true });
  const child = await occupant(path.join(dir, 'server', 'lib'));
  try { assert.equal(dirInUse(dir).inUse, true); }
  finally { await stop(child); }
});

test('an unexpected probe error counts as in use, never as free', () => {
  const fsImpl = { ...fs, existsSync: () => true, renameSync: () => { const e = new Error('boom'); e.code = 'EIO'; throw e; } };
  const v = dirInUse('C:/x/wt', { platform: 'win32', fsImpl });
  assert.equal(v.inUse, true);
  assert.match(v.reason, /EIO/);
});

test('on linux a /proc cwd under the directory makes it in use', () => {
  const fsImpl = {
    existsSync: () => true,
    readdirSync: () => ['1', '42', 'self', 'not-a-pid'],
    readlinkSync: (p) => {
      if (p === '/proc/1/cwd') return '/';
      if (p === '/proc/42/cwd') return '/w/proj/card-1/server';
      const e = new Error('denied'); e.code = 'EACCES'; throw e;
    },
  };
  assert.equal(dirInUse('/w/proj/card-1', { platform: 'linux', fsImpl }).inUse, true);
  assert.equal(dirInUse('/w/proj/card-10', { platform: 'linux', fsImpl }).inUse, false, 'a sibling prefix is not containment');
});

test('a platform with no probe answers unprobed, not in use', () => {
  const v = dirInUse('/w/x', { platform: 'darwin', fsImpl: { ...fs, existsSync: () => true } });
  assert.equal(v.inUse, false);
  assert.equal(v.reason, 'unprobed');
});

test('the reclaim marker sits beside the directory and outlives it', () => {
  const dir = path.join(tmp(), 'card-1');
  fs.mkdirSync(dir);
  writeReclaimMarker(dir, { branch: 'glmps-runner/p/card-1', by: 'runner-reclaim', outcome: 'removed', ts: 5 });
  fs.rmSync(dir, { recursive: true });
  const m = JSON.parse(fs.readFileSync(reclaimMarkerPath(dir), 'utf8'));
  assert.deepEqual(m, { dir, branch: 'glmps-runner/p/card-1', by: 'runner-reclaim', outcome: 'removed', ts: 5 });
  clearReclaimMarker(dir);
  assert.equal(fs.existsSync(reclaimMarkerPath(dir)), false);
  clearReclaimMarker(dir);
});
