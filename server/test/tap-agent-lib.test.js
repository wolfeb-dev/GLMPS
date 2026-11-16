// Routes under test: server/lib/routes/tap-routes.js
// server/test/tap-agent-lib.test.js
// Tap agent skeleton (card glmps-2-0-runtime-31): the agent's pure library.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tapHome, readConfig, serverUrlPolicy, DEFAULT_PORT, heartbeatRequest, detectTools, classifyHeartbeat, statusDocument } from '../../taps/tap-agent-lib.js';
import { TAP_PROTOCOL_HEADER, TAP_PROTOCOL } from '../lib/kernel/tap-protocol.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mc-tapagent-'));

test('tapHome: GLMPS_TAP_HOME wins, then LOCALAPPDATA, then the home directory default', () => {
  assert.equal(tapHome({ GLMPS_TAP_HOME: 'X:/t', LOCALAPPDATA: 'C:/L' }), 'X:/t');
  assert.equal(tapHome({ LOCALAPPDATA: 'C:/L' }), path.join('C:/L', 'GLMPS', 'tap'));
  assert.equal(tapHome({}, 'C:/Users/u'), path.join('C:/Users/u', 'AppData', 'Local', 'GLMPS', 'tap'));
});

test('readConfig: missing and unparsable files are named, the port defaults to the relay port', () => {
  const home = tmp();
  assert.deepEqual(readConfig(home), { ok: false, reason: 'no-config' });
  fs.writeFileSync(path.join(home, 'tap-config.json'), '{nope');
  assert.deepEqual(readConfig(home), { ok: false, reason: 'invalid-config' });
  fs.writeFileSync(path.join(home, 'tap-config.json'), JSON.stringify({ server: 'https://192.168.50.10:8123', clientId: 'cli_1', name: 'laptop' }));
  assert.equal(DEFAULT_PORT, 8123);
  assert.deepEqual(readConfig(home, {}), { ok: true, config: { server: 'https://192.168.50.10:8123', clientId: 'cli_1', name: 'laptop', port: 8123, projectRoots: [], editorCommand: 'antigravity', editorArgs: ['-g', '{path}'] } });
  fs.writeFileSync(path.join(home, 'tap-config.json'), JSON.stringify({ server: 'https://10.0.0.7:8123/', clientId: 'cli_1', name: 'laptop', port: 9001 }));
  assert.deepEqual(readConfig(home, {}).config, { server: 'https://10.0.0.7:8123', clientId: 'cli_1', name: 'laptop', port: 9001, projectRoots: [], editorCommand: 'antigravity', editorArgs: ['-g', '{path}'] });
});

test('readConfig: projectRoots come from the config, else GLMPS_PROJECT_ROOTS; relative entries drop; editor settings default', () => {
  const home = tmp();
  const base = { server: 'https://192.168.50.10:8123', clientId: 'cli_1', name: 'n' };
  fs.writeFileSync(path.join(home, 'tap-config.json'), JSON.stringify({ ...base, projectRoots: ['C:/Work', 'rel/x', ' /home/u/p ', 5], editorCommand: 'code', editorArgs: ['--goto', '{path}'] }));
  const c = readConfig(home, { GLMPS_PROJECT_ROOTS: 'D:/ignored' }).config;
  assert.deepEqual(c.projectRoots, ['C:/Work', '/home/u/p']);
  assert.equal(c.editorCommand, 'code'); assert.deepEqual(c.editorArgs, ['--goto', '{path}']);
  fs.writeFileSync(path.join(home, 'tap-config.json'), JSON.stringify(base));
  assert.deepEqual(readConfig(home, { GLMPS_PROJECT_ROOTS: 'D:/a; /b ,,rel' }).config.projectRoots, ['D:/a', '/b']);
  assert.deepEqual(readConfig(home, {}).config.projectRoots, []);
});

