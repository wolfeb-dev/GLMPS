import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSetupService } from '../src/lib/setup/assemble.js';

const STATUS = {
  deps: [], claude: { installed: false, signedIn: false }, github: { installed: false, signedIn: false, scopes: [], missingScopes: [] },
  slack: { saved: false }, hooks: { installed: false }, profile: { path: 'P', exists: false },
};

function make(over = {}) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'glmps-assemble-'));
  const runs = [];
  const env = { PATH: 'old' };
  const c = createSetupService({
    kernel: { node: 'N', kernelDir: 'K' }, userData, profileFile: path.join(userData, 'glmps.profile.json'),
    kernelScript: async (o) => { runs.push(o); return { code: 0, json: STATUS }; },
    visible: async () => ({ code: 0 }), refreshPath: async () => 'new', env, platform: 'win32',
    restartKernel: async () => ({ ok: true }), finish: async () => {}, openExternal: async () => {}, log: () => {}, ...over,
  });
  return { c, runs, env, userData };
}

test('the first health probe skips the version lookups, later ones include them, and the profile path is passed', async () => {
  const { c, runs, userData } = make();
  await c.getState();
  await c.run('claude', 'recheck');
  assert.deepEqual(runs[0].args, ['--no-latest', path.join(userData, 'glmps.profile.json')]);
  assert.deepEqual(runs[1].args, [path.join(userData, 'glmps.profile.json')]);
  assert.equal(runs[0].script, 'scripts/setup/setup-status.mjs');
});

test('progress is saved under userData as setup-progress.json and read back by a new service', async () => {
  const { c, userData } = make();
  await c.run('welcome', 'begin');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(userData, 'setup-progress.json'), 'utf8')), { completed: ['welcome'], skipped: [] });
  const again = createSetupService({
    kernel: null, userData, profileFile: 'p', kernelScript: async () => ({}), visible: async () => ({}), refreshPath: async () => '', env: {}, platform: 'linux',
    restartKernel: async () => ({}), finish: async () => {}, openExternal: async () => {}, log: () => {},
  });
  assert.equal((await again.getState()).steps.find((s) => s.id === 'welcome').status, 'ok');
});

test('with no local kernel the wizard still opens, degraded', async () => {
  const { c } = make({ kernel: null });
  const s = await c.getState();
  assert.equal(s.steps.length, 9);
  assert.equal(s.currentId, 'welcome');
});

// Card glmps-2-0-205: the probe reads the state dir Slack connect wrote to.
test('the health probe gets the state-dir override, and the kernel state dir reaches the handlers', async () => {
  const { c, runs } = make({ stateDirOverride: 'D:\state' });
  await c.getState();
  assert.equal(runs[0].env?.GLMPS_STATE_DIR, 'D:\state');
  const plain = make();
  await plain.c.getState();
  assert.equal(plain.runs[0].env?.GLMPS_STATE_DIR, undefined);

  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'glmps-repos-'));
  const kernelStateDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'glmps-ksd-')), 'state');
  const scan = make({
    kernelStateDir,
    kernelScript: async (o) => {
      if (o.script === 'scripts/glmps-init.mjs') { fs.writeFileSync(path.join(o.cwd, 'glmps.profile.json'), '{}'); return { code: 0, tail: '' }; }
      return { code: 0, json: STATUS };
    },
  });
  await scan.c.run('repos', 'scan', { folder, engagement: 'acme' });
  assert.ok(fs.existsSync(path.join(kernelStateDir, 'glmps.profile.json')));
});
