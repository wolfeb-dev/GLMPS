// server/test/nightly-config.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { nightlyConfig, killSwitchEngaged } from '../lib/orchestration/nightly-config.js';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'mc-nightly-config-')); }

test('nightlyConfig defaults to disabled, an empty allowlist and a null budget', () => {
  const cfg = nightlyConfig({});
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.hour, 22);
  assert.deepEqual(cfg.repoAllowlist, []);
  assert.deepEqual(cfg.budget, { maxUsd: null, maxTokens: null });
  assert.equal(cfg.maxItems, 1);
  assert.equal(cfg.killFile, 'nightly.kill');
  assert.equal(cfg.target, 'native-terminal');
});

test('nightlyConfig overrides defaults from cfg.nightly', () => {
  const cfg = nightlyConfig({
    nightly: {
      enabled: true, hour: 3, repoAllowlist: ['glmps'],
      budget: { maxUsd: 10, maxTokens: 50000 }, maxItems: 2,
      killFile: 'stop.txt', target: 'vscode',
    },
  });
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.hour, 3);
  assert.deepEqual(cfg.repoAllowlist, ['glmps']);
  assert.deepEqual(cfg.budget, { maxUsd: 10, maxTokens: 50000 });
  assert.equal(cfg.maxItems, 2);
  assert.equal(cfg.killFile, 'stop.txt');
  assert.equal(cfg.target, 'vscode');
});

test('nightlyConfig ignores a malformed nightly block instead of throwing', () => {
  assert.doesNotThrow(() => nightlyConfig(null));
  assert.doesNotThrow(() => nightlyConfig({ nightly: 'nope' }));
  assert.deepEqual(nightlyConfig({ nightly: 'nope' }).repoAllowlist, []);
});

test('killSwitchEngaged is true when config.enabled is false, with no filesystem check needed', () => {
  assert.equal(killSwitchEngaged(undefined, { enabled: false }), true);
});

test('killSwitchEngaged is false with no stateDir and no explicit disable', () => {
  assert.equal(killSwitchEngaged(undefined, { enabled: true }), false);
});

test('killSwitchEngaged is true once the kill file is dropped in <stateDir>/nightly', () => {
  const dir = tmp();
  const cfg = nightlyConfig({ nightly: { enabled: true } });
  assert.equal(killSwitchEngaged(dir, cfg), false);
  fs.mkdirSync(path.join(dir, 'nightly'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'nightly', cfg.killFile), '');
  assert.equal(killSwitchEngaged(dir, cfg), true);
});

test('killSwitchEngaged respects a custom killFile name', () => {
  const dir = tmp();
  const cfg = nightlyConfig({ nightly: { enabled: true, killFile: 'stop.txt' } });
  fs.mkdirSync(path.join(dir, 'nightly'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'nightly', 'nightly.kill'), '');
  assert.equal(killSwitchEngaged(dir, cfg), false, 'the default kill file name must not trip a custom killFile config');
  fs.writeFileSync(path.join(dir, 'nightly', 'stop.txt'), '');
  assert.equal(killSwitchEngaged(dir, cfg), true);
});
