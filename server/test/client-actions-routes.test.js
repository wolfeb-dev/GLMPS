// Routes under test: server/lib/routes/tap-routes.js
// Client-targeted actions (card glmps-2-0-runtime-45): the routes through a real
// server. Card glmps-2-0-152: the kernel is on a private bind, and a client reaches it over
// HTTPS from 127.0.0.2 (the remote path) with its token and its own certificate.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { openClientStore } from '../lib/kernel/clients.js';
import { startServer } from '../server.js';
import { waitFor } from './helpers/wait-for.js';
import { computeProof, sha256Hex, randomNonce } from '../lib/governance/launch-auth.js';
import { dbFileFor } from '../lib/state-dir.js';
import { privateBind, pairWithCert, remoteHttps } from './helpers/mtls.js';
import { listRoutes, matchRoute, registerRoute } from '../lib/observability/route-registry.js';

const snapshotRoutes = () => listRoutes().map(({ method, pattern }) => matchRoute(method, pattern).route);
const restoreRoutes = (saved) => { for (const r of saved) registerRoute(r); };

// One event-loop turn between polls; each poll is a real HTTP round trip, so this does not spin.
const turn = () => new Promise((r) => setImmediate(r));
const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });
const binds = new Map();
const trust = new Map();
function mkEnv(extra = {}, config = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-cact-')); tmpDirs.push(tmp);
  const claudeDir = path.join(tmp, 'claude');
  fs.mkdirSync(path.join(claudeDir, '.claude-manager'), { recursive: true });
  fs.writeFileSync(path.join(claudeDir, '.claude-manager', 'active-sessions.json'), '[]');
  const env = { GLMPS_CLAUDE_DIR: claudeDir, GLMPS_ANTIGRAVITY_DIR: path.join(tmp, 'ag'), GLMPS_STATE_DIR: path.join(tmp, 'state'),
    GLMPS_GEMINI_TMP_DIR: path.join(tmp, 'gemini-tmp'), GLMPS_VSCODE_STORAGE_DIR: path.join(tmp, 'vscode-storage'),
    GLMPS_AGY_CLI_DIR: path.join(tmp, 'agy-cli'), GLMPS_CODEX_DIR: path.join(tmp, 'codex'), GLMPS_COPILOT_CLI_DIR: path.join(tmp, 'copilot-cli'),
    GLMPS_HERMES_DIR: path.join(tmp, 'hermes'), GLMPS_OPENCODE_DIR: path.join(tmp, 'opencode'), GLMPS_UNMERGED_SCAN: 'off',
    GLMPS_ACCESS_TOKEN: 'shared-remote-token', ...extra };
  binds.set(env, privateBind({ stateDir: env.GLMPS_STATE_DIR, configFile: path.join(tmp, 'config.json'), config }));
  return env;
}
async function boot(env) {
  const b = binds.get(env);
  const srv = await startServer({ port: 0, pollMs: 1000, env, ...b.startOpts });
  trust.set(srv.port, b.homeCaPem);
  return srv;
}
const remote = (port, { client, token, ...o } = {}) => remoteHttps(port, { ca: trust.get(port), token: client?.token ?? token, client, ...o });

let sharedEnv;
let sharedSrv;
let sharedStore;
let sharedRoutes;

let shortEnv;
let shortSrv;
let shortStore;
let shortRoutes;

before(async () => {
  sharedEnv = mkEnv();
  sharedSrv = await boot(sharedEnv);
  sharedStore = openClientStore({ dbFile: dbFileFor(sharedEnv.GLMPS_STATE_DIR) });
  sharedRoutes = snapshotRoutes();

  shortEnv = mkEnv({ GLMPS_CLIENT_ACTION_CLAIM_MS: '150', GLMPS_CLIENT_ACTION_TIMEOUT_MS: '500' });
  shortSrv = await boot(shortEnv);
  shortStore = openClientStore({ dbFile: dbFileFor(shortEnv.GLMPS_STATE_DIR) });
  shortRoutes = snapshotRoutes();
});

after(async () => {
  sharedStore?.closeDb();
  await sharedSrv?.close();
  shortStore?.closeDb();
  await shortSrv?.close();
});

