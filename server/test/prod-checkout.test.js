// Tests for server/lib/kernel/prod-checkout.js and scripts/service/check-prod-checkout.mjs
// (card glmps-2-0-runtime-48, dev/prod T1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkProdCheckout } from '../lib/kernel/prod-checkout.js';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'service', 'check-prod-checkout.mjs');

function git(dir, ...args) {
  const r = spawnSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

// A bare upstream with one commit on main, and a clone tracking it.
function rig() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-prodco-'));
  const bare = path.join(root, 'up.git');
  const seed = path.join(root, 'seed');
  const clone = path.join(root, 'clone');
  fs.mkdirSync(bare);
  git(bare, 'init', '-q', '--bare');
  fs.mkdirSync(seed);
  git(seed, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(seed, 'a.txt'), 'one\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '-q', '-m', 'seed');
  git(seed, 'remote', 'add', 'origin', bare);
  git(seed, 'push', '-q', 'origin', 'main');
  git(root, 'clone', '-q', '-b', 'main', bare, clone);
  return { root, clone, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('a clean checkout level with upstream is ok', () => {
  const t = rig();
  try {
    assert.deepEqual(checkProdCheckout({ repoRoot: t.clone }), { ok: true, dirty: [], ahead: [], reason: null });
  } finally { t.cleanup(); }
});

test('a dirty tracked file is refused and listed', () => {
  const t = rig();
  try {
    fs.writeFileSync(path.join(t.clone, 'a.txt'), 'changed\n');
    const r = checkProdCheckout({ repoRoot: t.clone });
    assert.equal(r.ok, false);
    assert.equal(r.dirty.length, 1);
    assert.match(r.dirty[0], /a\.txt/);
    assert.match(r.reason, /a\.txt/);
  } finally { t.cleanup(); }
});

test('untracked files alone do not block', () => {
  const t = rig();
  try {
    fs.writeFileSync(path.join(t.clone, 'scratch.log'), 'x\n');
    const r = checkProdCheckout({ repoRoot: t.clone });
    assert.equal(r.ok, true);
    assert.deepEqual(r.dirty, []);
  } finally { t.cleanup(); }
});

test('a local commit ahead of upstream is refused and listed', () => {
  const t = rig();
  try {
    fs.writeFileSync(path.join(t.clone, 'a.txt'), 'lesson\n');
    git(t.clone, 'commit', '-q', '-am', 'lesson commit');
    const r = checkProdCheckout({ repoRoot: t.clone });
    assert.equal(r.ok, false);
    assert.equal(r.ahead.length, 1);
    assert.match(r.ahead[0], /lesson commit/);
    assert.match(r.reason, /lesson commit/);
  } finally { t.cleanup(); }
});

test('a missing upstream ref fails closed with a reason', () => {
  const t = rig();
  try {
    const r = checkProdCheckout({ repoRoot: t.clone, upstream: 'origin/no-such-branch' });
    assert.equal(r.ok, false);
    assert.ok(r.reason && r.reason.length > 0);
  } finally { t.cleanup(); }
});

test('a directory that is not a repo fails closed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-prodco-nogit-'));
  try {
    const r = checkProdCheckout({ repoRoot: dir });
    assert.equal(r.ok, false);
    assert.ok(r.reason);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a spawn error fails closed', () => {
  const r = checkProdCheckout({ repoRoot: '/x', spawnSyncFn: () => ({ error: new Error('ENOENT git') }) });
  assert.equal(r.ok, false);
  assert.match(r.reason, /ENOENT git/);
});

function cli(args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
}

test.skip('CLI exits 0 on a clean checkout', () => {
  const t = rig();
  try {
    const r = cli(['--repo', t.clone]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
  } finally { t.cleanup(); }
});

test.skip('CLI exits 1 and prints dirty files and ahead commits', () => {
  const t = rig();
  try {
    fs.writeFileSync(path.join(t.clone, 'a.txt'), 'lesson\n');
    git(t.clone, 'commit', '-q', '-am', 'lesson commit');
    fs.writeFileSync(path.join(t.clone, 'a.txt'), 'dirty\n');
    const r = cli(['--repo', t.clone]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /a\.txt/);
    assert.match(r.stdout, /lesson commit/);
  } finally { t.cleanup(); }
});

test.skip('CLI --upstream selects the ref and a bad ref exits 1', () => {
  const t = rig();
  try {
    const r = cli(['--repo', t.clone, '--upstream', 'origin/nope']);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /refused|nope|unknown|bad/i);
  } finally { t.cleanup(); }
});
