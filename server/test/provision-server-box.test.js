import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseManageBde, planConfigChange, planRollback, evaluateShellStart, evaluatePickup, runProvision,
} from '../../scripts/provision-server-box.mjs';
import { tlsPaths, ensureHomeServerTls } from '../lib/kernel/tls-material.js';

const DENIED = 'ERROR: An attempt to access a required resource was denied.\n';
const BDE_ON = 'Volume C: [OS]\n    Conversion Status:    Used Space Only Encrypted\n    Protection Status:    Protection On\n';
const LAN = '192.168.1.50';
const RULE = 'GLMPS Dashboard 8123';
const NOW = new Date('2026-11-10T17:00:00Z');

function mkEnv({
  config = { port: 8123, other: { keep: [1, 2] } }, bde = BDE_ON, elevated = true, lan = LAN,
  rule = null, httpsStatus = { '/': 200, '/api/state': 401 }, newFirewall = true, netCategory = 'Private',
} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prov-'));
  const configPath = path.join(dir, 'config.json');
  if (config) fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  const calls = [];
  const m = { rule };
  const run = async (cmd, args) => {
    const a = args.join(' ');
    calls.push([cmd, ...args].join(' '));
    if (cmd === 'net') return { code: elevated ? 0 : 5, stdout: '', stderr: '' };
    if (cmd === 'manage-bde') return { code: bde === DENIED ? 1 : 0, stdout: bde, stderr: '' };
    if (cmd !== 'powershell.exe') return { code: 1, stdout: '', stderr: 'unexpected' };
    if (/Get-NetRoute/.test(a)) return { code: 0, stdout: `${lan}\r\n`, stderr: '' };
    if (/New-NetFirewallRule/.test(a)) { m.rule = { Profile: 'Private', Port: '8123' }; return { code: newFirewall ? 0 : 1, stdout: '', stderr: 'boom' }; }
    if (/Set-NetFirewallRule/.test(a)) { m.rule = { Profile: 'Private', Port: '8123' }; return { code: 0, stdout: '', stderr: '' }; }
    if (/Get-NetFirewallRule/.test(a)) return { code: 0, stdout: m.rule ? JSON.stringify(m.rule) : '', stderr: '' };
    if (/Get-NetConnectionProfile/.test(a)) return netCategory ? { code: 0, stdout: `${netCategory}\r\n`, stderr: '' } : { code: 1, stdout: '', stderr: 'no profile' };
    if (/BitLocker/.test(a)) return { code: 0, stdout: '1\n', stderr: '' };
    return { code: 0, stdout: JSON.stringify({ run: '"x" --hidden', explorer: '2026-11-10T15:00:00.000Z', shell: '2026-11-10T15:01:00.000Z' }), stderr: '' };
  };
  const fetch = async (url) => {
    const u = String(url);
    const json = (b, s = 200) => ({ status: s, ok: s < 300, json: async () => b });
    if (u.endsWith('/healthz')) return json({ status: 'up', uptime_s: 120, shell: { pickup: { n: 0 } } });
    if (u.endsWith('/api/alerts')) return json([]);
    return json({}, 200);
  };
  const requests = [];
  const request = async (o) => { requests.push(o); return { status: httpsStatus[o.path] ?? 200 }; };
  return { dir, configPath, calls, run, fetch, request, m, requests };
}
const go = (e, argv = [], extra = {}) => runProvision({
  argv, run: e.run, fetch: e.fetch, request: e.request, configPath: e.configPath, stateDir: e.dir, now: () => NOW, ...extra,
});
const stepOf = (r, id) => r.steps.find((s) => s.id === id);
const readCfg = (e) => JSON.parse(fs.readFileSync(e.configPath, 'utf8'));
const baks = (e) => {
  try { return fs.readdirSync(path.join(e.dir, 'backups', 'config')).filter((f) => f.startsWith('config.json.')); } catch { return []; }
};

test('parseManageBde: on, off, denied', () => {
  assert.equal(parseManageBde(BDE_ON).state, 'on');
  assert.equal(parseManageBde(BDE_ON.replace('Protection On', 'Protection Off')).state, 'off');
  assert.equal(parseManageBde(DENIED).state, 'denied');
  assert.equal(parseManageBde('').state, 'unknown');
});

