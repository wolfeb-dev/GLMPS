// Routes under test: server/lib/routes/tap-routes.js
// server/test/tap-agent.test.js
// Tap agent skeleton (card glmps-2-0-runtime-31): the agent entry end to end
// against a throwaway server (port 0, temp dirs, an injected token reader so the
// state machine runs on every platform; the --once case uses the real DPAPI file on Windows).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openClientStore } from '../lib/kernel/clients.js';
import { openTapIngest } from '../lib/kernel/tap-ingest.js';
import { startServer } from '../server.js';
import { startAgent } from '../../taps/tap-agent.js';
import { writeToken } from '../../taps/tap-token.js';
import { waitFor } from './helpers/wait-for.js';
import { dbFileFor } from '../lib/state-dir.js';

const AGENT_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'taps', 'tap-agent.js');
const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });
const mkTmp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); tmpDirs.push(d); return d; };

function mkEnv() {
  const tmp = mkTmp('mc-tapagent-srv-');
  const claudeDir = path.join(tmp, 'claude');
  fs.mkdirSync(path.join(claudeDir, '.claude-manager'), { recursive: true });
  fs.writeFileSync(path.join(claudeDir, '.claude-manager', 'active-sessions.json'), '[]');
  return { GLMPS_CLAUDE_DIR: claudeDir, GLMPS_ANTIGRAVITY_DIR: path.join(tmp, 'ag'), GLMPS_STATE_DIR: path.join(tmp, 'state'),
    GLMPS_GEMINI_TMP_DIR: path.join(tmp, 'gemini-tmp'), GLMPS_VSCODE_STORAGE_DIR: path.join(tmp, 'vscode-storage'),
    GLMPS_AGY_CLI_DIR: path.join(tmp, 'agy-cli'), GLMPS_CODEX_DIR: path.join(tmp, 'codex'), GLMPS_COPILOT_CLI_DIR: path.join(tmp, 'copilot-cli'),
    GLMPS_HERMES_DIR: path.join(tmp, 'hermes'), GLMPS_OPENCODE_DIR: path.join(tmp, 'opencode'), GLMPS_UNMERGED_SCAN: 'off' };
}
function mkHome(config) {
  const home = mkTmp('mc-tapagent-home-');
  if (config) fs.writeFileSync(path.join(home, 'tap-config.json'), JSON.stringify(config));
  return home;
}
function getJson(port, p, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p, headers }, (res) => {
      let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(b) }));
    }).on('error', reject);
  });
}
const base = (home, extra = {}) => ({ home, port: 0, homeDir: mkTmp('mc-tapagent-user-'), intervalMs: 3_600_000, log: () => {}, budget: false, ...extra });

async function withPaired(fn) {
  const env = mkEnv();
  const srv = await startServer({ port: 0, pollMs: 1000, env });
  const store = openClientStore({ dbFile: dbFileFor(env.GLMPS_STATE_DIR) });
  try {
    const { clientId, token } = store.pair({ name: 'laptop', actor: 'test' });
    const home = mkHome({ server: `http://127.0.0.1:${srv.port}`, clientId, name: 'laptop' });
    await fn({ srv, store, clientId, token, home, env });
  } finally { store.closeDb(); await srv.close(); }
}

test('paired: the first heartbeat reaches the server and /tap/status reports paired, with no token in it', async () => {
  await withPaired(async ({ store, clientId, token, home }) => {
    const opts = base(home, { readToken: () => token });
    fs.mkdirSync(path.join(opts.homeDir, '.cursor'));
    const agent = await startAgent(opts);
    try {
      assert.equal(agent.address.address, '127.0.0.1', 'loopback only');
      await agent.ready;
      const { status, json } = await getJson(agent.address.port, '/tap/status');
      assert.equal(status, 200);
      assert.equal(json.state, 'paired');
      assert.equal(json.clientId, clientId);
      assert.equal(typeof json.lastHeartbeatTs, 'number');
      assert.deepEqual(json.tools, ['cursor']);
      assert.equal(JSON.stringify(json).includes(token), false);
      const c = store.get(clientId);
      assert.equal(c.tapVersion, json.version);
      assert.deepEqual(c.tools, ['cursor']);
      assert.equal(typeof c.lastSeenTs, 'number');
    } finally { await agent.close(); }
  });
});

