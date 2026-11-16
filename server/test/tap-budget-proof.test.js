// server/test/tap-budget-proof.test.js
// Budget derived on the client (card glmps-2-0-runtime-38), the proof the spec
// names: the Claude credentials file is read only by the budget collector, and
// neither its tokens nor anything but derived numbers reach the server.
// Proof 1 runs the source agent against a throwaway server with an fs spy;
// proof 2 is a static scan of taps/. Proof 3 is apps/tap/smoke.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import { openClientStore } from '../lib/kernel/clients.js';
import { openTapIngest } from '../lib/kernel/tap-ingest.js';
import { openTapMirror } from '../lib/kernel/tap-mirror-store.js';
import { getPaths } from '../lib/paths.js';
import { startServer } from '../server.js';
import { startAgent } from '../../taps/tap-agent.js';
import { waitFor } from './helpers/wait-for.js';
import { dbFileFor } from '../lib/state-dir.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ACCESS = 'SENTINEL-ACCESS-7f3a91';
const REFRESH = 'SENTINEL-REFRESH-c1d204';
const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });
const mkTmp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); tmpDirs.push(d); return d; };

function mkEnv() {
  const tmp = mkTmp('mc-tapbudget-srv-');
  const claudeDir = path.join(tmp, 'claude');
  fs.mkdirSync(path.join(claudeDir, '.claude-manager'), { recursive: true });
  fs.writeFileSync(path.join(claudeDir, '.claude-manager', 'active-sessions.json'), '[]');
  return { GLMPS_CLAUDE_DIR: claudeDir, GLMPS_ANTIGRAVITY_DIR: path.join(tmp, 'ag'), GLMPS_STATE_DIR: path.join(tmp, 'state'),
    GLMPS_GEMINI_TMP_DIR: path.join(tmp, 'gemini-tmp'), GLMPS_VSCODE_STORAGE_DIR: path.join(tmp, 'vscode-storage'),
    GLMPS_AGY_CLI_DIR: path.join(tmp, 'agy-cli'), GLMPS_CODEX_DIR: path.join(tmp, 'codex'), GLMPS_COPILOT_CLI_DIR: path.join(tmp, 'copilot-cli'),
    GLMPS_HERMES_DIR: path.join(tmp, 'hermes'), GLMPS_OPENCODE_DIR: path.join(tmp, 'opencode'), GLMPS_UNMERGED_SCAN: 'off' };
}

function plantCredentials() {
  const dir = mkTmp('mc-tapbudget-claude-');
  const file = path.join(dir, '.credentials.json');
  fs.writeFileSync(file, JSON.stringify({ claudeAiOauth: { accessToken: ACCESS, refreshToken: REFRESH, expiresAt: 4102444800000, subscriptionType: 'max', rateLimitTier: 'tier_x' } }));
  return { dir, file };
}

// Records every read of `target` with the stack that made it.
function spyReads(target) {
  const want = path.resolve(target).toLowerCase();
  const reads = [];
  const hit = (p) => {
    if (typeof p !== 'string' && !(p instanceof URL) && !Buffer.isBuffer(p)) return false;
    try { return path.resolve(p instanceof URL ? fileURLToPath(p) : String(p)).toLowerCase() === want; } catch { return false; }
  };
  const saved = [];
  const wrap = (obj, name) => {
    const orig = obj[name];
    saved.push([obj, name, orig]);
    obj[name] = function spied(p, ...rest) {
      if (hit(p)) reads.push({ fn: name, stack: new Error().stack });
      return orig.call(this, p, ...rest);
    };
  };
  for (const n of ['readFileSync', 'openSync', 'readFile', 'createReadStream']) wrap(fs, n);
  wrap(fs.promises, 'readFile');
  syncBuiltinESMExports();
  return { reads, restore: () => { for (const [o, n, f] of saved.reverse()) o[n] = f; syncBuiltinESMExports(); } };
}

