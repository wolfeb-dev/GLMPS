import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeLease } from '../lib/governance/push-lease-store.js';

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'hooks', 'push-lease-guard.js');

function runHook(repo, extraEnv = {}) {
  const env = { ...process.env, GLMPS_PORT: '1', GLMPS_PUSH_LEASE_TTL_MS: '600000' };
  for (const k of ['GLMPS_ROLE', 'GLMPS_ALLOW_PUSH_LEASE']) delete env[k];
  Object.assign(env, extraEnv);
  return spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git push origin main' }, cwd: repo, session_id: 'me', hook_event_name: 'PreToolUse' }),
    env, encoding: 'utf8',
  });
}

test('review P4: a push-lease.allow file in the cwd no longer lifts the lease (F10/D30)', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-lease-allow-'));
  try {
    const g = (...a) => execFileSync('git', a, { cwd: repo, stdio: 'ignore' });
    g('init', '-q', '-b', 'main');
    g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--allow-empty', '-q', '-m', 'init');
    const now = Date.now();
    writeLease(path.join(repo, '.git'), { ref: 'main', sessionId: 'other', cwd: repo, acquiredAt: now, renewedAt: now });
    fs.writeFileSync(path.join(repo, 'push-lease.allow'), '');

    const blocked = runHook(repo);
    assert.equal(blocked.status, 2, blocked.stderr);
    assert.match(blocked.stderr, /push-lease\.allow.*ignored.*GLMPS_ALLOW_PUSH_LEASE=1/s);

    const approved = runHook(repo, { GLMPS_ALLOW_PUSH_LEASE: '1' });
    assert.equal(approved.status, 0, approved.stderr);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});
