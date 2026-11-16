// The shipped config.json defaults (server/lib/config-defaults.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configDefaults, SCUT_DEFAULTS, HUDDLE_DEFAULTS } from '../lib/config-defaults.js';

test('configDefaults answers a fresh object on every call', () => {
  const a = configDefaults();
  const b = configDefaults();
  assert.notEqual(a, b);
  a.terminals.push({ label: 'x' });
  a.backlog.archiveDays = 99;
  a.integrationBranches.push('mutated');
  assert.equal(b.terminals.length, 4);
  assert.equal(b.backlog.archiveDays, 7);
  assert.equal(b.integrationBranches.includes('mutated'), false);
});

test('mutating one call\'s scut and huddle sections never reaches the shared defaults', () => {
  const a = configDefaults();
  a.scut.enabled = false;
  a.huddle.floorModel = 'changed';
  assert.equal(SCUT_DEFAULTS.enabled, true);
  assert.equal(HUDDLE_DEFAULTS.floorModel, 'haiku');
  assert.equal(configDefaults().scut.enabled, true);
});

test('the loopback server defaults and the opt-in features stay as documented', () => {
  const c = configDefaults();
  assert.equal(c.port, 8123);
  assert.equal(c.host, '127.0.0.1');
  assert.equal(c.accessToken, null);
  assert.equal(c.nightly.enabled, false);
  assert.deepEqual(c.nightly.repoAllowlist, []);
  assert.equal(c.learningIntegrity.freeze, true);
  assert.equal(c.platformAutonomy.enabled, false);
  assert.equal(c.scut.channelMessages, false);
  assert.equal(c.scut.rejoinReopens, false);
});

test('graph scope defaults: machine scan off, nothing excluded, fresh copy per call', () => {
  const a = configDefaults();
  assert.equal(a.graph.machine.enabled, false);
  assert.deepEqual(a.graph.machine.exclude, []);
  assert.equal(a.graph.ship.corpusRoot, null);
  a.graph.machine.exclude.push('x');
  a.graph.ship.corpusRoot = '/changed';
  const b = configDefaults();
  assert.deepEqual(b.graph.machine.exclude, []);
  assert.equal(b.graph.ship.corpusRoot, null);
});

test('every task class maps to a roster agent', () => {
  const routes = configDefaults().agentRoutes;
  assert.deepEqual(Object.keys(routes).sort(), ['debug', 'docs', 'feature', 'ops', 'refactor', 'research', 'review', 'ui']);
  for (const agent of Object.values(routes)) assert.match(agent, /^[a-z][a-z-]+$/);
});