test('planConfigChange binds a private address with home TLS, drops obsolete keys, keeps the rest', () => {
  const base = { a: 1, nested: { b: 2 }, remotePlaintextAcknowledged: true, tailscaleCli: 'x' };
  const p = planConfigChange(base, { lanIp: LAN });
  assert.equal(p.ok, true);
  assert.equal(p.changed, true);
  assert.deepEqual(p.next, { a: 1, nested: { b: 2 }, host: LAN, tls: { source: 'home' } });
  assert.equal(planConfigChange(p.next, { lanIp: LAN }).changed, false);
});

test('planConfigChange keeps a provided tls block', () => {
  const tls = { source: 'provided', certFile: 'c', keyFile: 'k', chainFile: 'ch' };
  const p = planConfigChange({ tls }, { lanIp: LAN });
  assert.deepEqual(p.next.tls, tls);
});

test('planConfigChange refuses a public or non-literal address', () => {
  assert.equal(planConfigChange({}, { lanIp: '8.8.8.8' }).ok, false);
  assert.equal(planConfigChange({}, { lanIp: 'example.com' }).ok, false);
  assert.equal(planConfigChange({}, { lanIp: undefined }).ok, false);
});

test('planRollback removes host and tls only', () => {
  const p = planRollback({ port: 1, host: LAN, tls: { source: 'home' } });
  assert.deepEqual(p.next, { port: 1 });
  assert.equal(p.changed, true);
  assert.equal(planRollback({ port: 1 }).changed, false);
});

test('evaluateShellStart', () => {
  const ok = evaluateShellStart({ runValue: 'x', explorerStart: '2026-11-03T15:00:00Z', shellStart: '2026-11-03T15:05:00Z' });
  assert.equal(ok.status, 'done');
  const late = evaluateShellStart({ runValue: 'x', explorerStart: '2026-11-03T08:00:00Z', shellStart: '2026-11-03T15:05:00Z' });
  assert.match(late.detail, /restarted since sign-in/);
  assert.equal(evaluateShellStart({ runValue: null }).status, 'needs-operator');
});

test('evaluatePickup', () => {
  assert.equal(evaluatePickup({ alerts: [], health: { uptime_s: 5, shell: { pickup: { n: 0 } } } }).status, 'done');
  assert.equal(evaluatePickup({ alerts: [{ source: 'shell-pickup' }], health: {} }).status, 'needs-operator');
});

test('the step list has no Headscale, WSL, Tailscale or join step', async () => {
  const e = mkEnv();
  const r = await go(e);
  assert.deepEqual(r.steps.map((s) => s.id), ['elevation', 'lan', 'tls', 'client-ca', 'token', 'firewall', 'network', 'bitlocker', 'config', 'kernel', 'shell', 'pickup']);
  assert.ok(!e.calls.some((c) => /wsl|tailscale|winget|msiexec/i.test(c)));
});

test('report mode writes nothing: no tls files, no config change, no firewall rule', async () => {
  const e = mkEnv();
  const before = fs.readFileSync(e.configPath, 'utf8');
  const r = await go(e);
  assert.equal(fs.readFileSync(e.configPath, 'utf8'), before);
  assert.equal(fs.existsSync(path.join(e.dir, 'tls')), false);
  assert.ok(!e.calls.some((c) => /New-NetFirewallRule|Set-NetFirewallRule/.test(c)));
  for (const id of ['tls', 'client-ca', 'token', 'firewall', 'config']) assert.equal(stepOf(r, id).status, 'apply-will-do', id);
  assert.equal(fs.existsSync(path.join(e.dir, 'access-token')), false);
  assert.equal(stepOf(r, 'lan').detail.startsWith(LAN), true);
  assert.equal(r.exitCode, 2);
});

