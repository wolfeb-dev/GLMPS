// server/test/project-dirs.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findRepoDirs, computeAdditionalDirectories, syncProjectDirs, createProject } from '../lib/orchestration/project-dirs.js';

const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });
function mkTmp() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-')); tmpDirs.push(d); return d; }
function mkRepo(root, name) { const d = path.join(root, name); fs.mkdirSync(path.join(d, '.git'), { recursive: true }); return d; }
function mkPlain(root, name) { const d = path.join(root, name); fs.mkdirSync(d, { recursive: true }); return d; }

// Private dirs: this sync is what made `git init D:\Vault` silently expose a
// personal directory to every agent session. A private dir must never be added,
// and one ALREADY present must be actively removed - prevention alone would
// leave the existing exposure in place forever.

test('computeAdditionalDirectories never adds a private repo found under a root', () => {
  const root = mkTmp();
  mkRepo(root, 'alpha');
  const secret = mkRepo(root, 'vault');
  const next = computeAdditionalDirectories({
    roots: [root], current: [], privateDirs: [secret.replace(/\\/g, '/')],
  });
  assert.ok(next.some(d => d.endsWith('/alpha')), 'non-private repo still added');
  assert.ok(!next.some(d => d.endsWith('/vault')), 'private repo never added');
});

test('computeAdditionalDirectories REMOVES a private dir that is already present', () => {
  const root = mkTmp();
  const secret = mkRepo(root, 'vault');
  const present = secret.replace(/\\/g, '/');
  const next = computeAdditionalDirectories({
    roots: [root], current: [present], privateDirs: [present],
  });
  assert.ok(!next.includes(present), 'an already-synced private dir is healed away, not just prevented');
});

test('computeAdditionalDirectories removes a private dir added OUTSIDE the managed roots', () => {
  const root = mkTmp();
  mkRepo(root, 'alpha');
  const external = 'X:/personal/taxes';
  const next = computeAdditionalDirectories({
    roots: [root], current: [external], privateDirs: [external],
  });
  assert.ok(!next.includes(external), 'the preserve-externals path does not smuggle a private dir back in');
});

test('computeAdditionalDirectories with no privateDirs behaves exactly as before', () => {
  const root = mkTmp();
  mkRepo(root, 'alpha');
  const withOut = computeAdditionalDirectories({ roots: [root], current: [] });
  const withEmpty = computeAdditionalDirectories({ roots: [root], current: [], privateDirs: [] });
  assert.deepEqual(withEmpty, withOut);
  assert.ok(withOut.some(d => d.endsWith('/alpha')));
});

test('findRepoDirs returns only child dirs containing .git', () => {
  const root = mkTmp();
  mkRepo(root, 'alpha'); mkRepo(root, 'beta'); mkPlain(root, 'notrepo');
  const found = findRepoDirs([root]).map(p => path.basename(p)).sort();
  assert.deepEqual(found, ['alpha', 'beta']);
});

test('computeAdditionalDirectories refreshes managed roots, preserves externals, sorts', () => {
  const root = mkTmp();
  mkRepo(root, 'alpha');
  const external = 'X:/manual/dir';
  const stale = root.replace(/\\/g, '/') + '/stale-removed';
  const next = computeAdditionalDirectories({ roots: [root], current: [external, stale] });
  assert.ok(next.includes(external), 'external entry preserved');
  assert.ok(next.some(d => d.endsWith('/alpha')), 'discovered repo added');
  assert.ok(!next.some(d => d.endsWith('/stale-removed')), 'stale managed entry dropped');
  assert.deepEqual(next, [...next].sort((a, b) => a.localeCompare(b)), 'sorted');
});

test('syncProjectDirs writes idempotently and preserves other settings', () => {
  const root = mkTmp(); mkRepo(root, 'alpha');
  const settingsFile = path.join(mkTmp(), 'settings.json');
  fs.writeFileSync(settingsFile, JSON.stringify({ permissions: { defaultMode: 'auto' }, theme: 'dark' }, null, 2));
  const r1 = syncProjectDirs({ settingsFile, roots: [root] });
  assert.equal(r1.ok, true); assert.equal(r1.changed, true);
  const s1 = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  assert.equal(s1.theme, 'dark');
  assert.equal(s1.permissions.defaultMode, 'auto');
  assert.ok(s1.permissions.additionalDirectories.some(d => d.endsWith('/alpha')));
  const r2 = syncProjectDirs({ settingsFile, roots: [root] });
  assert.equal(r2.changed, false); // idempotent
});

test('syncProjectDirs refuses unreadable settings', () => {
  const r = syncProjectDirs({ settingsFile: path.join(mkTmp(), 'nope.json'), roots: [] });
  assert.equal(r.ok, false);
});

// createProject: the one function behind POST /api/projects and
// scripts/create-project.mjs. Real git in a temp dir, temp settings and config.
function createFixture() {
  const root = mkTmp();
  const settingsFile = path.join(root, 'settings.json');
  const claudeConfigFile = path.join(root, 'claude.json');
  fs.writeFileSync(claudeConfigFile, JSON.stringify({ projects: {} }));
  return { root, settingsFile, claudeConfigFile, dir: path.join(root, 'proj', 'new-app') };
}
const fwd = (p) => p.replace(/\\/g, '/');
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