// Everything the process sends out over fetch or http.request.
function spyRequests() {
  const calls = [];
  const origFetch = globalThis.fetch;
  const origRequest = http.request;
  globalThis.fetch = function spiedFetch(url, init = {}) {
    calls.push({ via: 'fetch', url: String(url?.url ?? url), headers: init.headers ?? null, body: init.body ?? null });
    return origFetch.call(this, url, init);
  };
  http.request = function spiedRequest(...args) {
    const o = args.find((a) => a && typeof a === 'object' && !(a instanceof URL)) ?? {};
    calls.push({ via: 'http', url: String(args[0] instanceof URL ? args[0] : (o.path ?? args[0])), headers: o.headers ?? null, body: null });
    return origRequest.apply(this, args);
  };
  return { calls, restore: () => { globalThis.fetch = origFetch; http.request = origRequest; } };
}

function fakeUsage() {
  const seen = [];
  const f = async (url, init = {}) => {
    seen.push({ url: String(url), headers: init.headers ?? {} });
    return { ok: true, status: 200, json: async () => ({ five_hour: { utilization: 42, resets_at: '2030-01-01T00:00:00+00:00' }, seven_day: { utilization: 7, resets_at: '2030-01-05T00:00:00+00:00' } }) };
  };
  return { f, seen };
}

const base = (home, extra = {}) => ({ home, port: 0, homeDir: mkTmp('mc-tapbudget-user-'), intervalMs: 3_600_000, shipTickMs: 50, log: () => {}, ...extra });

async function withPaired(fn) {
  const env = mkEnv();
  const srv = await startServer({ port: 0, pollMs: 1000, env });
  const store = openClientStore({ dbFile: dbFileFor(env.GLMPS_STATE_DIR) });
  try {
    const { clientId, token } = store.pair({ name: 'laptop', actor: 'test' });
    const home = mkTmp('mc-tapbudget-home-');
    fs.writeFileSync(path.join(home, 'tap-config.json'), JSON.stringify({ server: `http://127.0.0.1:${srv.port}`, clientId, name: 'laptop' }));
    await fn({ srv, store, clientId, token, home, env });
  } finally { store.closeDb(); await srv.close(); }
}

const getJson = async (port, p) => { const r = await fetch(`http://127.0.0.1:${port}${p}`); return { status: r.status, text: await r.text() }; };

test('proof 1: end to end, only the collector reads the credentials file and only derived numbers leave the machine', async () => {
  await withPaired(async ({ srv, clientId, token, home, env }) => {
    const planted = plantCredentials();
    const usage = fakeUsage();
    const spy = spyReads(planted.file);
    const net = spyRequests();
    let agent;
    let relayed;
    try {
      // The mirror (task 10) walks the same Claude dir, so its reads and requests are in the proven run too.
      const transcript = path.join(planted.dir, 'projects', 'D--proof', 'sessP.jsonl');
      fs.mkdirSync(path.dirname(transcript), { recursive: true });
      fs.writeFileSync(transcript, '{"type":"user"}\n');
      const P = getPaths({ ...mkEnv(), GLMPS_CLAUDE_DIR: planted.dir });
      agent = await startAgent(base(home, { readToken: () => token, paths: () => P, mirrorTickMs: 40, budget: { claudeDir: planted.dir, fetch: usage.f } }));
      await agent.ready;
      const ing = openTapIngest({ dbFile: dbFileFor(env.GLMPS_STATE_DIR) });
      const mir = openTapMirror({ dbFile: dbFileFor(env.GLMPS_STATE_DIR), stateDir: env.GLMPS_STATE_DIR });
      try {
        await waitFor(() => ing.latestByKind('budget').length === 1, { message: 'a budget record to be ingested' });
        await waitFor(() => mir.manifest(clientId).files['claude/projects/D--proof/sessP.jsonl'], { message: 'the transcript to be mirrored' });
        assert.equal(Object.keys(mir.manifest(clientId).files).some((k) => k.includes('credentials')), false, 'mirror manifest');
        relayed = await fetch(`http://127.0.0.1:${agent.address.port}/api/state`);
        await relayed.text();
        const rows = ing.records({ clientId });
        assert.equal(JSON.stringify(rows).includes(ACCESS), false, 'tap_records row');
        assert.equal(JSON.stringify(rows).includes(REFRESH), false, 'tap_records row');
        const budgetRow = rows.find((r) => r.kind === 'budget');
        assert.equal(budgetRow.payload.usage.fiveHour.usedPercent, 42);
        assert.equal(budgetRow.payload.plan.subscriptionType, 'max');
      } finally { ing.closeDb(); mir.closeDb(); }
      const answer = await getJson(srv.port, '/api/budget');
      assert.equal(answer.status, 200);
      assert.equal(answer.text.includes(ACCESS) || answer.text.includes(REFRESH), false, '/api/budget answer');
      const b = JSON.parse(answer.text);
      assert.equal(b.source, 'client');
      assert.equal(b.usage.fiveHour.usedPercent, 42);
      assert.equal(b.clients[0].name, 'laptop');
    } finally {
      if (agent) await agent.close();
      spy.restore(); net.restore();
    }
    assert.ok(relayed && relayed.status < 500, 'the relayed request went through');
    assert.ok(spy.reads.length > 0, 'the collector read the planted file');
    for (const r of spy.reads) assert.match(r.stack, /tap-budget\.js/, `${r.fn} read came from the collector`);
    const sent = JSON.stringify(net.calls);
    assert.equal(sent.includes(ACCESS) || sent.includes(REFRESH), false, 'a request to the server carried a credential');
    assert.ok(net.calls.length > 0);
    assert.equal(usage.seen.length >= 1, true);
    for (const s of usage.seen) {
      assert.equal(s.url, 'https://api.anthropic.com/api/oauth/usage');
      assert.equal(s.headers.authorization, `Bearer ${ACCESS}`);
    }
    assert.equal(sent.includes('api.anthropic.com'), false, 'the usage call did not go through the agent fetch');
  });
});