test('readConfig: a missing or bad server url, one that is the agent itself, a bad port or missing client id is invalid', () => {
  const home = tmp();
  fs.writeFileSync(path.join(home, 'tap-config.json'), JSON.stringify({ clientId: 'cli_1', name: 'n' }));
  assert.deepEqual(readConfig(home), { ok: false, reason: 'invalid-config' }, 'no server');
  for (const bad of [{ server: 'http://127.0.0.1:8123' }, { server: 'http://localhost:8123/' }, { server: 'http://127.0.0.1:9001', port: 9001 }, { server: 'ftp://x' }, { server: 'not a url' }, { port: 0 }, { port: 70000 }, { port: '80' }, { clientId: '' }, { name: 5 }]) {
    fs.writeFileSync(path.join(home, 'tap-config.json'), JSON.stringify({ server: 'https://192.168.50.10:8123', clientId: 'cli_1', name: 'n', ...bad }));
    assert.deepEqual(readConfig(home), { ok: false, reason: 'invalid-config' }, JSON.stringify(bad));
  }
});

// Scan F7 (card glmps-2-0-runtime-107) and card glmps-2-0-152: the bearer token never crosses plain HTTP off loopback, and never leaves the local network.
const TRANSPORT_OK = ['http://127.0.0.1:9000', 'http://localhost:9000', 'http://[::1]:9000', 'https://10.0.0.7:8123', 'https://192.168.1.5:8443', 'https://172.16.4.4:8123', 'https://[fd12:3456::1]:8123', 'https://glmps.internal:8123', 'https://box.glmps.internal', 'https://BOX.GLMPS.INTERNAL.:8123'];
const TRANSPORT_REFUSED = ['http://glmps:8123', 'http://192.168.1.5:8123', 'http://10.0.0.2:8123', 'http://100.64.0.1:8123', 'http://glmps.tail1234.ts.net:8123', 'http://glmps.example.com:8123', 'http://[fe80::1]:8123', 'https://glmps.example.com', 'https://8.8.8.8:8123', 'https://100.64.0.1:8123', 'https://glmps.tail1234.ts.net', 'https://glmps.internal.evil.com', 'https://[fe80::1]:8123'];

test('serverUrlPolicy: plain http only to loopback, https only to a private address or a glmps.internal name', () => {
  for (const u of TRANSPORT_OK) assert.equal(serverUrlPolicy(new URL(u)).ok, true, u);
  for (const u of TRANSPORT_REFUSED) {
    const r = serverUrlPolicy(new URL(u));
    assert.equal(r.ok, false, u);
    assert.match(r.reason, /https|private address/, u);
  }
});

test('readConfig: a server off loopback over plain http, or off the local network, is refused as insecure-server, before any token is used', () => {
  const home = tmp();
  for (const server of TRANSPORT_REFUSED) {
    fs.writeFileSync(path.join(home, 'tap-config.json'), JSON.stringify({ server, clientId: 'cli_1', name: 'n' }));
    const r = readConfig(home, {});
    assert.equal(r.ok, false, server);
    assert.equal(r.reason, 'insecure-server', server);
    assert.equal(r.config, undefined, server);
  }
  for (const server of TRANSPORT_OK) {
    fs.writeFileSync(path.join(home, 'tap-config.json'), JSON.stringify({ server, clientId: 'cli_1', name: 'n', port: 18123 }));
    assert.equal(readConfig(home, {}).ok, true, server);
  }
});

test('heartbeatRequest: url, bearer token, protocol header and a body that never carries a client id', () => {
  const config = { server: 'https://10.0.0.7:8123', clientId: 'cli_1', name: 'laptop', port: 8123 };
  const r = heartbeatRequest({ config, token: 'tok', tapVersion: '0.1.0', spoolDepth: 0, dataRoots: ['C:/a'], tools: ['zed'], projectRoots: ['C:/w'] });
  assert.equal(r.url, 'https://10.0.0.7:8123/api/tap/heartbeat');
  assert.equal(r.method, 'POST');
  assert.equal(r.headers.authorization, 'Bearer tok');
  assert.equal(r.headers[TAP_PROTOCOL_HEADER], String(TAP_PROTOCOL));
  assert.equal(r.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(r.body), { tapVersion: '0.1.0', spoolDepth: 0, dataRoots: ['C:/a'], tools: ['zed'], projectRoots: ['C:/w'] });
});

