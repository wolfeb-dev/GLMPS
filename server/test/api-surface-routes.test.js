// Routes under test: server/lib/routes/surface-routes.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server.js';
import { makeFixture } from './fixtures/git-repo-fixture.js';

test('the surface routes: tree, file diff, and their refusals', async () => {
  const { base, work } = makeFixture();
  const stateDir = path.join(base, 'state'); fs.mkdirSync(stateDir);
  const claudeDir = path.join(base, 'claude'); fs.mkdirSync(claudeDir);
  const configFile = path.join(base, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ editableRoots: [work], surface: { localGeo: { city: 'Testville', lon: -100, lat: 40 } } }));
  const env = { ...process.env, GLMPS_STATE_DIR: stateDir, GLMPS_CLAUDE_DIR: claudeDir, GLMPS_UNMERGED_SCAN: 'off' };
  const h = await startServer({ port: 0, env, configFile });
  const get = (p) => fetch(`http://127.0.0.1:${h.port}${p}`);
  try {
    assert.equal((await get('/api/surface/tree?repo=work')).status, 503, 'no residency feed yet');
    fs.mkdirSync(path.join(stateDir, 'residency'));
    fs.writeFileSync(path.join(stateDir, 'residency', 'current.json'), JSON.stringify({ ts: Date.now(), rows: [{ repo: 'work', path: work, remote: 'x', residency: 'diverged' }] }));
    const tree = await get('/api/surface/tree?repo=work');
    assert.equal(tree.status, 200);
    assert.ok((await tree.json()).files.some((f) => f.path === 'dir/b.txt' && f.status === 'ahead'));
    assert.equal((await get('/api/surface/tree?repo=nope')).status, 404);
    assert.equal((await get('/api/surface/tree')).status, 400);
    const diff = await get('/api/surface/file-diff?repo=work&path=dir%2Fb.txt');
    assert.equal(diff.status, 200);
    assert.equal((await diff.json()).change.new.text, 'bee two\n');
    assert.equal((await get('/api/surface/file-diff?repo=work&path=..%2Fx')).status, 400);
    assert.equal((await get('/api/surface/file-diff?repo=work&path=%2Fetc%2Fpasswd')).status, 400);
    const secretRes = await get('/api/surface/file-diff?repo=work&path=.env');
    assert.equal(secretRes.status, 403);
    const secretBody = await secretRes.json();
    assert.deepEqual(secretBody, { error: 'path not allowed' }, 'the sensitive refusal never carries the FileApi message or the resolved path');
    // A residency row can point anywhere the operator's feed says; a row
    // whose path is not actually a git repository must not leak the git
    // subprocess's raw stderr (which names the absolute path) into the body.
    const notRepo = fs.mkdtempSync(path.join(base, 'norepo-'));
    const doc = JSON.parse(fs.readFileSync(path.join(stateDir, 'residency', 'current.json'), 'utf8'));
    doc.rows.push({ repo: 'norepo', path: notRepo, remote: null, residency: 'unknown' });
    fs.writeFileSync(path.join(stateDir, 'residency', 'current.json'), JSON.stringify(doc));
    const notRepoRes = await get('/api/surface/tree?repo=norepo');
    assert.equal(notRepoRes.status, 500);
    const notRepoBody = await notRepoRes.json();
    assert.deepEqual(notRepoBody, { error: 'repository read failed' });
    assert.ok(!JSON.stringify(notRepoBody).includes(notRepo), 'body must not echo the filesystem path');
    const cfg = await (await get('/api/config')).json();
    assert.deepEqual(cfg.surface.localGeo, { city: 'Testville', lon: -100, lat: 40, precision: 'city', source: 'operator' });
  } finally {
    await h.close?.();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('GET /api/surface/edits answers an empty feed on a fresh server', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-edits-'));
  const stateDir = path.join(base, 'state'); fs.mkdirSync(stateDir);
  const claudeDir = path.join(base, 'claude'); fs.mkdirSync(claudeDir);
  const configFile = path.join(base, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ editableRoots: [base] }));
  const env = { ...process.env, GLMPS_STATE_DIR: stateDir, GLMPS_CLAUDE_DIR: claudeDir, GLMPS_UNMERGED_SCAN: 'off' };
  const h = await startServer({ port: 0, env, configFile });
  try {
    const res = await fetch(`http://127.0.0.1:${h.port}/api/surface/edits`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.edits, []);
    assert.equal(typeof body.ts, 'number'); assert.equal(typeof body.windowMs, 'number');
  } finally {
    await h.close?.();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('GET /api/surface/ledger answers the eight data types on a fresh server', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-ledger-'));
  const stateDir = path.join(base, 'state'); fs.mkdirSync(stateDir);
  const claudeDir = path.join(base, 'claude'); fs.mkdirSync(claudeDir);
  const configFile = path.join(base, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ editableRoots: [base] }));
  const env = { ...process.env, GLMPS_STATE_DIR: stateDir, GLMPS_CLAUDE_DIR: claudeDir, GLMPS_UNMERGED_SCAN: 'off' };
  const h = await startServer({ port: 0, env, configFile });
  try {
    const res = await fetch(`http://127.0.0.1:${h.port}/api/surface/ledger`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.types.map((t) => t.id), ['markdown', 'config', 'code', 'projects', 'cards', 'sessions', 'learning', 'alerts']);
    assert.ok(body.types.every((t) => typeof t.count === 'number' && Array.isArray(t.copies)));
  } finally {
    await h.close?.();
    fs.rmSync(base, { recursive: true, force: true });
  }
});
