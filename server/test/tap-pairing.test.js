// Routes under test: server/lib/routes/tap-routes.js
// server/test/tap-pairing.test.js
// Server-and-client-tap task 4: pairing codes (lib) and the pairing routes (end to end).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createPairing, PairingRefusal } from '../lib/kernel/pairing.js';
import { openClientStore } from '../lib/kernel/clients.js';
import { checkAccess, TAP_PAIR_ROUTE } from '../lib/governance/access-guard.js';
import { startServer } from '../server.js';
import { TAP_PROTOCOL_HEADER, TAP_PROTOCOL } from '../lib/kernel/tap-protocol.js';
import { tapKeyPair, certIssuer, privateBind, remoteHttps } from './helpers/mtls.js';

const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });
const tmp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); tmpDirs.push(d); return d; };

function setup(opts = {}) {
  const dir = tmp('mc-pair-');
  const clock = { t: 1_000_000 };
  const now = () => clock.t;
  const store = openClientStore({ dbFile: path.join(dir, 'kernel.db'), now });
  const pairing = createPairing({ clientStore: store, issueCert: certIssuer(dir), now, ...opts });
  return { clock, store, pairing };
}
const TAP_KEY = tapKeyPair();
const body = (extra = {}) => ({ name: 'laptop', tapVersion: '1.0.0', dataRoots: ['C:/x'], publicKey: TAP_KEY.publicKeyPem, source: '10.0.0.5', ...extra });
const refusal = (fn) => { try { fn(); } catch (e) { return e; } assert.fail('expected a refusal'); };

test('card glmps-2-0-152: a redeemed code returns a client certificate over the tap key, naming the new client', () => {
  const { pairing, store } = setup();
  const r = pairing.redeem({ code: pairing.mint({ actor: 'op' }).code, ...body() });
  const cert = new crypto.X509Certificate(r.certificate);
  assert.match(cert.subject, new RegExp(`CN=${r.clientId}`));
  assert.equal(cert.publicKey.export({ type: 'spki', format: 'pem' }), TAP_KEY.publicKeyPem);
  assert.equal(r.certificateExpiresAt, Date.parse(cert.validTo));
  assert.equal(store.get(r.clientId).certSha256, cert.fingerprint256.replace(/:/g, '').toLowerCase());
});

test('a minted code is 8 unambiguous characters and redeems once into a client id and a 32-byte token', () => {
  const { pairing, store } = setup();
  const m = pairing.mint({ actor: 'operator' });
  assert.match(m.code, /^[ABCDEFGHJKMNPQRSTVWXYZ23456789]{8}$/);
  assert.equal(m.clientId, null);
  const r = pairing.redeem({ code: m.code, ...body() });
  assert.match(r.clientId, /^cli_/);
  assert.equal(Buffer.from(r.token, 'base64url').length, 32);
  assert.equal(r.repaired, false);
  assert.equal(store.authenticate(r.token).id, r.clientId);
  const again = refusal(() => pairing.redeem({ code: m.code, ...body() }));
  assert.equal(again.status, 401);
  assert.equal(again.reason, 'invalid-code');
});

test('input is case-insensitive and spaces and hyphens are stripped', () => {
  const { pairing } = setup();
  const m = pairing.mint({ actor: 'operator' });
  const typed = `${m.code.slice(0, 4)}-${m.code.slice(4)}`.toLowerCase().replace('-', ' - ');
  assert.ok(pairing.redeem({ code: typed, ...body() }).token);
});

test('a code expires at ten minutes', () => {
  const { pairing, clock } = setup();
  const m = pairing.mint({ actor: 'operator' });
  assert.equal(m.expiresAt, clock.t + 10 * 60 * 1000);
  clock.t += 10 * 60 * 1000;
  assert.equal(refusal(() => pairing.redeem({ code: m.code, ...body() })).reason, 'invalid-code');
  const m2 = pairing.mint({ actor: 'operator' });
  clock.t += 10 * 60 * 1000 - 1;
  assert.ok(pairing.redeem({ code: m2.code, ...body() }).token);
});