test('a revoked token moves the agent to unpaired and it keeps answering', async () => {
  await withPaired(async ({ store, clientId, token, home }) => {
    store.revoke(clientId, { actor: 'test' });
    const agent = await startAgent(base(home, { readToken: () => token }));
    try {
      await agent.ready;
      const { json } = await getJson(agent.address.port, '/tap/status');
      assert.equal(json.state, 'unpaired');
      assert.match(json.reason, /pair/);
      assert.equal((await getJson(agent.address.port, '/tap/status')).status, 200, 'still running');
    } finally { await agent.close(); }
  });
});

test('no token file is unpaired without calling the server; an unreadable one is unpaired with the reason', async () => {
  const calls = [];
  const fetchFn = async (...a) => { calls.push(a); return { status: 200 }; };
  const home = mkHome({ server: 'http://127.0.0.1:1', clientId: 'cli_1', name: 'n' });
  const a1 = await startAgent(base(home, { readToken: () => null, fetch: fetchFn }));
  await a1.ready;
  assert.equal((await getJson(a1.address.port, '/tap/status')).json.state, 'unpaired');
  await a1.close();
  const a2 = await startAgent(base(home, { readToken: () => { throw Object.assign(new Error('unreadable'), { code: 'TAP_TOKEN_UNREADABLE' }); }, fetch: fetchFn }));
  await a2.ready;
  const s2 = (await getJson(a2.address.port, '/tap/status')).json;
  assert.equal(s2.state, 'unpaired');
  assert.match(s2.reason, /unreadable/);
  await a2.close();
  assert.equal(calls.length, 0);
});

test('no config is unconfigured, and nothing is sent', async () => {
  const calls = [];
  const agent = await startAgent(base(mkHome(), { readToken: () => 'x', fetch: async (...a) => { calls.push(a); return { status: 200 }; } }));
  try {
    await agent.ready;
    const { json } = await getJson(agent.address.port, '/tap/status');
    assert.equal(json.state, 'unconfigured');
    assert.equal(json.reason, 'no-config');
    assert.equal(calls.length, 0);
  } finally { await agent.close(); }
});

test('an unreachable server is offline, not a crash', async () => {
  const closed = await new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
  const home = mkHome({ server: `http://127.0.0.1:${closed}`, clientId: 'cli_1', name: 'n' });
  const agent = await startAgent(base(home, { readToken: () => 'tok' }));
  try {
    await agent.ready;
    const { json } = await getJson(agent.address.port, '/tap/status');
    assert.equal(json.state, 'offline');
    assert.match(json.reason, /unreachable/);
  } finally { await agent.close(); }
});

// A stand-in server that records requests and answers a fixed status.
async function fakeServer(status) {
  const seen = [];
  const s = http.createServer((req, res) => { seen.push({ method: req.method, url: req.url, headers: req.headers }); res.writeHead(status, { 'content-type': 'application/json' }); res.end('{}'); });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return { seen, port: s.address().port, close: () => new Promise((r) => s.close(r)) };
}

test('a 426 from the server is surfaced as protocol-too-old; the request carried the token and the protocol header', async () => {
  const fake = await fakeServer(426);
  const home = mkHome({ server: `http://127.0.0.1:${fake.port}`, clientId: 'cli_1', name: 'n' });
  const agent = await startAgent(base(home, { readToken: () => 'tok-123' }));
  try {
    await agent.ready;
    assert.equal((await getJson(agent.address.port, '/tap/status')).json.state, 'protocol-too-old');
    assert.equal(fake.seen[0].url, '/api/tap/heartbeat');
    assert.equal(fake.seen[0].headers.authorization, 'Bearer tok-123');
    assert.equal(fake.seen[0].headers['x-glmps-tap-protocol'], '1');
  } finally { await agent.close(); await fake.close(); }
});

test('the heartbeat repeats on the interval', async () => {
  const fake = await fakeServer(200);
  const home = mkHome({ server: `http://127.0.0.1:${fake.port}`, clientId: 'cli_1', name: 'n' });
  const agent = await startAgent(base(home, { readToken: () => 'tok', intervalMs: 20 }));
  try {
    await agent.ready;
    await waitFor(() => fake.seen.length >= 3, { message: 'three heartbeats' });
  } finally { await agent.close(); await fake.close(); }
});

test('every other path goes to the relay: out of scope is 403, an unconfigured agent answers 503', async () => {
  const agent = await startAgent(base(mkHome()));
  try {
    for (const p of ['/', '/tap/ingest', '/tap/relay/api/state', '/tap/status/x']) {
      const r = await getJson(agent.address.port, p);
      assert.equal(r.status, 403, p);
      assert.equal(r.json.error, 'relay-refused');
    }
    const r = await getJson(agent.address.port, '/api/backlog/c-1/chain');
    assert.equal(r.status, 503);
    assert.equal(r.json.error, 'tap-unconfigured');
  } finally { await agent.close(); }
});