test('detectTools: reports a tool by its config directory under the given home, sorted, never reading inside', () => {
  const home = tmp();
  assert.deepEqual(detectTools(home), []);
  fs.mkdirSync(path.join(home, '.cursor'));
  fs.mkdirSync(path.join(home, '.continue'));
  fs.mkdirSync(path.join(home, '.codeium', 'windsurf'), { recursive: true });
  fs.mkdirSync(path.join(home, 'AppData', 'Roaming', 'Zed'), { recursive: true });
  fs.writeFileSync(path.join(home, '.aider'), 'a file is not a directory');
  assert.deepEqual(detectTools(home), ['continue', 'cursor', 'windsurf', 'zed']);
  fs.rmSync(path.join(home, '.aider'));
  fs.mkdirSync(path.join(home, '.aider'));
  assert.deepEqual(detectTools(home), ['aider', 'continue', 'cursor', 'windsurf', 'zed']);
});

test('classifyHeartbeat: 200 paired, 401 unpaired, 426 protocol-too-old, network error offline, other statuses offline', () => {
  assert.equal(classifyHeartbeat({ status: 200 }).state, 'paired');
  assert.equal(classifyHeartbeat({ status: 401 }).state, 'unpaired');
  assert.equal(classifyHeartbeat({ status: 426 }).state, 'protocol-too-old');
  assert.equal(classifyHeartbeat({ error: 'ECONNREFUSED' }).state, 'offline');
  assert.equal(classifyHeartbeat({ status: 500 }).state, 'offline');
  assert.match(classifyHeartbeat({ status: 500 }).reason, /500/);
  assert.match(classifyHeartbeat({ error: 'ECONNREFUSED' }).reason, /ECONNREFUSED/);
});

test('classifyHeartbeat: a 401 names the server reason, and a certificate refusal marks the certificate refused', () => {
  const refused = classifyHeartbeat({ status: 401, body: { error: 'client-certificate-mismatch' } });
  assert.equal(refused.state, 'unpaired');
  assert.match(refused.reason, /client-certificate-mismatch/);
  assert.equal(refused.certificate, 'refused');
  assert.equal(classifyHeartbeat({ status: 401, body: { error: 'client-must-re-pair' } }).certificate, 'refused');
  const revoked = classifyHeartbeat({ status: 401, body: { error: 'unauthorized' } });
  assert.match(revoked.reason, /revoked|pair this client again/);
  assert.equal(revoked.certificate, undefined);
});

test('statusDocument carries the certificate state and expiry, never the key', () => {
  const doc = statusDocument({ version: '0.1.0', state: 'paired', config: null, certificate: { state: 'ok', notAfter: 7, reason: null }, now: 1 });
  assert.deepEqual(doc.certificate, { state: 'ok', notAfter: 7, reason: null });
  assert.equal(statusDocument({ version: '0.1.0', state: 'paired', config: null, now: 1 }).certificate, null);
});

test('statusDocument: names the state and the facts, and has no field a token could ride in', () => {
  const doc = statusDocument({
    version: '0.1.0', state: 'paired', config: { server: 'http://s:8123', clientId: 'cli_1', name: 'laptop', port: 8123 },
    lastHeartbeatTs: 5, lastError: null, spoolDepth: 0, tools: ['zed'], now: 9,
  });
  assert.deepEqual(doc, {
    ok: true, agent: 'glmps-tap', version: '0.1.0', state: 'paired', reason: null,
    server: 'http://s:8123', clientId: 'cli_1', name: 'laptop',
    protocol: TAP_PROTOCOL, lastHeartbeatTs: 5, spoolDepth: 0, tools: ['zed'], spool: null, shipper: null, mirror: null, actions: null, git: null, certificate: null, now: 9,
  });
  const unconf = statusDocument({ version: '0.1.0', state: 'unconfigured', reason: 'no-config', config: null, now: 1 });
  assert.equal(unconf.state, 'unconfigured');
  assert.equal(unconf.reason, 'no-config');
  assert.equal(unconf.server, null);
  assert.equal(JSON.stringify(doc).toLowerCase().includes('token'), false);
});