test('the sixth attempt in a minute from one source is rate limited without checking the code, then resets', () => {
  const { pairing, clock } = setup();
  const m = pairing.mint({ actor: 'operator' });
  for (let i = 0; i < 5; i++) assert.equal(refusal(() => pairing.redeem({ code: 'WRONGCDE', ...body() })).status, 401);
  const limited = refusal(() => pairing.redeem({ code: m.code, ...body() }));
  assert.equal(limited.status, 429);
  assert.equal(limited.reason, 'rate-limited');
  assert.ok(pairing.redeem({ code: m.code, ...body({ source: '10.0.0.6' }) }).token, 'another source is unaffected');
  const m2 = pairing.mint({ actor: 'operator' });
  clock.t += 60 * 1000 + 1;
  assert.ok(pairing.redeem({ code: m2.code, ...body() }).token, 'the window passed');
});

test('every attempt is audited, refusals included', () => {
  const { pairing, store } = setup();
  const m = pairing.mint({ actor: 'alice' });
  refusal(() => pairing.redeem({ code: 'NOPENOPE', ...body() }));
  const ok = pairing.redeem({ code: m.code, ...body() });
  const rows = store.audit();
  const refused = rows.find((r) => r.action === 'pair-refused');
  assert.equal(refused.source, '10.0.0.5');
  assert.deepEqual(refused.meta, { reason: 'invalid-code' });
  const paired = rows.find((r) => r.action === 'pair');
  assert.equal(paired.clientId, ok.clientId);
  assert.equal(paired.actor, 'pair-code:alice');
  assert.equal(paired.source, '10.0.0.5');
});

test('an invalid body is 400 and does not burn the code', () => {
  const { pairing, store } = setup();
  const m = pairing.mint({ actor: 'operator' });
  for (const bad of [{ name: '' }, { name: 'x'.repeat(101) }, { dataRoots: 'C:/x' }, { dataRoots: [''] }, { tapVersion: 5 }, { publicKey: undefined }, { publicKey: 'not a key' }]) {
    const e = refusal(() => pairing.redeem({ code: m.code, ...body(bad) }));
    assert.equal(e.status, 400);
    assert.equal(e.reason, 'invalid-body');
  }
  assert.ok(pairing.redeem({ code: m.code, ...body() }).token);
  assert.ok(store.audit().some((r) => r.action === 'pair-refused' && r.meta.reason === 'invalid-body'));
});

test('a re-pair code keeps the client id and the old token stops authenticating', () => {
  const { pairing, store } = setup();
  const first = pairing.redeem({ code: pairing.mint({ actor: 'op' }).code, ...body() });
  const m = pairing.mint({ actor: 'op', clientId: first.clientId });
  assert.equal(m.clientId, first.clientId);
  const second = pairing.redeem({ code: m.code, ...body({ name: 'laptop2', clientId: 'cli_attacker' }) });
  assert.equal(second.clientId, first.clientId);
  assert.equal(second.repaired, true);
  assert.equal(store.authenticate(first.token), null);
  assert.equal(store.authenticate(second.token).id, first.clientId);
  assert.equal(store.get(first.clientId).name, 'laptop2');
});

test('minting a re-pair code for an unknown client throws', () => {
  const { pairing } = setup();
  assert.throws(() => pairing.mint({ actor: 'op', clientId: 'cli_nope' }), /no client/);
});

test('the live-code cap is a mint rate limit, and expired codes free their slot', () => {
  const { pairing, clock } = setup({ maxLiveCodes: 3 });
  for (let i = 0; i < 3; i++) pairing.mint({ actor: 'op' });
  const e = refusal(() => pairing.mint({ actor: 'op' }));
  assert.equal(e.name, 'PairingRefusal');
  assert.equal(e.status, 429);
  assert.ok(e instanceof PairingRefusal);
  clock.t += 10 * 60 * 1000;
  assert.ok(pairing.mint({ actor: 'op' }).code);
});

test('a code is consumed even if the store then fails', () => {
  const { pairing, store } = setup();
  const m = pairing.mint({ actor: 'op' });
  store.pair = () => { throw new Error('disk full'); };
  assert.throws(() => pairing.redeem({ code: m.code, ...body() }), /disk full/);
  store.pair = undefined;
  assert.equal(refusal(() => pairing.redeem({ code: m.code, ...body() })).reason, 'invalid-code');
});

