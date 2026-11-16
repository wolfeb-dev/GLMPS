// taps/tap-setup.mjs - the client tap installer (server-and-client-tap task 7).
// glmps-tap-setup.exe extracts its payload and runs this from it:
//   node.exe taps\tap-setup.mjs --installer <the exe's own path> [--code C] [--fingerprint F] [--name N] [--port P] [--server URL] [--no-start]
//   node.exe taps\tap-setup.mjs --uninstall
// It verifies the payload's signed catalog, refuses a taken tap port, pins the
// server's CA by the fingerprint the dashboard shows, pairs with a key pair made
// here, copies the payload into the tap home, stores the token and the key with
// DPAPI beside the client certificate and the pinned CA, installs the
// hooks and statusline through the bundled scripts/install.mjs (its backup and
// refusal rules unchanged), registers the logon task and starts the agent.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tapHome, DEFAULT_PORT } from './tap-agent-lib.js';
import crypto from 'node:crypto';
import { writeToken, writeClientKey } from './tap-token.js';
import { createTapFetch, probeServerChain, tapKeyPair, pinFromChain, normalizeFingerprint, groupFingerprint, writePem, certFile, caFile } from './tap-tls.js';
import { readPin, verifyTapPayload } from './tap-signature.js';
import { LOGON_TASK_NAME, planLogonTask, applyLogonTask } from './tap-logon-task.js';
import { parseArgs, resolveServer, normalizeCode, normalizeName, pairRequest, pairRefusalText, listeningPid, imageFromTasklist, portDecision } from './tap-setup-lib.js';

export const TAP_SETUP_VERSION = '0.1.0';
const STATUS_WAIT_MS = 20_000;

// This file sits at <payload>/taps/tap-setup.mjs (the bundle keeps repo layout).
const PAYLOAD_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

class SetupRefusal extends Error {}
const refuse = (m) => { throw new SetupRefusal(m); };
const isLoopback = (h) => ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(h);

