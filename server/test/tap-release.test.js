// Routes under test: server/lib/routes/tap-routes.js
// server/test/tap-release.test.js
// Server-and-client-tap task 7: the published tap release and its download routes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createTapRelease, RELEASE_DIR, RELEASE_FILE, INSTALLER_FILE, UPDATE_FILE } from '../lib/kernel/tap-release.js';
import { startServer } from '../server.js';
import { privateBind, remoteHttps, tapKeyPair } from './helpers/mtls.js';
import { TAP_PROTOCOL_HEADER, TAP_PROTOCOL } from '../lib/kernel/tap-protocol.js';

const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });
const tmp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); tmpDirs.push(d); return d; };
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const T = 'C74BBD54C1211B9386A27E2904D2463908B6F9E9';

function publish(stateDir, { installer = Buffer.from('MZ fake installer'), update = Buffer.from('PK fake update'), mutate = (r) => r } = {}) {
  const dir = path.join(stateDir, RELEASE_DIR);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, INSTALLER_FILE), installer);
  fs.writeFileSync(path.join(dir, UPDATE_FILE), update);
  const rel = mutate({
    version: '0.1.0', commit: 'abc1234', builtAt: '2026-10-26T00:00:00.000Z', node: 'v24.22.1',
    signing: { thumbprint: T, mode: 'test', subject: 'CN=GLMPS Tap Test Signing' },
    artifacts: {
      installer: { file: INSTALLER_FILE, size: installer.length, sha256: sha(installer) },
      update: { file: UPDATE_FILE, size: update.length, sha256: sha(update) },
    },
  });
  fs.writeFileSync(path.join(dir, RELEASE_FILE), JSON.stringify(rel));
  return { dir, installer, update };
}

test('no release published answers 404 naming the release command', async () => {
  const r = await createTapRelease({ stateDir: tmp('mc-taprel-') }).load();
  assert.equal(r.status, 404);
  assert.match(r.error, /npm run release/);
});

test('a published release loads with its recomputed hashes, and the hash is cached by size and mtime', async () => {
  const stateDir = tmp('mc-taprel-');
  const { installer } = publish(stateDir);
  let hashed = 0;
  const rel = createTapRelease({ stateDir, hash: async (f) => { hashed++; return sha(fs.readFileSync(f)); } });
  const r = await rel.load();
  assert.equal(r.ok, true);
  assert.equal(r.files.installer.sha256, sha(installer));
  await rel.load();
  assert.equal(hashed, 2, 'one hash per artifact, then cached');
});

test('a file swapped after publishing, a missing file and a malformed document are each refused', async () => {
  const a = tmp('mc-taprel-');
  const { dir } = publish(a);
  fs.writeFileSync(path.join(dir, INSTALLER_FILE), 'MZ tampered!!!!!!');
  assert.match((await createTapRelease({ stateDir: a }).load()).error, /does not match the published SHA-256/);

  const b = tmp('mc-taprel-');
  fs.rmSync(path.join(publish(b).dir, UPDATE_FILE));
  assert.match((await createTapRelease({ stateDir: b }).load()).error, /missing/);

  const c = tmp('mc-taprel-');
  publish(c, { mutate: (r) => ({ ...r, signing: { thumbprint: 'nope', mode: 'test' } }) });
  assert.match((await createTapRelease({ stateDir: c }).load()).error, /no signer/);

  const d = tmp('mc-taprel-');
  publish(d, { mutate: (r) => ({ ...r, artifacts: { ...r.artifacts, update: { ...r.artifacts.update, file: '../x' } } }) });
  assert.match((await createTapRelease({ stateDir: d }).load()).error, /update entry is malformed/);
});

function mkEnv() {
  const t = tmp('mc-taprel-e2e-');
  const claudeDir = path.join(t, 'claude');
  fs.mkdirSync(path.join(claudeDir, '.claude-manager'), { recursive: true });
  fs.writeFileSync(path.join(claudeDir, '.claude-manager', 'active-sessions.json'), '[]');
  return { GLMPS_CLAUDE_DIR: claudeDir, GLMPS_ANTIGRAVITY_DIR: path.join(t, 'ag'), GLMPS_STATE_DIR: path.join(t, 'state'),
    GLMPS_GEMINI_TMP_DIR: path.join(t, 'gemini-tmp'), GLMPS_VSCODE_STORAGE_DIR: path.join(t, 'vscode-storage'),
    GLMPS_AGY_CLI_DIR: path.join(t, 'agy-cli'), GLMPS_CODEX_DIR: path.join(t, 'codex'), GLMPS_COPILOT_CLI_DIR: path.join(t, 'copilot-cli'),
    GLMPS_HERMES_DIR: path.join(t, 'hermes'), GLMPS_OPENCODE_DIR: path.join(t, 'opencode'), GLMPS_UNMERGED_SCAN: 'off',
    GLMPS_ACCESS_TOKEN: 'shared-remote-token' };
}
// HTTPS from 127.0.0.2 to the private listener, so the access guard takes its remote path. The helper returns text;
// the release test bodies are ASCII, so buf is the same bytes.
let trustCa = null;
async function boot(env) {
  const bind = privateBind({ stateDir: env.GLMPS_STATE_DIR, configFile: path.join(path.dirname(env.GLMPS_STATE_DIR), 'config.json') });
  trustCa = bind.homeCaPem;
  return startServer({ port: 0, pollMs: 1000, env, ...bind.startOpts });
}
function remote(port, { method = 'GET', path: p, token, client, body: b, host = 'glmps:8123', protocol = String(TAP_PROTOCOL) } = {}) {
  return remoteHttps(port, { method, path: p, token, client, body: b, ca: trustCa, headers: { host, [TAP_PROTOCOL_HEADER]: protocol } })
    .then((r) => ({ ...r, buf: Buffer.from(r.body, 'utf8') }));
}
async function pairOver(port, shared, name = 'laptop') {
  const code = (await remote(port, { method: 'POST', path: '/api/tap/pair-code', token: shared, body: {} })).json.code;
  const keys = tapKeyPair();
  const pair = await remote(port, { method: 'POST', path: '/api/tap/pair', body: { code, name, tapVersion: '0.1.0', publicKey: keys.publicKeyPem } });
  return { pair, token: pair.json?.token, client: { cert: pair.json?.certificate, key: keys.privateKeyPem } };
}

