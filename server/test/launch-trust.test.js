// server/test/launch-trust.test.js
// AC-1: every interactive launch trusts its cwd in the harness config BEFORE the
// spawn. The config state is captured INSIDE the injected spawn seam, which is
// what proves "before launch". The config is the sibling of the temp claude dir,
// so the operator's real ~/.claude.json is never touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { startServer } from '../server.js';
import { claudeTmp } from './fixtures/claude-dir.js';

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const SID = '3f2a9b1c-1111-4222-8333-444455556666';
const fwd = (p) => p.replace(/\\/g, '/');

async function withServer(fn, { extraEnv = {}, dryRun = false } = {}) {
  const stateDir = tmp('mc-launchtrust-state-');
  const claudeDir = claudeTmp();
  const claudeJson = claudeDir + '.json';
  fs.writeFileSync(claudeJson, JSON.stringify({ projects: {} }));
  const env = { ...process.env, GLMPS_STATE_DIR: stateDir, GLMPS_CLAUDE_DIR: claudeDir, ...extraEnv };
  delete env.GLMPS_CLAUDE_CONFIG_FILE;
  delete env.GLMPS_SERVICE;
  delete env.GLMPS_AUTO_TRUST;
  Object.assign(env, extraEnv);
  if (dryRun) env.GLMPS_RUNNER_DRYRUN = '1'; else delete env.GLMPS_RUNNER_DRYRUN;
  const configFile = path.join(stateDir, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ launchRoots: [os.tmpdir()] }));
  const seen = [];
  const editorSpawnFn = () => {
    seen.push(JSON.parse(fs.readFileSync(claudeJson, 'utf8')));
    const child = new EventEmitter();
    child.pid = 424242;
    child.unref = () => {};
    return child;
  };
  const h = await startServer({ port: 0, env, configFile, agAliveProbe: () => false, ...(dryRun ? {} : { editorSpawnFn }) });
  const post = async (p, body) => {
    const r = await fetch(`http://127.0.0.1:${h.port}${p}`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-glmps-local-session': h.localSession }, body: JSON.stringify(body),
    });
    return { status: r.status, body: await r.json() };
  };
  try { await fn({ post, h, seen, readConfig: () => JSON.parse(fs.readFileSync(claudeJson, 'utf8')) }); }
  finally {
    await h.close?.();
    for (const d of [stateDir, claudeDir]) fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    fs.rmSync(claudeJson, { force: true });
  }
}

test('a never-seen cwd is trusted in the harness config before the terminal spawns', async () => {
  const cwd = tmp('mc-launchtrust-cwd-');
  try {
    await withServer(async ({ post, seen }) => {
      const r = await post('/api/resume', { sessionId: SID, cwd });
      assert.equal(r.status, 200);
      assert.equal(seen.length, 1, 'the spawn seam ran once');
      assert.equal(seen[0].projects[fwd(cwd)]?.hasTrustDialogAccepted, true, 'trusted by the time the spawn ran');
    });
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test('the runner dry-run launch path trusts the cwd too', async () => {
  const cwd = tmp('mc-launchtrust-dry-');
  try {
    await withServer(async ({ post, readConfig }) => {
      const r = await post('/api/resume', { sessionId: SID, cwd });
      assert.equal(r.status, 200);
      assert.equal(readConfig().projects[fwd(cwd)]?.hasTrustDialogAccepted, true);
    }, { dryRun: true });
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test('GLMPS_AUTO_TRUST=0 leaves the harness config untouched', async () => {
  const cwd = tmp('mc-launchtrust-off-');
  try {
    await withServer(async ({ post, seen, readConfig }) => {
      const r = await post('/api/resume', { sessionId: SID, cwd });
      assert.equal(r.status, 200);
      assert.equal(seen.length, 1);
      assert.deepEqual(seen[0], { projects: {} });
      assert.deepEqual(readConfig(), { projects: {} });
    }, { extraEnv: { GLMPS_AUTO_TRUST: '0' } });
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});
