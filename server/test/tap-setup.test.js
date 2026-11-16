// Routes under test: server/lib/routes/tap-routes.js
// server/test/tap-setup.test.js
// Server-and-client-tap task 7: the installer's flow, with every system call injected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runSetup } from '../../taps/tap-setup.mjs';
import { tapKeyPair } from '../../taps/tap-tls.js';
import { createCa, issueClientCert, certFingerprint } from '../lib/kernel/x509-lite.js';
import { LOGON_TASK_NAME } from '../../taps/tap-logon-task.js';

const T = 'C74BBD54C1211B9386A27E2904D2463908B6F9E9';
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const INSTALLER = 'C:\\Users\\me\\Downloads\\glmps-tap-setup_https_192.168.50.10_8123.exe';

function payload() {
  const dir = tmp('mc-tapsetup-src-');
  fs.mkdirSync(path.join(dir, 'scripts'));
  fs.mkdirSync(path.join(dir, 'taps'));
  fs.writeFileSync(path.join(dir, 'node.exe'), 'node');
  fs.writeFileSync(path.join(dir, 'scripts', 'install.mjs'), '');
  fs.writeFileSync(path.join(dir, 'taps', 'tap-agent.js'), '');
  fs.writeFileSync(path.join(dir, 'tap.cat'), 'cat');
  fs.writeFileSync(path.join(dir, 'signer.json'), JSON.stringify({ thumbprint: T, mode: 'test' }));
  return dir;
}

const NETSTAT_HELD = '  TCP    127.0.0.1:8123   0.0.0.0:0   LISTENING   4410\n';

// The server's chain and the certificate it issues, real so the installer can parse them.
const CA = createCa({ cn: 'GLMPS Test CA', days: 30 });
const OTHER_CA = createCa({ cn: 'Impostor CA', days: 30 });
const FP = certFingerprint(CA.certPem);
const KEYS = tapKeyPair();
const CLIENT_CERT = issueClientCert({ caCertPem: CA.certPem, caKeyPem: CA.keyPem, publicKeyPem: KEYS.publicKeyPem, clientId: 'cli_1' });
const PAIRED = { clientId: 'cli_1', token: 'tok-secret', repaired: false, certificate: CLIENT_CERT.certPem, certificateExpiresAt: CLIENT_CERT.notAfter };

function deps({ netstat = '', tasklist = '"node.exe","4410","Services","0","1 K"', pair = { status: 201, body: PAIRED }, status = { agent: 'glmps-tap', state: 'paired' }, verifyResult, installStatus = 0, env = {}, task = { state: 'absent' }, chain = [CA.certPem] } = {}) {
  const calls = [];
  const lines = [];
  const home = tmp('mc-tapsetup-home-');
  let agentUp = false;
  const d = {
    home, env, calls, lines, platform: 'win32',
    payloadRoot: payload(),
    log: (m) => lines.push(m),
    sleep: async () => {},
    prompt: async (q) => { calls.push(['prompt', q]); return q.startsWith('Pairing') ? 'abcd-2345' : q.startsWith('Server fingerprint') ? FP.toUpperCase().replace(/(.{4})/g, '$1 ') : ''; },
    probeChain: async (url) => { calls.push(['probe', url]); return chain; },
    generateKeyPair: () => KEYS,
    writeClientKey: (h, k) => calls.push(['key', h, k]),
    verify: () => verifyResult ?? { catalog: 'Valid', signature: 'UnknownError', thumbprint: T, subject: 'CN=GLMPS Tap Test Signing', missing: [], extra: [], changed: [] },
    writeToken: (h, t) => calls.push(['token', h, t]),
    currentUserSid: () => 'S-1-5-21-1',
    queryTaskXml: () => task,
    createTask: (xml) => { calls.push(['createTask', xml]); return { ok: true }; },
    run: (cmd, args) => {
      calls.push([cmd, ...args]);
      if (cmd === 'netstat.exe') return { status: 0, stdout: agentUp ? '' : netstat };
      if (cmd === 'tasklist.exe') return { status: 0, stdout: tasklist };
      // Like the real task: /End leaves node.exe on the port; only taskkill frees it.
      if (cmd === 'taskkill.exe') { agentUp = true; return { status: 0 }; }
      if (cmd.endsWith('node.exe')) return { status: installStatus };
      return { status: 0, stdout: '' };
    },
    fetch: async (url, init) => {
      calls.push(['fetch', url, init?.method ?? 'GET', init?.body ?? null, init?.tls ?? null]);
      if (url.endsWith('/api/tap/pair')) return { status: pair.status, json: async () => pair.body };
      if (url.endsWith('/tap/status')) return status ? { ok: true, json: async () => status } : { ok: false };
      throw new Error('unexpected fetch');
    },
  };
  return d;
}