test('downloads end to end: dashboard token only, filename carries the server URL, SHA-256 in the header', async () => {
  const env = mkEnv();
  const srv = await boot(env);
  const SHARED = env.GLMPS_ACCESS_TOKEN;
  try {
    assert.equal((await remote(srv.port, { path: '/api/tap/release', token: SHARED })).status, 404, 'nothing published yet');
    const { installer, update } = publish(env.GLMPS_STATE_DIR);

    const rel = await remote(srv.port, { path: '/api/tap/release', token: SHARED });
    assert.equal(rel.status, 200);
    // Card glmps-2-0-152: reached over the private HTTPS listener, so the installer names an https server.
    assert.equal(rel.json.installer.fileName, 'glmps-tap-setup_https_glmps_8123.exe');
    assert.equal(rel.json.installer.sha256, sha(installer));
    assert.equal(rel.json.update.sha256, sha(update));
    assert.equal(rel.json.signing.thumbprint, T);

    const dl = await remote(srv.port, { path: '/api/tap/download/installer', token: SHARED, host: '192.168.50.10:8123' });
    assert.equal(dl.status, 200);
    assert.deepEqual(dl.buf, installer);
    assert.equal(dl.headers['content-disposition'], 'attachment; filename="glmps-tap-setup_https_192.168.50.10_8123.exe"');
    assert.equal(dl.headers['x-content-sha256'], sha(installer));
    assert.equal(dl.headers['cache-control'], 'no-store');
    const up = await remote(srv.port, { path: '/api/tap/download/update', token: SHARED });
    assert.deepEqual(up.buf, update);
    assert.equal(up.headers['x-content-sha256'], sha(update));

    assert.equal((await remote(srv.port, { path: '/api/tap/download/installer' })).status, 401, 'no token');
    assert.equal((await remote(srv.port, { path: '/api/tap/release' })).status, 401, 'no token');
    assert.equal((await remote(srv.port, { path: '/api/tap/download/other', token: SHARED })).status, 404);
    assert.equal((await remote(srv.port, { path: '/api/tap/download/installer', token: SHARED, host: 'a_b:8123' })).status, 400, 'unusable host');

    // A paired client's token is refused everywhere but its own update archive.
    const { pair, client } = await pairOver(srv.port, SHARED);
    assert.equal(pair.status, 201);
    for (const p of ['/api/tap/release', '/api/tap/download/installer']) {
      assert.equal((await remote(srv.port, { path: p, token: pair.json.token, client })).status, 403, p);
    }
    const mine = await remote(srv.port, { path: '/api/tap/download/update', token: pair.json.token, client });
    assert.equal(mine.status, 200);
    assert.deepEqual(mine.buf, update);
    assert.equal(mine.headers['x-content-sha256'], sha(update));

    fs.appendFileSync(path.join(env.GLMPS_STATE_DIR, RELEASE_DIR, INSTALLER_FILE), 'x');
    const swapped = await remote(srv.port, { path: '/api/tap/download/installer', token: SHARED });
    assert.equal(swapped.status, 500);
    assert.match(swapped.json.error, /does not match/);
  } finally { await srv.close(); }
});

test('card glmps-2-0-runtime-67: heartbeat and 426 name the release, and a too-old tap can still fetch its update', async () => {
  const env = mkEnv();
  const srv = await boot(env);
  const SHARED = env.GLMPS_ACCESS_TOKEN;
  try {
    const { token: tok, client } = await pairOver(srv.port, SHARED);
    const beat = (o = {}) => remote(srv.port, { method: 'POST', path: '/api/tap/heartbeat', token: tok, client, body: { tapVersion: '0.1.0', spoolDepth: 0, dataRoots: [], tools: [] }, ...o });

    const none = await beat();
    assert.equal(none.status, 200);
    assert.equal(none.json.update, null, 'nothing published');

    const { update } = publish(env.GLMPS_STATE_DIR);
    const advert = { version: '0.1.0', commit: 'abc1234', sha256: sha(update), size: update.length };
    const ok = await beat();
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.json.update, advert);

    const old = await beat({ protocol: '0' });
    assert.equal(old.status, 426);
    assert.equal(old.json.error, 'tap-protocol-too-old');
    assert.deepEqual(old.json.update, advert, 'the refusal tells the tap what to fetch');
    const oldRead = await remote(srv.port, { path: '/api/backlog', token: tok, client, protocol: '0' });
    assert.equal(oldRead.status, 426);
    assert.deepEqual(oldRead.json.update, advert);

    const fetched = await remote(srv.port, { path: '/api/tap/download/update', token: tok, client, protocol: '0' });
    assert.equal(fetched.status, 200, 'a too-old tap can still fetch the release that fixes it');
    assert.deepEqual(fetched.buf, update);
    assert.equal((await remote(srv.port, { path: '/api/tap/download/installer', token: tok, client, protocol: '0' })).status, 403);

    fs.appendFileSync(path.join(env.GLMPS_STATE_DIR, RELEASE_DIR, UPDATE_FILE), 'x');
    assert.equal((await beat()).json.update, null, 'a release that fails its own hash is not advertised');
  } finally { await srv.close(); }
});
