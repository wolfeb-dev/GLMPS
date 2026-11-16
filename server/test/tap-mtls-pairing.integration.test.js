// Routes under test: server/lib/routes/tap-routes.js
// server/test/tap-mtls-pairing.integration.test.js
// Card glmps-2-0-runtime-147 (spec 2026-11-10-glmps-2-0-171, the tap side): the
// real installer pairs against a real kernel's private HTTPS listener only when
// the server CA matches the fingerprint the dashboard showed, and the real agent
// then heartbeats and ships with its client certificate until it is revoked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server.js';
import { openClientStore } from '../lib/kernel/clients.js';
import { openTapIngest } from '../lib/kernel/tap-ingest.js';
import { dbFileFor } from '../lib/state-dir.js';
import { createCa, certFingerprint } from '../lib/kernel/x509-lite.js';
import { runSetup } from '../../taps/tap-setup.mjs';
import { startAgent } from '../../taps/tap-agent.js';
import { createTapFetch, probeServerChain } from '../../taps/tap-tls.js';
import { privateBind, PRIVATE_HOST, LISTEN_ALIAS } from './helpers/mtls.js';
import { waitFor } from './helpers/wait-for.js';

const SHARED = 'shared-remote-token';
const T = 'C74BBD54C1211B9386A27E2904D2463908B6F9E9';
// CI has no private interface: dial the loopback alias the kernel's HTTPS listener binds, check names as 192.168.50.10.
const CONNECT = { host: LISTEN_ALIAS, localAddress: LISTEN_ALIAS };
const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });
const mkTmp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); tmpDirs.push(d); return d; };

async function boot() {
  const tmp = mkTmp('mc-tapmtls-');
  const claudeDir = path.join(tmp, 'claude');
  fs.mkdirSync(path.join(claudeDir, '.claude-manager'), { recursive: true });
  fs.writeFileSync(path.join(claudeDir, '.claude-manager', 'active-sessions.json'), '[]');
  const env = { GLMPS_CLAUDE_DIR: claudeDir, GLMPS_ANTIGRAVITY_DIR: path.join(tmp, 'ag'), GLMPS_STATE_DIR: path.join(tmp, 'state'),
    GLMPS_GEMINI_TMP_DIR: path.join(tmp, 'gemini-tmp'), GLMPS_VSCODE_STORAGE_DIR: path.join(tmp, 'vscode-storage'),
    GLMPS_AGY_CLI_DIR: path.join(tmp, 'agy-cli'), GLMPS_CODEX_DIR: path.join(tmp, 'codex'), GLMPS_COPILOT_CLI_DIR: path.join(tmp, 'copilot-cli'),
    GLMPS_HERMES_DIR: path.join(tmp, 'hermes'), GLMPS_OPENCODE_DIR: path.join(tmp, 'opencode'), GLMPS_UNMERGED_SCAN: 'off',
    GLMPS_ACCESS_TOKEN: SHARED };
  const bind = privateBind({ stateDir: env.GLMPS_STATE_DIR, configFile: path.join(tmp, 'config.json') });
  const srv = await startServer({ port: 0, pollMs: 1000, env, ...bind.startOpts });
  const store = openClientStore({ dbFile: dbFileFor(env.GLMPS_STATE_DIR) });
  return { env, srv, store, fingerprint: bind.trustFingerprint, close: async () => { store.closeDb(); await srv.close(); } };
}

function mintCode(port, body = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/tap/pair-code', headers: { 'content-type': 'application/json', authorization: `Bearer ${SHARED}` } }, (res) => {
      let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve(JSON.parse(b)));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

function payload() {
  const dir = mkTmp('mc-tapmtls-src-');
  for (const d of ['scripts', 'taps']) fs.mkdirSync(path.join(dir, d));
  fs.writeFileSync(path.join(dir, 'node.exe'), 'node');
  fs.writeFileSync(path.join(dir, 'scripts', 'install.mjs'), '');
  fs.writeFileSync(path.join(dir, 'tap.cat'), 'cat');
  fs.writeFileSync(path.join(dir, 'signer.json'), JSON.stringify({ thumbprint: T, mode: 'test' }));
  return dir;
}

