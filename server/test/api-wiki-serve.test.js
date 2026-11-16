// server/test/api-wiki-serve.test.js
// the kernel serves /wiki/* from <stateDir>/wiki/builds/<current>/ and
// GET /api/wiki reads the same build for its own repo.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { startServer } from '../server.js';
import { wikiPaths, buildIdFor, publishWikiBuild } from '../lib/observability/wiki-publish.js';

function mkEnv() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-aws-'));
  const claudeDir = path.join(tmp, 'claude');
  fs.mkdirSync(path.join(claudeDir, '.claude-manager'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'ag', 'brain'), { recursive: true });
  fs.writeFileSync(path.join(claudeDir, '.claude-manager', 'active-sessions.json'), '[]');
  return { GLMPS_CLAUDE_DIR: claudeDir, GLMPS_ANTIGRAVITY_DIR: path.join(tmp, 'ag'), GLMPS_STATE_DIR: path.join(tmp, 'state'),
    GLMPS_GEMINI_TMP_DIR: path.join(tmp, 'gt'), GLMPS_VSCODE_STORAGE_DIR: path.join(tmp, 'vs'), GLMPS_AGY_CLI_DIR: path.join(tmp, 'agy'),
    GLMPS_CODEX_DIR: path.join(tmp, 'cx'), GLMPS_HERMES_DIR: path.join(tmp, 'hm'), GLMPS_COPILOT_CLI_DIR: path.join(tmp, 'copilot-cli'),
    GLMPS_OPENCODE_DIR: path.join(tmp, 'oc'), GLMPS_UNMERGED_SCAN: 'off' };
}
function publishFixture(stateDir) {
  const dir = path.join(wikiPaths(stateDir).builds, buildIdFor('c'.repeat(40), 5000));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ builtAtCommit: 'c'.repeat(40), generatedAt: '2026-09-23T00:00:00Z',
    tierLlm: true, sections: [{ slug: 'server', title: 'Server', llm: true, fileCount: 1 }] }));
  fs.writeFileSync(path.join(dir, 'server.html'), '<!doctype html><p>STATE_DIR_PAGE</p>');
  fs.writeFileSync(path.join(wikiPaths(stateDir).root, 'secret.html'), 'do not serve');
  publishWikiBuild({ stateDir, buildDir: dir, meta: { builtAtCommit: 'c'.repeat(40), sections: 1, llmSections: 1 } });
}
const raw = (port, p) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: p }, (res) => { let b = ''; res.on('data', d => { b += d; }); res.on('end', () => resolve({ status: res.statusCode, body: b, type: res.headers['content-type'] })); })
    .on('error', reject);
});

let env;
let srv;

before(async () => {
  env = mkEnv();
  srv = await startServer({ port: 0, pollMs: 1000, env });
});

after(async () => {
  await srv?.close();
});

beforeEach(() => {
  fs.rmSync(wikiPaths(env.GLMPS_STATE_DIR).root, { recursive: true, force: true });
});

test('GET /wiki/<slug>.html serves the published page; raw and encoded traversal get 400', async () => {
  publishFixture(env.GLMPS_STATE_DIR);
  const ok = await raw(srv.port, '/wiki/server.html');
  assert.equal(ok.status, 200);
  assert.match(ok.body, /STATE_DIR_PAGE/);
  assert.match(ok.type, /text\/html/);
  const man = await raw(srv.port, '/wiki/manifest.json');
  assert.equal(man.status, 200);
  assert.match(man.type, /application\/json/);
  for (const p of ['/wiki/../secret.html', '/wiki/..%2Fsecret.html', '/wiki/.cache.json']) {
    const r = await raw(srv.port, p);
    assert.equal(r.status, 400, p);
    assert.doesNotMatch(r.body, /do not serve/);
  }
});

test('GET /wiki/<slug>.html is 404 before anything is published; /wiki/ still loads the dashboard', async () => {
  assert.equal((await raw(srv.port, '/wiki/server.html')).status, 404);
  const spa = await raw(srv.port, '/wiki/');
  assert.equal(spa.status, 200);
  assert.match(spa.type, /text\/html/);
});

test('GET /api/wiki for the server\'s own repo reads the state-dir build with base /wiki', async () => {
  publishFixture(env.GLMPS_STATE_DIR);
  const body = await (await fetch(`http://127.0.0.1:${srv.port}/api/wiki`)).json();
  assert.equal(body.base, '/wiki');
  assert.equal(body.manifest.builtAtCommit, 'c'.repeat(40));
  assert.deepEqual(body.sections.map(s => s.slug), ['server']);
});

// readWikiState's manifestError field (an unparseable manifest is
// distinct from "no wiki yet" -- both leave body.manifest null, but only one
// is an operator-actionable bug in the published build).
test('GET /api/wiki surfaces manifestError when the current build\'s manifest exists but fails to parse', async () => {
  const dir = path.join(wikiPaths(env.GLMPS_STATE_DIR).builds, buildIdFor('d'.repeat(40), 7000));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), '{ not valid json');
  publishWikiBuild({ stateDir: env.GLMPS_STATE_DIR, buildDir: dir, meta: { builtAtCommit: 'd'.repeat(40), sections: 0, llmSections: 0 } });
  const body = await (await fetch(`http://127.0.0.1:${srv.port}/api/wiki`)).json();
  assert.equal(body.manifest, null);
  assert.match(body.manifestError, /unreadable manifest/);
});

// readCurrentWiki throws on a malformed current.json,
// carrying the absolute state-dir path in its message. Both the /wiki/* asset
// route (via resolveWikiRequest) and GET /api/wiki (via readWikiState ->
// resolveWikiSource -> readCurrentWiki, for the kernel's own repo) used to let
// that throw reach the server's outer 500 handler unchanged, which put the
// raw error (including the path) straight into the client response body.
function seedMalformedCurrent(stateDir) {
  fs.mkdirSync(wikiPaths(stateDir).root, { recursive: true });
  fs.writeFileSync(wikiPaths(stateDir).current, '{ not valid json');
}

test('GET /wiki/<slug>.html on a malformed current.json is 500 with a generic body, never the path or "malformed" detail', async () => {
  seedMalformedCurrent(env.GLMPS_STATE_DIR);
  const r = await raw(srv.port, '/wiki/server.html');
  assert.equal(r.status, 500);
  assert.doesNotMatch(r.body, /malformed/);
  assert.doesNotMatch(r.body, new RegExp(env.GLMPS_STATE_DIR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('GET /api/wiki on a malformed current.json still answers 200 with a generic manifestError, never the path or "malformed" detail', async () => {
  seedMalformedCurrent(env.GLMPS_STATE_DIR);
  const res = await fetch(`http://127.0.0.1:${srv.port}/api/wiki`);
  const bodyText = await res.text();
  assert.equal(res.status, 200);
  assert.doesNotMatch(bodyText, /malformed/);
  assert.doesNotMatch(bodyText, new RegExp(env.GLMPS_STATE_DIR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const body = JSON.parse(bodyText);
  assert.equal(body.manifest, null);
  assert.equal(body.manifestError, 'wiki build unavailable');
});