test('apply creates both CAs, the firewall rule and the bind, in that order, with a config backup', async () => {
  const e = mkEnv();
  const r = await go(e, ['--apply']);
  const p = tlsPaths(e.dir);
  for (const f of [p.homeCaCert, p.homeCaKey, p.serverCert, p.serverKey, p.clientCaCert, p.clientCaKey]) assert.ok(fs.existsSync(f), f);
  assert.deepEqual(readCfg(e), { port: 8123, other: { keep: [1, 2] }, host: LAN, tls: { source: 'home' } });
  assert.equal(baks(e).length, 1);
  const fw = e.calls.findIndex((c) => /New-NetFirewallRule/.test(c));
  assert.ok(fw >= 0);
  assert.match(e.calls[fw], /-Profile Private/);
  assert.match(e.calls[fw], /GLMPS Dashboard 8123/);
  assert.match(e.calls[fw], /-LocalPort 8123/);
  assert.match(stepOf(r, 'tls').detail, /\b[0-9a-f]{64}\b/);
  assert.match(stepOf(r, 'tls').detail, /iPhone|phone/i);
  assert.equal(stepOf(r, 'kernel').status, 'done');
  assert.equal(r.exitCode, 0);
  assert.match(r.output, /Restart server/);
});

// 2026-11-10: the server refuses a non-loopback bind with no access-token file,
// so writing the bind without one took the dashboard down on the next restart.
test('apply creates the remote access token before the bind and never prints it', async () => {
  const e = mkEnv();
  const r = await go(e, ['--apply']);
  const file = path.join(e.dir, 'access-token');
  const token = fs.readFileSync(file, 'utf8').trim();
  assert.match(token, /^[A-Za-z0-9_-]{43,}$/);
  assert.equal(stepOf(r, 'token').status, 'done');
  assert.ok(stepOf(r, 'token').detail.includes(file));
  assert.ok(!r.output.includes(token));
  assert.ok(!JSON.stringify(r.steps).includes(token));
  assert.equal(readCfg(e).host, LAN);
});

test('an existing access token is kept, never overwritten', async () => {
  const e = mkEnv();
  const file = path.join(e.dir, 'access-token');
  fs.writeFileSync(file, 'kept-token-value-0123456789abcdefghijklmnopqrstuv\n');
  const r = await go(e, ['--apply']);
  assert.equal(fs.readFileSync(file, 'utf8'), 'kept-token-value-0123456789abcdefghijklmnopqrstuv\n');
  assert.equal(stepOf(r, 'token').status, 'done');
  assert.ok(!r.output.includes('kept-token-value'));
});

test('an empty access-token file blocks the bind instead of being replaced', async () => {
  const e = mkEnv();
  const file = path.join(e.dir, 'access-token');
  fs.writeFileSync(file, '  \n');
  const before = fs.readFileSync(e.configPath, 'utf8');
  const r = await go(e, ['--apply']);
  assert.equal(stepOf(r, 'token').status, 'blocked');
  assert.equal(stepOf(r, 'config').status, 'blocked');
  assert.match(stepOf(r, 'config').detail, /token/);
  assert.equal(fs.readFileSync(e.configPath, 'utf8'), before);
  assert.equal(fs.readFileSync(file, 'utf8'), '  \n');
});

// 2026-11-10: a Public Wi-Fi profile left the Private-only rule inert, so a
// phone on the home network could not reach the dashboard while every step said done.
test('a Public network profile is reported for the operator to change, never changed by the script', async () => {
  const e = mkEnv({ netCategory: 'Public' });
  const r = await go(e, ['--apply']);
  const n = stepOf(r, 'network');
  assert.equal(n.status, 'needs-operator');
  assert.match(n.detail, /Public/);
  assert.match(n.detail, /Set-NetConnectionProfile|Network profile type/);
  assert.ok(!e.calls.some((c) => /Set-NetConnectionProfile/.test(c)));
  assert.equal(readCfg(e).host, LAN);
  assert.equal(r.exitCode, 2);
});

test('a Private or domain network profile is done; an unreadable one needs the operator', async () => {
  for (const cat of ['Private', 'DomainAuthenticated']) assert.equal(stepOf(await go(mkEnv({ netCategory: cat })), 'network').status, 'done', cat);
  assert.equal(stepOf(await go(mkEnv({ netCategory: null })), 'network').status, 'needs-operator');
});

test('the kernel check proves HTTPS with only the home CA as trust, and loopback health', async () => {
  const e = mkEnv();
  await go(e, ['--apply']);
  assert.ok(e.requests.length >= 2);
  const homeCa = fs.readFileSync(tlsPaths(e.dir).homeCaCert, 'utf8');
  for (const q of e.requests) { assert.equal(q.host, LAN); assert.equal(q.port, 8123); assert.equal(q.ca, homeCa); }
  assert.deepEqual(e.requests.map((q) => q.path).sort(), ['/', '/api/state']);
});

