// server/test/launch-cwd-confinement.test.js
// F15/F16 end to end. GLMPS_RUNNER_DRYRUN=1: nothing ever opens.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server.js';

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const SID = '3f2a9b1c-1111-4222-8333-444455556666';

async function withServer(fn) {
  const stateDir = tmp('mc-lcc-state-');
  const claudeDir = tmp('mc-lcc-claude-');
  const allowed = tmp('mc-lcc-allowed-');
  const outside = tmp('mc-lcc-outside-');
  fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({ permissions: { additionalDirectories: [allowed] } }));
  const env = { ...process.env, GLMPS_STATE_DIR: stateDir, GLMPS_CLAUDE_DIR: claudeDir, GLMPS_RUNNER_DRYRUN: '1', GLMPS_UNMERGED_SCAN: 'off' };
  const h = await startServer({ port: 0, env, configFile: path.join(stateDir, 'no-config.json') });
  const post = async (p, o) => {
    const r = await fetch(`http://127.0.0.1:${h.port}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-glmps-local-session': h.localSession }, body: JSON.stringify(o) });
    return { status: r.status, body: await r.json() };
  };
  try { await fn({ post, allowed, outside }); }
  finally { await h.close(); for (const d of [stateDir, claudeDir, allowed, outside]) fs.rmSync(d, { recursive: true, force: true }); }
}

test('Review focus 2: a terminal cwd outside every configured root is refused 403 with a message that says how to allow it', async () => {
  await withServer(async ({ post, outside }) => {
    const r = await post('/api/terminal', { terminal: 'Claude', cwd: outside });
    assert.equal(r.status, 403);
    assert.match(r.body.error, /cwd refused/);
    assert.match(r.body.error, /additionalDirectories/);
    assert.match(r.body.error, /launchRoots/);
  });
});

test('F15: a terminal cwd inside a configured root still launches', async () => {
  await withServer(async ({ post, allowed }) => {
    const r = await post('/api/terminal', { terminal: 'Claude', cwd: allowed });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  });
});

test('/api/config marks which indexed session cwds a terminal launch would accept', async () => {
  const stateDir = tmp('mc-lcc-cfg-state-');
  const claudeDir = tmp('mc-lcc-cfg-claude-');
  const allowed = tmp('mc-lcc-cfg-allowed-');
  const outside = tmp('mc-lcc-cfg-outside-');
  fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({ permissions: { additionalDirectories: [allowed] } }));
  fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'state', 'index.json'), JSON.stringify([
    { id: 's1', tool: 'claude-code', cwd: allowed, skillsUsed: [], agentsUsed: [], eventCount: 0 },
    { id: 's2', tool: 'claude-code', cwd: outside, skillsUsed: [], agentsUsed: [], eventCount: 0 },
  ]));
  const env = { ...process.env, GLMPS_STATE_DIR: stateDir, GLMPS_CLAUDE_DIR: claudeDir, GLMPS_RUNNER_DRYRUN: '1', GLMPS_UNMERGED_SCAN: 'off' };
  const h = await startServer({ port: 0, env, configFile: path.join(stateDir, 'no-config.json') });
  try {
    const body = await (await fetch(`http://127.0.0.1:${h.port}/api/config`)).json();
    assert.ok(body.projectRoots.includes(allowed) && body.projectRoots.includes(outside));
    assert.deepEqual(body.launchableRoots, [allowed]);
  } finally { await h.close(); for (const d of [stateDir, claudeDir, allowed, outside]) fs.rmSync(d, { recursive: true, force: true }); }
});

test('F16: /api/resume refuses an outside cwd (both the terminal and the workspace variant) and accepts an inside one', async () => {
  await withServer(async ({ post, allowed, outside }) => {
    assert.equal((await post('/api/resume', { sessionId: SID, cwd: outside })).status, 403);
    assert.equal((await post('/api/resume', { sessionId: SID, cwd: outside, location: 'workspace' })).status, 403);
    assert.equal((await post('/api/resume', { sessionId: SID, cwd: allowed })).status, 200);
  });
});