test('proof 1: with the collector disabled the same run never reads the credentials file', async () => {
  await withPaired(async ({ srv, token, home }) => {
    const planted = plantCredentials();
    const spy = spyReads(planted.file);
    let agent;
    try {
      // the env and homeDir would both lead the collector to the planted dir if it ran
      agent = await startAgent(base(home, { readToken: () => token, budget: false, homeDir: path.dirname(planted.dir) }));
      await agent.ready;
      await getJson(srv.port, '/api/budget');
      await fetch(`http://127.0.0.1:${agent.address.port}/api/state`).then((r) => r.text());
    } finally { if (agent) await agent.close(); spy.restore(); }
    assert.equal(spy.reads.length, 0);
  });
});

test('proof 1: an offline agent spools the derived record and the spool holds no credential', async () => {
  const env = mkEnv();
  const home = mkTmp('mc-tapbudget-home-');
  fs.writeFileSync(path.join(home, 'tap-config.json'), JSON.stringify({ server: 'http://127.0.0.1:9', clientId: 'cli_x', name: 'laptop' }));
  const planted = plantCredentials();
  const usage = fakeUsage();
  const agent = await startAgent(base(home, { readToken: () => 'tok', fetch: async () => { throw new Error('offline'); }, budget: { claudeDir: planted.dir, fetch: usage.f } }));
  try {
    await agent.ready;
    const spoolDir = path.join(home, 'spool');
    const text = fs.readdirSync(spoolDir).map((f) => fs.readFileSync(path.join(spoolDir, f), 'utf8')).join('\n');
    assert.match(text, /"kind":"budget"/);
    assert.equal(text.includes(ACCESS) || text.includes(REFRESH), false);
  } finally { await agent.close(); }
  void env;
});

function listJs(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') out.push(...listJs(p)); } else if (/\.(js|mjs|cjs)$/.test(e.name)) out.push(p);
  }
  return out;
}

test('proof 2: nothing under taps/ but tap-budget.js names the credentials file or imports budget.js', () => {
  const files = listJs(path.join(ROOT, 'taps'));
  assert.ok(files.some((f) => path.basename(f) === 'tap-budget.js'));
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    const isCollector = path.basename(f) === 'tap-budget.js';
    if (isCollector) { assert.match(src, /observability\/budget\.js/); continue; }
    assert.doesNotMatch(src, /\.credentials\.json|credentialsFile|readCredentials/, `${path.relative(ROOT, f)} mentions the credentials file`);
    assert.doesNotMatch(src, /(?<![\w-])budget\.js['"]/, `${path.relative(ROOT, f)} imports budget.js`);
  }
});