test('a kernel that serves / and /api/state without a 401 is not done', async () => {
  const e = mkEnv({ httpsStatus: { '/': 200, '/api/state': 200 } });
  const r = await go(e, ['--apply']);
  assert.equal(stepOf(r, 'kernel').status, 'needs-operator');
});

test('nothing answering on the private bind says to restart the kernel from the dashboard', async () => {
  const e = mkEnv();
  e.request = async () => { throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }); };
  const r = await go(e, ['--apply']);
  assert.equal(stepOf(r, 'kernel').status, 'needs-operator');
  assert.match(stepOf(r, 'kernel').detail, /Restart server/);
});

test('rerun is idempotent: no second backup, no rule recreate, nothing to do', async () => {
  const e = mkEnv();
  await go(e, ['--apply']);
  const created = e.calls.filter((c) => /New-NetFirewallRule/.test(c)).length;
  const r2 = await go(e, ['--apply']);
  assert.equal(baks(e).length, 1);
  assert.equal(e.calls.filter((c) => /New-NetFirewallRule/.test(c)).length, created);
  assert.deepEqual(r2.steps.map((s) => s.status === 'done'), r2.steps.map(() => true));
  assert.equal(r2.exitCode, 0);
});

test('a replaced server certificate while the kernel already serves the bind needs a restart', async () => {
  const e = mkEnv({ config: { port: 8123, host: LAN, tls: { source: 'home' } } });
  ensureHomeServerTls({ stateDir: e.dir, ips: ['192.168.1.99'], now: NOW });
  const r = await go(e, ['--apply']);
  assert.match(stepOf(r, 'tls').detail, /needs a restart/);
  assert.match(stepOf(r, 'tls').detail, /Restart server/);
});

test('an existing firewall rule on the wrong profile is corrected, never duplicated', async () => {
  const e = mkEnv({ rule: { Profile: 'Any', Port: '8123' } });
  const dry = await go(e);
  assert.equal(stepOf(dry, 'firewall').status, 'apply-will-do');
  assert.match(stepOf(dry, 'firewall').detail, /Private/);
  const r = await go(e, ['--apply']);
  assert.equal(stepOf(r, 'firewall').status, 'done');
  assert.ok(e.calls.some((c) => /Set-NetFirewallRule/.test(c)));
  assert.ok(!e.calls.some((c) => /New-NetFirewallRule/.test(c)));
});

test('apply without elevation changes no firewall and no config, and says why', async () => {
  const e = mkEnv({ elevated: false });
  const r = await go(e, ['--apply']);
  assert.equal(stepOf(r, 'elevation').status, 'needs-operator');
  assert.equal(stepOf(r, 'firewall').status, 'needs-operator');
  assert.match(stepOf(r, 'firewall').detail, /elevated terminal/);
  assert.equal(stepOf(r, 'config').status, 'blocked');
  assert.equal(readCfg(e).host, undefined);
  assert.ok(!e.calls.some((c) => /New-NetFirewallRule/.test(c)));
});

test('a failed firewall rule blocks the bind', async () => {
  const e = mkEnv({ newFirewall: false });
  e.m.rule = null;
  const r = await go(e, ['--apply']);
  assert.equal(stepOf(r, 'firewall').status, 'needs-operator');
  assert.equal(stepOf(r, 'config').status, 'blocked');
  assert.equal(readCfg(e).host, undefined);
});

test('--lan-ip overrides detection; a public or malformed one is blocked and the bind never widens', async () => {
  const e = mkEnv({ lan: '10.9.9.9' });
  const r = await go(e, ['--apply', '--lan-ip', '10.0.0.9']);
  assert.equal(readCfg(e).host, '10.0.0.9');
  assert.ok(!e.calls.some((c) => /Get-NetRoute/.test(c)));
  assert.equal(r.exitCode, 0);
  const e2 = mkEnv();
  const r2 = await go(e2, ['--apply', '--lan-ip', '8.8.8.8']);
  assert.equal(stepOf(r2, 'lan').status, 'blocked');
  assert.equal(stepOf(r2, 'config').status, 'blocked');
  assert.equal(fs.existsSync(tlsPaths(e2.dir).homeCaCert), false);
});