test('a fresh install pairs with the server in its filename, stores the token, installs hooks and starts the agent', async () => {
  const d = deps({ env: { COMPUTERNAME: 'TAP-BOX' } });
  const r = await runSetup(['--installer', INSTALLER], d);
  assert.deepEqual(r, { ok: true, clientId: 'cli_1', home: d.home, task: 'started', state: 'paired' });
  const pair = d.calls.find((c) => c[0] === 'fetch' && c[1].endsWith('/api/tap/pair'));
  assert.equal(pair[1], 'https://192.168.50.10:8123/api/tap/pair');
  assert.deepEqual(JSON.parse(pair[3]), { code: 'ABCD2345', name: 'TAP-BOX', tapVersion: '0.1.0', publicKey: KEYS.publicKeyPem });
  assert.deepEqual(pair[4], { ca: CA.certPem }, 'the pair request trusts only the pinned CA');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(d.home, 'tap-config.json'), 'utf8')), { server: 'https://192.168.50.10:8123', clientId: 'cli_1', name: 'TAP-BOX', port: 8123, trustFingerprint: FP });
  assert.equal(fs.readFileSync(path.join(d.home, 'server-ca.pem'), 'utf8'), CA.certPem);
  assert.equal(fs.readFileSync(path.join(d.home, 'client-cert.pem'), 'utf8'), CLIENT_CERT.certPem);
  assert.deepEqual(d.calls.find((c) => c[0] === 'key'), ['key', d.home, KEYS.privateKeyPem], 'the private key goes to the DPAPI store');
  const files = fs.readdirSync(d.home).map((f) => path.join(d.home, f)).filter((f) => fs.statSync(f).isFile());
  assert.equal(files.some((f) => fs.readFileSync(f, 'utf8').includes('PRIVATE KEY')), false, 'no plaintext key file in the tap home');
  assert.equal(pair[3].includes('PRIVATE KEY'), false, 'AC-3: the pair body carries only the public key');
  assert.equal(d.lines.join('\n').includes('PRIVATE KEY'), false, 'AC-3: the key never reaches the log');
  assert.ok(fs.existsSync(path.join(d.home, 'node.exe')), 'payload copied into the tap home');
  assert.deepEqual(d.calls.find((c) => c[0] === 'token'), ['token', d.home, 'tok-secret']);
  assert.ok(d.calls.some((c) => c[0] === path.join(d.home, 'node.exe') && c[1] === path.join(d.home, 'scripts', 'install.mjs') && c.length === 2), 'existing installer run from the tap home with no flags');
  const xml = d.calls.find((c) => c[0] === 'createTask')[1];
  assert.match(xml, /conhost\.exe/);
  assert.ok(xml.includes(path.join(d.home, 'taps', 'tap-agent.js')));
  assert.ok(d.calls.some((c) => c[0] === 'schtasks.exe' && c[1] === '/Run' && c[3] === LOGON_TASK_NAME));
  assert.equal(d.lines.join('\n').includes('tok-secret'), false, 'the token never reaches the log');
});

// The installer reads only its injected env, so the real process COMPUTERNAME
// (which can differ from os.hostname() in case) must not leak into the expectation.
test('with no COMPUTERNAME in its env the client name falls back to the hostname', async () => {
  const d = deps({ env: {} });
  await runSetup(['--installer', INSTALLER], d);
  const pair = d.calls.find((c) => c[0] === 'fetch' && c[1].endsWith('/api/tap/pair'));
  assert.equal(JSON.parse(pair[3]).name, os.hostname());
});

test('a port held by another program refuses before pairing and names the program', async () => {
  const d = deps({ netstat: NETSTAT_HELD, status: null });
  await assert.rejects(runSetup(['--installer', INSTALLER, '--code', 'ABCD2345'], d), /port 8123 is already in use by node\.exe \(pid 4410\)/);
  assert.equal(d.calls.some((c) => c[0] === 'fetch' && c[1].endsWith('/api/tap/pair')), false);
  assert.equal(d.calls.some((c) => c[0] === 'token'), false);
});

test('our own agent on the port is stopped and replaced, not refused', async () => {
  const d = deps({ netstat: NETSTAT_HELD });
  const r = await runSetup(['--installer', INSTALLER, '--code', 'ABCD2345', '--name', 'laptop'], d);
  assert.equal(r.ok, true);
  const end = d.calls.findIndex((c) => c[0] === 'schtasks.exe' && c[1] === '/End');
  const kill = d.calls.findIndex((c) => c[0] === 'taskkill.exe');
  const token = d.calls.findIndex((c) => c[0] === 'token');
  assert.ok(end > 0 && end < kill && kill < token, 'the old agent stops before the new token lands');
  assert.deepEqual(d.calls[kill], ['taskkill.exe', '/PID', '4410', '/T', '/F']);
});

test('a payload that fails its signature check stops before anything is written', async () => {
  const d = deps({ verifyResult: { catalog: 'ValidationFailed', signature: 'UnknownError', thumbprint: T, changed: ['hooks\\plan-gate.js'] } });
  await assert.rejects(runSetup(['--installer', INSTALLER, '--code', 'ABCD2345'], d), /failed its signature check: 1 file\(s\) differ/);
  assert.equal(d.calls.some((c) => c[0] === 'fetch'), false);
  assert.equal(fs.readdirSync(d.home).length, 0);
});

