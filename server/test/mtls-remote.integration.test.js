// Routes under test: server/lib/routes/tap-routes.js
// server/test/mtls-remote.integration.test.js
// Card glmps-2-0-152 (spec 2026-11-10-glmps-2-0-171, primary seam): a real
// kernel on a private bind serves HTTPS on the private address and plain HTTP
// on loopback; a remote client token is accepted only beside the certificate
// issued to that same client.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server.js';
import { openClientStore } from '../lib/kernel/clients.js';
import { dbFileFor } from '../lib/state-dir.js';
import { privateBind, pairWithCert, remoteHttps, tapKeyPair, LISTEN_ALIAS } from './helpers/mtls.js';
import { waitFor } from './helpers/wait-for.js';

const SHARED = 'shared-remote-token';
const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });

function mkEnv() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-mtls-')); tmpDirs.push(tmp);
  const claudeDir = path.join(tmp, 'claude');
  fs.mkdirSync(path.join(claudeDir, '.claude-manager'), { recursive: true });
  fs.writeFileSync(path.join(claudeDir, '.claude-manager', 'active-sessions.json'), '[]');
  const env = { GLMPS_CLAUDE_DIR: claudeDir, GLMPS_ANTIGRAVITY_DIR: path.join(tmp, 'ag'), GLMPS_STATE_DIR: path.join(tmp, 'state'),
    GLMPS_GEMINI_TMP_DIR: path.join(tmp, 'gemini-tmp'), GLMPS_VSCODE_STORAGE_DIR: path.join(tmp, 'vscode-storage'),
    GLMPS_AGY_CLI_DIR: path.join(tmp, 'agy-cli'), GLMPS_CODEX_DIR: path.join(tmp, 'codex'), GLMPS_COPILOT_CLI_DIR: path.join(tmp, 'copilot-cli'),
    GLMPS_HERMES_DIR: path.join(tmp, 'hermes'), GLMPS_OPENCODE_DIR: path.join(tmp, 'opencode'), GLMPS_UNMERGED_SCAN: 'off',
    GLMPS_ACCESS_TOKEN: SHARED };
  const bind = privateBind({ stateDir: env.GLMPS_STATE_DIR, configFile: path.join(tmp, 'config.json') });
  return { env, ...bind };
}

async function boot() {
  const ctx = mkEnv();
  const srv = await startServer({ port: 0, pollMs: 1000, env: ctx.env, ...ctx.startOpts });
  const store = openClientStore({ dbFile: dbFileFor(ctx.env.GLMPS_STATE_DIR) });
  const call = (o) => remoteHttps(srv.port, { ca: ctx.homeCaPem, ...o });
  return { ...ctx, srv, store, call, close: async () => { store.closeDb(); await srv.close(); } };
}

test('AC-1: matching certificate and token 200; token only, another client\'s certificate, or a revoked client 401', async () => {
  const k = await boot();
  try {
    const a = pairWithCert(k.store, k.env.GLMPS_STATE_DIR, { name: 'laptop' });
    const b = pairWithCert(k.store, k.env.GLMPS_STATE_DIR, { name: 'desktop' });
    const ok = await k.call({ path: '/api/sessions/live', token: a.token, client: a });
    assert.equal(ok.status, 200, ok.body);
    const tokenOnly = await k.call({ path: '/api/sessions/live', token: a.token });
    assert.deepEqual([tokenOnly.status, tokenOnly.json?.error], [401, 'client-certificate-required']);
    const crossed = await k.call({ path: '/api/sessions/live', token: a.token, client: b });
    assert.deepEqual([crossed.status, crossed.json?.error], [401, 'client-certificate-mismatch']);
    k.store.revoke(a.clientId, { actor: 'test' });
    const revoked = await k.call({ path: '/api/sessions/live', token: a.token, client: a });
    assert.equal(revoked.status, 401, 'revoked: the store is read on every request');
    assert.equal((await k.call({ path: '/api/sessions/live', token: b.token, client: b })).status, 200, 'the other client is unaffected');
  } finally { await k.close(); }
});

test('a certificate signed by any other CA is refused even with the right fingerprint on file', async () => {
  const k = await boot();
  try {
    const a = pairWithCert(k.store, k.env.GLMPS_STATE_DIR, { name: 'laptop' });
    // A second state dir has its own client CA; its certificate for the same id does not chain here.
    const foreignDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-mtls-foreign-')); tmpDirs.push(foreignDir);
    const foreignStore = openClientStore({ dbFile: path.join(foreignDir, 'kernel.db') });
    const f = pairWithCert(foreignStore, foreignDir, { name: 'evil' });
    foreignStore.closeDb();
    const r = await k.call({ path: '/api/sessions/live', token: a.token, client: f });
    assert.equal(r.status, 401);
  } finally { await k.close(); }
});

test('the dashboard token works over HTTPS with no client certificate; no token is 401; liveness stays open', async () => {
  const k = await boot();
  try {
    assert.equal((await k.call({ path: '/api/state', token: SHARED })).status, 200);
    assert.equal((await k.call({ path: '/api/state' })).status, 401);
    assert.equal((await k.call({ path: '/healthz' })).status, 200);
  } finally { await k.close(); }
});

