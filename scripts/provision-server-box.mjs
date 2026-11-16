#!/usr/bin/env node
// Provisions this Windows PC as the GLMPS server box for local-only remote access (spec
// docs/specs/2026-11-10-glmps-2-0-171-local-only-mtls.md): a name-constrained home CA and server
// certificate (or a provided enterprise certificate), the client-issuing CA, an inbound
// firewall rule on the Private profile, and the kernel bound to this PC's private address
// with TLS. Report only by default; --apply acts (from an elevated terminal); --rollback
// (+ --apply) returns the bind to loopback; --lan-ip <addr> overrides the detected address;
// --json prints the step array. Re-run it after each operator step.
// Exit: 0 all done, 2 something needs the operator, 1 error.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { execFile } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isPrivateAddress, remoteBindPolicy } from '../server/lib/governance/access-guard.js';
import { configFileFor } from '../server/lib/paths.js';
import { resolveStateDir } from '../server/lib/state-dir.js';
import { snapshotConfig } from '../server/lib/config-snapshot.js';
import { hasCriticalNameConstraints, certFingerprint } from '../server/lib/kernel/x509-lite.js';
import {
  tlsPaths, tlsConfigured, ensureClientCa, ensureHomeServerTls, loadServerTls,
} from '../server/lib/kernel/tls-material.js';
import crypto from 'node:crypto';

const PORT = 8123;
const RULE_NAME = `GLMPS Dashboard ${PORT}`;
const OBSOLETE_KEYS = ['remotePlaintextAcknowledged', 'tailscaleCli'];
const SIGNIN_WINDOW_MS = 10 * 60 * 1000;
const RENEW_WINDOW_MS = 30 * 86400000;
const ELEVATE = 'rerun from an elevated terminal; nothing was changed';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const RESTART = 'The kernel needs a restart to pick this up: dashboard settings gear > Restart server.';

const step = (id, title, status, detail = '') => ({ id, title, status, detail });

export function parseManageBde(text) {
  const t = String(text ?? '');
  if (/denied/i.test(t)) return { state: 'denied' };
  const m = /Protection Status:\s*Protection\s+(On|Off)/i.exec(t);
  return m ? { state: m[1].toLowerCase() } : { state: 'unknown' };
}

export function planConfigChange(config, { lanIp } = {}) {
  const base = config ?? {};
  if (!lanIp || !isPrivateAddress(lanIp)) return { ok: false, reason: `${lanIp || 'no address'} is not a private address literal` };
  if (base.tls !== undefined && !tlsConfigured(base.tls)) {
    return { ok: false, reason: 'config.json has a tls block that is incomplete (provided needs certFile and keyFile); fix or remove it, then rerun' };
  }
  const tls = tlsConfigured(base.tls) ? base.tls : { source: 'home' };
  const policy = remoteBindPolicy({ bindHost: lanIp, tls: true });
  if (!policy.allow) return { ok: false, reason: policy.reason };
  const next = { ...base, host: lanIp, tls };
  for (const k of OBSOLETE_KEYS) delete next[k];
  return { ok: true, changed: !isDeepStrictEqual(next, base), next };
}

export function planRollback(config) {
  const next = { ...config };
  delete next.host;
  delete next.tls;
  return { changed: 'host' in (config ?? {}) || 'tls' in (config ?? {}), next };
}

export function evaluateShellStart({ runValue, explorerStart, shellStart } = {}) {
  if (!runValue) return { status: 'needs-operator', detail: 'autostart value dev.glmps.shell2 is missing from HKCU Run; launch the desktop app once' };
  if (!shellStart) return { status: 'needs-operator', detail: 'autostart is set but the desktop shell is not running' };
  const e = Date.parse(explorerStart);
  const s = Date.parse(shellStart);
  if (!Number.isFinite(e) || !Number.isFinite(s)) return { status: 'needs-operator', detail: 'could not read process start times' };
  if (s - e <= SIGNIN_WINDOW_MS) return { status: 'done', detail: `shell started ${Math.round((s - e) / 1000)} s after sign-in` };
  return { status: 'needs-operator', detail: 'the shell was restarted since sign-in, so this check needs a fresh sign-in (sign out, sign in, rerun)' };
}

