// Routes under test: server/lib/routes/tap-routes.js
// server/test/clients-panel.test.js
// Server-and-client-tap task 8: GET /api/clients and the Clients panel's pure view model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server.js';
import { privateBind, remoteHttps, tapKeyPair } from './helpers/mtls.js';
import { serverSource } from './helpers/server-source.js';
import { STALE_MS, clientStatus, lastSeenText, depthText, formatCode, expiresInText, installerLine, mintErrorText, certExpiry, fingerprintText, CERT_WARN_MS } from '../../web/shared/clients-panel.js';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });

function mkEnv() {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-clients-panel-'));
  tmpDirs.push(t);
  const claudeDir = path.join(t, 'claude');
  fs.mkdirSync(path.join(claudeDir, '.claude-manager'), { recursive: true });
  fs.writeFileSync(path.join(claudeDir, '.claude-manager', 'active-sessions.json'), '[]');
  return { GLMPS_CLAUDE_DIR: claudeDir, GLMPS_ANTIGRAVITY_DIR: path.join(t, 'ag'), GLMPS_STATE_DIR: path.join(t, 'state'),
    GLMPS_GEMINI_TMP_DIR: path.join(t, 'gemini-tmp'), GLMPS_VSCODE_STORAGE_DIR: path.join(t, 'vscode-storage'),
    GLMPS_AGY_CLI_DIR: path.join(t, 'agy-cli'), GLMPS_CODEX_DIR: path.join(t, 'codex'), GLMPS_COPILOT_CLI_DIR: path.join(t, 'copilot-cli'),
    GLMPS_HERMES_DIR: path.join(t, 'hermes'), GLMPS_OPENCODE_DIR: path.join(t, 'opencode'), GLMPS_UNMERGED_SCAN: 'off',
    GLMPS_ACCESS_TOKEN: 'shared-remote-token' };
}
test('GET /api/clients lists paired and revoked clients newest first, with no token or hash, and refuses a client token', async () => {
  const env = mkEnv();
  const bind = privateBind({ stateDir: env.GLMPS_STATE_DIR, configFile: path.join(path.dirname(env.GLMPS_STATE_DIR), 'config.json') });
  const srv = await startServer({ port: 0, pollMs: 1000, env, ...bind.startOpts });
  // HTTPS from 127.0.0.2 (the remote path) on the private bind.
  const remote = (port, o) => remoteHttps(port, { ca: bind.homeCaPem, ...o });
  const SHARED = env.GLMPS_ACCESS_TOKEN;
  try {
    const empty = await remote(srv.port, { path: '/api/clients', token: SHARED });
    assert.equal(empty.status, 200, empty.body);
    assert.deepEqual(empty.json, { clients: [] });

    const pairOne = async (name) => {
      const code = (await remote(srv.port, { method: 'POST', path: '/api/tap/pair-code', token: SHARED, body: {} })).json.code;
      const keys = tapKeyPair();
      const json = (await remote(srv.port, { method: 'POST', path: '/api/tap/pair', body: { code, name, tapVersion: '1.0.0', dataRoots: ['C:/x'], publicKey: keys.publicKeyPem } })).json;
      return { ...json, key: keys.privateKeyPem };
    };
    const a = await pairOne('desk');
    const b = await pairOne('laptop');
    await remote(srv.port, { method: 'POST', path: `/api/clients/${a.clientId}/revoke`, token: SHARED, body: {} });

    const list = await remote(srv.port, { path: '/api/clients', token: SHARED });
    assert.equal(list.status, 200, list.body);
    const rows = list.json.clients;
    assert.deepEqual(rows.map((c) => [c.name, c.paired]).sort(), [['desk', false], ['laptop', true]]);
    assert.ok(rows[0].createdTs >= rows[1].createdTs, 'newest first');
    for (const k of ['id', 'tapVersion', 'dataRoots', 'createdTs', 'lastSeenTs', 'spoolDepth', 'revokedTs']) assert.ok(k in rows[0], k);
    assert.ok(!/tokenHash|token"/.test(list.body), 'no token or hash in the list');
    assert.ok(!list.body.includes(b.token));

    assert.equal((await remote(srv.port, { path: '/api/clients' })).status, 401, 'no token');
    assert.equal((await remote(srv.port, { path: '/api/clients', token: b.token, client: { cert: b.certificate, key: b.key } })).status, 403, 'client token');
  } finally { await srv.close(); }
});

test('status: revoked and never-seen are neutral, a heartbeat older than STALE_MS is a warning, otherwise online', () => {
  const now = 10_000_000;
  assert.deepEqual(clientStatus({ paired: false, lastSeenTs: now }, now), { key: 'revoked', label: 'Revoked', tone: 'neutral' });
  assert.deepEqual(clientStatus({ paired: true, lastSeenTs: null }, now), { key: 'never', label: 'Never seen', tone: 'neutral' });
  assert.deepEqual(clientStatus({ paired: true, lastSeenTs: now - STALE_MS }, now), { key: 'online', label: 'Online', tone: 'success' });
  assert.deepEqual(clientStatus({ paired: true, lastSeenTs: now - STALE_MS - 1 }, now), { key: 'stale', label: 'Stale', tone: 'warning' });
  assert.equal(STALE_MS, 5 * 60 * 1000);
});

test('last seen and depth: a missing value is null (rendered as a muted dash), zero is 0', () => {
  const now = 10_000_000;
  assert.equal(lastSeenText(null, now), null);
  assert.equal(lastSeenText(now - 5_000, now), 'just now');
  assert.equal(lastSeenText(now - 3 * 60_000, now), '3m ago');
  assert.equal(lastSeenText(now - 2 * 3_600_000, now), '2h ago');
  assert.equal(lastSeenText(now - 3 * 86_400_000, now), '3d ago');
  assert.equal(depthText(0), '0');
  assert.equal(depthText(12345), '12,345');
  assert.equal(depthText(null), null);
  assert.equal(depthText(undefined), null);
});

test('a code shows as XXXX-XXXX and the countdown reads m:ss, then expired', () => {
  assert.equal(formatCode('ABCD2345'), 'ABCD-2345');
  assert.equal(formatCode('abc'), 'ABC');
  const now = 1_000_000;
  assert.equal(expiresInText(now + 10 * 60_000, now), '10:00');
  assert.equal(expiresInText(now + 61_500, now), '1:02');
  assert.equal(expiresInText(now + 999, now), '0:01');
  assert.equal(expiresInText(now, now), null);
});

test('installer line: reads task 7 release answer; 404 says none is published; anything else names the status', () => {
  const release = { version: '0.1.0', installer: { size: 9, sha256: 'ab'.repeat(32), url: '/api/tap/download/installer', fileName: 'glmps-tap-setup_http_box_8123.exe' }, update: {} };
  assert.deepEqual(installerLine(200, release),
    { available: true, version: '0.1.0', sha256: 'ab'.repeat(32), url: '/api/tap/download/installer', fileName: 'glmps-tap-setup_http_box_8123.exe' });
  assert.deepEqual(installerLine(404, { error: 'no tap release is published' }), { available: false, text: 'No installer is published on this server yet.' });
  assert.deepEqual(installerLine(500, { error: 'boom' }), { available: false, text: 'Installer details unavailable: boom' });
  assert.deepEqual(installerLine(200, { version: '0.1.0' }), { available: false, text: 'Installer details unavailable: incomplete answer' });
  // A null fileName means the Host header cannot name the server, so the download would answer 400.
  assert.match(installerLine(200, { ...release, installer: { ...release.installer, fileName: null } }).text, /by its private address/);
  // Only same-origin paths are linked, so a bad answer cannot point the download elsewhere.
  assert.equal(installerLine(200, { ...release, installer: { ...release.installer, url: 'https://evil.example/x.exe' } }).available, false);
});

test('the installer path the panel fetches is a route the server registers', () => {
  const api = fs.readFileSync(path.join(ROOT, 'web/shared/api.js'), 'utf8');
  const fetched = api.match(/getInstallerInfo = \(\) => clientCall\('([^']+)'\)/)?.[1];
  assert.ok(fetched, 'getInstallerInfo path found');
  const server = serverSource();
  assert.ok(server.includes(`pattern: '${fetched}'`), `${fetched} is registered in server.js`);
});

test('mint errors read as what to do next', () => {
  assert.equal(mintErrorText(429, { error: 'too-many-live-codes' }), '10 codes are already live. Wait for one to expire, then try again.');
  assert.equal(mintErrorText(404, { error: 'unknown client' }), 'That client no longer exists. Reload the list.');
  assert.equal(mintErrorText(503, { error: 'clients store unavailable' }), 'The clients store is unavailable on this server: clients store unavailable');
  assert.equal(mintErrorText(500, {}), 'Could not mint a pairing code (server answered 500).');
});

test('the panel offers no Rotate: a rotation needs the tap\'s new key, so a paired client gets Pair again (card glmps-2-0-177)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'web', 'shared', 'clients-panel.js'), 'utf8');
  assert.doesNotMatch(src, /rotateClient|button\('Rotate'/);
  assert.doesNotMatch(fs.readFileSync(path.join(ROOT, 'web', 'shared', 'api.js'), 'utf8'), /rotateClient/);
});

test('AC-4: certificate expiry reads as days left, warns inside the 30-day alert window, and names a missing certificate', () => {
  const day = 86_400_000;
  const now = Date.UTC(2026, 10, 11);
  assert.equal(CERT_WARN_MS, 30 * day, 'the same window as the server expiry alert');
  assert.deepEqual(certExpiry({ paired: true, certNotAfter: now + 200 * day }, now), { text: '200d', tone: 'neutral', title: 'Client certificate expires 2027-05-30' });
  assert.deepEqual(certExpiry({ paired: true, certNotAfter: now + 12 * day }, now), { text: '12d', tone: 'warning', title: 'Client certificate expires 2026-11-23; pair again to renew' });
  assert.equal(certExpiry({ paired: true, certNotAfter: now + 3600_000 }, now).text, 'today');
  assert.deepEqual(certExpiry({ paired: true, certNotAfter: now - day }, now), { text: 'Expired', tone: 'danger', title: 'Client certificate expired 2026-11-10; pair again' });
  assert.deepEqual(certExpiry({ paired: true, certNotAfter: null }, now), { text: 'None', tone: 'warning', title: 'Paired before client certificates; pair again' });
  assert.equal(certExpiry({ paired: false, certNotAfter: now + day }, now), null, 'a revoked client has no live certificate');
});

test('Add a client shows the server fingerprint in groups of four, and says when the server has none', () => {
  assert.equal(fingerprintText('ab'.repeat(32)), 'abab abab abab abab abab abab abab abab abab abab abab abab abab abab abab abab');
  assert.equal(fingerprintText(null), null);
  assert.equal(fingerprintText('xyz'), null);
});