test('a refused code, a bad code and an unnamed server each stop with a named reason', async () => {
  await assert.rejects(runSetup(['--installer', INSTALLER, '--code', 'ABCD2345'], deps({ pair: { status: 401, body: { error: 'invalid-code' } } })), /mint a new code/);
  await assert.rejects(runSetup(['--installer', INSTALLER, '--code', 'nope'], deps()), /not a pairing code/);
  await assert.rejects(runSetup(['--installer', 'C:\\setup.exe'], deps()), /does not name a server/);
  await assert.rejects(runSetup(['--server', 'http://127.0.0.1:8123'], deps()), /own tap port/);
});

test('AC-1: a server whose chain lacks the pinned fingerprint is refused before the code or any key is sent', async () => {
  const d = deps({ chain: [OTHER_CA.certPem] });
  await assert.rejects(runSetup(['--installer', INSTALLER, '--code', 'ABCD2345', '--name', 'laptop'], d), /may not be your GLMPS server, so nothing was sent/);
  assert.equal(d.calls.some((c) => c[0] === 'fetch' && c[1].endsWith('/api/tap/pair')), false, 'no pair request went out');
  assert.equal(d.calls.some((c) => c[0] === 'token' || c[0] === 'key'), false);
  assert.equal(fs.readdirSync(d.home).length, 0, 'nothing written');
  await assert.rejects(runSetup(['--installer', INSTALLER, '--code', 'ABCD2345', '--fingerprint', 'abc'], deps()), /not a server fingerprint/);
});

test('--fingerprint skips the prompt; a plain-http loopback server needs no fingerprint and pins nothing', async () => {
  const a = deps();
  await runSetup(['--installer', INSTALLER, '--code', 'ABCD2345', '--name', 'laptop', '--fingerprint', FP], a);
  assert.equal(a.calls.some((c) => c[0] === 'prompt' && c[1].startsWith('Server fingerprint')), false);
  const b = deps({ env: { GLMPS_TAP_HOME: 'x' } });
  await runSetup(['--server', 'http://127.0.0.1:18123', '--code', 'ABCD2345', '--name', 'laptop'], b);
  assert.equal(b.calls.some((c) => c[0] === 'probe'), false);
  const pair = b.calls.find((c) => c[0] === 'fetch' && c[1].endsWith('/api/tap/pair'));
  assert.equal(pair[4], null, 'loopback http carries no tls options');
  assert.equal(fs.existsSync(path.join(b.home, 'server-ca.pem')), false);
});

test('a pairing answer without a client certificate stops before anything is stored', async () => {
  const d = deps({ pair: { status: 201, body: { clientId: 'cli_1', token: 'tok-secret' } } });
  await assert.rejects(runSetup(['--installer', INSTALLER, '--code', 'ABCD2345', '--name', 'laptop'], d), /issued no client certificate/);
  assert.equal(d.calls.some((c) => c[0] === 'token'), false);
});

test('a failing hooks install stops before the logon task', async () => {
  const d = deps({ installStatus: 2 });
  await assert.rejects(runSetup(['--installer', INSTALLER, '--code', 'ABCD2345'], d), /hooks and statusline failed \(exit 2\)/);
  assert.equal(d.calls.some((c) => c[0] === 'createTask'), false);
});

test('--no-start registers the task without running it; GLMPS_TAP_HOME skips the task', async () => {
  const a = deps();
  assert.equal((await runSetup(['--installer', INSTALLER, '--code', 'ABCD2345', '--no-start'], a)).task, 'registered');
  assert.equal(a.calls.some((c) => c[1] === '/Run'), false);
  const b = deps({ env: { GLMPS_TAP_HOME: 'x' } });
  assert.equal((await runSetup(['--installer', INSTALLER, '--code', 'ABCD2345'], b)).task, 'skipped');
  assert.equal(b.calls.some((c) => c[0] === 'createTask'), false);
});

test('--uninstall runs the existing installer in reverse, stops the agent on its configured port and deletes the task', async () => {
  const d = deps({ netstat: '  TCP    127.0.0.1:18123   0.0.0.0:0   LISTENING   4410\n' });
  fs.writeFileSync(path.join(d.home, 'tap-config.json'), JSON.stringify({ port: 18123 }));
  fs.writeFileSync(path.join(d.home, 'node.exe'), 'node');
  await runSetup(['--uninstall'], d);
  assert.ok(d.calls.some((c) => c[0] === path.join(d.home, 'node.exe') && c[2] === '--uninstall'));
  assert.ok(d.calls.some((c) => c[0] === 'schtasks.exe' && c[1] === '/Delete' && c[3] === LOGON_TASK_NAME));
  assert.ok(d.calls.some((c) => c[0] === 'taskkill.exe' && c[2] === '4410'));
});

test('a port holder that is not the tap agent is never killed', async () => {
  const d = deps({ netstat: NETSTAT_HELD, status: null });
  fs.writeFileSync(path.join(d.home, 'node.exe'), 'node');
  await runSetup(['--uninstall'], d);
  assert.equal(d.calls.some((c) => c[0] === 'taskkill.exe'), false);
});