/** The real installer with the real network path; only the Windows system calls and DPAPI are stood in for. */
function setupDeps(home, secrets, lines, sent) {
  const tapFetch = createTapFetch({ connect: CONNECT });
  return {
    home, env: { GLMPS_TAP_HOME: home }, platform: 'win32', payloadRoot: payload(),
    log: (m) => lines.push(m), sleep: async () => {}, prompt: async () => '',
    verify: () => ({ catalog: 'Valid', signature: 'UnknownError', thumbprint: T, subject: 'CN=GLMPS Tap Test Signing', missing: [], extra: [], changed: [] }),
    writeToken: (_h, t) => { secrets.token = t; },
    writeClientKey: (_h, k) => { secrets.key = k; },
    run: (cmd) => ({ status: 0, stdout: cmd === 'netstat.exe' ? '' : '' }),
    probeChain: (url) => probeServerChain(url, { connect: CONNECT }),
    fetch: (url, init) => { sent.push({ url, body: init?.body ?? null }); return tapFetch(url, init); },
  };
}

function getStatus(port) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/tap/status' }, (res) => {
      let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve(JSON.parse(b)));
    }).on('error', reject);
  });
}

test('AC-1, AC-2, AC-3: pinned pairing over HTTPS, heartbeat and ingest with the certificate, refused after revoke', async () => {
  const k = await boot();
  const home = mkTmp('mc-tapmtls-home-');
  const secrets = {};
  const lines = [];
  const sent = [];
  let agent = null;
  const inbox = openTapIngest({ dbFile: dbFileFor(k.env.GLMPS_STATE_DIR) });
  try {
    const server = `https://${PRIVATE_HOST}:${k.srv.port}`;

    // AC-1, refusal: the fingerprint of another CA is refused before the code is sent, and the code still works.
    const minted = await mintCode(k.srv.port);
    assert.equal(minted.trustFingerprint, k.fingerprint, 'Add a client carries the server CA fingerprint');
    const wrong = certFingerprint(createCa({ cn: 'Impostor', days: 1 }).certPem);
    await assert.rejects(runSetup(['--server', server, '--code', minted.code, '--fingerprint', wrong, '--name', 'laptop', '--no-start'], setupDeps(home, secrets, lines, sent)),
      /may not be your GLMPS server, so nothing was sent/);
    assert.equal(sent.length, 0, 'no request reached the server');
    assert.equal(secrets.token, undefined);

    // AC-1, success: the matching fingerprint pairs over HTTPS and stores token, key, certificate and the pinned CA.
    const r = await runSetup(['--server', server, '--code', minted.code, '--fingerprint', k.fingerprint, '--name', 'laptop', '--no-start'], setupDeps(home, secrets, lines, sent));
    assert.equal(r.ok, true);
    assert.match(r.clientId, /^cli_/);
    assert.equal(k.store.get(r.clientId).name, 'laptop');
    assert.ok(secrets.token && secrets.key.includes('PRIVATE KEY'));
    assert.ok(fs.readFileSync(path.join(home, 'client-cert.pem'), 'utf8').includes('BEGIN CERTIFICATE'));
    assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'tap-config.json'), 'utf8')).trustFingerprint, k.fingerprint);
    console.log(`AC-1 pairing log:\n  ${lines.join('\n  ')}`);

    // AC-2: the agent heartbeats and ships with its certificate.
    const agentLog = [];
    const agentFetch = createTapFetch({ connect: CONNECT });
    agent = await startAgent({
      home, port: 0, homeDir: mkTmp('mc-tapmtls-user-'), intervalMs: 3_600_000, shipTickMs: 20, budget: false,
      log: (m) => agentLog.push(m), readToken: () => secrets.token, readClientKey: () => secrets.key,
      fetch: (url, init) => { sent.push({ url, body: init?.body ?? null }); return agentFetch(url, init); },
      relay: { connect: CONNECT },
    });
    await agent.ready;
    let status = await getStatus(agent.address.port);
    assert.equal(status.state, 'paired', JSON.stringify(status));
    assert.equal(status.certificate.state, 'ok');
    assert.equal(status.certificate.notAfter, k.store.list().find((c) => c.id === r.clientId).certNotAfter, 'the tap and the Clients list agree on expiry');
    agent.spool.append('hook', { i: 0, sessionId: 's1' });
    await waitFor(() => inbox.records({ clientId: r.clientId }).length === 1, { timeoutMs: 20_000, message: 'ingest over mTLS' });
    // A hook on the client calls the relay on loopback; the relay forwards with the certificate.
    const relayed = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: agent.address.port, path: '/api/sessions/live' }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject);
    });
    assert.equal(relayed, 200, 'the relay reaches the server over mTLS');
    console.log(`AC-2 paired: relay=${relayed} state=${status.state} certificate=${status.certificate.state} ingested=${inbox.records({ clientId: r.clientId }).length}`);

    // AC-2: after revoke the next heartbeat fails and the status page says why.
    k.store.revoke(r.clientId, { actor: 'test' });
    await agent.heartbeatOnce();
    status = await getStatus(agent.address.port);
    assert.equal(status.state, 'unpaired');
    assert.match(status.reason, /does not accept this token.*pair this client again/);
    console.log(`AC-2 revoked: state=${status.state} reason="${status.reason}"`);

    // AC-3: the private key appears in no request body, no log line and no status document.
    const key = secrets.key;
    const keyBody = key.split('\n').filter((l) => l && !l.startsWith('-----')).join('');
    for (const s of sent) {
      const b = s.body == null ? '' : Buffer.isBuffer(s.body) ? s.body.toString('utf8') : String(s.body);
      assert.equal(b.includes('PRIVATE KEY') || b.replace(/\\n/g, '').includes(keyBody), false, `the key rode in a request to ${s.url}`);
    }
    for (const l of [...lines, ...agentLog]) assert.equal(String(l).includes(keyBody.slice(0, 40)) || String(l).includes('PRIVATE KEY'), false, `the key reached a log line: ${l}`);
    assert.equal(JSON.stringify(status).includes(keyBody.slice(0, 40)), false);
    console.log(`AC-3: checked ${sent.length} request bodies and ${lines.length + agentLog.length} log lines; the key is in none`);
  } finally {
    if (agent) await agent.close();
    inbox.closeDb();
    await k.close();
  }
});