test('an unconstrained home CA already in the state dir blocks the tls step', async () => {
  const e = mkEnv();
  const p = tlsPaths(e.dir);
  fs.mkdirSync(p.dir, { recursive: true });
  const { createCa } = await import('../lib/kernel/x509-lite.js');
  const ca = createCa({ cn: 'Old CA', days: 30, now: NOW, permitted: null });
  fs.writeFileSync(p.homeCaCert, ca.certPem);
  fs.writeFileSync(p.homeCaKey, ca.keyPem);
  const r = await go(e, ['--apply']);
  assert.equal(stepOf(r, 'tls').status, 'blocked');
  assert.match(stepOf(r, 'tls').detail, /name constraints/);
  assert.equal(stepOf(r, 'config').status, 'blocked');
});

test('provided source: configured files are checked, not replaced, and the bind keeps the block', async () => {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'prov-pki-'));
  ensureHomeServerTls({ stateDir: src, ips: [LAN], now: NOW });
  const sp = tlsPaths(src);
  const tls = { source: 'provided', certFile: sp.serverCert, keyFile: sp.serverKey, chainFile: sp.homeCaCert };
  const e = mkEnv({ config: { port: 8123, tls } });
  const r = await go(e, ['--apply']);
  assert.equal(stepOf(r, 'tls').status, 'done');
  assert.equal(fs.existsSync(tlsPaths(e.dir).homeCaCert), false);
  assert.deepEqual(readCfg(e).tls, tls);
  assert.equal(readCfg(e).host, LAN);
  const bad = mkEnv({ config: { port: 8123, tls: { ...tls, certFile: path.join(src, 'missing.pem') } } });
  const r2 = await go(bad, ['--apply']);
  assert.equal(stepOf(r2, 'tls').status, 'blocked');
  assert.equal(stepOf(r2, 'config').status, 'blocked');
});

test('provided source in report mode leaves the state dir untouched', async () => {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'prov-pki-'));
  ensureHomeServerTls({ stateDir: src, ips: [LAN], now: NOW });
  const sp = tlsPaths(src);
  const e = mkEnv({ config: { tls: { source: 'provided', certFile: sp.serverCert, keyFile: sp.serverKey } } });
  await go(e);
  assert.equal(fs.existsSync(path.join(e.dir, 'tls')), false);
});

test('rollback removes host and tls, keeps the rest, backs up, never restarts anything', async () => {
  const e = mkEnv({ config: { port: 8123, host: LAN, tls: { source: 'home' }, keep: 'me' } });
  const dry = await go(e, ['--rollback']);
  assert.equal(readCfg(e).host, LAN);
  assert.equal(dry.exitCode, 0);
  const r = await go(e, ['--rollback', '--apply']);
  assert.deepEqual(readCfg(e), { port: 8123, keep: 'me' });
  assert.equal(baks(e).length, 1);
  assert.match(r.output, /Restart server/);
  assert.equal(e.calls.length, 0);
});

test('bitlocker access denied is needs-operator with the fallback reading', async () => {
  const e = mkEnv({ bde: DENIED });
  const r = await go(e);
  const s = stepOf(r, 'bitlocker');
  assert.equal(s.status, 'needs-operator');
  assert.match(s.detail, /elevated/);
  assert.match(s.detail, /fallback/);
});

test('--json prints the step array', async () => {
  const e = mkEnv();
  const r = await go(e, ['--json']);
  assert.ok(Array.isArray(JSON.parse(r.output)));
});

test('a machine where every command fails reports needs-operator and writes nothing', async () => {
  const e = mkEnv();
  const r = await runProvision({
    argv: [], run: async () => ({ code: 1, stdout: '', stderr: 'no' }), fetch: e.fetch, request: e.request,
    configPath: e.configPath, stateDir: e.dir, now: () => NOW,
  });
  assert.equal(r.exitCode, 2);
  assert.equal(stepOf(r, 'lan').status, 'blocked');
  assert.equal(fs.existsSync(path.join(e.dir, 'tls')), false);
});