export function evaluatePickup({ alerts, health } = {}) {
  const list = Array.isArray(alerts) ? alerts : (alerts?.alerts ?? []);
  const stats = JSON.stringify(health?.shell?.pickup ?? null);
  const info = `pickup ${stats}, kernel uptime ${health?.uptime_s ?? '?'} s (samples reset on every kernel restart)`;
  if (list.some((a) => a?.source === 'shell-pickup')) return { status: 'needs-operator', detail: `slow-pickup alert is raised; ${info}` };
  return { status: 'done', detail: `no slow-pickup alert; ${info}` };
}

const defaultRun = (cmd, args, { timeout = 30000 } = {}) => new Promise((resolve) => {
  execFile(cmd, args, { timeout, windowsHide: true, encoding: 'utf8', maxBuffer: 4 << 20 }, (err, stdout, stderr) => {
    resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: stdout ?? '', stderr: stderr ?? '', error: err?.code === 'ENOENT' ? 'ENOENT' : undefined });
  });
});

const defaultRequest = ({ host, port, path: p = '/', ca }) => new Promise((resolve, reject) => {
  const req = https.request({ host, port, path: p, ca, method: 'GET', timeout: 5000 }, (res) => {
    res.resume();
    resolve({ status: res.statusCode });
  });
  req.on('timeout', () => req.destroy(new Error('timeout')));
  req.on('error', reject);
  req.end();
});

const safeJson = (t) => { try { return JSON.parse(t); } catch { return undefined; } };
const psq = (s) => `'${String(s).replaceAll("'", "''")}'`;
const ps = (run, script) => run('powershell.exe', ['-NoProfile', '-Command', script]);
const failed = (r) => (r.stderr || r.stdout || `exit ${r.code}`).replace(/[\u0000\r]/g, '').trim().slice(0, 300);

function readConfig(configPath) {
  if (!fs.existsSync(configPath)) return { config: {}, existed: false };
  try { return { config: JSON.parse(fs.readFileSync(configPath, 'utf8')), existed: true }; } catch (e) { return { error: e.message }; }
}

function writeConfig(configPath, next, existed, now, stateDir) {
  const backup = existed ? snapshotConfig(configPath, { stateDir, now }) : null;
  fs.writeFileSync(configPath, JSON.stringify(next, null, 2) + '\n');
  return backup;
}

async function bitlocker(run, drive) {
  const r = await run('manage-bde', ['-status', `${drive}:`]);
  const parsed = parseManageBde(`${r.stdout}\n${r.stderr}`);
  const fb = await ps(run, `(New-Object -ComObject Shell.Application).NameSpace('${drive}:\\').Self.ExtendedProperty('System.Volume.BitLockerProtection')`);
  const v = fb.stdout.trim();
  return { state: parsed.state, fallback: v === '1' ? 'on' : v === '' ? 'unreadable' : `code ${v}` };
}

const TRUST_HOWTO = (file, fp) => [
  `Home CA SHA-256 fingerprint: ${fp}`,
  `Trust it on each device that opens the dashboard, from ${file}:`,
  '  Another Windows PC: certutil -addstore -user Root home-ca.pem (or double-click, Install Certificate, Trusted Root Certification Authorities).',
  '  iPhone: send home-ca.pem to the phone, open it, Install Profile, then Settings > General > About > Certificate Trust Settings and turn on full trust.',
  '  Android: Settings > Security > Install a certificate > CA certificate.',
  'This CA is name-constrained to private addresses and glmps.internal, so it cannot vouch for any public site.',
].join('\n');

const certOk = (pem, ip, caPem, now) => {
  try {
    const c = new crypto.X509Certificate(pem);
    return !!c.checkIP(ip) && c.checkIssued(new crypto.X509Certificate(caPem)) && Date.parse(c.validTo) > now.getTime() + RENEW_WINDOW_MS;
  } catch { return false; }
};

