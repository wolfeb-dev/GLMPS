import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpRoot } from './helpers/tmp.js';
import path from 'node:path';
import { sweepOldFiles, isInside } from '../lib/governance/old-cleanup.js';

const DAY = 24 * 3_600_000;
const T0 = Date.parse('2026-11-01T12:00:00Z');

function tmp(pfx) { return fs.realpathSync(fs.mkdtempSync(path.join(tmpRoot(), pfx))); }
function rmBestEffort(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* best effort */ } }

// A tracked repo is a directory with a .git entry; the sweep never runs git.
function repo() {
  const r = tmp('mc-oldclean-repo-');
  fs.mkdirSync(path.join(r, '.git'));
  return r;
}

// A state file that already exists, so the run under test is past the baseline run.
function primedState() {
  const stateFile = path.join(tmp('mc-oldclean-state-'), 'old-cleanup.json');
  fs.writeFileSync(stateFile, JSON.stringify({ seen: {}, refused: {}, baseline: {} }));
  return stateFile;
}

function sweeper(roots) {
  const stateFile = primedState();
  const events = [];
  const run = (now) => sweepOldFiles({ roots, stateFile, now, emit: (kind, payload) => events.push({ kind, payload }) });
  return { run, events };
}

// A directory link that needs no privilege on Windows (a junction) and is a plain symlink elsewhere.
function dirLink(target, link) { fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir'); }

test('a .old file is kept until it has been seen for 7 days, then deleted and recorded', async () => {
  const r = repo();
  try {
    fs.writeFileSync(path.join(r, 'a.txt.old'), 'x');
    fs.mkdirSync(path.join(r, 'sub'));
    fs.writeFileSync(path.join(r, 'sub', 'b.js.old'), 'x');
    const s = sweeper([r]);
    const first = await s.run(T0);
    assert.equal(first.deleted.length, 0);
    assert.equal(first.pending, 2);
    assert.equal((await s.run(T0 + 6 * DAY)).deleted.length, 0, 'first-seen, not re-seen, is the clock');
    const later = await s.run(T0 + 7 * DAY);
    assert.deepEqual(later.deleted.map((d) => path.basename(d.path)).sort(), ['a.txt.old', 'b.js.old']);
    assert.ok(!fs.existsSync(path.join(r, 'a.txt.old')));
    assert.ok(!fs.existsSync(path.join(r, 'sub', 'b.js.old')));
    const del = s.events.filter((e) => e.kind === 'cleanup.old_deleted');
    assert.equal(del.length, 2);
    assert.ok(del.every((e) => e.payload.root === r && e.payload.firstSeen === new Date(T0).toISOString()));
  } finally { rmBestEffort(r); }
});

test('only .old paths go; other files, .git and node_modules are never touched', async () => {
  const r = repo();
  try {
    for (const f of ['keep.txt', 'old.txt', 'a.older', 'x.old.txt']) fs.writeFileSync(path.join(r, f), 'x');
    fs.writeFileSync(path.join(r, '.git', 'packed.old'), 'x');
    fs.mkdirSync(path.join(r, 'node_modules'));
    fs.writeFileSync(path.join(r, 'node_modules', 'm.old'), 'x');
    const s = sweeper([r]);
    await s.run(T0);
    const res = await s.run(T0 + 30 * DAY);
    assert.equal(res.deleted.length, 0);
    for (const f of ['keep.txt', 'old.txt', 'a.older', 'x.old.txt', '.git/packed.old', 'node_modules/m.old']) {
      assert.ok(fs.existsSync(path.join(r, f)), f);
    }
  } finally { rmBestEffort(r); }
});

test('a root that is not a git repo, and a nested repo, are not swept', async () => {
  const plain = tmp('mc-oldclean-plain-');
  const r = repo();
  try {
    fs.writeFileSync(path.join(plain, 'a.old'), 'x');
    fs.mkdirSync(path.join(r, 'vendored', '.git'), { recursive: true });
    fs.writeFileSync(path.join(r, 'vendored', 'n.old'), 'x');
    const s = sweeper([plain, r]);
    await s.run(T0);
    const res = await s.run(T0 + 30 * DAY);
    assert.equal(res.deleted.length, 0);
    assert.equal(res.roots.find((x) => x.root === plain).status, 'not-a-git-repo');
    assert.ok(fs.existsSync(path.join(plain, 'a.old')));
    assert.ok(fs.existsSync(path.join(r, 'vendored', 'n.old')));
  } finally { rmBestEffort(plain); rmBestEffort(r); }
});

test('a junction or symlink out of the repo is never walked, and its .old target survives', async () => {
  const outside = tmp('mc-oldclean-outside-');
  const r = repo();
  try {
    fs.writeFileSync(path.join(outside, 'victim.old'), 'x');
    dirLink(outside, path.join(r, 'escape'));
    const s = sweeper([r]);
    await s.run(T0);
    const res = await s.run(T0 + 30 * DAY);
    assert.equal(res.deleted.length, 0);
    assert.ok(fs.existsSync(path.join(outside, 'victim.old')));
  } finally { rmBestEffort(r); rmBestEffort(outside); }
});

test('a .old link whose realpath is outside the root is refused and recorded once', async () => {
  const outside = tmp('mc-oldclean-outside-');
  const r = repo();
  try {
    fs.writeFileSync(path.join(outside, 'precious.txt'), 'x');
    dirLink(outside, path.join(r, 'escape.old'));
    const s = sweeper([r]);
    await s.run(T0);
    const res = await s.run(T0 + 30 * DAY);
    assert.equal(res.deleted.length, 0);
    assert.match(res.refused[0].reason, /outside the tracked root/);
    assert.ok(fs.existsSync(path.join(outside, 'precious.txt')));
    assert.ok(fs.existsSync(path.join(r, 'escape.old')), 'the link itself is left too');
    assert.equal(s.events.filter((e) => e.kind === 'cleanup.old_refused').length, 1);
  } finally { rmBestEffort(r); rmBestEffort(outside); }
});

test('a .old file symlink to a file outside the root is refused', async (t) => {
  const outside = tmp('mc-oldclean-outside-');
  const r = repo();
  try {
    fs.writeFileSync(path.join(outside, 'target.txt'), 'x');
    try { fs.symlinkSync(path.join(outside, 'target.txt'), path.join(r, 'f.old'), 'file'); } catch (e) {
      t.skip(`file symlinks need privilege here (${e.code})`);
      return;
    }
    const s = sweeper([r]);
    await s.run(T0);
    const res = await s.run(T0 + 30 * DAY);
    assert.equal(res.deleted.length, 0);
    assert.match(res.refused[0].reason, /outside the tracked root/);
    assert.ok(fs.existsSync(path.join(outside, 'target.txt')));
  } finally { rmBestEffort(r); rmBestEffort(outside); }
});

test('a .old directory is deleted whole, but refused whole if it holds a link out', async () => {
  const outside = tmp('mc-oldclean-outside-');
  const r = repo();
  try {
    fs.mkdirSync(path.join(r, 'build.old', 'deep'), { recursive: true });
    fs.writeFileSync(path.join(r, 'build.old', 'deep', 'f.txt'), 'x');
    fs.mkdirSync(path.join(r, 'trap.old'));
    fs.writeFileSync(path.join(outside, 'precious.txt'), 'x');
    dirLink(outside, path.join(r, 'trap.old', 'link'));
    const s = sweeper([r]);
    await s.run(T0);
    const res = await s.run(T0 + 30 * DAY);
    assert.deepEqual(res.deleted.map((d) => path.basename(d.path)), ['build.old']);
    assert.ok(!fs.existsSync(path.join(r, 'build.old')));
    assert.match(res.refused.find((x) => x.path.endsWith('trap.old')).reason, /holds a link/);
    assert.ok(fs.existsSync(path.join(outside, 'precious.txt')));
  } finally { rmBestEffort(r); rmBestEffort(outside); }
});

test('a root reached through a link is swept at its realpath; the deletion ceiling holds', async () => {
  const r = repo();
  const via = path.join(tmp('mc-oldclean-via-'), 'alias');
  try {
    dirLink(r, via);
    for (let i = 0; i < 5; i += 1) fs.writeFileSync(path.join(r, `f${i}.old`), 'x');
    const stateFile = primedState();
    await sweepOldFiles({ roots: [via, r], stateFile, now: T0 });
    const res = await sweepOldFiles({ roots: [via, r], stateFile, now: T0 + 30 * DAY, maxDeletes: 3 });
    assert.equal(res.deleted.length, 3);
    assert.equal(res.pending, 2);
    assert.ok(res.deleted.every((d) => d.root === r));
    assert.equal(res.roots.length, 1, 'the same repo by two spellings is swept once');
  } finally { rmBestEffort(r); rmBestEffort(path.dirname(via)); }
});

test('isInside rejects the root itself, siblings and parents', () => {
  const root = path.resolve('/a/repo');
  assert.equal(isInside(root, path.join(root, 'x.old')), true);
  assert.equal(isInside(root, root), false);
  assert.equal(isInside(root, path.resolve('/a/repo2/x.old')), false);
  assert.equal(isInside(root, path.resolve('/a/x.old')), false);
});

test('the first run only takes a baseline; .old paths that predate it are never deleted', async () => {
  const r = repo();
  try {
    fs.writeFileSync(path.join(r, 'kept-on-purpose.old'), 'x');
    const stateFile = path.join(tmp('mc-oldclean-state-'), 'old-cleanup.json');
    const first = await sweepOldFiles({ roots: [r], stateFile, now: T0 });
    assert.equal(first.firstRun, true);
    assert.equal(first.baselined, 1);
    fs.writeFileSync(path.join(r, 'new.old'), 'x');
    await sweepOldFiles({ roots: [r], stateFile, now: T0 + DAY });
    const res = await sweepOldFiles({ roots: [r], stateFile, now: T0 + 30 * DAY });
    assert.deepEqual(res.deleted.map((d) => path.basename(d.path)), ['new.old']);
    assert.ok(fs.existsSync(path.join(r, 'kept-on-purpose.old')));
  } finally { rmBestEffort(r); }
});

test('a corrupt state file fails the run instead of re-baselining', async () => {
  const r = repo();
  try {
    const stateFile = path.join(tmp('mc-oldclean-state-'), 'old-cleanup.json');
    fs.writeFileSync(stateFile, '{not json');
    await assert.rejects(sweepOldFiles({ roots: [r], stateFile, now: T0 }));
  } finally { rmBestEffort(r); }
});