async function agentStatus(fetchFn, port) {
  try {
    const r = await fetchFn(`http://127.0.0.1:${port}/tap/status`, { signal: AbortSignal.timeout(2000) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

// Ending the task kills only the conhost --headless wrapper; its node.exe child
// keeps running and holding the port, so the agent is stopped by that process too,
// once it has answered /tap/status as the tap agent.
async function stopAgent({ run, fetch: fetchFn, sleep }, port) {
  run('schtasks.exe', ['/End', '/TN', LOGON_TASK_NAME]);
  const pid = listeningPid(run('netstat.exe', ['-ano', '-p', 'TCP']).stdout, port);
  if (pid != null && (await agentStatus(fetchFn, port))?.agent === 'glmps-tap') run('taskkill.exe', ['/PID', String(pid), '/T', '/F']);
  return waitFor(() => listeningPid(run('netstat.exe', ['-ano', '-p', 'TCP']).stdout, port) == null, 10_000, sleep);
}

async function waitFor(fn, ms, sleep) {
  for (let waited = 0; ; waited += 500) {
    const v = await fn();
    if (v || waited >= ms) return v;
    await sleep(500);
  }
}

export async function runSetup(argv, deps) {
  const { log, fetch: fetchFn, prompt, run, verify, writeToken: writeTokenFn, env, sleep } = deps;
  const writeClientKeyFn = deps.writeClientKey ?? writeClientKey;
  const probeChain = deps.probeChain ?? ((url) => probeServerChain(url));
  const generateKeyPair = deps.generateKeyPair ?? tapKeyPair;
  const parsed = parseArgs(argv);
  if (!parsed.ok) refuse(parsed.reason);
  const o = parsed.opts;
  const home = deps.home ?? tapHome(env);
  if (o.uninstall) return runUninstall({ home, deps });

  const source = path.resolve(o.source ?? deps.payloadRoot ?? PAYLOAD_ROOT);
  const srv = resolveServer(o);
  if (!srv.ok) refuse(srv.reason);
  const su = new URL(srv.server);
  if (isLoopback(su.hostname) && Number(su.port || 80) === o.port) refuse(`${srv.server} is this machine's own tap port; the installer must name the GLMPS server`);

  let pin;
  try { pin = readPin(source); } catch (e) { refuse(`the installer payload has no usable signer pin (${e.message})`); }
  const v = verifyTapPayload(source, { pin, verify, platform: deps.platform });
  if (!v.ok) refuse(`the installer payload failed its signature check: ${v.reason}`);
  log(`Payload signature: ${v.result.signature} by ${v.result.subject} (${pin.thumbprint}, ${pin.mode} certificate)`);

  const pid = listeningPid(run('netstat.exe', ['-ano', '-p', 'TCP']).stdout, o.port);
  const image = pid == null ? null : imageFromTasklist(run('tasklist.exe', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']).stdout);
  const port = portDecision({ port: o.port, pid, image, agentStatus: pid == null ? null : await agentStatus(fetchFn, o.port) });
  if (!port.ok) refuse(port.reason);

  log(`This installer pairs with ${srv.server}`);
  const code = normalizeCode(o.code ?? await prompt('Pairing code (from the dashboard, Settings, Add a client): '));
  if (!code) refuse('that is not a pairing code: it is 8 letters and digits, shown next to the download link');
  // Pinned trust (card glmps-2-0-runtime-147): over https the server's chain must hold
  // the CA whose fingerprint the dashboard showed, before the code is sent.
  let trust = null;
  if (su.protocol === 'https:') {
    const fingerprint = normalizeFingerprint(o.fingerprint ?? await prompt('Server fingerprint (from the dashboard, under the pairing code): '));
    if (!fingerprint) refuse('that is not a server fingerprint: it is 64 letters and digits, shown under the pairing code');
    let chain;
    try { chain = await probeChain(srv.server); }
    catch (e) { refuse(`could not reach ${srv.server} (${e?.code || e.message}); check that this machine is on the same network as the server`); }
    const pin = pinFromChain(chain, fingerprint);
    if (!pin.ok) refuse(pin.reason);
    trust = { ca: pin.caPem, fingerprint };
    log(`Server certificate authority matches ${groupFingerprint(fingerprint)}`);
  }
  const fallbackName = env.COMPUTERNAME || os.hostname();
  const name = normalizeName(o.name ?? await prompt(`Client name [${fallbackName}]: `), fallbackName);
  if (!name) refuse('a client name is 1 to 64 printable characters');

  const keys = generateKeyPair();
  const req = pairRequest({ server: srv.server, code, name, tapVersion: TAP_SETUP_VERSION, publicKey: keys.publicKeyPem });
  let res;
  try { res = await fetchFn(req.url, { method: req.method, headers: req.headers, body: req.body, signal: AbortSignal.timeout(15_000), ...(trust ? { tls: { ca: trust.ca } } : {}) }); }
  catch (e) { refuse(`could not reach ${srv.server} (${e?.cause?.code || e.message}); check that this machine is on the same network as the server`); }
  const body = await res.json().catch(() => ({}));
  if (res.status !== 201 || !body.clientId || !body.token) refuse(pairRefusalText(res.status, body));
  if (typeof body.certificate !== 'string' || !body.certificate.includes('BEGIN CERTIFICATE')) refuse('the server paired this client but issued no client certificate; update the GLMPS server, then pair again with a new code');
  log(`Paired as ${body.clientId}${body.repaired ? ' (re-paired)' : ''}`);

  if (port.ownAgent) {
    log('Stopping the running tap agent to replace it');
    if (!(await stopAgent(deps, o.port))) refuse(`the old tap agent still holds port ${o.port}; the token is not stored, so pair again with a new code after stopping it`);
  }

  if (path.resolve(home) !== source) fs.cpSync(source, home, { recursive: true, force: true });
  fs.writeFileSync(path.join(home, 'tap-config.json'), JSON.stringify({ server: srv.server, clientId: body.clientId, name, port: o.port, ...(trust ? { trustFingerprint: trust.fingerprint } : {}) }, null, 2) + '\n');
  writeTokenFn(home, body.token);
  writeClientKeyFn(home, keys.privateKeyPem);
  writePem(certFile(home), body.certificate);
  if (trust) writePem(caFile(home), trust.ca);
  else fs.rmSync(caFile(home), { force: true });
  log(`Client certificate valid until ${new Date(body.certificateExpiresAt ?? Date.parse(new crypto.X509Certificate(body.certificate).validTo)).toISOString().slice(0, 10)}`);
  log(`Installed to ${home}`);

  const node = path.join(home, 'node.exe');
  const inst = run(node, [path.join(home, 'scripts', 'install.mjs')], { stdio: 'inherit' });
  if (inst.status !== 0) refuse(`installing the hooks and statusline failed (exit ${inst.status}); settings.json was left as the installer's refusal rules require`);

  if (env.GLMPS_TAP_HOME) {
    log('GLMPS_TAP_HOME is set, so the logon task (which reads the default tap home) was not registered');
    return { ok: true, clientId: body.clientId, home, task: 'skipped' };
  }
  const plan = planLogonTask({ userId: deps.currentUserSid(), nodePath: node, agentPath: path.join(home, 'taps', 'tap-agent.js') }, { queryTaskXml: deps.queryTaskXml });
  const applied = applyLogonTask(plan, { createTask: deps.createTask, log });
  if (!applied.ok) refuse(`registering the logon task failed: ${applied.reason}`);
  if (o.noStart) return { ok: true, clientId: body.clientId, home, task: 'registered' };

  const started = run('schtasks.exe', ['/Run', '/TN', LOGON_TASK_NAME]);
  if (started.status !== 0) refuse(`starting the tap agent failed: ${String(started.stderr || started.stdout).trim()}`);
  const status = await waitFor(async () => { const s = await agentStatus(fetchFn, o.port); return s && s.state !== 'unconfigured' ? s : null; }, STATUS_WAIT_MS, sleep);
  if (!status) refuse(`the tap agent did not answer on 127.0.0.1:${o.port} within ${STATUS_WAIT_MS / 1000} s; see ${path.join(home, 'logs')}`);
  log(`Tap agent: ${status.state}${status.reason ? ` (${status.reason})` : ''}`);
  return { ok: status.state === 'paired', clientId: body.clientId, home, task: 'started', state: status.state };
}

async function runUninstall({ home, deps }) {
  const { log, run } = deps;
  const node = path.join(home, 'node.exe');
  if (!fs.existsSync(node)) refuse(`no tap is installed at ${home}`);
  const inst = run(node, [path.join(home, 'scripts', 'install.mjs'), '--uninstall'], { stdio: 'inherit' });
  if (inst.status !== 0) refuse(`removing the hooks and statusline failed (exit ${inst.status})`);
  let port = DEFAULT_PORT;
  try { port = JSON.parse(fs.readFileSync(path.join(home, 'tap-config.json'), 'utf8')).port ?? DEFAULT_PORT; } catch {}
  if (!(await stopAgent(deps, port))) log(`the tap agent still holds port ${port}; end it in Task Manager`);
  const del = run('schtasks.exe', ['/Delete', '/TN', LOGON_TASK_NAME, '/F']);
  log(del.status === 0 ? `Removed ${LOGON_TASK_NAME}` : `${LOGON_TASK_NAME} was not registered`);
  log(`Left in place: ${home} (token and spool). Revoke this client in the dashboard to retire its token.`);
  return { ok: true, home };
}

export function realDeps(env = process.env) {
  // System tools by full path: another whoami (Git Bash's coreutils) earlier on PATH answered /user with an error.
  const sys32 = path.join(env.SystemRoot || 'C:\\Windows', 'System32');
  const SYSTEM_TOOLS = new Set(['whoami.exe', 'schtasks.exe', 'netstat.exe', 'tasklist.exe', 'taskkill.exe']);
  const run = (cmd, args, opts = {}) => spawnSync(SYSTEM_TOOLS.has(cmd) ? path.join(sys32, cmd) : cmd, args, { encoding: 'utf8', windowsHide: true, ...opts });
  return {
    env, log: (m) => console.log(m), fetch: createTapFetch(), run, writeToken, writeClientKey,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    prompt: async (q) => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      try { return await rl.question(q); } finally { rl.close(); }
    },
    queryTaskXml: (name) => {
      const r = run('schtasks.exe', ['/Query', '/TN', name, '/XML']);
      if (r.error) return { state: 'unknown', reason: r.error.message };
      if (r.status === 0) return { state: 'present', xml: r.stdout };
      const out = String(r.stderr || r.stdout || '').trim();
      return /cannot find/i.test(out) ? { state: 'absent' } : { state: 'unknown', reason: `schtasks exited ${r.status}: ${out.slice(0, 300)}` };
    },
    currentUserSid: () => {
      const sid = String(run('whoami.exe', ['/user', '/fo', 'csv', '/nh']).stdout || '').match(/S-1-[0-9-]+/);
      if (!sid) throw new SetupRefusal('whoami /user gave no SID');
      return sid[0];
    },
    // schtasks reads /XML as the UTF-16 its declaration names.
    createTask: (xml) => {
      const tmp = path.join(os.tmpdir(), `glmps-tap-task-${process.pid}.xml`);
      fs.writeFileSync(tmp, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, 'utf16le')]));
      try {
        const r = run('schtasks.exe', ['/Create', '/TN', LOGON_TASK_NAME, '/XML', tmp, '/F']);
        return r.error ? { ok: false, reason: r.error.message }
          : r.status !== 0 ? { ok: false, reason: `schtasks /Create exited ${r.status}: ${String(r.stderr || r.stdout).trim().slice(0, 300)}` } : { ok: true };
      } finally { fs.rmSync(tmp, { force: true }); }
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  if (process.platform !== 'win32') { console.error('GLMPS tap setup: Windows only for now'); process.exit(1); }
  runSetup(process.argv.slice(2), realDeps()).then((r) => {
    console.log(r.ok ? 'GLMPS tap: done.' : 'GLMPS tap: installed, but the agent is not paired yet; see above.');
    process.exitCode = r.ok ? 0 : 1;
  }, (e) => {
    if (!(e instanceof SetupRefusal)) throw e;
    console.error(`GLMPS tap: ${e.message}. Setup stopped at this step.`);
    process.exitCode = 2;
  });
}