function tlsStep({ apply, lanIp, cfg, stateDir, now }) {
  const title = 'Server-trust CA and certificate';
  if (!lanIp) return step('tls', title, 'blocked', 'needs a private LAN address first');
  const tls = cfg.config?.tls;
  const serving = !!cfg.config && isPrivateAddress(cfg.config.host ?? '') && tlsConfigured(tls);
  if (tlsConfigured(tls) && tls.source === 'provided') {
    // Throwaway state dir: loadServerTls would otherwise create the client CA as a side effect.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'glmps-tlscheck-'));
    try {
      const m = loadServerTls({ tls, stateDir: tmp });
      const left = Math.floor((m.serverNotAfter - now.getTime()) / 86400000);
      if (left < 0) return step('tls', title, 'needs-operator', 'the provided server certificate has expired; replace it, then restart the kernel');
      return step('tls', title, 'done', `provided certificate loads; expires in ${left} days; trust anchor SHA-256 ${m.trustFingerprint}`);
    } catch (e) { return step('tls', title, 'blocked', `provided TLS files do not load: ${e.message}`); } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  }
  const p = tlsPaths(stateDir);
  const have = [p.homeCaCert, p.homeCaKey, p.serverCert, p.serverKey].map((f) => fs.existsSync(f));
  if (have[0] !== have[1]) return step('tls', title, 'blocked', `${have[0] ? 'home-ca.key' : 'home-ca.pem'} is missing from ${p.dir}; the CA is never regenerated over a half-present one`);
  if (have[0]) {
    try {
      if (!hasCriticalNameConstraints(fs.readFileSync(p.homeCaCert, 'utf8'))) {
        return step('tls', title, 'blocked', `the home CA in ${p.dir} has no name constraints, so it could vouch for any site; move it aside and rerun`);
      }
    } catch (e) { return step('tls', title, 'blocked', `the home CA in ${p.dir} cannot be read: ${e.message}`); }
  }
  const caPem = have[0] ? fs.readFileSync(p.homeCaCert, 'utf8') : null;
  const fine = have.every(Boolean) && certOk(fs.readFileSync(p.serverCert, 'utf8'), lanIp, caPem, now);
  if (fine) return step('tls', title, 'done', `server certificate covers ${lanIp}\n${TRUST_HOWTO(p.homeCaCert, certFingerprint(caPem))}`);
  const willDo = `${have[0] ? 'keep the home CA, ' : 'create the home CA, '}issue a server certificate for ${lanIp}`;
  if (!apply) return step('tls', title, 'apply-will-do', `${willDo} under ${p.dir}${serving ? `. ${RESTART}` : ''}`);
  try {
    const r = ensureHomeServerTls({ stateDir, ips: [lanIp], now });
    return step('tls', title, 'done', `${willDo}${serving ? `. ${RESTART}` : ''}\n${TRUST_HOWTO(r.paths.homeCaCert, r.caFingerprint)}`);
  } catch (e) { return step('tls', title, 'blocked', e.message); }
}

function clientCaStep({ apply, stateDir, now }) {
  const title = 'Client-issuing CA';
  const p = tlsPaths(stateDir);
  const [c, k] = [p.clientCaCert, p.clientCaKey].map((f) => fs.existsSync(f));
  if (c !== k) return step('client-ca', title, 'blocked', `${c ? 'client-ca.key' : 'client-ca.pem'} is missing from ${p.dir}; the CA is never regenerated over a half-present one`);
  if (c) return step('client-ca', title, 'done', `${p.clientCaCert} (used only to sign tap certificates, never installed in an OS store)`);
  if (!apply) return step('client-ca', title, 'apply-will-do', `create the GLMPS client CA under ${p.dir}`);
  try { ensureClientCa(stateDir, { now }); } catch (e) { return step('client-ca', title, 'blocked', e.message); }
  return step('client-ca', title, 'done', `created ${p.clientCaCert}`);
}