// Scan F10 (card glmps-2-0-runtime-110): a DNS-rebinding page must not read the client id and server URL.
test('/tap/status refuses a foreign Host, an Origin, or a Sec-Fetch-Site header with 403', async () => {
  const agent = await startAgent(base(mkHome({ server: 'http://127.0.0.1:1', clientId: 'cli_secret', name: 'n' }), { readToken: () => null }));
  try {
    await agent.ready;
    const port = agent.address.port;
    const cases = {
      'foreign host': { host: `evil.example:${port}` },
      origin: { origin: 'http://evil.example' },
      'sec-fetch-site': { 'sec-fetch-site': 'cross-site' },
    };
    for (const [name, headers] of Object.entries(cases)) {
      const r = await getJson(port, '/tap/status', headers);
      assert.equal(r.status, 403, name);
      assert.equal(r.json.error, 'relay-refused', name);
      assert.equal(JSON.stringify(r.json).includes('cli_secret'), false, name);
    }
    assert.equal((await getJson(port, '/tap/status', { host: `localhost:${port}` })).status, 200, 'loopback host still served');
  } finally { await agent.close(); }
});

test('a port that is already taken refuses to start with a named error', async () => {
  const holder = net.createServer();
  await new Promise((r) => holder.listen(0, '127.0.0.1', r));
  try {
    await assert.rejects(startAgent(base(mkHome(), { port: holder.address().port })), (e) => e.code === 'TAP_PORT_IN_USE' && /already in use/.test(e.message));
  } finally { await new Promise((r) => holder.close(r)); }
});

test('--once prints the status JSON after one heartbeat and exits (real DPAPI token, Windows only)', { skip: process.platform !== 'win32' }, async () => {
  await withPaired(async ({ token, home }) => {
    writeToken(home, token);
    // Async on purpose: the throwaway server lives in this process and must keep answering.
    const r = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [AGENT_PATH, '--once'], {
        env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, GLMPS_TAP_HOME: home, HOME: home, USERPROFILE: home }, windowsHide: true,
      });
      let stdout = ''; let stderr = '';
      child.stdout.on('data', (d) => { stdout += d; }); child.stderr.on('data', (d) => { stderr += d; });
      const timer = setTimeout(() => { child.kill(); reject(new Error('--once timed out')); }, 60000);
      child.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
    });
    assert.equal(r.status, 0, r.stderr);
    const doc = JSON.parse(r.stdout);
    assert.equal(doc.state, 'paired');
    assert.equal(r.stdout.includes(token), false);
  });
});

test('spool and shipper: records appended on the client land in the server inbox once, through a failed ship', async () => {
  await withPaired(async ({ store, clientId, token, home, env }) => {
    const inbox = openTapIngest({ dbFile: dbFileFor(env.GLMPS_STATE_DIR) });
    let failIngest = 1;
    const ingestCalls = [];
    const flaky = async (url, init) => {
      if (String(url).endsWith('/api/tap/ingest')) {
        ingestCalls.push(JSON.parse(init.body));
        if (failIngest-- > 0) throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNRESET' } });
      }
      return fetch(url, init);
    };
    const agent = await startAgent(base(home, { readToken: () => token, fetch: flaky, shipTickMs: 20 }));
    try {
      await agent.ready;
      for (let i = 0; i < 3; i++) agent.spool.append('hook', { i, sessionId: 's1' });
      await waitFor(() => inbox.records({ clientId }).length === 3, { timeoutMs: 20_000 });
      assert.ok(ingestCalls.length >= 2, 'the first ship failed and was retried after the backoff');
      assert.deepEqual(inbox.records({ clientId }).map((r) => r.payload.i), [0, 1, 2]);
      const { json } = await getJson(agent.address.port, '/tap/status');
      assert.equal(json.spoolDepth, 0);
      assert.equal(json.shipper.state, 'ok');
      assert.equal(typeof json.shipper.lastShipTs, 'number');
      assert.deepEqual(json.spool, { bytes: 0, full: false, dropped: 0 });
      assert.equal(JSON.stringify(json).includes(token), false);
      // The heartbeat now reports the real depth.
      agent.spool.append('hook', { i: 3 });
      await waitFor(() => inbox.records({ clientId }).length === 4, { timeoutMs: 15_000 });
      // The inbox has the record before the agent has handled the ingest reply
      // and trimmed its spool; under load the heartbeat could still report 1.
      await waitFor(async () => (await getJson(agent.address.port, '/tap/status')).json.spoolDepth === 0, { timeoutMs: 15_000, message: 'spool trimmed after ship' });
      await agent.heartbeatOnce();
      assert.equal(store.get(clientId).spoolDepth, 0);
    } finally { await agent.close(); inbox.closeDb(); }
  });
});