function resetServerState(srv, store, routes, env) {
  restoreRoutes(routes);
  for (const c of store.list()) {
    if (c.paired) store.revoke(c.id, { actor: 'test' });
  }
  srv.launchBroker.expirePending(() => true, 'reset');
  srv.launchBroker.failStaleClaims(-1, 'reset');
  fs.rmSync(path.join(env.GLMPS_CLAUDE_DIR, 'CLAUDE.md'), { force: true });
}

test('heartbeat stores projectRoots and refuses a malformed list with 400', async () => {
  resetServerState(sharedSrv, sharedStore, sharedRoutes, sharedEnv);
  const me = pairWithCert(sharedStore, sharedEnv.GLMPS_STATE_DIR, { name: 'laptop' });
  const { clientId } = me;
  const ok = await remote(sharedSrv.port, { method: 'POST', path: '/api/tap/heartbeat', client: me, body: { projectRoots: ['C:/Work'] } });
  assert.equal(ok.status, 200);
  assert.deepEqual(sharedStore.get(clientId).projectRoots, ['C:/Work']);
  const bad = await remote(sharedSrv.port, { method: 'POST', path: '/api/tap/heartbeat', client: me, body: { projectRoots: 'C:/Work' } });
  assert.equal(bad.status, 400);
});

// The desktop shell's signed call, over plain loopback.
function shell(srv, env, { method = 'GET', path: p, body = '' }) {
  const token = fs.readFileSync(path.join(env.GLMPS_STATE_DIR, 'launch-token'), 'utf8').trim();
  const nonce = randomNonce();
  const proof = computeProof(token, { direction: 'req', method, path: p, nonce, bodyHash: sha256Hex(body) });
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: srv.port, method, path: p, headers: { 'content-type': 'application/json', 'x-launch-nonce': nonce, 'x-launch-proof': proof } }, (res) => {
      let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch {} resolve({ status: res.statusCode, json: j }); });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function twoClients() {
  resetServerState(sharedSrv, sharedStore, sharedRoutes, sharedEnv);
  const a = pairWithCert(sharedStore, sharedEnv.GLMPS_STATE_DIR, { name: 'alpha-box' });
  const b = pairWithCert(sharedStore, sharedEnv.GLMPS_STATE_DIR, { name: 'beta-box' });
  sharedStore.heartbeat(a.clientId, { projectRoots: ['C:/Work/Alpha'] });
  sharedStore.heartbeat(b.clientId, { projectRoots: ['D:/Beta'] });
  return { env: sharedEnv, srv: sharedSrv, store: sharedStore, a, b };
}

test('launch routes: a client token polls, claims and completes only its own records; the shell never sees them', async (t) => {
  const { env, srv, a, b } = await twoClients(t);
  const mine = srv.launchBroker.enqueue({ command: 'claude --resume 11111111-1111-1111-1111-111111111111', cwd: 'C:/Work/Alpha', origin: 'resume', targetClient: a.clientId });
  const plain = srv.launchBroker.enqueue({ command: 'claude', cwd: 'D:/r', origin: 'terminal' });

  const shellPoll = await shell(srv, env, { path: '/api/launches' });
  assert.deepEqual(shellPoll.json.pending.map((r) => r.id), [plain.id], 'the shell sees only untargeted records');
  assert.equal((await shell(srv, env, { method: 'POST', path: `/api/launches/${mine.id}/claim`, body: '{}' })).status, 409, 'the shell cannot claim a client record');

  const poll = await remote(srv.port, { path: '/api/launches', client: a });
  assert.equal(poll.status, 200);
  assert.deepEqual(poll.json.pending.map((r) => r.id), [mine.id]);
  assert.ok(Array.isArray(poll.json.allowedCommands));
  assert.deepEqual((await remote(srv.port, { path: '/api/launches', client: b })).json.pending, []);

  assert.equal((await remote(srv.port, { method: 'POST', path: `/api/launches/${mine.id}/claim`, client: b, body: {} })).status, 409, 'another client cannot claim it');
  assert.equal((await remote(srv.port, { method: 'POST', path: `/api/launches/${plain.id}/claim`, client: a, body: {} })).status, 409, 'a client cannot claim the shell record');
  const claim = await remote(srv.port, { method: 'POST', path: `/api/launches/${mine.id}/claim`, client: a, body: { by: `tap:${a.clientId}` } });
  assert.equal(claim.status, 200); assert.equal(claim.json.state, 'claimed');
  assert.equal((await remote(srv.port, { method: 'POST', path: `/api/launches/${mine.id}/result`, client: b, body: { pid: 5 } })).status, 404, 'not the other client record to complete');
  const done = await remote(srv.port, { method: 'POST', path: `/api/launches/${mine.id}/result`, client: a, body: { pid: 4242 } });
  assert.equal(done.status, 204);
  assert.equal(srv.launchBroker.get(mine.id).state, 'done');
  assert.equal(srv.launchBroker.get(mine.id).pid, 4242);
});

