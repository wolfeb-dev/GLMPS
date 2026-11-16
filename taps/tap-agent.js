// taps/tap-agent.js
// The per-user tap agent (skeleton, card glmps-2-0-runtime-31). Started by the
// logon task, it reads its pairing token from the DPAPI file, sends the server
// a heartbeat every minute and answers GET /tap/status on 127.0.0.1. It owns the
// spool and ships it to the server every second when there is something to send
// (task 9), and relays every other request on its port to the server
// (taps/tap-relay.js, task 12). After each heartbeat it applies a newer signed
// release when idle (taps/tap-updater.js, card glmps-2-0-runtime-67). It mirrors
// the client's session files to the server every few seconds (taps/tap-mirror.js,
// task 10). Its action claimer polls for launch records aimed at this client
// (resume, terminal, editor, file) and runs them locally (taps/tap-actions.js,
// card glmps-2-0-runtime-45).
//
//   node taps/tap-agent.js          run until stopped
//   node taps/tap-agent.js --once   one heartbeat, print the status JSON, exit
//                                   (0 when paired, 1 otherwise)
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tapHome, readConfig, DEFAULT_PORT, heartbeatRequest, detectTools, classifyHeartbeat, statusDocument } from './tap-agent-lib.js';
import { readToken, readClientKey } from './tap-token.js';
import { createTapFetch, certificateState, readCa, readCert } from './tap-tls.js';
import { openSpool, SPOOL_CAP_BYTES } from './tap-spool.js';
import { createShipper } from './tap-shipper.js';
import { createActionClaimer, ACTION_TICK_MS } from './tap-actions.js';
import { createMirrorWatcher, dataRootIds, MIRROR_TICK_MS } from './tap-mirror.js';
import { createGitWatcher, resolveRepoSettings, GIT_TICK_MS } from './tap-git.js';
import { getPaths } from '../server/lib/paths.js';
import { browserRefusal, createRelay } from './tap-relay.js';
import { createBudgetCollector } from './tap-budget.js';
import { createUpdater, cleanupOld, logonTaskRestarter } from './tap-updater.js';

// The folder this agent was loaded from: <home>/taps/tap-agent.js in an installed bundle.
const PAYLOAD_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const TAP_AGENT_VERSION = '0.1.0';
export const HEARTBEAT_MS = 60_000;
export const SHIP_TICK_MS = 1000;
export { MIRROR_TICK_MS, ACTION_TICK_MS, GIT_TICK_MS };
const HEARTBEAT_TIMEOUT_MS = 10_000;
export const DRAIN_MS = 15_000;