test('the status page names a missing certificate, an expired one, and a certificate the server refuses', async () => {
  const k = await boot();
  try {
    const server = `https://${PRIVATE_HOST}:${k.srv.port}`;
    const home = mkTmp('mc-tapmtls-home-');
    const secrets = {};
    const minted = await mintCode(k.srv.port);
    const r = await runSetup(['--server', server, '--code', minted.code, '--fingerprint', k.fingerprint, '--name', 'laptop', '--no-start'], setupDeps(home, secrets, [], []));
    const base = { home, port: 0, homeDir: mkTmp('mc-tapmtls-user-'), intervalMs: 3_600_000, budget: false, log: () => {}, readToken: () => secrets.token, fetch: createTapFetch({ connect: CONNECT }) };

    const missing = await startAgent({ ...base, readClientKey: () => null });
    try {
      await missing.ready;
      const s = await getStatus(missing.address.port);
      assert.deepEqual([s.state, s.certificate.state], ['unpaired', 'missing']);
      assert.match(s.reason, /no client certificate; pair it again/);
    } finally { await missing.close(); }

    const expired = await startAgent({ ...base, readClientKey: () => secrets.key, now: () => Date.now() + 400 * 86_400_000 });
    try {
      await expired.ready;
      const s = await getStatus(expired.address.port);
      assert.deepEqual([s.state, s.certificate.state], ['unpaired', 'expired']);
      assert.match(s.reason, /expired on \d{4}-\d{2}-\d{2}/);
    } finally { await expired.close(); }

    // Pair again reissues token and certificate: the new token beside the old certificate is refused by fingerprint.
    const before = fs.readFileSync(path.join(home, 'client-cert.pem'), 'utf8');
    const other = mkTmp('mc-tapmtls-home2-');
    const fresh = {};
    const re = await mintCode(k.srv.port, { clientId: r.clientId });
    await runSetup(['--server', server, '--code', re.code, '--fingerprint', k.fingerprint, '--name', 'laptop', '--no-start'], setupDeps(other, fresh, [], []));
    const refused = await startAgent({ ...base, readToken: () => fresh.token, readClientKey: () => secrets.key });
    try {
      await refused.ready;
      const s = await getStatus(refused.address.port);
      assert.equal(fs.readFileSync(path.join(home, 'client-cert.pem'), 'utf8'), before, 'the old tap still holds the old certificate');
      assert.deepEqual([s.state, s.certificate.state], ['unpaired', 'refused']);
      assert.match(s.reason, /refused this client's certificate \(client-certificate-mismatch\)/);
    } finally { await refused.close(); }
  } finally { await k.close(); }
});
