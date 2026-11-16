// server/test/profile.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expandHome, normalizeProfile, loadProfile, deriveTierRoots } from '../lib/chassis/profile.js';

const HOME = '/home/tester';

test('expandHome expands a leading ~', () => {
  assert.equal(expandHome('~/x', HOME), path.join(HOME, 'x'));
  assert.equal(expandHome('/abs/x', HOME), '/abs/x');
  assert.equal(expandHome(null, HOME), null);
});

test('normalizeProfile fills defaults and expands paths', () => {
  const p = normalizeProfile({ engagement: 'acme', stateDir: '~/.glmps/acme', repoRoots: ['~/acme/api'] }, HOME);
  assert.equal(p.version, 1);
  assert.equal(p.engagement, 'acme');
  assert.equal(p.stateDir, path.join(HOME, '.glmps/acme'));
  assert.deepEqual(p.repoRoots, [path.join(HOME, 'acme/api')]);
  assert.equal(p.tiers, null);
  assert.equal(p.mutationPolicy.artifact, 'gate');
  assert.equal(p.harness.claudeDir, null);
});

test('normalizeProfile returns null for non-objects', () => {
  assert.equal(normalizeProfile(null, HOME), null);
  assert.equal(normalizeProfile('x', HOME), null);
});

test('loadProfile reads GLMPS_PROFILE then cwd, null on miss/parse-error', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glmps-prof-'));
  const file = path.join(dir, 'glmps.profile.json');
  fs.writeFileSync(file, JSON.stringify({ engagement: 'acme', repoRoots: ['/x'] }));
  assert.equal(loadProfile({ cwd: dir, env: {}, home: HOME }).engagement, 'acme');
  // GLMPS_PROFILE must take precedence over cwd - use a DISTINCT file with different content.
  const envDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glmps-prof-env-'));
  const envFile = path.join(envDir, 'glmps.profile.json');
  fs.writeFileSync(envFile, JSON.stringify({ engagement: 'env-wins', repoRoots: ['/y'] }));
  assert.equal(loadProfile({ cwd: dir, env: { GLMPS_PROFILE: envFile }, home: HOME }).engagement, 'env-wins');
  assert.equal(loadProfile({ cwd: '/nonexistent', env: {}, home: HOME }), null);
  fs.writeFileSync(file, '{ not json');
  assert.equal(loadProfile({ cwd: dir, env: {}, home: HOME }), null);
});


// Card glmps-2-0-205: a kernel the desktop app did not launch (the service, a
// checkout) has no GLMPS_PROFILE and a cwd of its own, so the setup wizard
// also puts the profile in the state dir.
test('loadProfile falls back to the state dir, after GLMPS_PROFILE and cwd', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glmps-prof-state-'));
  fs.writeFileSync(path.join(stateDir, 'glmps.profile.json'), JSON.stringify({ engagement: 'from-state', repoRoots: ['/s'] }));
  assert.equal(loadProfile({ cwd: '/nonexistent', env: {}, home: HOME, stateDir }).engagement, 'from-state');
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'glmps-prof-cwd-'));
  fs.writeFileSync(path.join(cwd, 'glmps.profile.json'), JSON.stringify({ engagement: 'from-cwd', repoRoots: ['/c'] }));
  assert.equal(loadProfile({ cwd, env: {}, home: HOME, stateDir }).engagement, 'from-cwd');
  assert.equal(loadProfile({ cwd: '/nonexistent', env: {}, home: HOME }), null);
});

test('deriveTierRoots derives from P + adapter tierDirs when no override', () => {
  const P = {
    profile: { tiers: null }, repoRoots: ['/c/api'],
    assetsDir: '/c/assets', agentsDir: '/c/assets/agents',
    claudeDir: '/c/claude', projectsDir: '/c/claude/projects', stateDir: '/c/state',
  };
  const fakeAdapter = { id: 'claude-code', tierDirs: (p) => ({ brain: [p.claudeDir + '/skills'], ephemeral: [p.projectsDir] }) };
  const r = deriveTierRoots(P, [fakeAdapter]);
  assert.deepEqual(r.artifact, ['/c/api']);
  assert.ok(r.brain.includes('/c/assets'));
  assert.ok(r.brain.includes('/c/claude/skills'));
  assert.ok(r.ephemeral.includes('/c/state'));
  assert.ok(r.ephemeral.includes('/c/claude/projects'));
});

test('deriveTierRoots honors an explicit tiers override', () => {
  const P = { profile: { tiers: { artifact: ['/x'], brain: ['/y'], ephemeral: ['/z'] } }, repoRoots: ['/ignored'] };
  const r = deriveTierRoots(P, []);
  assert.deepEqual(r, { artifact: ['/x'], brain: ['/y'], ephemeral: ['/z'] });
});