test('launch routes: no token and a bad token are refused, and a client poll needs the tap protocol header', async (t) => {
  const { srv, a } = await twoClients(t);
  assert.equal((await remote(srv.port, { path: '/api/launches' })).status, 401);
  assert.equal((await remote(srv.port, { path: '/api/launches', token: 'nope' })).status, 401);
    const noHeader = (await remote(srv.port, { path: '/api/launches', client: a, headers: { 'x-glmps-tap-protocol': null } })).status;
  assert.equal(noHeader, 426, 'a client poll must state the tap protocol');
});

const SHARED = 'shared-remote-token';
const admin = (srv, method, p, body) => remote(srv.port, { method, path: p, token: SHARED, body });
const UUID = '11111111-2222-3333-4444-555555555555';

async function withClaimEnv(_t, extra) {
  const useShort = Boolean(extra && (extra.GLMPS_CLIENT_ACTION_CLAIM_MS || extra.GLMPS_CLIENT_ACTION_TIMEOUT_MS));
  const env = useShort ? shortEnv : sharedEnv;
  const srv = useShort ? shortSrv : sharedSrv;
  const store = useShort ? shortStore : sharedStore;
  const routes = useShort ? shortRoutes : sharedRoutes;
  resetServerState(srv, store, routes, env);
  const a = pairWithCert(store, env.GLMPS_STATE_DIR, { name: 'alpha-box' });
  const b = pairWithCert(store, env.GLMPS_STATE_DIR, { name: 'beta-box' });
  store.heartbeat(a.clientId, { projectRoots: ['C:/Work/Alpha'] });
  store.heartbeat(b.clientId, { projectRoots: ['D:/Beta'] });
  return { env, srv, store, a, b };
}

// Stands in for the tap: polls with the client token, claims what it finds and answers with `answer(record)`.
function fakeTap(srv, client, answer) {
  let stop = false;
  const loop = (async () => {
    while (!stop) {
      const poll = await remote(srv.port, { path: '/api/launches', client: client });
      for (const rec of poll.json?.pending ?? []) {
        const claim = await remote(srv.port, { method: 'POST', path: `/api/launches/${rec.id}/claim`, client: client, body: { by: `tap:${client.clientId}` } });
        if (claim.status !== 200) continue;
        await remote(srv.port, { method: 'POST', path: `/api/launches/${rec.id}/result`, client: client, body: answer(rec) });
      }
      await turn();
    }
  })();
  return async () => { stop = true; await loop; };
}

test('resume: a client-namespaced session queues for that client, with its own first root as the cwd', async (t) => {
  const { srv, a } = await withClaimEnv(t);
  const r = await admin(srv, 'POST', '/api/resume', { sessionId: `${a.clientId}:${UUID}` });
  assert.equal(r.status, 200, r.body);
  assert.equal(r.json.launched, 'queued'); assert.equal(r.json.client, a.clientId); assert.equal(r.json.clientName, 'alpha-box'); assert.equal(r.json.pid, null);
  assert.equal(r.json.cwd, 'C:/Work/Alpha');
  const rec = srv.launchBroker.get(r.json.launchId);
  assert.equal(rec.origin, 'resume'); assert.equal(rec.targetClient, a.clientId); assert.equal(rec.command, `claude --resume ${UUID}`); assert.equal(rec.cwd, 'C:/Work/Alpha');
  assert.deepEqual(srv.launchBroker.pending().map((x) => x.id), [], 'not in the shell queue');
});