// The firewall rule is Private-only on purpose, so on a network Windows calls
// Public it is inert and other devices cannot connect. Only reported: choosing
// a network's profile is the operator's call, and it does not block the bind.
async function networkStep({ run, lanIp }) {
  const title = 'Network profile of the LAN adapter';
  if (!lanIp) return step('network', title, 'blocked', 'needs a LAN address first');
  const r = await ps(run, `(Get-NetIPAddress -IPAddress ${psq(lanIp)} -ErrorAction Stop | Get-NetConnectionProfile -ErrorAction Stop).NetworkCategory`);
  const cat = r.code === 0 ? r.stdout.trim() : '';
  if (cat === 'Private' || cat === 'DomainAuthenticated') return step('network', title, 'done', `${cat}: the Private-only firewall rule applies`);
  if (cat === 'Public') {
    return step('network', title, 'needs-operator', 'Public: Windows treats this network as untrusted, so the Private-only firewall rule does not apply and other devices cannot reach the dashboard. '
      + 'If this is your home or office network, set it to Private: Settings > Network & internet > (the adapter) > Network profile type > Private network, '
      + 'or in an elevated terminal Set-NetConnectionProfile -InterfaceAlias <adapter> -NetworkCategory Private. This script never changes it.');
  }
  return step('network', title, 'needs-operator', `could not read the network profile for ${lanIp} (${cat || failed(r)}); check it in Settings > Network & internet`);
}

// The server refuses a non-loopback bind without this file (and never makes one
// itself), so the bind must not be written before it exists. The value is never
// printed: the operator reads the file to sign in from another device.
function tokenStep({ apply, stateDir }) {
  const title = 'Remote access token';
  const file = path.join(stateDir, 'access-token');
  if (fs.existsSync(file)) {
    let have = '';
    try { have = fs.readFileSync(file, 'utf8').trim(); } catch (e) { return step('token', title, 'blocked', `${file} is unreadable: ${e.message}`); }
    return have
      ? step('token', title, 'done', `${file} exists (open it to copy the token for signing in from another device)`)
      : step('token', title, 'blocked', `${file} is empty, so the server would refuse the bind; delete it to have one created, or put a token in it`);
  }
  if (!apply) return step('token', title, 'apply-will-do', `create a random token in ${file} (needed before the server accepts a LAN bind)`);
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(file, crypto.randomBytes(32).toString('base64url') + '\n', { flag: 'wx', mode: 0o600 });
  } catch (e) { return step('token', title, 'blocked', `could not create ${file}: ${e.message}`); }
  return step('token', title, 'done', `created ${file} (open it to copy the token for signing in from another device)`);
}

async function lanStep({ run, override }) {
  const title = 'LAN address';
  let ip = override;
  let how = 'from --lan-ip';
  if (ip === undefined) {
    const r = await ps(run, '$r = Get-NetRoute -DestinationPrefix 0.0.0.0/0 | Sort-Object RouteMetric | Select-Object -First 1; '
      + '(Get-NetIPAddress -InterfaceIndex $r.ifIndex -AddressFamily IPv4 | Select-Object -First 1).IPAddress');
    ip = r.stdout.trim();
    how = 'default-route interface';
  }
  if (!ip || !isPrivateAddress(ip)) return { step: step('lan', title, 'blocked', `${ip || 'no address found'} is not a private address literal; pass --lan-ip <addr> if the detection picked the wrong adapter`) };
  return { ip, step: step('lan', title, 'done', `${ip} (${how})`) };
}