export function createAgent({ home = tapHome(), homeDir = os.homedir(), fetch: fetchFn = createTapFetch(), readToken: readTokenFn = readToken, readClientKey: readClientKeyFn = readClientKey, now: nowFn = Date.now, log = console.error, spoolCap = SPOOL_CAP_BYTES, update: updateOpts = {}, paths = () => getPaths(), spawn: spawnFn = undefined, platform = process.platform, budget: budgetOpts = {} } = {}) {
  let state = { state: 'unconfigured', reason: 'no-config' };
  let lastHeartbeatTs = null;
  let tools = [];
  let config = null;
  // What the shipper sends with; null until a heartbeat has read a config and a token.
  let creds = null;
  // The client certificate as the status page reports it; null for a plain-http loopback server.
  let certificate = null;
  // Every call to the paired server carries the pinned CA and the client certificate.
  const serverFetch = (url, init = {}) => fetchFn(url, creds?.tls && String(url).startsWith(`${creds.config.server}/`) ? { ...init, tls: creds.tls } : init);
  let spool = null;
  let spoolError = null;
  try { spool = openSpool({ dir: path.join(home, 'spool'), cap: spoolCap }); }
  catch (e) { spoolError = e?.message || String(e); log(`[tap-agent] spool unavailable: ${spoolError}`); }
  const shipper = spool ? createShipper({ spool, getCreds: () => creds, fetch: serverFetch, log }) : null;
  // budget: false turns the collector off; an object overrides claudeDir, the usage fetch or refreshMs.
  const budgetCollector = spool && budgetOpts !== false ? createBudgetCollector({ spool, homeDir, log, ...budgetOpts }) : null;
  // Task 10: the mirror watcher ships the client's session files; it has its own
  // tick and one request in flight, like the shipper.
  const mirror = createMirrorWatcher({ getCreds: () => creds, getPaths: paths, tmpDir: path.join(home, 'mirror-tmp'), fetch: serverFetch, log });
  // Launch records aimed at this client; shares the heartbeat's creds and reads the project roots from the config.
  const actions = createActionClaimer({ getCreds: () => creds, getProjectRoots: () => config?.projectRoots ?? [], home, fetch: serverFetch, spawn: spawnFn, log, platform });
  // Card glmps-2-0-runtime-40: the git watcher posts a per-repo summary of the client's repos; own tick, one scan at a time.
  const git = createGitWatcher({
    getCreds: () => creds, fetch: serverFetch, log,
    getSettings: () => resolveRepoSettings({ home, claudeDir: paths().claudeDir }),
  });
  let relay = null;
  const relayDepth = () => relay?.queueDepth() ?? 0;
  // Requests being answered on the agent's port; startAgent counts them.
  let inFlight = 0;
  const track = (p) => { inFlight++; return p.finally(() => { inFlight--; }); };
  // A 426-driven update does not wait for the queues: nothing ships while the
  // protocol is refused, and both queues are on disk and survive the restart.
  const isIdle = ({ required = false, inFlightOnly = false } = {}) => {
    if (inFlight > 0 || shipper?.busy() || mirror.busy() || actions.busy() || git.busy() || relay?.draining()) return false;
    if (required || inFlightOnly) return true;
    return (spool ? spool.stats().depth : 0) === 0 && relayDepth() === 0;
  };
  const updater = createUpdater({
    home, payloadRoot: updateOpts.payloadRoot ?? PAYLOAD_ROOT, fetch: serverFetch, getCreds: () => creds, isIdle, log,
    restart: updateOpts.restart ?? (async () => ({ restarting: false, reason: 'no restart is wired in this mode' })),
    ...(updateOpts.verify ? { verify: updateOpts.verify } : {}),
    ...(updateOpts.extract ? { extract: updateOpts.extract } : {}),
    ...(updateOpts.platform ? { platform: updateOpts.platform } : {}),
  });
  if (updater.status().state !== 'disabled') cleanupOld(home, { log });

  // The relay's upstream. startAgent runs the first heartbeat before any request
  // is accepted, and its config and token read is synchronous, so creds is current.
  async function upstream() {
    if (creds) return { server: creds.config.server, token: creds.token, tls: creds.tls };
    return { unavailable: config ? 'tap-unpaired' : 'tap-unconfigured' };
  }

  const safeDataRoots = () => { try { return dataRootIds(paths()); } catch { return []; } };

  async function heartbeatOnce() {
    const cfg = readConfig(home);
    if (!cfg.ok) { config = null; creds = null; certificate = null; state = { state: 'unconfigured', reason: cfg.reason }; return state; }
    config = cfg.config;
    let token;
    try { token = readTokenFn(home); } catch (e) {
      creds = null;
      state = { state: 'unpaired', reason: e.message };
      return state;
    }
    if (!token) { creds = null; certificate = null; state = { state: 'unpaired', reason: 'no token file; pair this client' }; return state; }
    // Card glmps-2-0-runtime-147: an https server is reached only with the pinned CA and this client's certificate.
    let tlsOpts = null;
    if (config.server.startsWith('https:')) {
      let key = null;
      try { key = readClientKeyFn(home); } catch (e) {
        creds = null;
        certificate = { state: 'missing', notAfter: null, reason: e.message };
        state = { state: 'unpaired', reason: e.message };
        return state;
      }
      const certPem = readCert(home);
      const caPem = readCa(home);
      certificate = certificateState({ certPem, keyPresent: Boolean(key), caPem, now: nowFn() });
      if (certificate.state !== 'ok') { creds = null; state = { state: 'unpaired', reason: certificate.reason }; return state; }
      tlsOpts = { ca: caPem, cert: certPem, key };
    } else certificate = null;
    creds = { config, token, tls: tlsOpts };
    tools = detectTools(homeDir);
    const req = heartbeatRequest({ config, token, tapVersion: TAP_AGENT_VERSION, spoolDepth: (spool ? spool.stats().depth : 0) + relayDepth(), dataRoots: safeDataRoots(), tools, projectRoots: config.projectRoots });
    try {
      const res = await serverFetch(req.url, { method: req.method, headers: req.headers, body: req.body, signal: AbortSignal.timeout(HEARTBEAT_TIMEOUT_MS) });
      const refusal = res.status === 401 ? await res.json().catch(() => null) : null;
      state = classifyHeartbeat({ status: res.status, body: refusal });
      if (state.certificate === 'refused' && certificate) certificate = { ...certificate, state: 'refused', reason: state.reason };
      delete state.certificate;
      if (res.status === 200) { lastHeartbeatTs = Date.now(); relay?.online(); }
      if (res.status === 200 || res.status === 426) {
        const body = await res.json().catch(() => null);
        updater.offer(body?.update ?? null, { required: res.status === 426 });
      }
    } catch (e) {
      state = classifyHeartbeat({ error: e?.cause?.code || e?.message || String(e) });
    }
    if (state.state === 'paired') { shipper?.resume(); mirror.resume(); git.resume(); }
    else log(`[tap-agent] heartbeat: ${state.state}: ${state.reason}`);
    // Offline too: the spool carries the record until the server is back.
    if (budgetCollector) await budgetCollector.tick();
    return state;
  }

  const spoolStatus = () => {
    if (!spool) return { error: spoolError };
    const { bytes, full, dropped } = spool.stats();
    return { bytes, full, dropped };
  };
  const status = () => statusDocument({
    version: TAP_AGENT_VERSION, ...state, config, lastHeartbeatTs, tools, certificate,
    spoolDepth: (spool ? spool.stats().depth : 0) + relayDepth(), spool: spoolStatus(), shipper: shipper ? shipper.status() : null, mirror: mirror.status(), actions: actions.status(), git: git.status(),
  });
  const shipTick = () => (shipper ? shipper.tick() : Promise.resolve({ skipped: 'no-spool' }));
  const mirrorTick = () => mirror.tick();
  const actionTick = () => actions.tick();
  const gitTick = () => git.tick();
  const attachRelay = (r) => { relay = r; };
  return {
    heartbeatOnce, status: () => ({ ...status(), ...(relay ? { relay: relay.status() } : {}), update: updater.status() }),
    shipTick, mirrorTick, actionTick, gitTick, spool, upstream, attachRelay, track, updateTick: () => updater.maybeApply(),
  };
}