test('resume: a cwd outside the owner roots is 403, under another client is 403, dotdot is 400, an unpaired owner is 409', async (t) => {
  const { srv, a, store } = await withClaimEnv(t);
  const sid = `${a.clientId}:${UUID}`;
  const out = await admin(srv, 'POST', '/api/resume', { sessionId: sid, cwd: 'E:/elsewhere' });
  assert.equal(out.status, 403); assert.match(out.json.error, /path not owned by client/);
  assert.equal((await admin(srv, 'POST', '/api/resume', { sessionId: sid, cwd: 'D:/Beta/x' })).status, 403);
  assert.equal((await admin(srv, 'POST', '/api/resume', { sessionId: sid, cwd: 'C:/Work/Alpha/../../etc' })).status, 400);
  store.revoke(a.clientId, { actor: 'test' });
  assert.equal((await admin(srv, 'POST', '/api/resume', { sessionId: sid })).status, 409);
  assert.equal(srv.launchBroker.pending({ client: a.clientId }).length, 0);
});

test('resume: an unprefixed session stays on the server even when its cwd is under a client root', async (t) => {
  const { srv, a, b } = await withClaimEnv(t);
  for (const cwd of ['D:/Beta/x', 'C:/Work/Alpha']) {
    const r = await admin(srv, 'POST', '/api/resume', { sessionId: UUID, cwd });
    assert.notEqual(r.json?.launched, 'queued', r.body);
    assert.equal(r.json?.client, undefined, r.body);
  }
  assert.equal(srv.launchBroker.pending({ client: a.clientId }).length, 0);
  assert.equal(srv.launchBroker.pending({ client: b.clientId }).length, 0);
});

test('resume: workspace location on a client target becomes an editor open of the cwd', async (t) => {
  const { srv, a } = await withClaimEnv(t);
  const sid = `${a.clientId}:${UUID}`;
  assert.equal((await admin(srv, 'POST', '/api/resume', { sessionId: sid, location: 'workspace' })).status, 400, 'cwd required');
  const r = await admin(srv, 'POST', '/api/resume', { sessionId: sid, location: 'workspace', cwd: 'C:/Work/Alpha/proj' });
  assert.equal(r.status, 200, r.body);
  assert.equal(r.json.opened, 'queued'); assert.equal(r.json.client, a.clientId);
  const rec = srv.launchBroker.get(r.json.launchId);
  assert.equal(rec.origin, 'editor'); assert.deepEqual(rec.action, { kind: 'open', path: 'C:/Work/Alpha/proj' });
});

test('terminal: a client path queues a terminal record; isolate and an unknown terminal are refused', async (t) => {
  const { srv, a } = await withClaimEnv(t);
  const iso = await admin(srv, 'POST', '/api/terminal', { terminal: 'Claude', cwd: 'C:/Work/Alpha/x', isolate: true });
  assert.equal(iso.status, 409); assert.match(iso.json.error, /isolate is not supported on a client target/);
  assert.equal((await admin(srv, 'POST', '/api/terminal', { terminal: 'Nope', cwd: 'C:/Work/Alpha/x' })).status, 400);
  const ok = await admin(srv, 'POST', '/api/terminal', { terminal: 'Claude', cwd: 'C:/Work/Alpha/x' });
  assert.equal(ok.status, 200, ok.body);
  assert.equal(ok.json.launched, 'queued'); assert.equal(ok.json.client, a.clientId);
  const rec = srv.launchBroker.get(ok.json.launchId);
  assert.equal(rec.origin, 'terminal'); assert.equal(rec.command, 'claude'); assert.equal(rec.cwd, 'C:/Work/Alpha/x'); assert.equal(rec.targetClient, a.clientId);
  const named = await admin(srv, 'POST', '/api/terminal', { terminal: 'Claude', clientId: a.clientId });
  assert.equal(named.status, 200); assert.equal(named.json.cwd, 'C:/Work/Alpha', 'defaults to the first root of the client');
});