test('createProject creates, inits, registers and trusts a new dir', () => {
  const f = createFixture();
  fs.writeFileSync(f.settingsFile, JSON.stringify({ theme: 'dark', permissions: { allow: ['x'], additionalDirectories: ['D:/other'] } }));
  const r = createProject({ settingsFile: f.settingsFile, dir: f.dir, claudeConfigFile: f.claudeConfigFile, env: {} });
  assert.deepEqual({ ok: r.ok, created: r.created, initialized: r.initialized, registered: r.registered, trusted: r.trusted }, { ok: true, created: true, initialized: true, registered: true, trusted: true });
  assert.equal(r.dir, fwd(f.dir));
  assert.ok(fs.existsSync(path.join(f.dir, '.git')), 'git init ran');
  const s = readJson(f.settingsFile);
  assert.deepEqual(s.permissions.additionalDirectories, ['D:/other', fwd(f.dir)]);
  assert.equal(s.theme, 'dark', 'other keys preserved');
  assert.deepEqual(s.permissions.allow, ['x']);
  assert.equal(readJson(f.claudeConfigFile).projects[fwd(f.dir)].hasTrustDialogAccepted, true);
});

test('createProject is idempotent and dedupes any spelling already registered', () => {
  const f = createFixture();
  const spelled = fwd(f.dir).toUpperCase() + '/';
  fs.writeFileSync(f.settingsFile, JSON.stringify({ permissions: { additionalDirectories: [spelled] } }));
  const r = createProject({ settingsFile: f.settingsFile, dir: f.dir, claudeConfigFile: f.claudeConfigFile, env: {} });
  assert.equal(r.ok, true);
  assert.equal(r.registered, false);
  assert.deepEqual(readJson(f.settingsFile).permissions.additionalDirectories, [spelled]);
  const again = createProject({ settingsFile: f.settingsFile, dir: f.dir, claudeConfigFile: f.claudeConfigFile, env: {} });
  assert.equal(again.created, false);
  assert.equal(again.initialized, false);
});

test('createProject adopts an existing repo without re-initialising it', () => {
  const f = createFixture();
  fs.mkdirSync(path.join(f.dir, '.git'), { recursive: true });
  let gitCalls = 0;
  const r = createProject({ settingsFile: f.settingsFile, dir: f.dir, claudeConfigFile: f.claudeConfigFile, env: {}, runGit: () => { gitCalls++; } });
  assert.equal(r.ok, true);
  assert.equal(r.initialized, false);
  assert.equal(gitCalls, 0);
  assert.deepEqual(readJson(f.settingsFile), { permissions: { additionalDirectories: [fwd(f.dir)] } }, 'missing settings file is created');
});

test('createProject refuses an empty path, a relative path and a private dir by name', () => {
  const f = createFixture();
  const base = { settingsFile: f.settingsFile, claudeConfigFile: f.claudeConfigFile, env: {} };
  assert.match(createProject({ ...base, dir: '' }).reason, /empty|absolute/);
  assert.match(createProject({ ...base, dir: 'rel/path' }).reason, /absolute/);
  const priv = createProject({ ...base, dir: f.dir, privateDirs: [fwd(f.dir)] });
  assert.equal(priv.ok, false);
  assert.equal(priv.private, true);
  assert.match(priv.reason, /private/);
  assert.ok(!fs.existsSync(f.dir), 'a refused private dir is not even created');
  assert.ok(!fs.existsSync(f.settingsFile));
});

test('createProject leaves a malformed settings file untouched and reports it', () => {
  const f = createFixture();
  fs.writeFileSync(f.settingsFile, '{ not json');
  const r = createProject({ settingsFile: f.settingsFile, dir: f.dir, claudeConfigFile: f.claudeConfigFile, env: {} });
  assert.equal(r.ok, false);
  assert.equal(fs.readFileSync(f.settingsFile, 'utf8'), '{ not json');
});

test('createProject never throws when git fails', () => {
  const f = createFixture();
  const r = createProject({ settingsFile: f.settingsFile, dir: f.dir, claudeConfigFile: f.claudeConfigFile, env: {}, runGit: () => { throw new Error('no git'); } });
  assert.equal(r.ok, false);
  assert.match(r.reason, /no git/);
});

test('createProject with GLMPS_AUTO_TRUST=0 registers but does not trust', () => {
  const f = createFixture();
  const r = createProject({ settingsFile: f.settingsFile, dir: f.dir, claudeConfigFile: f.claudeConfigFile, env: { GLMPS_AUTO_TRUST: '0' } });
  assert.equal(r.ok, true);
  assert.equal(r.registered, true);
  assert.equal(r.trusted, false);
  assert.deepEqual(readJson(f.claudeConfigFile), { projects: {} });
});