test('spool and shipper: close waits for a ship still in flight, not just the latest tick', async () => {
  await withPaired(async ({ token, home }) => {
    let release; let started = false;
    const gate = new Promise((r) => { release = r; });
    const slow = async (url, init) => {
      if (String(url).endsWith('/api/tap/ingest')) { started = true; await gate; }
      return fetch(url, init);
    };
    const agent = await startAgent(base(home, { readToken: () => token, fetch: slow, shipTickMs: 10 }));
    await agent.ready;
    agent.spool.append('hook', { i: 0 });
    await waitFor(() => started, { timeoutMs: 15_000 });
    // Later ticks return 'in-flight' at once; close must still wait for the first.
    await new Promise((r) => setTimeout(r, 50));
    let closed = false;
    const closing = agent.close().then(() => { closed = true; });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(closed, false, 'close returned while the ship was in flight');
    release();
    await closing;
    assert.equal(agent.spool.stats().depth, 0);
  });
});

test('spool and shipper: a revoked client stops shipping and keeps its spool', async () => {
  await withPaired(async ({ store, clientId, token, home, env }) => {
    const inbox = openTapIngest({ dbFile: dbFileFor(env.GLMPS_STATE_DIR) });
    const agent = await startAgent(base(home, { readToken: () => token, shipTickMs: 20 }));
    try {
      await agent.ready;
      store.revoke(clientId, { actor: 'test' });
      agent.spool.append('hook', { kept: true });
      await waitFor(async () => (await getJson(agent.address.port, '/tap/status')).json.shipper.state === 'unpaired', { timeoutMs: 15_000 });
      assert.equal((await getJson(agent.address.port, '/tap/status')).json.spoolDepth, 1);
      assert.equal(inbox.records({ clientId }).length, 0);
    } finally { await agent.close(); inbox.closeDb(); }
  });
});

