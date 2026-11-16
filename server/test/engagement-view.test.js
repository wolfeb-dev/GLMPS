// server/test/engagement-view.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { engagementView } from '../lib/chassis/profile.js';

test('engagementView assembles tiers + controllable + identity', () => {
  const P = {
    profile: { engagement: 'acme', identity: { handle: 'al' }, tiers: null, mutationPolicy: { artifact: 'gate', brain: 'versioned', ephemeral: 'readonly' } },
    repoRoots: ['/c/api'], assetsDir: '/c/assets', agentsDir: '/c/assets/agents', stateDir: '/c/state',
    claudeDir: '/c/claude', projectsDir: '/c/claude/projects',
  };
  const ctl = { id: 'claude-code', controllable: true, detect: () => ({ installed: true }), tierDirs: (p) => ({ brain: [p.claudeDir + '/skills'], ephemeral: [p.projectsDir] }) };
  const v = engagementView(P, [ctl]);
  assert.equal(v.engagement, 'acme');
  assert.equal(v.controllable, true);
  assert.deepEqual(v.tiers.artifact.roots, ['/c/api']);
  assert.ok(v.tiers.brain.roots.includes('/c/assets'));
  assert.equal(v.mutationPolicy.brain, 'versioned');
});

test('engagementView with no adapters yields controllable=false and empty tier roots', () => {
  // Observe-only: no adapters, no roots - tests the minimal/empty code path.
  const P = {
    profile: { engagement: 'obs', identity: null, tiers: null, mutationPolicy: null },
    repoRoots: [], assetsDir: null, agentsDir: null, stateDir: null,
    claudeDir: null, projectsDir: null,
  };
  const v = engagementView(P, []);
  assert.equal(v.engagement, 'obs');
  assert.equal(v.controllable, false);
  assert.deepEqual(v.tiers.artifact.roots, []);
  assert.deepEqual(v.tiers.brain.roots, []);
  assert.deepEqual(v.tiers.ephemeral.roots, []);
  // Default mutation policy applied when profile.mutationPolicy is absent.
  assert.equal(v.mutationPolicy.artifact, 'gate');
  assert.equal(v.mutationPolicy.brain, 'versioned');
  assert.equal(v.mutationPolicy.ephemeral, 'readonly');
});
