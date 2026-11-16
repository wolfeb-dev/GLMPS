// apps/shell/test/runner-command-contract.test.js
// glmps-2-0-61: the kernel appended --settings/--model to every runner launch
// and the shell's runner shape kept refusing them, because each side was
// tested only against its own idea of the command. This builds the command
// the way launchJob (server.js) does, with the kernel's own builders, and
// feeds it through the shell's validateLaunch.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateLaunch } from '../src/lib/launch-runner.js';
import { seededCommand, resumedCommand } from '../../../server/lib/orchestration/editor-targets.js';
import { writePrompt } from '../../../server/lib/orchestration/runner-store.js';
import { writeRoleSettings } from '../../../server/lib/governance/role-permissions.js';
import { appendArgs, channelLaunchPlan } from '../../../server/lib/scut/channel-launch.js';

const stateDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'mc-contract-state-')));
const CWD = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'mc-contract-cwd-')));
const opts = { exists: () => true, allowedCommands: ['claude'], stateDir };

// server.js launchJob, from the prompt file to the role flags.
function kernelCommand({ id, role, reviewer = null, resumeSessionId = null, channel = false }) {
  const promptFile = writePrompt(stateDir, id, 'task');
  let seeded = resumeSessionId
    ? resumedCommand('claude', resumeSessionId, promptFile)
    : seededCommand('claude', promptFile, { sessionId: crypto.randomUUID() });
  const roleFile = writeRoleSettings(stateDir, { role, reviewHead: reviewer ? 'feat/x' : undefined, integrationBranches: ['main'], key: id });
  if (roleFile) seeded = appendArgs(seeded, ['--settings', roleFile]);
  if (reviewer?.model) seeded = appendArgs(seeded, ['--model', reviewer.model]);
  // glmps-2-0-62: scut.channel=true, a slack-origin job, never a reviewer.
  const plan = reviewer ? null : channelLaunchPlan({
    job: { id, origin: { via: 'slack', channel: 'C1', thread_ts: '1.2' } },
    stateDir, cwd: CWD, serverPath: path.join(CWD, 'channel-server.js'), enabled: channel,
  });
  if (plan) seeded = appendArgs(seeded, plan.args);
  return seeded;
}

test('a worker launch with its role settings file passes the shell', () => {
  const command = kernelCommand({ id: 'glmps-184', role: 'worker' });
  assert.match(command, / --settings /);
  assert.deepEqual(validateLaunch({ origin: 'runner', command, cwd: CWD }, opts), { ok: true });
});

test('a reviewer launch with role settings and a reviewer model passes the shell', () => {
  const command = kernelCommand({ id: 'glmps-185-review-r1', role: 'reviewer', reviewer: { model: 'sonnet' } });
  assert.match(command, / --settings .* --model /);
  assert.deepEqual(validateLaunch({ origin: 'runner', command, cwd: CWD }, opts), { ok: true });
});

test('a resumed launch with role settings passes the shell', () => {
  const command = kernelCommand({ id: 'glmps-186', role: 'worker', resumeSessionId: crypto.randomUUID() });
  assert.deepEqual(validateLaunch({ origin: 'runner', command, cwd: CWD }, opts), { ok: true });
});

test('a launch with no role (no settings file) still passes the shell', () => {
  const command = kernelCommand({ id: 'glmps-187', role: null });
  assert.doesNotMatch(command, /--settings/);
  assert.deepEqual(validateLaunch({ origin: 'runner', command, cwd: CWD }, opts), { ok: true });
});

test('a slack-channel launch with role settings passes the shell', () => {
  const command = kernelCommand({ id: 'glmps-188', role: 'worker', channel: true });
  assert.match(command, / --settings .* --channels server:scut-slack --dangerously-load-development-channels server:scut-slack$/);
  assert.deepEqual(validateLaunch({ origin: 'runner', command, cwd: CWD }, opts), { ok: true });
});

test('a resumed slack-channel launch passes the shell', () => {
  const command = kernelCommand({ id: 'glmps-189', role: 'worker', channel: true, resumeSessionId: crypto.randomUUID() });
  assert.deepEqual(validateLaunch({ origin: 'runner', command, cwd: CWD }, opts), { ok: true });
});

// The dev-channels flag is accepted only as the exact pair channelLaunchPlan
// emits for its one fixed server; every other spelling is refused.
test('any variation of the channel flags is refused', () => {
  const base = kernelCommand({ id: 'glmps-190', role: 'worker' });
  const variants = [
    ' --channels server:other --dangerously-load-development-channels server:other',
    ' --channels server:scut-slack --dangerously-load-development-channels server:other',
    ' --channels server:scut-slack',
    ' --dangerously-load-development-channels server:scut-slack',
    ' --dangerously-load-development-channels server:scut-slack --channels server:scut-slack',
    ' --channels server:scut-slack --dangerously-load-development-channels server:scut-slack server:other',
    ' --channels server:scut-slack --dangerously-load-development-channels server:scut-slack --dangerously-skip-permissions',
    ' --channels server:scut-slack --dangerously-load-development-channels server:scut-slack --channels server:scut-slack --dangerously-load-development-channels server:scut-slack',
    ' --channels plugin:scut-slack@x --dangerously-load-development-channels server:scut-slack',
  ];
  for (const v of variants) {
    const r = validateLaunch({ origin: 'runner', command: base + v, cwd: CWD }, opts);
    assert.equal(r.ok, false, v);
  }
});

test('the shell pins the same channel server name the kernel uses', async () => {
  const { SERVER_NAME } = await import('../../../server/lib/scut/channel-core.js');
  assert.equal(SERVER_NAME, 'scut-slack');
});