// Card glmps-2-0-runtime-67: the agent applies a published update when idle.
// The archive bytes are opaque; the injected extractor maps them to a tree, and
// the injected check stands in for Authenticode (tap-updater.test.js covers refusals).
const PIN67 = { thumbprint: 'C74BBD54C1211B9386A27E2904D2463908B6F9E9', mode: 'test', subject: 'CN=GLMPS Tap Test Signing' };
function bundle67(commit) {
  return {
    'taps/tap-agent.js': `agent ${commit}`, 'node.exe': `node ${commit}`, 'package.json': '{}', 'tap.cat': `cat ${commit}`,
    'signer.json': JSON.stringify(PIN67), 'tap-manifest.json': JSON.stringify({ commit, files: { 'taps/tap-agent.js': 'x' } }),
  };
}
const writeTree67 = (dir, files) => { for (const [r, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, r)), { recursive: true }); fs.writeFileSync(path.join(dir, r), c); } };
async function publish67(stateDir, commit) {
  const { RELEASE_DIR, RELEASE_FILE, INSTALLER_FILE, UPDATE_FILE } = await import('../lib/kernel/tap-release.js');
  const crypto = await import('node:crypto');
  const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
  const dir = path.join(stateDir, RELEASE_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const archive = Buffer.from(`zip of ${commit}`);
  const installer = Buffer.from('MZ');
  fs.writeFileSync(path.join(dir, UPDATE_FILE), archive);
  fs.writeFileSync(path.join(dir, INSTALLER_FILE), installer);
  fs.writeFileSync(path.join(dir, RELEASE_FILE), JSON.stringify({ version: '0.2.0', commit, builtAt: 'x', node: 'v', signing: PIN67,
    artifacts: { installer: { file: INSTALLER_FILE, size: installer.length, sha256: sha(installer) }, update: { file: UPDATE_FILE, size: archive.length, sha256: sha(archive) } } }));
  return archive;
}
// One request per connection: an agent that closes right after an update (or a
// 426 answered before its body is read) otherwise leaves a keep-alive socket
// that stalls the throwaway server's close in teardown.
const fetch67 = (url, o = {}) => fetch(url, { ...o, headers: { ...(o.headers || {}), connection: 'close' } });
const update67 = (archive, commit, restarts) => ({
  platform: 'win32',
  extract: (zip, dir) => (fs.readFileSync(zip).equals(archive) ? (writeTree67(dir, bundle67(commit)), { ok: true }) : { error: 'unknown archive' }),
  verify: (dir) => ({ catalog: 'Valid', signature: 'UnknownError', thumbprint: PIN67.thumbprint, subject: PIN67.subject, missing: [], extra: [], changed: [] }),
  restart: async (info) => { restarts.push(info); return { restarting: true }; },
});

test('update: a published release with another commit is fetched with the client token, swapped in and restarted', async () => {
  await withPaired(async ({ token, home, env }) => {
    writeTree67(home, bundle67('aaa1111'));
    const archive = await publish67(env.GLMPS_STATE_DIR, 'bbb2222');
    const restarts = [];
    const agent = await startAgent(base(home, { readToken: () => token, fetch: fetch67, update: { ...update67(archive, 'bbb2222', restarts), payloadRoot: home } }));
    try {
      await agent.ready;
      await waitFor(() => agent.status().update.state === 'applied', { timeoutMs: 10_000 });
      const st = (await getJson(agent.address.port, '/tap/status')).json;
      assert.equal(st.update.state, 'applied', st.update.reason);
      assert.equal(st.update.installedCommit, 'bbb2222');
      assert.equal(fs.readFileSync(path.join(home, 'taps', 'tap-agent.js'), 'utf8'), 'agent bbb2222');
      assert.ok(fs.existsSync(path.join(home, 'tap-config.json')), 'config kept');
      assert.deepEqual(restarts, [{ from: 'aaa1111', to: 'bbb2222' }]);
    } finally { await agent.close(); }
  });
});

test('update: the same commit is current, and an agent run from a checkout never updates', async () => {
  await withPaired(async ({ token, home, env }) => {
    writeTree67(home, bundle67('bbb2222'));
    const archive = await publish67(env.GLMPS_STATE_DIR, 'bbb2222');
    const same = await startAgent(base(home, { readToken: () => token, fetch: fetch67, update: { ...update67(archive, 'bbb2222', []), payloadRoot: home } }));
    try { await same.ready; assert.equal(same.status().update.state, 'current'); } finally { await same.close(); }
    const fromCheckout = await startAgent(base(home, { readToken: () => token, fetch: fetch67 }));
    try { await fromCheckout.ready; assert.equal(fromCheckout.status().update.state, 'disabled'); } finally { await fromCheckout.close(); }
  });
});

test('update: a 426 names the release, and the too-old tap still fetches and applies it with queued work on disk', async () => {
  await withPaired(async ({ token, home, env }) => {
    writeTree67(home, bundle67('aaa1111'));
    const archive = await publish67(env.GLMPS_STATE_DIR, 'ccc3333');
    // This tap speaks protocol 0 on every request, so the server refuses all but the update download.
    const old = (url, o = {}) => fetch67(url, { ...o, headers: { ...(o.headers || {}), 'x-glmps-tap-protocol': '0' } });
    const restarts = [];
    const agent = await startAgent(base(home, { readToken: () => token, fetch: old, update: { ...update67(archive, 'ccc3333', restarts), payloadRoot: home } }));
    try {
      agent.spool.append('event', { n: 1 });
      await agent.ready;
      await waitFor(() => agent.status().update.state === 'applied', { timeoutMs: 10_000 });
      assert.equal(agent.status().state, 'protocol-too-old');
      assert.equal(fs.readFileSync(path.join(home, 'taps', 'tap-agent.js'), 'utf8'), 'agent ccc3333');
      assert.ok(agent.spool.stats().depth > 0, 'the queued record is kept for the new agent');
      assert.deepEqual(restarts, [{ from: 'aaa1111', to: 'ccc3333' }]);
    } finally { await agent.close(); }
  });
});

test('update: the default restart closes the agent and exits once the logon task is handed the restart', async () => {
  await withPaired(async ({ token, home, env }) => {
    writeTree67(home, bundle67('aaa1111'));
    const archive = await publish67(env.GLMPS_STATE_DIR, 'bbb2222');
    const exits = [];
    const { restart, ...rest } = update67(archive, 'bbb2222', []);
    const agent = await startAgent(base(home, {
      readToken: () => token, exit: (c) => exits.push(c), fetch: fetch67,
      update: { ...rest, payloadRoot: home },
      restarter: () => ({ restarting: true }),
    }));
    try {
      await agent.ready;
      await waitFor(() => exits.length > 0, { timeoutMs: 10_000 });
      assert.deepEqual(exits, [0]);
    } finally { await agent.close(); }
  });
});
