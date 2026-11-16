// server/test/discover.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discoverRepos, discoverHarnesses, buildProfileDraft } from '../lib/chassis/discover.js';

test('discoverRepos finds .git dirs up to depth 2', () => {
  const tree = { '/s/a/.git': true, '/s/b/c/.git': true, '/s/d': true };
  const fsmod = {
    readdirSync: (d) => {
      if (d === '/s') return [{ name: 'a', isDirectory: () => true }, { name: 'b', isDirectory: () => true }, { name: 'd', isDirectory: () => true }];
      if (d === '/s/b') return [{ name: 'c', isDirectory: () => true }];
      return [];
    },
    existsSync: (p) => !!tree[p.replace(/\\/g, '/')],
  };
  const repos = discoverRepos(['/s'], fsmod).map(p => p.replace(/\\/g, '/'));
  assert.ok(repos.includes('/s/a'));
  assert.ok(repos.includes('/s/b/c'));
  assert.ok(!repos.includes('/s/d'));
});

test('buildProfileDraft only includes installed harness dirs', () => {
  const draft = buildProfileDraft({
    engagement: 'acme', identity: { handle: 'al' }, repoRoots: ['/r'],
    harnesses: [{ id: 'claude-code', installed: true, dataDirs: ['/c/claude'] }, { id: 'codex-cli', installed: false, dataDirs: ['/c/codex'] }],
    stateDir: '~/.glmps/acme',
  });
  assert.equal(draft.engagement, 'acme');
  assert.deepEqual(draft.repoRoots, ['/r']);
  assert.equal(draft.harness.claudeDir, '/c/claude');
  assert.ok(!('codexDir' in draft.harness) || draft.harness.codexDir == null);
});

test('discoverRepos excludes .git dirs at depth > 2', () => {
  // /s/a/b/c contains .git but is 3 levels from /s (depth 3 > maxDepth 2) - must not be found.
  const tree = { '/s/a/b/c/.git': true };
  const fsmod = {
    readdirSync: (d) => {
      const map = {
        '/s':       [{ name: 'a', isDirectory: () => true }],
        '/s/a':     [{ name: 'b', isDirectory: () => true }],
        '/s/a/b':   [{ name: 'c', isDirectory: () => true }],
      };
      return map[d] ?? [];
    },
    existsSync: (p) => !!tree[p.replace(/\\/g, '/')],
  };
  const repos = discoverRepos(['/s'], fsmod).map(p => p.replace(/\\/g, '/'));
  assert.equal(repos.length, 0, 'depth-3 repo must not be discovered');
  assert.ok(!repos.includes('/s/a/b/c'));
});

test('discoverHarnesses maps installed state and swallows detect errors', () => {
  const adapters = [
    { id: 'claude-code', detect: () => ({ installed: true, dataDirs: ['/home/.claude'] }) },
    { id: 'codex-cli',  detect: () => ({ installed: false, dataDirs: [] }) },
    { id: 'broken',     detect: () => { throw new Error('oops'); } },
  ];
  const result = discoverHarnesses({}, adapters);
  assert.equal(result.length, 3);
  const cc = result.find(r => r.id === 'claude-code');
  assert.equal(cc.installed, true);
  assert.deepEqual(cc.dataDirs, ['/home/.claude']);
  const codex = result.find(r => r.id === 'codex-cli');
  assert.equal(codex.installed, false);
  const broken = result.find(r => r.id === 'broken');
  assert.equal(broken.installed, false);
  assert.deepEqual(broken.dataDirs, []);
});