test('open-in-editor: a client path queues an editor record', async (t) => {
  const { srv, a } = await withClaimEnv(t);
  const r = await admin(srv, 'POST', '/api/open-in-editor', { path: 'C:/Work/Alpha/src/a.js' });
  assert.equal(r.status, 200, r.body);
  assert.equal(r.json.queued, true); assert.equal(r.json.client, a.clientId);
  const rec = srv.launchBroker.get(r.json.launchId);
  assert.equal(rec.origin, 'editor'); assert.equal(rec.targetClient, a.clientId); assert.deepEqual(rec.action, { kind: 'open', path: 'C:/Work/Alpha/src/a.js' });
});

test('ownership refusals: ambiguous roots 409, wrong explicit client 403, unknown client 404', async (t) => {
  const { srv, store, a, b } = await withClaimEnv(t);
  store.heartbeat(b.clientId, { projectRoots: ['D:/Beta', 'c:\\work\\alpha'] });
  const amb = await admin(srv, 'POST', '/api/open-in-editor', { path: 'C:/Work/Alpha/f.js' });
  assert.equal(amb.status, 409); assert.match(amb.json.error, new RegExp(a.clientId)); assert.match(amb.json.error, new RegExp(b.clientId));
  const named = await admin(srv, 'POST', '/api/open-in-editor', { path: 'C:/Work/Alpha/f.js', clientId: a.clientId });
  assert.equal(named.status, 200, named.body);
  store.heartbeat(b.clientId, { projectRoots: ['D:/Beta'] });
  const wrong = await admin(srv, 'POST', '/api/open-in-editor', { path: 'C:/Work/Alpha/f.js', clientId: b.clientId });
  assert.equal(wrong.status, 403); assert.match(wrong.json.error, /path not owned by client/);
  assert.equal((await admin(srv, 'POST', '/api/open-in-editor', { path: 'C:/Work/Alpha/f.js', clientId: 'cli_nope' })).status, 404);
});

test('file API: read, save and undo on a client-owned path round-trip through the tap and the finished records keep no content', async (t) => {
  const { env, srv, a } = await withClaimEnv(t);
  const seen = [];
  const stop = fakeTap(srv, a, (rec) => {
    seen.push(rec.action);
    const save = rec.action.op === 'save';
    return { result: { status: save ? 409 : 200, body: save ? { error: 'conflict: changed on disk' } : { content: 'hello', hash: 'h1' } } };
  });
  try {
    const read = await admin(srv, 'GET', `/api/file?path=${encodeURIComponent('C:/Work/Alpha/a.txt')}`);
    assert.equal(read.status, 200); assert.deepEqual(read.json, { content: 'hello', hash: 'h1' });
    const save = await admin(srv, 'PUT', '/api/file', { path: 'C:/Work/Alpha/a.txt', content: 'new text', hash: 'h1', force: false });
    assert.equal(save.status, 409, 'the status of the client passes through'); assert.match(save.json.error, /conflict/);
    const undo = await admin(srv, 'POST', '/api/file/undo', { path: 'C:/Work/Alpha/a.txt' });
    assert.equal(undo.status, 200);
    assert.deepEqual(seen.map((x) => x.op), ['read', 'save', 'undo']);
    assert.equal(seen[1].content, 'new text'); assert.equal(seen[1].hash, 'h1');
    const queueText = fs.readFileSync(path.join(env.GLMPS_STATE_DIR, 'launches', 'queue.json'), 'utf8');
    assert.equal(queueText.includes('new text'), false);
    assert.equal(queueText.includes('hello'), false);
  } finally { await stop(); }
});

test('file API: a path under two clients is 409, a path under A with clientId B is 403, an unowned path stays local', async (t) => {
  const { srv, store, a, b } = await withClaimEnv(t);
  const q = (p, extra = '') => admin(srv, 'GET', `/api/file?path=${encodeURIComponent(p)}${extra}`);
  assert.equal((await q('C:/Work/Alpha/a.txt', `&client=${b.clientId}`)).status, 403);
  store.heartbeat(b.clientId, { projectRoots: ['D:/Beta', 'C:/Work/Alpha'] });
  assert.equal((await q('C:/Work/Alpha/a.txt')).status, 409);
  store.heartbeat(b.clientId, { projectRoots: ['D:/Beta'] });
  const local = await q(path.join(os.tmpdir(), 'mc-cact-nonexistent-file.txt').replace(/\\/g, '/'));
  assert.notEqual(local.status, 504, 'an unowned path is not sent to a client');
  assert.equal(srv.launchBroker.pending({ client: a.clientId }).length, 0);
});

