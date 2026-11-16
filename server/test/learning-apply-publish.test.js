// server/test/learning-apply-publish.test.js
// applyGuard publish mode (card glmps-2-0-runtime-52, dev/prod T5) against real
// git in temp repos: a bare origin, a dev clone with an assets/ dir, and a
// second clone that stands in for anyone else pushing meanwhile.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { applyGuard, repoSlug } from '../lib/evaluation/learning-apply.js';

const tmpDirs = [];
after(() => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });

function git(dir, args) {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return (r.stdout ?? '').trim();
}
function identify(dir) {
  git(dir, ['config', 'user.name', 'Test']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'core.autocrlf', 'false']);
}
const BRANCH = 'glmps2/main';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-publish-'));
  tmpDirs.push(root);
  const origin = path.join(root, 'origin.git');
  spawnSync('git', ['init', '--bare', `--initial-branch=${BRANCH}`, origin], { windowsHide: true });
  const seed = path.join(root, 'seed');
  spawnSync('git', ['init', `--initial-branch=${BRANCH}`, seed], { windowsHide: true });
  identify(seed);
  fs.mkdirSync(path.join(seed, 'assets'));
  fs.writeFileSync(path.join(seed, 'assets', 'CLAUDE.global.md'), '# T\n');
  fs.writeFileSync(path.join(seed, 'README.md'), 'x\n');
  git(seed, ['add', '.']);
  git(seed, ['commit', '-m', 'seed']);
  git(seed, ['remote', 'add', 'origin', origin]);
  git(seed, ['push', 'origin', BRANCH]);
  const clone = (name) => {
    const dir = path.join(root, name);
    spawnSync('git', ['clone', '-c', 'core.autocrlf=false', origin, dir], { windowsHide: true });
    identify(dir);
    return dir;
  };
  const dev = clone('dev');
  const other = clone('other');
  return { root, origin, dev, other, assets: path.join(dev, 'assets') };
}

const apply = (fx, extra = {}) => applyGuard({
  assetsDir: fx.assets, file: 'CLAUDE.global.md', section: 'Learned guards', rule: '- a new rule',
  message: 'learning: apply L1', serverRoot: null, publish: true, now: () => 1234, ...extra,
});
const remoteHead = (fx) => git(fx.origin, ['rev-parse', BRANCH]);
const otherPushes = (fx) => {
  fs.writeFileSync(path.join(fx.other, 'assets', 'other.md'), 'o\n');
  git(fx.other, ['add', '.']);
  git(fx.other, ['commit', '-m', 'someone else']);
  git(fx.other, ['push', 'origin', BRANCH]);
};

test('publish: commits under assets/ and pushes to the upstream branch', () => {
  const fx = fixture();
  const r = apply(fx);
  assert.equal(r.changed, true);
  assert.equal(remoteHead(fx), r.commit);
  assert.deepEqual(r.pushed, { repo: null, branch: BRANCH, sha: r.commit, ts: 1234 });
  assert.match(fs.readFileSync(path.join(fx.assets, 'CLAUDE.global.md'), 'utf8'), /- a new rule/);
});

test('publish: a rejected first push is fetched, rebased and pushed again', () => {
  const fx = fixture();
  let raced = false;
  const runGit = (args) => {
    const r = spawnSync('git', ['-C', fx.assets, ...args], { encoding: 'utf8', windowsHide: true });
    if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${(r.stderr ?? '').trim()}`);
    if (args[0] === 'commit' && !raced) { raced = true; otherPushes(fx); }
    return (r.stdout ?? '').trim();
  };
  const r = apply(fx, { runGit });
  assert.equal(raced, true);
  assert.equal(remoteHead(fx), r.commit);
  assert.equal(r.pushed.sha, r.commit);
  assert.match(git(fx.origin, ['log', '--format=%s', BRANCH]), /someone else/);
});

test('publish: two failed pushes reset the clone to the pre-commit sha and throw', () => {
  const fx = fixture();
  const before = git(fx.dev, ['rev-parse', 'HEAD']);
  const hook = path.join(fx.origin, 'hooks', 'pre-receive');
  fs.writeFileSync(hook, '#!/bin/sh\necho nope >&2\nexit 1\n', { mode: 0o755 });
  assert.throws(() => apply(fx), /lesson push failed twice/);
  assert.equal(git(fx.dev, ['rev-parse', 'HEAD']), before);
  assert.equal(git(fx.dev, ['status', '--porcelain']), '');
});

test('publish: a commit touching a non-assets path is reset and refused', () => {
  const fx = fixture();
  const before = git(fx.dev, ['rev-parse', 'HEAD']);
  const origHead = remoteHead(fx);
  assert.throws(() => apply(fx, { file: '../x.md' }), /outside assets/);
  assert.equal(git(fx.dev, ['rev-parse', 'HEAD']), before);
  assert.equal(remoteHead(fx), origHead);
});

test('publish: a pull --ff-only failure throws before the file is written', () => {
  const fx = fixture();
  fs.writeFileSync(path.join(fx.dev, 'local.md'), 'l\n');
  git(fx.dev, ['add', '.']);
  git(fx.dev, ['commit', '-m', 'local only']);
  otherPushes(fx);
  assert.throws(() => apply(fx), /dev clone pull failed/);
  assert.doesNotMatch(fs.readFileSync(path.join(fx.assets, 'CLAUDE.global.md'), 'utf8'), /new rule/);
});

test('publish: a guard already present returns changed:false and pushes nothing', () => {
  const fx = fixture();
  apply(fx);
  const head = remoteHead(fx);
  const r = apply(fx);
  assert.equal(r.changed, false);
  assert.equal(r.pushed, undefined);
  assert.equal(remoteHead(fx), head);
});

test('publish: no upstream throws', () => {
  const fx = fixture();
  git(fx.dev, ['branch', '--unset-upstream']);
  assert.throws(() => apply(fx), /upstream/);
});

test('publish off (default): commits locally and never pushes', () => {
  const fx = fixture();
  const head = remoteHead(fx);
  const r = apply(fx, { publish: undefined });
  assert.equal(r.changed, true);
  assert.equal(r.pushed, undefined);
  assert.equal(remoteHead(fx), head);
});

test('repoSlug parses owner/name from https and ssh remotes', () => {
  assert.equal(repoSlug('https://github.com/wolfeb-dev/glmps-2.0-runtime.git'), 'wolfeb-dev/glmps-2.0-runtime');
  assert.equal(repoSlug('https://github.com/wolfeb-dev/glmps-2.0-runtime'), 'wolfeb-dev/glmps-2.0-runtime');
  assert.equal(repoSlug('git@github.com:wolfeb-dev/glmps-2.0-runtime.git'), 'wolfeb-dev/glmps-2.0-runtime');
  assert.equal(repoSlug('ssh://git@github.com/o/n.git'), 'o/n');
  assert.equal(repoSlug('C:\\tmp\\origin.git'), null);
  assert.equal(repoSlug('/tmp/origin.git'), null);
  assert.equal(repoSlug(''), null);
});
