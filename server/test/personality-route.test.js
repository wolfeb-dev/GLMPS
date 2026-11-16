// server/test/personality-route.test.js
// GET /api/personality over a booted server whose home-side paths are all
// redirected to temp dirs (GLMPS_* overrides), and the read-only open allowance
// for the Gemini files the page links to.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server.js';
import { claudeTmp } from './fixtures/claude-dir.js';

const SECRET = 'ROUTE-SENTINEL-91bd';
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const w = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); return file; };

async function withServer(fn, env = {}) {
  const stateDir = tmp('mc-pers-state-');
  const claudeDir = claudeTmp();
  const assetsDir = tmp('mc-pers-assets-');
  const geminiDir = tmp('mc-pers-gemini-');
  w(path.join(claudeDir, 'CLAUDE.md'), '# Global\n## Approach\nbe brief\n');
  w(path.join(assetsDir, 'agents', 'huddle', 'chair.md'), '---\nname: chair\ndescription: Owns the question\n---\n');
  w(path.join(geminiDir, 'settings.json'), '{"ide":{}}');
  w(path.join(geminiDir, 'oauth_creds.json'), SECRET);
  const configFile = w(path.join(stateDir, 'config.json'), JSON.stringify({ antigravityCommand: 'fake-editor', terminals: [{ label: 'Claude', command: 'claude' }], huddle: { maxTokens: 9 } }));
  const h = await startServer({
    port: 0, configFile, editorSpawnFn: () => { throw new Error('no spawn in this test'); }, agAliveProbe: () => false,
    env: { ...process.env, GLMPS_STATE_DIR: stateDir, GLMPS_CLAUDE_DIR: claudeDir, GLMPS_ASSETS_DIR: assetsDir, GLMPS_GEMINI_DIR: geminiDir, GLMPS_UNMERGED_SCAN: 'off', GLMPS_ALLOW_ACT: '1', ...env },
  });
  const j = async (p, opt) => { const r = await fetch(`http://127.0.0.1:${h.port}${p}`, { ...opt, headers: { ...(opt?.headers), 'x-glmps-local-session': h.localSession } }); return { status: r.status, body: await r.json() }; };
  const post = (p, obj) => j(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) });
  const put = (p, obj) => j(p, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) });
  try { await fn({ get: (p) => j(p), post, put, geminiDir, stateDir }); }
  finally { await h.close?.(); for (const d of [stateDir, claudeDir, assetsDir, geminiDir]) fs.rmSync(d, { recursive: true, force: true }); }
}

test('GET /api/personality returns the five groups from the redirected paths', async () => {
  await withServer(async ({ get }) => {
    const r = await get('/api/personality');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.groups.map((g) => g.id), ['machine', 'project', 'agents', 'runtime', 'memory']);
    const all = r.body.groups.flatMap((g) => g.cards);
    assert.match(all.find((c) => c.id === 'machine-global-instructions').text, /be brief/);
    assert.deepEqual(all.find((c) => c.id === 'agents-brainstorm-team').rows.map((x) => x.name), ['chair']);
    assert.match(all.find((c) => c.id === 'runtime-huddle-config').text, /"maxTokens": 9/);
    assert.equal(JSON.stringify(r.body).includes(SECRET), false, 'the credential file content never leaves');
  });
});

test('POST /api/personality is not a route (the page is read-only)', async () => {
  await withServer(async ({ post }) => {
    const r = await post('/api/personality', {});
    assert.ok(r.status === 404 || r.status === 405, `status ${r.status}`);
  });
});

test('open-in-editor accepts the gemini settings file the page links to, and refuses the oauth file', async () => {
  await withServer(async ({ post, geminiDir }) => {
    const ok = await post('/api/open-in-editor', { path: path.join(geminiDir, 'settings.json') });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const no = await post('/api/open-in-editor', { path: path.join(geminiDir, 'oauth_creds.json') });
    assert.equal(no.status, 403);
  }, { GLMPS_SERVICE: '1' });
});

test('the open-only allowance does not widen the file API: the gemini settings file is not writable through it', async () => {
  await withServer(async ({ put, geminiDir }) => {
    const r = await put('/api/file', { path: path.join(geminiDir, 'settings.json'), content: '{}', hash: 'x' });
    assert.notEqual(r.status, 200);
    assert.equal(fs.readFileSync(path.join(geminiDir, 'settings.json'), 'utf8'), '{"ide":{}}');
  });
});