async function firewallStep({ run, apply, elevated }) {
  const title = `Firewall rule ${RULE_NAME}`;
  const q = await ps(run, `$r = Get-NetFirewallRule -DisplayName ${psq(RULE_NAME)} -ErrorAction SilentlyContinue | Select-Object -First 1; `
    + 'if ($r) { $p = $r | Get-NetFirewallPortFilter; [pscustomobject]@{ Profile = [string]$r.Profile; Port = [string]$p.LocalPort; '
    + 'Enabled = [string]$r.Enabled; Direction = [string]$r.Direction } | ConvertTo-Json -Compress }');
  const rule = q.stdout.trim() ? safeJson(q.stdout.trim()) : null;
  if (rule === undefined) return step('firewall', title, 'needs-operator', 'could not read the firewall rule; rerun in an elevated terminal');
  const gate = (willDo) => {
    if (!apply) return step('firewall', title, 'apply-will-do', willDo);
    if (!elevated) return step('firewall', title, 'needs-operator', `${ELEVATE}. Would: ${willDo}`);
    return null;
  };
  if (rule) {
    if (String(rule.Port) !== String(PORT) || (rule.Direction && rule.Direction !== 'Inbound')) {
      return step('firewall', title, 'needs-operator', `a rule named ${RULE_NAME} exists but is not inbound TCP ${PORT}; delete it (Remove-NetFirewallRule -DisplayName "${RULE_NAME}") and rerun`);
    }
    const good = rule.Profile === 'Private' && (rule.Enabled === undefined || rule.Enabled === 'True');
    if (good) return step('firewall', title, 'done', `TCP ${PORT} inbound, Private profile only`);
    const g = gate(`set ${RULE_NAME} to the Private profile and enable it (it is ${rule.Profile}, enabled ${rule.Enabled})`);
    if (g) return g;
    const a = await ps(run, `Set-NetFirewallRule -DisplayName ${psq(RULE_NAME)} -Profile Private -Enabled True`);
    return a.code === 0 ? step('firewall', title, 'done', 'corrected to the Private profile') : step('firewall', title, 'needs-operator', `Set-NetFirewallRule failed: ${failed(a)}`);
  }
  const g = gate(`allow inbound TCP ${PORT} on the Private profile only`);
  if (g) return g;
  const a = await ps(run, `New-NetFirewallRule -DisplayName ${psq(RULE_NAME)} -Direction Inbound -Protocol TCP -LocalPort ${PORT} -Profile Private -RemoteAddress LocalSubnet -Action Allow | Out-Null`);
  return a.code === 0 ? step('firewall', title, 'done', `created: TCP ${PORT} inbound, Private profile, local subnet`) : step('firewall', title, 'needs-operator', `New-NetFirewallRule failed: ${failed(a)}`);
}

async function kernelStep({ doFetch, request, hostNow, stateDir, tls }) {
  const title = 'Kernel live on the new bind';
  let health;
  try { health = await (await doFetch(`http://127.0.0.1:${PORT}/healthz`, { signal: AbortSignal.timeout(5000) })).json(); } catch (e) {
    return step('kernel', title, 'needs-operator', `loopback /healthz unreachable (${e.cause?.code || e.message}); check the GLMPS2 service`);
  }
  if (health?.status !== 'up') return step('kernel', title, 'needs-operator', `loopback /healthz status ${health?.status}`);
  if (!hostNow) return step('kernel', title, 'blocked', 'loopback is up; the private bind is not configured yet');
  let ca;
  try {
    const file = tls?.source === 'provided' ? tls.chainFile : tlsPaths(stateDir).homeCaCert;
    if (file) ca = fs.readFileSync(file, 'utf8');
  } catch { ca = undefined; }
  const get = async (p) => { try { return await request({ host: hostNow, port: PORT, path: p, ca }); } catch (e) { return { error: e.code || e.message }; } };
  const page = await get('/');
  if (page.error) return step('kernel', title, 'needs-operator', `https://${hostNow}:${PORT} did not answer with the home CA as the only trust (${page.error}): restart the kernel (dashboard settings gear > Restart server), then rerun`);
  const api = await get('/api/state');
  if (page.status !== 200 || api.status !== 401) return step('kernel', title, 'needs-operator', `on https://${hostNow}:${PORT}: / gave ${page.status}, /api/state gave ${api.status ?? api.error} (expected 200 and 401)`);
  return step('kernel', title, 'done', `loopback /healthz is up; https://${hostNow}:${PORT} serves the page (200) and refuses /api/state without a token (401)`);
}

