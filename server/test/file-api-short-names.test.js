// Routes under test: server/lib/routes/surface-routes.js
// Windows 8.3 short names alias a sensitive long name
// (ENV~1 -> .env, CREDEN~1.JSO -> .credentials.json, SSH~1 -> .ssh). The
// name-based deny only sees the alias, and plain fs.realpathSync does not
// expand short names, so the alias read the secret. The real alias is
// queried from the volume (cmd's %~sI, no window); every case skips with a
// reason when the platform or the volume has no short names.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { FileApi } from '../lib/governance/file-api.js';
import { fileDiff } from '../lib/surface/repo-tree.js';
import { makeFixture } from './fixtures/git-repo-fixture.js';

const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });
function mkTmp() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-sn-')); tmpDirs.push(d); return d; }

// The leaf's 8.3 alias, joined onto its LONG parent, or null when the
// volume generates none (8dot3 off, or not Windows).
export function shortLeaf(p) {
  if (process.platform !== 'win32') return null;
  let out;
  try {
    out = execFileSync('cmd.exe', ['/d', '/c', `for %I in ("${p}") do @echo %~sI`], { windowsHide: true, windowsVerbatimArguments: true, encoding: 'utf8' }).trim();
  } catch { return null; }
  const leaf = path.basename(out);
  if (!leaf || leaf.toLowerCase() === path.basename(p).toLowerCase() || !/~\d/.test(leaf)) return null;
  return path.join(path.dirname(p), leaf);
}

const SKIP = 'no 8.3 short name on this volume (8dot3 generation off, or not Windows)';

test('S-F1: an 8.3 alias of .env is refused for read and save', (t) => {
  const root = mkTmp();
  const secret = path.join(root, '.env');
  fs.writeFileSync(secret, 'SECRET=x');
  const alias = shortLeaf(secret);
  if (!alias) { t.skip(SKIP); return; }
  const api = new FileApi([root], mkTmp());
  assert.throws(() => api.read(alias), /not allowed/i);
  assert.throws(() => api.save(alias, 'y', null, { force: true }), /not allowed/i);
  assert.equal(fs.readFileSync(secret, 'utf8'), 'SECRET=x', 'the secret is untouched');
});

test('S-F1: an 8.3 alias of .credentials.json is refused', (t) => {
  const root = mkTmp();
  const secret = path.join(root, '.credentials.json');
  fs.writeFileSync(secret, '{}');
  const alias = shortLeaf(secret);
  if (!alias) { t.skip(SKIP); return; }
  const api = new FileApi([root], mkTmp());
  assert.throws(() => api.read(alias), /not allowed/i);
});

test('S-F1: a file under an 8.3 alias of .ssh is refused, existing or a new save target', (t) => {
  const root = mkTmp();
  const dir = path.join(root, '.ssh');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'config'), 'Host *');
  const alias = shortLeaf(dir);
  if (!alias) { t.skip(SKIP); return; }
  const api = new FileApi([root], mkTmp());
  assert.throws(() => api.read(path.join(alias, 'config')), /not allowed/i);
  assert.throws(() => api.save(path.join(alias, 'authorized_keys'), 'ssh-ed25519 AAAA', null), /not allowed/i);
  assert.equal(fs.existsSync(path.join(dir, 'authorized_keys')), false, 'no key was planted');
});

test('S-F1: a tilde-digit segment below the root is refused on win32 even when nothing exists there yet', (t) => {
  if (process.platform !== 'win32') { t.skip('short names are a win32 concern'); return; }
  const root = mkTmp();
  const api = new FileApi([root], mkTmp());
  assert.throws(() => api.save(path.join(root, 'ENV~2'), 'x', null), /not allowed/i);
  assert.throws(() => api.read(path.join(root, 'SSH~3', 'config')), /not allowed/i);
});

test('S-F1: an ordinary long-named file stays readable and saveable', () => {
  const root = mkTmp();
  const f = path.join(root, 'notes.md');
  fs.writeFileSync(f, 'hi');
  const api = new FileApi([root], mkTmp());
  assert.equal(api.read(f).content, 'hi');
  api.save(path.join(root, 'new-dir-free.md'), 'x', null);
});

test('S-F1: the surface file diff refuses an 8.3 alias of .env', async (t) => {
  const { base, work } = makeFixture();
  tmpDirs.push(base);
  const alias = shortLeaf(path.join(work, '.env'));
  if (!alias) { t.skip(SKIP); return; }
  const fileApi = new FileApi([work], path.join(base, 'undo'));
  await assert.rejects(fileDiff({ repoPath: work, repo: 'work', relPath: path.basename(alias), fileApi }), (e) => e.status === 403 && e.message === 'path not allowed');
});

test('S-F1: GET /api/surface/file-diff and GET /api/file refuse an 8.3 alias of .env', async (t) => {
  const { base, work } = makeFixture();
  tmpDirs.push(base);
  const alias = shortLeaf(path.join(work, '.env'));
  if (!alias) { t.skip(SKIP); return; }
  const { startServer } = await import('../server.js');
  const stateDir = path.join(base, 'state'); fs.mkdirSync(path.join(stateDir, 'residency'), { recursive: true });
  const claudeDir = path.join(base, 'claude'); fs.mkdirSync(claudeDir);
  const configFile = path.join(base, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ editableRoots: [work] }));
  fs.writeFileSync(path.join(stateDir, 'residency', 'current.json'), JSON.stringify({ ts: Date.now(), rows: [{ repo: 'work', path: work, remote: 'x', residency: 'diverged' }] }));
  const env = { ...process.env, GLMPS_STATE_DIR: stateDir, GLMPS_CLAUDE_DIR: claudeDir, GLMPS_UNMERGED_SCAN: 'off' };
  const h = await startServer({ port: 0, env, configFile });
  try {
    const diff = await fetch(`http://127.0.0.1:${h.port}/api/surface/file-diff?repo=work&path=${encodeURIComponent(path.basename(alias))}`);
    const diffBody = await diff.text();
    assert.equal(diff.status, 403);
    assert.ok(!diffBody.includes('SECRET'), 'the secret never reaches the body');
    const file = await fetch(`http://127.0.0.1:${h.port}/api/file?path=${encodeURIComponent(alias)}`);
    const fileBody = await file.text();
    assert.notEqual(file.status, 200);
    assert.ok(!fileBody.includes('SECRET'), 'the secret never reaches the body');
  } finally { await h.close?.(); }
});
