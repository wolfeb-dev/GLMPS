// The desktop setup wizard's kernel scripts: they ship in the staged kernel and
// obey their contract (one JSON line, tokens only from the environment).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { classify, PROFILES } from '../../scripts/release-builder.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const SCRIPTS = ['scripts/setup/setup-status.mjs', 'scripts/setup/slack-connect.mjs', 'scripts/install.mjs', 'scripts/glmps-init.mjs'];

test('every script the wizard runs ships in the staged kernel', () => {
  for (const rel of SCRIPTS) assert.deepEqual(classify(rel, PROFILES.kernel), { out: rel }, rel);
});

function runScript(rel, env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glmps-setup-scripts-'));
  try {
    return spawnSync(process.execPath, [path.join(ROOT, rel), '--no-latest'], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, GLMPS_STATE_DIR: dir, GLMPS_CLAUDE_DIR: dir, SCUT_CREDS_FILE: path.join(dir, 'scut.json'), ...env },
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('slack-connect prints one JSON line and never echoes a token', () => {
  const r = runScript('scripts/setup/slack-connect.mjs', { SETUP_BOT_TOKEN: 'xoxb-leaky', SETUP_APP_TOKEN: 'not-an-app-token' });
  const lines = r.stdout.trim().split('\n');
  assert.equal(lines.length, 1);
  const out = JSON.parse(lines[0]);
  assert.deepEqual({ ok: out.ok, error: out.error }, { ok: false, error: 'invalid_tokens' });
  assert.ok(!r.stdout.includes('xoxb-leaky') && !r.stderr.includes('xoxb-leaky'));
  assert.equal(r.status, 1);
});

test('setup-status prints one JSON line with every section', () => {
  const r = runScript('scripts/setup/setup-status.mjs', { GLMPS_PROFILE: path.join(os.tmpdir(), 'no-such-profile.json') });
  const lines = r.stdout.trim().split('\n');
  assert.equal(lines.length, 1);
  const s = JSON.parse(lines[0]);
  assert.deepEqual(Object.keys(s).sort(), ['claude', 'deps', 'editorPick', 'editors', 'github', 'hooks', 'profile', 'slack']);
  assert.equal(s.slack.saved, false);
  assert.equal(s.hooks.installed, false);
  assert.equal(s.profile.exists, false);
});
