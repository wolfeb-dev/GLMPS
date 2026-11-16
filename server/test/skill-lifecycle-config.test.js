import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getSkillLifecycleConfig, DEFAULTS } from '../lib/evaluation/skill-lifecycle-config.js';

test('defaults when no config', () => {
  const c = getSkillLifecycleConfig();
  assert.equal(c.enabled, true);          // archive-scan: no network, on by default
  assert.equal(c.checkUpdates, false);    // network egress: opt-in only
  assert.equal(c.minObservationDays, 180);
  assert.deepEqual(c.exempt, []);
  assert.equal(c.tickMs, 86400000);
});

test('overrides merge over defaults', () => {
  const c = getSkillLifecycleConfig({ skillLifecycle: { checkUpdates: true, exempt: ['a:b'] } });
  assert.equal(c.checkUpdates, true);
  assert.deepEqual(c.exempt, ['a:b']);
  assert.equal(c.enabled, true); // untouched default
  assert.equal(c.minObservationDays, 180); // untouched default
});

test('malformed input returns defaults', () => {
  assert.equal(getSkillLifecycleConfig(null).enabled, DEFAULTS.enabled);
  assert.equal(getSkillLifecycleConfig('nope').checkUpdates, DEFAULTS.checkUpdates);
  assert.equal(getSkillLifecycleConfig({ skillLifecycle: 'nope' }).tickMs, DEFAULTS.tickMs);
});