/** Starts the listener and the heartbeat timer. `ready` settles after the first heartbeat. */
export async function startAgent(opts = {}) {
  const { intervalMs = HEARTBEAT_MS, shipTickMs = SHIP_TICK_MS, mirrorTickMs = MIRROR_TICK_MS, actionTickMs = ACTION_TICK_MS, gitTickMs = GIT_TICK_MS, drainMs = DRAIN_MS, port: portOverride, home = tapHome(), log = console.error, exit = process.exit } = opts;
  // A verified update hands the restart to the logon task; this process then
  // closes and exits so the task's next instance runs the new files.
  let exitForUpdate = false;
  const restartLogonTask = opts.restarter ?? logonTaskRestarter({ home });
  const update = {
    ...(opts.update || {}),
    restart: opts.update?.restart ?? (async () => { const r = restartLogonTask(); exitForUpdate = r.restarting === true; return r; }),
  };
  const agent = createAgent({ ...opts, home, log, update });
  const relay = createRelay({ home, getUpstream: agent.upstream, spool: agent.spool, log, ...(opts.relay || {}) });
  agent.attachRelay(relay);
  const port = portOverride ?? readConfig(home).config?.port ?? DEFAULT_PORT;
  const server = http.createServer((req, res) => {
    const pathname = (req.url || '').split('?')[0];
    if (req.method === 'GET' && pathname === '/tap/status') {
      // Status names the client id and server URL, so a rebinding page is refused here as on every relay route.
      const refusal = browserRefusal(req.headers, req.socket.localPort);
      if (refusal) {
        res.writeHead(403, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ error: 'relay-refused', reason: refusal }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(agent.status()));
      return;
    }
    agent.track(relay.handle(req, res).catch((e) => {
      log(`[tap-agent] relay error: ${e.message}`);
      if (!res.headersSent) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'relay-error', relay: true })); } else res.destroy();
    }));
  });
  await new Promise((resolve, reject) => {
    server.once('error', (e) => reject(e.code === 'EADDRINUSE'
      ? Object.assign(new Error(`tap agent port ${port} is already in use; is another tap agent running?`), { code: 'TAP_PORT_IN_USE' })
      : e));
    server.listen(port, '127.0.0.1', resolve);
  });
  let updating = Promise.resolve();
  let handle = null;
  const updateTick = () => {
    updating = agent.updateTick().catch((e) => log(`[tap-agent] update check failed: ${e.message}`));
    updating.then(() => {
      if (!exitForUpdate) return;
      exitForUpdate = false;
      log('[tap-agent] update applied; exiting so the logon task starts the new agent');
      handle.close().finally(() => exit(0));
    });
    return updating;
  };
  const ready = agent.heartbeatOnce().then(() => { updateTick(); });
  const timer = setInterval(() => { agent.heartbeatOnce().then(updateTick, () => {}); }, intervalMs);
  timer.unref();
  // One tick per interval; the shipper itself skips while a ship is in flight or backing off.
  // A skipped tick resolves at once, so `shipping` joins every tick for close() to await the real ship.
  let shipping = Promise.resolve();
  const shipTimer = setInterval(() => {
    shipping = Promise.all([shipping, agent.shipTick().catch(() => {})]).then(() => {});
  }, shipTickMs);
  shipTimer.unref();
  // Same shape as the ship tick: a skipped tick resolves at once, so `mirroring` joins every tick.
  let mirroring = Promise.resolve();
  const mirrorTimer = setInterval(() => {
    mirroring = Promise.all([mirroring, agent.mirrorTick().catch((e) => log(`[tap-agent] mirror tick failed: ${e.message}`))]).then(() => {});
  }, mirrorTickMs);
  mirrorTimer.unref();
  let acting = Promise.resolve();
  const actionTimer = setInterval(() => {
    acting = Promise.all([acting, agent.actionTick().catch((e) => log(`[tap-agent] action tick failed: ${e.message}`))]).then(() => {});
  }, actionTickMs);
  actionTimer.unref();
  let gitScanning = Promise.resolve();
  const gitTimer = setInterval(() => {
    gitScanning = Promise.all([gitScanning, agent.gitTick().catch((e) => log(`[tap-agent] git tick failed: ${e.message}`))]).then(() => {});
  }, gitTickMs);
  gitTimer.unref();
  const drainTimer = setInterval(() => { if (relay.queueDepth()) relay.drain().catch(() => {}); }, drainMs);
  drainTimer.unref();
  let closing = null;
  handle = {
    address: server.address(), ready, status: agent.status, heartbeatOnce: agent.heartbeatOnce, shipTick: agent.shipTick, mirrorTick: agent.mirrorTick, actionTick: agent.actionTick, gitTick: agent.gitTick, spool: agent.spool, relay,
    updateTick,
    close: () => {
      closing ??= (async () => {
        clearInterval(timer); clearInterval(shipTimer); clearInterval(mirrorTimer); clearInterval(actionTimer); clearInterval(gitTimer); clearInterval(drainTimer);
        await ready; await shipping; await mirroring; await acting; await gitScanning; await updating;
        await new Promise((r) => { server.close(r); server.closeAllConnections?.(); });
      })();
      return closing;
    },
  };
  return handle;
}

export async function runOnce(opts = {}) {
  const agent = createAgent(opts);
  await agent.heartbeatOnce();
  return agent.status();
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  if (process.argv.includes('--once')) {
    const doc = await runOnce();
    process.stdout.write(`${JSON.stringify(doc)}\n`);
    process.exit(doc.state === 'paired' ? 0 : 1);
  } else {
    try { await startAgent({}); } catch (e) {
      console.error(`[tap-agent] ${e.code ?? 'error'}: ${e.message}`);
      process.exit(1);
    }
  }
}
