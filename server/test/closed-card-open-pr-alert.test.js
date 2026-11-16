import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as backlogStore from '../lib/orchestration/backlog-store.js';

// Card glmps-2-0-197 (review of 191, AC-5): the open-PR lookup used to ride the
// unmerged-branch scan, so GLMPS_UNMERGED_SCAN=off silently turned the alert off.
// It is a read-only gh call and stands on its own.
const PR = 'https://github.com/o/r/pull/7';

function fakeGh() {
  const calls = [];
  const gh = async (_file, args) => {
    calls.push(args.join(' '));
    if (args[0] === 'api' && args[1] === 'user') return { status: 0, stdout: 'o\n', stderr: '' };
    if (args[0] === 'search') return { status: 0, stdout: JSON.stringify([{ number: 7, title: 't', url: PR, repository: { nameWithOwner: 'o/r' } }]), stderr: '' };
    return { status: 1, stdout: '', stderr: 'unexpected' };
  };
  return { gh, calls };
}

async function withServer(items, fn) {
  const { startServer } = await import('../server.js');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-closedpr-'));
  const stateDir = path.join(base, 'state'); fs.mkdirSync(stateDir);
  const claudeDir = path.join(base, 'claude'); fs.mkdirSync(claudeDir);
  backlogStore.save(stateDir, { items });
  const { gh, calls } = fakeGh();
  const env = { ...process.env, GLMPS_STATE_DIR: stateDir, GLMPS_CLAUDE_DIR: claudeDir, GLMPS_UNMERGED_SCAN: 'off' };
  const h = await startServer({ port: 0, env, ghRun: gh });
  const alerts = async () => {
    const j = await (await fetch(`http://127.0.0.1:${h.port}/api/alerts`)).json();
    return (Array.isArray(j) ? j : (j.alerts ?? j.items ?? [])).filter((a) => a.source === 'closed-card-open-pr');
  };
  try {
    await fn({ h, calls, alerts });
  } finally {
    await h.close?.();
    fs.rmSync(base, { recursive: true, force: true });
  }
}

test('server: a closed card with an open PR alerts even with the unmerged-branch scan off', async () => {
  await withServer([
    { id: 'p-1', project: 'p', title: 'closed with open PR', state: 'done', prUrl: PR },
    { id: 'p-2', project: 'p', title: 'open card', state: 'queued', prUrl: 'https://github.com/o/r/pull/8' },
  ], async ({ h, calls, alerts }) => {
    await alerts();
    await h.openPrStatesSettled();
    const list = await alerts();
    assert.deepEqual(list.map((a) => a.title), ['Card p-1 is done but its PR is still open']);
    assert.ok(calls.some((c) => c.startsWith('search prs')), calls.join(' | '));
  });
});

test('server: no closed card names a PR, so the alert path makes no gh call', async () => {
  await withServer([{ id: 'p-1', project: 'p', title: 'closed, no PR', state: 'done' }], async ({ h, calls, alerts }) => {
    assert.deepEqual(await alerts(), []);
    await h.openPrStatesSettled();
    assert.equal(calls.filter((c) => c.startsWith('search prs')).length, 0);
  });
});