test('loopback stays plain HTTP on 127.0.0.1 at the same port, and the private listener speaks no plain HTTP', async () => {
  const k = await boot();
  try {
    assert.equal((await fetch(`http://127.0.0.1:${k.srv.port}/healthz`)).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${k.srv.port}/api/state`)).status, 200, 'loopback needs no token, as before');
    const plain = await new Promise((resolve) => {
      const req = http.get({ host: LISTEN_ALIAS, localAddress: LISTEN_ALIAS, port: k.srv.port, path: '/healthz' }, (res) => { res.resume(); resolve(`status ${res.statusCode}`); });
      req.on('error', (e) => resolve(`error ${e.code}`));
    });
    assert.doesNotMatch(plain, /^status 200$/, `plain HTTP on the private listener answered: ${plain}`);
  } finally {
    await k.close();
    await assert.rejects(fetch(`http://127.0.0.1:${k.srv.port}/healthz`), 'close releases loopback');
  }
});

test('pairing over HTTPS returns a certificate the next request uses; rotate ends the old certificate and token', async () => {
  const k = await boot();
  try {
    const mint = await k.call({ method: 'POST', path: '/api/tap/pair-code', token: SHARED, body: {} });
    assert.equal(mint.status, 201, mint.body);
    assert.equal(mint.json.trustFingerprint, k.trustFingerprint, 'the pairing screen carries the server-trust CA fingerprint');
    const keys = tapKeyPair();
    const noKey = await k.call({ method: 'POST', path: '/api/tap/pair', body: { code: mint.json.code, name: 'laptop', tapVersion: '1.0.0' } });
    assert.deepEqual([noKey.status, noKey.json?.error], [400, 'invalid-body'], 'a pairing without a public key is refused and keeps the code');
    const pair = await k.call({ method: 'POST', path: '/api/tap/pair', body: { code: mint.json.code, name: 'laptop', tapVersion: '1.0.0', publicKey: keys.publicKeyPem } });
    assert.equal(pair.status, 201, pair.body);
    assert.equal(JSON.stringify(pair.json).includes('PRIVATE KEY'), false, 'the server never holds the tap key');
    const cert = new crypto.X509Certificate(pair.json.certificate);
    assert.match(cert.subjectAltName, new RegExp(`urn:glmps:client:${pair.json.clientId}`));
    const me = { cert: pair.json.certificate, key: keys.privateKeyPem };
    assert.equal((await k.call({ path: '/api/sessions/live', token: pair.json.token, client: me })).status, 200);

    const noKeyRotate = await k.call({ method: 'POST', path: `/api/clients/${pair.json.clientId}/rotate`, token: SHARED, body: {} });
    assert.deepEqual([noKeyRotate.status, noKeyRotate.json?.error], [400, 'public-key-required']);
    const keys2 = tapKeyPair();
    const rot = await k.call({ method: 'POST', path: `/api/clients/${pair.json.clientId}/rotate`, token: SHARED, body: { publicKey: keys2.publicKeyPem } });
    assert.equal(rot.status, 200, rot.body);
    const me2 = { cert: rot.json.certificate, key: keys2.privateKeyPem };
    assert.equal((await k.call({ path: '/api/sessions/live', token: rot.json.token, client: me2 })).status, 200);
    const oldCert = await k.call({ path: '/api/sessions/live', token: rot.json.token, client: me });
    assert.deepEqual([oldCert.status, oldCert.json?.error], [401, 'client-certificate-mismatch'], 'the old certificate is dead');
    assert.equal((await k.call({ path: '/api/sessions/live', token: pair.json.token, client: me2 })).status, 401, 'the old token is dead');
  } finally { await k.close(); }
});

test('a client paired before client certificates is told to re-pair', async () => {
  const k = await boot();
  try {
    const legacy = k.store.pair({ name: 'old', actor: 'test' });
    const r = await k.call({ path: '/api/sessions/live', token: legacy.token });
    assert.deepEqual([r.status, r.json?.error], [401, 'client-must-re-pair']);
  } finally { await k.close(); }
});

test('the cert-expiry loop raises an alert for a client certificate inside 30 days', async () => {
  const k = await boot();
  try {
    const soon = Date.now() + 5 * 86400000;
    k.store.pair({ name: 'old-laptop', actor: 'test', issueCert: () => ({ certPem: 'x', notAfter: soon, fingerprint256: 'ab'.repeat(32) }) });
    const run = await fetch(`http://127.0.0.1:${k.srv.port}/api/loops/cert-expiry/run`, { method: 'POST' });
    assert.equal(run.status, 202);
    const hit = await waitFor(async () => {
      const alerts = await (await fetch(`http://127.0.0.1:${k.srv.port}/api/alerts`)).json();
      return (alerts.alerts ?? alerts).find?.((a) => a.source === 'cert-expiry') ?? null;
    }, { intervalMs: 100, message: 'a cert-expiry alert after the loop ran' });
    assert.match(hit.title, /old-laptop/);
  } finally { await k.close(); }
});
