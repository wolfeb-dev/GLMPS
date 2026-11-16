// server/test/resume-launch.test.js
// Resume opens a native terminal itself when Antigravity cannot host it (no
// companion seam here: antigravity-launch.test.js covers that path).
// GLMPS_RUNNER_DRYRUN records launches instead of opening windows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server.js';
import { getPaths } from '../lib/paths.js';

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

// Deviation from the task-12 brief: the brief's own Step 1 code used
// non-UUID session ids ('abc-123', 'abc') here, but Step 3's resumeCommand
// (tested in editor-targets.test.js with exact values) refuses anything that
// is not a session UUID - the same rule server.js's resumedCommand already
// enforces for `--resume`. A non-UUID id would 400 under that contract, so
// these fixtures use UUID-shaped ids instead (the brief's own Interfaces
// line says to do exactly this).
const SID = '3f2a9b1c-1111-4222-8333-444455556666';

async function withServer(fn) {
  const stateDir = tmp('mc-resume-state-');
  const claudeDir = tmp('mc-resume-claude-');
  const env = { ...process.env, GLMPS_STATE_DIR: stateDir, GLMPS_CLAUDE_DIR: claudeDir, GLMPS_RUNNER_DRYRUN: '1' };
  const configFile = path.join(stateDir, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ launchRoots: [os.tmpdir()] }));
  const h = await startServer({ port: 0, env, configFile });
  const post = async (p, o) => {
    const r = await fetch(`http://127.0.0.1:${h.port}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-glmps-local-session': h.localSession }, body: JSON.stringify(o) });
    return { status: r.status, body: await r.json() };
  };
  try { await fn({ post, h, stateDir, env }); }
  finally {
    await h.close?.();
    fs.rmSync(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    fs.rmSync(claudeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

test('Resume opens `claude --resume <id>` in a native terminal in the session cwd', async () => {
  const cwd = tmp('mc-resume-cwd-');
  await withServer(async ({ post, h, stateDir }) => {
    const { status, body } = await post('/api/resume', { sessionId: SID, cwd, location: 'editor' });
    assert.equal(status, 200);
    assert.equal(body.launched, true);
    const last = h.dryRunLaunches.at(-1);
    assert.equal(last.command, `claude --resume ${SID}`);
    assert.equal(path.resolve(last.cwd), path.resolve(cwd));
    assert.equal(fs.existsSync(path.join(stateDir, 'requests', 'resume.jsonl')), false, 'nothing is queued for a companion');
  });
  fs.rmSync(cwd, { recursive: true, force: true });
});

test('Resume without a session id is a 400 "sessionId required"; a missing cwd falls back to the server cwd', async () => {
  await withServer(async ({ post, h }) => {
    const missing = await post('/api/resume', { cwd: null });
    assert.equal(missing.status, 400);
    assert.equal(missing.body.error, 'sessionId required');
    const { status } = await post('/api/resume', { sessionId: SID, cwd: path.join(os.tmpdir(), 'no-such-dir-glmps') });
    assert.equal(status, 200);
    assert.equal(path.resolve(h.dryRunLaunches.at(-1).cwd), path.resolve(process.cwd()));
  });
});

// a cwd that was ASKED for but no longer exists is a
// visible fallback (cwdFallback: true, cwd is the effective one actually
// used), not an indistinguishable silent success - the operator clicked
// Resume for a specific session's folder and it is gone.
test('Resume: a requested cwd that no longer exists reports cwdFallback and the effective cwd', async () => {
  await withServer(async ({ post }) => {
    const gone = path.join(os.tmpdir(), 'no-such-dir-glmps-2');
    const r = await post('/api/resume', { sessionId: SID, cwd: gone });
    assert.equal(r.status, 200);
    assert.equal(r.body.cwdFallback, true);
    assert.equal(path.resolve(r.body.cwd), path.resolve(process.cwd()));
  });
});

test('Resume: an ordinary successful resume carries no cwdFallback field', async () => {
  const cwd = tmp('mc-resume-cwd2-');
  await withServer(async ({ post }) => {
    const r = await post('/api/resume', { sessionId: SID, cwd });
    assert.equal(r.status, 200);
    assert.equal('cwdFallback' in r.body, false);
  });
  fs.rmSync(cwd, { recursive: true, force: true });
});

// M-iface: a PRESENT but invalid sessionId gets a different, more specific
// message than a MISSING one - the brief's own Interfaces line names both.
test('Resume with a non-UUID session id is refused with "sessionId must be a session UUID"', async () => {
  await withServer(async ({ post }) => {
    const r = await post('/api/resume', { sessionId: 'abc-123' });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'sessionId must be a session UUID');
  });
});

test('the request file no longer exists in the path table', async () => {
  await withServer(async ({ env }) => {
    assert.equal(getPaths(env).requestsFile, undefined);
  });
});