async function shellStep(run) {
  const script = "$o=@{run=$null;explorer=$null;shell=$null};"
    + "$e=Get-Process explorer -ErrorAction SilentlyContinue|Sort-Object StartTime|Select-Object -First 1;"
    + "if($e){$o.explorer=$e.StartTime.ToUniversalTime().ToString('o')};"
    + "$s=Get-Process 'GLMPS 2.0' -ErrorAction SilentlyContinue|Sort-Object StartTime|Select-Object -First 1;"
    + "if($s){$o.shell=$s.StartTime.ToUniversalTime().ToString('o')};"
    + "$o.run=(Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name 'dev.glmps.shell2' -ErrorAction SilentlyContinue).'dev.glmps.shell2';"
    + '$o|ConvertTo-Json -Compress';
  const r = await ps(run, script);
  const j = safeJson(r.stdout.trim());
  const title = 'Desktop shell started at sign-in';
  if (!j) return step('shell', title, 'needs-operator', 'could not read process or autostart state');
  const ev = evaluateShellStart({ runValue: j.run, explorerStart: j.explorer, shellStart: j.shell });
  return step('shell', title, ev.status, ev.detail);
}

async function pickupStep(doFetch) {
  const title = 'No slow-pickup alert';
  const get = async (p) => { try { const r = await doFetch(`http://127.0.0.1:${PORT}${p}`, { signal: AbortSignal.timeout(8000) }); return await r.json(); } catch { return null; } };
  const [health, alerts] = await Promise.all([get('/healthz'), get('/api/alerts')]);
  if (!health || alerts === null) return step('pickup', title, 'needs-operator', 'could not read /healthz or /api/alerts from the kernel');
  const ev = evaluatePickup({ alerts, health });
  return step('pickup', title, ev.status, ev.detail);
}

