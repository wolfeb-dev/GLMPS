// The operator script that gives the merge queue its own clone (card glmps-2-0-runtime-16).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { main, planRepoEntry, DEFAULT_REPO } from '../../scripts/merge-queue-clone.mjs';

const REPO = 'wolfeb-dev/glmps';
const g = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf-8' }).trim();

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-mqclone-'));
  const seed = path.join(root, 'seed');
  const origin = path.join(root, 'origin.git');
  execFileSync('git', ['init', '-q', seed]);
  for (const [k, v] of [['user.email', 't@t'], ['user.name', 'T'], ['commit.gpgsign', 'false']]) g(seed, 'config', k, v);
  fs.writeFileSync(path.join(seed, 'a.txt'), 'x\n');
  g(seed, 'add', '.'); g(seed, 'commit', '-q', '-m', 'seed');
  execFileSync('git', ['init', '-q', '--bare', origin]);
  g(seed, 'push', '-q', origin, 'HEAD:refs/heads/glmps2/main');
  const config = path.join(root, 'config.json');
  const cfg = { port: 8123, mergeQueue: { autoDeploy: true, repos: { 'WolfeB-Dev/GLMPS': { path: 'D:/glmps', test: 'npm test' }, 'o/other': { path: 'D:/other' } } } };
  fs.writeFileSync(config, JSON.stringify(cfg, null, 2) + '\n');
  const stateDir = path.join(root, 'state');
  const clone = path.join(stateDir, 'repos', 'glmps');
  const snaps = () => { try { return fs.readdirSync(path.join(stateDir, 'backups', 'config')).filter((n) => n.startsWith('config.json.')); } catch { return []; } };
  const run = (...extra) => {
    const lines = [];
    const code = main(['--repo', REPO, '--config', config, '--path', clone, '--url', origin, ...extra], { env: { ...process.env, GLMPS_STATE_DIR: stateDir }, log: (l) => lines.push(l) });
    return { code, out: lines.join('\n') };
  };
  const cleanup = () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* Windows may hold git handles briefly */ } };
  return { root, stateDir, origin, config, clone, cfg, run, snaps, cleanup };
}

test('planRepoEntry re-points the matching entry case-insensitively and keeps its other fields', () => {
  const cfg = { a: 1, mergeQueue: { autoDeploy: true, repos: { 'WolfeB-Dev/GLMPS': { path: 'D:/glmps', test: 'npm test' }, 'o/x': { path: 'D:/x' } } } };
  const p = planRepoEntry(cfg, { repo: REPO, clonePath: 'C:/clone' });
  assert.equal(p.key, 'WolfeB-Dev/GLMPS');
  assert.equal(p.changed, true);
  assert.deepEqual(p.next.mergeQueue.repos['WolfeB-Dev/GLMPS'], { path: 'C:/clone', test: 'npm test' });
  assert.deepEqual(p.next.mergeQueue.repos['o/x'], { path: 'D:/x' });
  assert.equal(p.next.mergeQueue.autoDeploy, true);
  assert.equal(p.next.a, 1);
  assert.equal(cfg.mergeQueue.repos['WolfeB-Dev/GLMPS'].path, 'D:/glmps', 'input not mutated');
});

test('planRepoEntry adds an entry when none exists and reports no change when already set', () => {
  const added = planRepoEntry({}, { repo: REPO, clonePath: 'C:/clone' });
  assert.equal(added.before, null);
  assert.deepEqual(added.next.mergeQueue.repos[REPO], { path: 'C:/clone' });
  assert.equal(planRepoEntry(added.next, { repo: REPO, clonePath: 'C:/clone' }).changed, false);
});