test('codes are held only as hashes', () => {
  const { pairing } = setup();
  const m = pairing.mint({ actor: 'op' });
  assert.equal(JSON.stringify(pairing, (k, v) => (typeof v === 'function' ? undefined : v)).includes(m.code), false);
  const dump = JSON.stringify([...(pairing._debugKeys?.() ?? [])]);
  assert.ok(!dump.includes(m.code));
  assert.ok(pairing._debugKeys().every((k) => /^[0-9a-f]{64}$/.test(k)));
});

// Guard rule: the pairing code is the credential for exactly one route.
const guard = (extra) => checkAccess({ remoteAddress: '100.64.0.9', method: 'POST', pathname: '/api/tap/pair', token: 'shared', ...extra });
test('guard: an un-tokened remote may POST /api/tap/pair and nothing next to it', () => {
  assert.equal(TAP_PAIR_ROUTE, '/api/tap/pair');
  assert.deepEqual(guard({}), { allow: true });
  assert.equal(guard({ method: 'GET' }).status, 401);
  assert.equal(guard({ pathname: '/api/tap/pair-code' }).status, 401);
  assert.equal(guard({ pathname: '/api/clients/cli_x/rotate' }).status, 401);
  assert.deepEqual(guard({ presentedToken: 'shared' }), { allow: true });
  const d = guard({ presentedToken: 'ct', clientCert: { fingerprint256: 'ab', authorized: true }, authenticateClient: (t) => (t === 'ct' ? { id: 'cli_1', certSha256: 'ab' } : null) });
  assert.deepEqual(d, { allow: false, status: 403, reason: 'client-token-out-of-scope' });
});