test('file API: a client that never claims gets a 504 naming it, and the record fails scrubbed', async (t) => {
  const { env, srv, a } = await withClaimEnv(t, { GLMPS_CLIENT_ACTION_CLAIM_MS: '150', GLMPS_CLIENT_ACTION_TIMEOUT_MS: '400' });
  const r = await admin(srv, 'PUT', '/api/file', { path: 'C:/Work/Alpha/a.txt', content: 'never lands', hash: 'h' });
  assert.equal(r.status, 504);
  assert.match(r.json.error, /alpha-box did not pick this up within 150 ms/);
  assert.equal(r.json.client, 'alpha-box');
  assert.equal(srv.launchBroker.pending({ client: a.clientId }).length, 0);
  assert.equal(fs.readFileSync(path.join(env.GLMPS_STATE_DIR, 'launches', 'queue.json'), 'utf8').includes('never lands'), false);
});

test('file API: a client that claims but never answers gets a 504 at the overall limit', async (t) => {
  const { srv, a } = await withClaimEnv(t, { GLMPS_CLIENT_ACTION_CLAIM_MS: '150', GLMPS_CLIENT_ACTION_TIMEOUT_MS: '500' });
  const claimer = (async () => {
    for (let i = 0; i < 40; i++) {
      const poll = await remote(srv.port, { path: '/api/launches', client: a });
      for (const rec of poll.json?.pending ?? []) await remote(srv.port, { method: 'POST', path: `/api/launches/${rec.id}/claim`, client: a, body: {} });
      await turn();
    }
  })();
  const r = await admin(srv, 'GET', `/api/file?path=${encodeURIComponent('C:/Work/Alpha/a.txt')}`);
  assert.equal(r.status, 504); assert.match(r.json.error, /did not answer within 500 ms/);
  await claimer;
});

test('end to end: the real claimer answers a file read, save and undo for the server over HTTP', async () => {
  const { createActionClaimer } = await import('../../taps/tap-actions.js');
  resetServerState(sharedSrv, sharedStore, sharedRoutes, sharedEnv);
  const srv = sharedSrv;
  const store = sharedStore;
  const tapHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-cact-tap-')); tmpDirs.push(tapHome);
  const root = path.join(tapHome, 'proj'); fs.mkdirSync(root);
  const file = path.join(root, 'n.txt'); fs.writeFileSync(file, 'v1');
  // The real claimer speaks plain HTTP (its mTLS side is a later card), so it stays on loopback, which needs no certificate.
  const c = store.pair({ name: 'real-tap', actor: 'test' });
  store.heartbeat(c.clientId, { projectRoots: [root] });
  const claimer = createActionClaimer({ getCreds: () => ({ config: { server: `http://127.0.0.1:${srv.port}`, clientId: c.clientId }, token: c.token }), getProjectRoots: () => [root], home: tapHome, spawn: () => ({ pid: 1 }), log: () => {} });
  let stop = false;
  const pump = (async () => { while (!stop) { await claimer.tick(); await turn(); } })();
  try {
    const read = await admin(srv, 'GET', `/api/file?path=${encodeURIComponent(file)}`);
    assert.equal(read.status, 200, read.body); assert.equal(read.json.content, 'v1');
    const save = await admin(srv, 'PUT', '/api/file', { path: file, content: 'v2', hash: read.json.hash });
    assert.equal(save.status, 200, save.body);
    assert.equal(fs.readFileSync(file, 'utf8'), 'v2');
    assert.equal((await admin(srv, 'POST', '/api/file/undo', { path: file })).status, 200);
    assert.equal(fs.readFileSync(file, 'utf8'), 'v1');
    const term = await admin(srv, 'POST', '/api/terminal', { terminal: 'Claude', cwd: root });
    assert.equal(term.status, 200, term.body);
    await waitFor(() => srv.launchBroker.get(term.json.launchId).state === 'done', { message: 'the terminal record to finish' });
    const rec = srv.launchBroker.get(term.json.launchId);
    assert.equal(rec.state, 'done'); assert.equal(rec.pid, 1);
  } finally { stop = true; await pump; }
});

