// Routes under test: server/lib/routes/tap-routes.js
// server/test/tap-setup-lib.test.js
// Server-and-client-tap task 7: the installer's pure parts and the filename that carries the server URL.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installerFileName, serverUrlFromInstaller, serverUrlFromHost } from '../lib/kernel/tap-installer-name.js';
import { parseArgs, resolveServer, normalizeCode, normalizeName, pairRequest, pairRefusalText, listeningPid, imageFromTasklist, portDecision } from '../../taps/tap-setup-lib.js';
import { TAP_PROTOCOL_HEADER } from '../lib/kernel/tap-protocol.js';

test('the installer filename round-trips a server URL', () => {
  for (const url of ['http://glmps:8123', 'http://glmps.tail1234.ts.net:8123', 'http://100.101.102.103:8123', 'https://box.example:443']) {
    const name = installerFileName(url);
    assert.match(name, /^glmps-tap-setup_https?_[A-Za-z0-9.-]+_\d+\.exe$/);
    assert.deepEqual(serverUrlFromInstaller(`C:\\Users\\me\\Downloads\\${name}`), { ok: true, server: url });
  }
  assert.equal(installerFileName('http://glmps'), 'glmps-tap-setup_http_glmps_80.exe');
});

test('a browser duplicate suffix still parses; anything else names no server', () => {
  assert.equal(serverUrlFromInstaller('glmps-tap-setup_http_glmps_8123 (1).exe').server, 'http://glmps:8123');
  assert.equal(serverUrlFromInstaller('glmps-tap-setup_http_glmps_8123 - Copy.exe').server, 'http://glmps:8123');
  for (const bad of ['glmps-tap-setup.exe', 'setup.exe', 'glmps-tap-setup_ftp_glmps_21.exe', 'glmps-tap-setup_http_glmps_99999.exe', 'glmps-tap-setup_http_-bad_8123.exe', '']) {
    const r = serverUrlFromInstaller(bad);
    assert.equal(r.ok, false, bad);
    assert.match(r.reason, /server/);
  }
});

test('installerFileName refuses a host a filename cannot carry', () => {
  assert.throws(() => installerFileName('http://[::1]:8123'), /cannot be carried/);
  assert.throws(() => installerFileName('ftp://glmps:21'), /unsupported scheme/);
});

test('serverUrlFromHost takes a hostname and port from the Host header and rejects anything else', () => {
  assert.equal(serverUrlFromHost('GLMPS:8123'), 'http://glmps:8123');
  assert.equal(serverUrlFromHost('100.64.0.7:8123'), 'http://100.64.0.7:8123');
  assert.equal(serverUrlFromHost('glmps'), 'http://glmps:80');
  for (const bad of [undefined, '', '[::1]:8123', 'a b', 'glmps:0', 'glmps:70000', 'evil.com/x', 'glmps:8123@x']) assert.equal(serverUrlFromHost(bad), null, String(bad));
});

test('parseArgs reads flags, refuses unknown ones and checks the port', () => {
  assert.deepEqual(parseArgs(['--installer', 'C:\\x.exe', '--code', 'abcd2345', '--no-start']).opts, { port: 8123, installer: 'C:\\x.exe', code: 'abcd2345', noStart: true });
  assert.equal(parseArgs(['--port', '18123']).opts.port, 18123);
  assert.match(parseArgs(['--bogus']).reason, /unknown flag '--bogus'/);
  assert.match(parseArgs(['--code']).reason, /--code needs a value/);
  assert.match(parseArgs(['--port', '0']).reason, /--port must be/);
  assert.equal(parseArgs(['--uninstall']).opts.uninstall, true);
});

test('resolveServer prefers --server, else the installer filename', () => {
  assert.equal(resolveServer({ server: 'https://192.168.1.9:9000/', installer: 'glmps-tap-setup_https_192.168.1.5_8123.exe' }).server, 'https://192.168.1.9:9000');
  assert.equal(resolveServer({ installer: 'glmps-tap-setup_https_192.168.1.5_8123.exe' }).server, 'https://192.168.1.5:8123');
  assert.equal(resolveServer({ installer: 'glmps-tap-setup_https_box.glmps.internal_443.exe' }).server, 'https://box.glmps.internal:443');
  assert.equal(resolveServer({}).ok, false);
  assert.equal(resolveServer({ server: 'ftp://x' }).ok, false);
});

