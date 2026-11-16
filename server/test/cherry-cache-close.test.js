// server/test/cherry-cache-close.test.js
//
// Card glmps-2-0-runtime-135: GET /api/alerts kicks the unmerged-branch scan
// over this checkout, and a scan still running at close() used to save
// cherry-cache.json into stateDir after shutdown. On Windows that late write
// raced the test teardown's rm (EPERM in gepa-route.test.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server.js';

function tmp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

const ADAPTER_DIRS = [
  'GLMPS_CLAUDE_DIR', 'GLMPS_ANTIGRAVITY_DIR', 'GLMPS_GEMINI_TMP_DIR', 'GLMPS_VSCODE_STORAGE_DIR',
  'GLMPS_AGY_CLI_DIR', 'GLMPS_CODEX_DIR', 'GLMPS_COPILOT_CLI_DIR', 'GLMPS_HERMES_DIR', 'GLMPS_OPENCODE_DIR',
  'GLMPS_ASSETS_DIR', 'GLMPS_CURSOR_DIR', 'GLMPS_GROK_DIR', 'GLMPS_PI_DIR', 'GLMPS_FACTORY_DIR',
  'GLMPS_CLINE_STORAGE_DIR', 'GLMPS_OPENCLAW_DIR',
];

test('a server closed while its unmerged-branch scan is in flight writes nothing into stateDir afterwards', async () => {
  const stateDir = tmp('mc-cherry-close-');
  const scratch = [];
  const env = { ...process.env, GLMPS_STATE_DIR: stateDir };
  for (const k of ADAPTER_DIRS) { const d = tmp('mc-cherry-close-ad-'); scratch.push(d); env[k] = d; }
  delete env.GLMPS_UNMERGED_SCAN;
  const h = await startServer({ port: 0, env, configFile: path.join(stateDir, 'no-config.json') });
  try {
    const r = await fetch(`http://127.0.0.1:${h.port}/api/alerts`);
    assert.equal(r.status, 200);
    await r.arrayBuffer();
  } finally {
    await h.close?.();
  }
  const cacheDir = path.join(stateDir, 'cache');
  const cacheWrites = () => (fs.existsSync(cacheDir) ? fs.readdirSync(cacheDir) : []).filter((f) => f.startsWith('cherry-cache.json'));
  const before = cacheWrites();
  // Settles only after the scan's own cache save, so a late write would
  // already be on disk here.
  await h.unmergedScanSettled();
  try {
    assert.deepEqual(cacheWrites(), before, 'no cherry-cache write lands after close() resolved');
  } finally {
    for (const d of [stateDir, ...scratch]) fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

// Card glmps-2-0-runtime-138, finding 3: close() waits at most 500 ms for an
// in-flight save, so a save still waiting on git results past that bound must
// check it is still wanted before it writes.
test('saveCherryCache writes nothing when the server closed while it waited on pending git results', async () => {
  const { saveCherryCache } = await import('../lib/observability/unmerged-branches.js');
  const dir = tmp('mc-cherry-slow-');
  try {
    let release;
    const cache = new Map([['a', Promise.resolve(1)], ['b', new Promise((r) => { release = r; })]]);
    let open = true;
    const saving = saveCherryCache(path.join(dir, 'cherry-cache.json'), cache, { shouldWrite: () => open });
    open = false;
    release(2);
    await saving;
    assert.deepEqual(fs.readdirSync(dir), []);

    await saveCherryCache(path.join(dir, 'cherry-cache.json'), cache, { shouldWrite: () => true });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'cherry-cache.json'), 'utf8')), { a: 1, b: 2 });
  } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

// Card glmps-2-0-runtime-139 finding 4: the scan's git calls are refused once
// the server closed, so a scan still walking repos spawns no child after close.
test('the unmerged scan exec refuses every git call once the server has closed', async () => {
  const { closableExec, scanRepos } = await import('../lib/observability/unmerged-branches.js');
  const spawned = [];
  let closed = false;
  const exec = closableExec(() => closed, async (file, args) => { spawned.push(args.join(' ')); return ''; });
  await exec('git', ['rev-parse']);
  assert.equal(spawned.length, 1, 'open: the call goes through');
  closed = true;
  await assert.rejects(exec('git', ['for-each-ref']), /server closed/);
  const root = tmp('mc-cherry-refuse-');
  try {
    fs.mkdirSync(path.join(root, 'repo', '.git'), { recursive: true });
    await scanRepos({ roots: [root], exec }).catch(() => {});
    assert.equal(spawned.length, 1, 'closed: a scan spawns no git child');
  } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test('server.js routes the unmerged scan through the closable exec', () => {
  const src = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.match(src, /scanUnmergedRepos\(\{[^}]*exec[^}]*\}\)/);
  assert.match(src, /const exec = closableExec\(\(\) => cherryCacheClosed, gitExecAsync\);/);
});