// End to end over a real socket: HTTPS from 127.0.0.2 to the private listener takes the remote path.
function mkEnv() {
  const t = tmp('mc-pair-e2e-');
  const claudeDir = path.join(t, 'claude');
  fs.mkdirSync(path.join(claudeDir, '.claude-manager'), { recursive: true });
  fs.writeFileSync(path.join(claudeDir, '.claude-manager', 'active-sessions.json'), '[]');
  return { GLMPS_CLAUDE_DIR: claudeDir, GLMPS_ANTIGRAVITY_DIR: path.join(t, 'ag'), GLMPS_STATE_DIR: path.join(t, 'state'),
    GLMPS_GEMINI_TMP_DIR: path.join(t, 'gemini-tmp'), GLMPS_VSCODE_STORAGE_DIR: path.join(t, 'vscode-storage'),
    GLMPS_AGY_CLI_DIR: path.join(t, 'agy-cli'), GLMPS_CODEX_DIR: path.join(t, 'codex'), GLMPS_COPILOT_CLI_DIR: path.join(t, 'copilot-cli'),
    GLMPS_HERMES_DIR: path.join(t, 'hermes'), GLMPS_OPENCODE_DIR: path.join(t, 'opencode'), GLMPS_UNMERGED_SCAN: 'off',
    GLMPS_ACCESS_TOKEN: 'shared-remote-token' };
}
test('pairing end to end: mint, pair un-tokened, use, single use, rotate, revoke, re-pair', async () => {
  const env = mkEnv();
  const bind = privateBind({ stateDir: env.GLMPS_STATE_DIR, configFile: path.join(path.dirname(env.GLMPS_STATE_DIR), 'config.json') });
  const srv = await startServer({ port: 0, pollMs: 1000, env, ...bind.startOpts });
  const remote = (port, o) => remoteHttps(port, { ca: bind.homeCaPem, ...o });
  const keys = tapKeyPair();
  const keys2 = tapKeyPair();
  const SHARED = env.GLMPS_ACCESS_TOKEN;
  try {
    const mint = await remote(srv.port, { method: 'POST', path: '/api/tap/pair-code', token: SHARED, body: {} });
    assert.equal(mint.status, 201, mint.body);
    assert.equal(mint.json.clientId, null);
    assert.equal(mint.headers['cache-control'], 'no-store');
    const code = mint.json.code;
    // A bad tapVersion is refused before the code is consumed, so the same code still redeems.
    for (const tapVersion of ['', 'x'.repeat(65), 7]) {
      const bad = await remote(srv.port, { method: 'POST', path: '/api/tap/pair', body: { code, name: 'laptop', tapVersion, publicKey: keys.publicKeyPem } });
      assert.equal(bad.status, 400, `${JSON.stringify(tapVersion)}: ${bad.body}`);
      assert.equal(bad.json.error, 'invalid-body');
    }

    const pair = await remote(srv.port, { method: 'POST', path: '/api/tap/pair', body: { code, name: 'laptop', tapVersion: '1.0.0', dataRoots: ['C:/x'], publicKey: keys.publicKeyPem } });
    assert.equal(pair.status, 201, pair.body);
    assert.equal(pair.headers['cache-control'], 'no-store');
    const { clientId, token } = pair.json;
    const me = { cert: pair.json.certificate, key: keys.privateKeyPem };
    assert.equal(pair.json.repaired, false);
    assert.equal((await remote(srv.port, { path: '/api/sessions/live', token, client: me })).status, 200);

    const reuse = await remote(srv.port, { method: 'POST', path: '/api/tap/pair', body: { code, name: 'laptop', publicKey: keys.publicKeyPem } });
    assert.equal(reuse.status, 401);
    assert.equal(reuse.json.error, 'invalid-code');

    const rot = await remote(srv.port, { method: 'POST', path: `/api/clients/${clientId}/rotate`, token: SHARED, body: { publicKey: keys2.publicKeyPem } });
    assert.equal(rot.status, 200, rot.body);
    assert.equal(rot.headers['cache-control'], 'no-store');
    assert.equal((await remote(srv.port, { path: '/api/sessions/live', token, client: me })).status, 401, 'old token is dead');
    const me2 = { cert: rot.json.certificate, key: keys2.privateKeyPem };
    assert.equal((await remote(srv.port, { path: '/api/sessions/live', token: rot.json.token, client: me2 })).status, 200);
    assert.equal((await remote(srv.port, { method: 'POST', path: '/api/clients/cli_nope/rotate', token: SHARED, body: { publicKey: keys2.publicKeyPem } })).status, 404);

    const rev = await remote(srv.port, { method: 'POST', path: `/api/clients/${clientId}/revoke`, token: SHARED, body: { reason: 'lost laptop' } });
    assert.equal(rev.status, 200, rev.body);
    assert.equal(rev.json.paired, false);
    assert.equal((await remote(srv.port, { path: '/api/sessions/live', token: rot.json.token, client: me2 })).status, 401);
    assert.equal((await remote(srv.port, { method: 'POST', path: `/api/clients/${clientId}/rotate`, token: SHARED, body: { publicKey: keys2.publicKeyPem } })).status, 409);
    assert.equal((await remote(srv.port, { method: 'POST', path: '/api/clients/cli_nope/revoke', token: SHARED, body: {} })).status, 404);

    const re = await remote(srv.port, { method: 'POST', path: '/api/tap/pair-code', token: SHARED, body: { clientId } });
    assert.equal(re.status, 201);
    assert.equal(re.json.clientId, clientId);
    const back = await remote(srv.port, { method: 'POST', path: '/api/tap/pair', body: { code: re.json.code, name: 'laptop', publicKey: keys.publicKeyPem } });
    assert.equal(back.status, 201);
    assert.equal(back.json.clientId, clientId);
    assert.equal(back.json.repaired, true);
    const me3 = { cert: back.json.certificate, key: keys.privateKeyPem };
    assert.equal((await remote(srv.port, { path: '/api/sessions/live', token: back.json.token, client: me3 })).status, 200);
    assert.equal((await remote(srv.port, { method: 'POST', path: '/api/tap/pair-code', token: SHARED, body: { clientId: 'cli_nope' } })).status, 404);

    assert.equal((await remote(srv.port, { method: 'POST', path: '/api/tap/pair-code', body: {} })).status, 401, 'no token');
    assert.equal((await remote(srv.port, { method: 'POST', path: '/api/tap/pair-code', token: back.json.token, client: me3, body: {} })).status, 403, 'client token');
    assert.equal((await remote(srv.port, { method: 'POST', path: '/api/tap/pair', body: '[]' })).status, 400);
  } finally { await srv.close(); }
});