test('resolveServer refuses plain http off loopback, from --server or the installer name (scan F7)', () => {
  for (const server of ['http://box:9000', 'http://192.168.1.5:8123', 'http://glmps.example.com:8123', 'http://100.64.0.7:8123', 'http://glmps.tail1.ts.net:8123']) {
    const r = resolveServer({ server });
    assert.equal(r.ok, false, server);
    assert.match(r.reason, /https/, server);
  }
  for (const installer of ['glmps-tap-setup_http_glmps_8123.exe', 'glmps-tap-setup_http_192.168.1.5_8123.exe']) {
    assert.equal(resolveServer({ installer }).ok, false, installer);
  }
  for (const server of ['http://127.0.0.1:9000', 'https://192.168.1.5:8123', 'https://10.0.0.4:8123', 'https://[fd00::5]:8123', 'https://glmps.internal:8123', 'https://box.glmps.internal:8123']) {
    assert.equal(resolveServer({ server }).ok, true, server);
  }
});

test('card glmps-2-0-152: https only to a private address or a glmps.internal name, never off the local network', () => {
  for (const server of ['https://box:9000', 'https://glmps.example.com', 'https://8.8.8.8:8123', 'https://100.64.0.7:8123', 'https://glmps.tail1.ts.net', 'https://glmps.internal.evil.com', 'https://[2001:db8::1]:8123']) {
    const r = resolveServer({ server });
    assert.equal(r.ok, false, server);
    assert.match(r.reason, /private address|glmps\.internal/, server);
  }
});

test('codes and names are normalised the way the server reads them', () => {
  assert.equal(normalizeCode(' abcd-2345 '), 'ABCD2345');
  assert.equal(normalizeCode('abcd234'), null);
  assert.equal(normalizeCode('ABCDE1O0'), null); // 1, O and 0 are not in the alphabet
  assert.equal(normalizeName('', 'DESKTOP-1'), 'DESKTOP-1');
  assert.equal(normalizeName('  laptop '), 'laptop');
  assert.equal(normalizeName('x'.repeat(65)), null);
  assert.equal(normalizeName('a\nb'), null);
});

test('the pair request carries the protocol header and no token', () => {
  const r = pairRequest({ server: 'http://glmps:8123', code: 'ABCD2345', name: 'laptop', tapVersion: '0.1.0' });
  assert.equal(r.url, 'http://glmps:8123/api/tap/pair');
  assert.equal(r.headers[TAP_PROTOCOL_HEADER], '1');
  assert.equal(r.headers.authorization, undefined);
  assert.deepEqual(JSON.parse(r.body), { code: 'ABCD2345', name: 'laptop', tapVersion: '0.1.0' });
  assert.match(pairRefusalText(401, { error: 'invalid-code' }), /mint a new code/);
  assert.match(pairRefusalText(429, {}), /wait a minute/);
});

const NETSTAT = `
Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1204
  TCP    127.0.0.1:8123         0.0.0.0:0              LISTENING       4410
  TCP    127.0.0.1:8123         127.0.0.1:50122        ESTABLISHED     4410
  TCP    [::]:18123             [::]:0                 LISTENING       77
`;

test('the port holder is read from netstat and tasklist', () => {
  assert.equal(listeningPid(NETSTAT, 8123), 4410);
  assert.equal(listeningPid(NETSTAT, 18123), 77);
  assert.equal(listeningPid(NETSTAT, 9999), null);
  assert.equal(imageFromTasklist('"node.exe","4410","Services","0","61,224 K"\r\n'), 'node.exe');
  assert.equal(imageFromTasklist('INFO: No tasks are running which match the specified criteria.'), null);
});

test('a port held by another program refuses and names it; our own agent does not', () => {
  assert.deepEqual(portDecision({ port: 8123, pid: null }), { ok: true, ownAgent: false });
  const clash = portDecision({ port: 8123, pid: 4410, image: 'node.exe', agentStatus: null });
  assert.equal(clash.ok, false);
  assert.match(clash.reason, /port 8123 is already in use by node\.exe \(pid 4410\)/);
  assert.deepEqual(portDecision({ port: 8123, pid: 4410, image: 'node.exe', agentStatus: { agent: 'glmps-tap' } }), { ok: true, ownAgent: true });
});