test('server roots win: a client root over the server box own editable root leaves its files on the server', async (t) => {
  const { env, srv, store, a } = await withClaimEnv(t);
  const own = path.join(env.GLMPS_CLAUDE_DIR, 'CLAUDE.md'); fs.writeFileSync(own, 'server copy');
  store.heartbeat(a.clientId, { projectRoots: [env.GLMPS_CLAUDE_DIR, 'C:/Work/Alpha'] });
  const read = await admin(srv, 'GET', `/api/file?path=${encodeURIComponent(own)}`);
  assert.equal(read.status, 200, read.body); assert.equal(read.json.content, 'server copy');
  const save = await admin(srv, 'PUT', '/api/file', { path: own, content: 'edited on the server', hash: read.json.hash });
  assert.equal(save.status, 200, save.body);
  assert.equal(fs.readFileSync(own, 'utf8'), 'edited on the server');
  assert.equal(srv.launchBroker.pending({ client: a.clientId }).length, 0, 'nothing went to the client');
  const named = await admin(srv, 'POST', '/api/open-in-editor', { path: own, clientId: a.clientId });
  assert.equal(named.status, 200, named.body); assert.equal(named.json.client, a.clientId, 'naming the client still reaches it');
});

test('a malformed path answers the same with or without a paired client', async () => {
  resetServerState(sharedSrv, sharedStore, sharedRoutes, sharedEnv);
  const srv = sharedSrv;
  const store = sharedStore;
  const probes = () => Promise.all([
    admin(srv, 'GET', `/api/file?path=${encodeURIComponent('relative/f.txt')}`),
    admin(srv, 'POST', '/api/file/undo', { path: 'C:/Work/Alpha/../x' }),
    admin(srv, 'POST', '/api/terminal', { terminal: 'Claude', cwd: '\\host\share' }),
  ]).then((rs) => rs.map((r) => [r.status, r.json?.error]));
  const beforeProbes = await probes();
  const a = pairWithCert(store, sharedEnv.GLMPS_STATE_DIR, { name: 'alpha-box' });
  store.heartbeat(a.clientId, { projectRoots: ['C:/Work/Alpha'] });
  assert.deepEqual(await probes(), beforeProbes);
});

test('end to end: a client resume runs when the Claude command is not one of the configured terminals', async (t) => {
  const { createActionClaimer } = await import('../../taps/tap-actions.js');
  const env = mkEnv({}, { terminals: [{ label: 'Gemini', command: 'gemini' }] });
  const srv = await boot(env);
  const store = openClientStore({ dbFile: dbFileFor(env.GLMPS_STATE_DIR) });
  const tapHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-cact-tap-')); tmpDirs.push(tapHome);
  const root = path.join(tapHome, 'proj'); fs.mkdirSync(root);
  // The real claimer speaks plain HTTP (its mTLS side is a later card), so it stays on loopback, which needs no certificate.
  const c = store.pair({ name: 'real-tap', actor: 'test' });
  store.heartbeat(c.clientId, { projectRoots: [root] });
  t.after(async () => { store.closeDb(); await srv.close(); });
  const claimer = createActionClaimer({ getCreds: () => ({ config: { server: `http://127.0.0.1:${srv.port}`, clientId: c.clientId }, token: c.token }), getProjectRoots: () => [root], home: tapHome, spawn: () => ({ pid: 7 }), log: () => {} });
  let stop = false;
  const pump = (async () => { while (!stop) { await claimer.tick(); await turn(); } })();
  try {
    const r = await admin(srv, 'POST', '/api/resume', { sessionId: `${c.clientId}:${UUID}`, cwd: root });
    assert.equal(r.status, 200, r.body);
    await waitFor(() => ['done', 'failed'].includes(srv.launchBroker.get(r.json.launchId).state), { message: 'the resume record to finish' });
    const rec = srv.launchBroker.get(r.json.launchId);
    assert.equal(rec.state, 'done', rec.error); assert.equal(rec.pid, 7);
  } finally { stop = true; await pump; }
});