test('dry run changes nothing on disk', () => {
  const f = fixture();
  try {
    const before = fs.readFileSync(f.config, 'utf8');
    const r = f.run();
    assert.equal(r.code, 0);
    assert.match(r.out, /DRY RUN/);
    assert.match(r.out, /would clone/);
    assert.equal(fs.readFileSync(f.config, 'utf8'), before);
    assert.equal(fs.existsSync(f.clone), false);
    assert.deepEqual(fs.readdirSync(f.root).filter((n) => n.includes('.bak')), []);
    assert.deepEqual(f.snaps(), []);
  } finally { f.cleanup(); }
});

test('--apply clones, backs up config.json and re-points only the repo path; a second run is a no-op', () => {
  const f = fixture();
  try {
    const r = f.run('--apply');
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /clone ready: 1 origin branches/);
    assert.equal(g(f.clone, 'rev-parse', 'origin/glmps2/main').length, 40);
    // The queue's own operation against the clone: a detached worktree at an origin ref.
    const wt = path.join(f.root, 'wt');
    g(f.clone, 'worktree', 'add', '-q', '--detach', wt, 'origin/glmps2/main');
    assert.ok(fs.existsSync(path.join(wt, 'a.txt')));
    g(f.clone, 'worktree', 'remove', '--force', wt);

    const next = JSON.parse(fs.readFileSync(f.config, 'utf8'));
    const expected = structuredClone(f.cfg);
    expected.mergeQueue.repos['WolfeB-Dev/GLMPS'].path = path.resolve(f.clone);
    assert.deepEqual(next, expected);
    assert.deepEqual(fs.readdirSync(f.root).filter((n) => n.includes('.bak')), [], 'nothing beside config.json');
    const backups = f.snaps();
    assert.equal(backups.length, 1);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.stateDir, 'backups', 'config', backups[0]), 'utf8')), f.cfg);

    const again = f.run('--apply');
    assert.equal(again.code, 0, again.out);
    assert.match(again.out, /clone exists/);
    assert.match(again.out, /already set, no change/);
    assert.equal(f.snaps().length, 1, 'no second backup');
  } finally { f.cleanup(); }
});

test('refuses a non-empty target that is not a clone, and a clone of some other repo', () => {
  const f = fixture();
  try {
    fs.mkdirSync(f.clone, { recursive: true });
    fs.writeFileSync(path.join(f.clone, 'stray.txt'), 'x');
    let r = f.run('--apply');
    assert.equal(r.code, 1);
    assert.match(r.out, /not a git clone/);

    fs.rmSync(f.clone, { recursive: true, force: true });
    execFileSync('git', ['init', '-q', f.clone]);
    g(f.clone, 'remote', 'add', 'origin', 'https://github.com/someone/else.git');
    const before = fs.readFileSync(f.config, 'utf8');
    r = f.run('--apply');
    assert.equal(r.code, 1);
    assert.match(r.out, /origin is "https:\/\/github.com\/someone\/else.git"/);
    assert.equal(fs.readFileSync(f.config, 'utf8'), before);
  } finally { f.cleanup(); }
});

test('refuses a config with no mergeQueue section, the mark of a checkout copy rather than the running kernel', () => {
  const f = fixture();
  try {
    fs.writeFileSync(f.config, JSON.stringify({ port: 8123 }, null, 2) + '\n');
    const before = fs.readFileSync(f.config, 'utf8');
    for (const extra of [[], ['--apply']]) {
      const r = f.run(...extra);
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /has no mergeQueue section/);
      assert.match(r.out, /--config/);
    }
    assert.equal(fs.readFileSync(f.config, 'utf8'), before);
    assert.equal(fs.existsSync(f.clone), false);
    assert.deepEqual(fs.readdirSync(f.root).filter((n) => n.includes('.bak')), []);
    assert.deepEqual(f.snaps(), []);
  } finally { f.cleanup(); }
});

test('with no --repo it clones the 2.0 repo, never the archived 1.0 one (card glmps-2-0-146)', () => {
  assert.equal(DEFAULT_REPO, 'wolfeb-dev/glmps-2.0');
});