export async function runProvision({
  argv = [], run = defaultRun, fetch: doFetch = globalThis.fetch, env = process.env, request = defaultRequest,
  configPath = configFileFor({ env }), stateDir = resolveStateDir({ env }), now = () => new Date(),
} = {}) {
  const apply = argv.includes('--apply');
  const out = [];
  const say = (s = '') => out.push(s);
  const finish = (steps, exitCode) => (argv.includes('--json')
    ? { steps, exitCode, output: JSON.stringify(steps, null, 2) }
    : { steps, exitCode, output: out.join('\n') });

  if (argv.includes('--rollback')) {
    const cur = readConfig(configPath);
    if (cur.error) return finish([step('rollback', 'Roll back to loopback', 'blocked', `config unreadable: ${cur.error}`)], 1);
    const plan = planRollback(cur.config);
    let detail = plan.changed ? 'would remove host and tls from config.json (rerun with --apply)' : 'already on loopback, nothing to remove';
    if (plan.changed && apply) {
      const bak = writeConfig(configPath, plan.next, cur.existed, now, stateDir);
      detail = `removed host and tls, backup ${bak}. ${RESTART}`;
    }
    say(`rollback: ${detail}`);
    return finish([step('rollback', 'Roll back to loopback', plan.changed && !apply ? 'apply-will-do' : 'done', detail)], 0);
  }

  const steps = [];
  const elevated = (await run('net', ['session'])).code === 0;
  if (!apply) steps.push(step('elevation', 'Elevated terminal', 'done', elevated ? 'elevated' : 'not elevated: report only is fine, --apply needs an elevated terminal'));
  else steps.push(elevated ? step('elevation', 'Elevated terminal', 'done', 'elevated') : step('elevation', 'Elevated terminal', 'needs-operator', ELEVATE));

  const lanIdx = argv.indexOf('--lan-ip');
  const lan = await lanStep({ run, override: lanIdx >= 0 ? argv[lanIdx + 1] : undefined });
  steps.push(lan.step);
  const cfg = readConfig(configPath);
  const at = now();
  const tls = tlsStep({ apply, lanIp: lan.ip, cfg, stateDir, now: at });
  const clientCa = clientCaStep({ apply, stateDir, now: at });
  const token = tokenStep({ apply, stateDir });
  const fw = await firewallStep({ run, apply, elevated });
  steps.push(tls, clientCa, token, fw, await networkStep({ run, lanIp: lan.ip }));

  const drive = (p) => (path.parse(path.resolve(p)).root[0] || 'C').toUpperCase();
  const sd = drive(stateDir);
  const rd = drive(path.join(HERE, '..'));
  const bl = await bitlocker(run, sd);
  let blStep;
  if (bl.state === 'on') blStep = step('bitlocker', `BitLocker on ${sd}:`, 'done', 'Protection On');
  else if (bl.state === 'off') blStep = step('bitlocker', `BitLocker on ${sd}:`, 'needs-operator', 'Protection Off. Turn on in Settings > Privacy & security > Device encryption (Windows 11 Home has no manage-bde route; this script never enables it)');
  else blStep = step('bitlocker', `BitLocker on ${sd}:`, 'needs-operator', `manage-bde ${bl.state === 'denied' ? 'was denied' : 'gave no reading'}: rerun this in an elevated terminal. Non-elevated fallback reading: ${bl.fallback}`);
  if (rd !== sd) {
    const b2 = await bitlocker(run, rd);
    blStep.detail += ` | runtime checkout volume ${rd}: ${b2.state === 'unknown' || b2.state === 'denied' ? `fallback ${b2.fallback}` : b2.state} (informational)`;
  }
  steps.push(blStep);

  // Written last: the bind never widens before the TLS files, the access token and the firewall rule exist.
  const prereqs = [lan.step, tls, clientCa, token, fw];
  const ready = prereqs.every((s) => s.status === 'done' || (!apply && s.status === 'apply-will-do'));
  let hostNow = null;
  let tlsNow = cfg.config?.tls;
  if (cfg.error) steps.push(step('config', 'config.json bind', 'blocked', `config unreadable: ${cfg.error}`));
  else if (!ready) steps.push(step('config', 'config.json bind', 'blocked', `blocked until ${prereqs.filter((s) => s.status !== 'done').map((s) => s.id).join(', ')} ${apply ? 'are done' : 'can run'}, so the bind never widens before TLS, the access token and the firewall rule are in place`));
  else {
    const plan = planConfigChange(cfg.config, { lanIp: lan.ip });
    if (!plan.ok) steps.push(step('config', 'config.json bind', 'blocked', plan.reason));
    else if (!plan.changed) { hostNow = cfg.config.host; steps.push(step('config', 'config.json bind', 'done', `host ${cfg.config.host}, tls ${cfg.config.tls.source}`)); }
    else if (!apply) steps.push(step('config', 'config.json bind', 'apply-will-do', `set host ${lan.ip}, tls ${plan.next.tls.source}; remove obsolete keys ${OBSOLETE_KEYS.join(', ')} in ${configPath} (backup first)`));
    else {
      const bak = writeConfig(configPath, plan.next, cfg.existed, now, stateDir);
      hostNow = lan.ip;
      tlsNow = plan.next.tls;
      steps.push(step('config', 'config.json bind', 'done', `wrote ${configPath}${bak ? `, backup ${bak}` : ''}. ${RESTART}`));
    }
  }

  steps.push(await kernelStep({ doFetch, request, hostNow, stateDir, tls: tlsNow }));
  steps.push(await shellStep(run));
  steps.push(await pickupStep(doFetch));

  for (const s of steps) { say(`[${s.status}] ${s.id}: ${s.title}`); if (s.detail) say(s.detail.split('\n').map((l) => `    ${l}`).join('\n')); }
  say('');
  say(apply ? 'Mode: apply.' : 'Mode: report only (add --apply to act). Rollback: --rollback --apply.');
  return finish(steps, steps.every((s) => s.status === 'done') ? 0 : 2);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runProvision({ argv: process.argv.slice(2) }).then((r) => {
    console.log(r.output);
    process.exitCode = r.exitCode;
  }, (e) => {
    console.error(`provision-server-box failed: ${e?.message || e}`);
    process.exitCode = 1;
  });
}
