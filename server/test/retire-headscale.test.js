import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runRetire, decodeWslList, OLD_CA_THUMBPRINT } from '../../scripts/retire-headscale.mjs';

const NOW = new Date('2026-11-10T17:00:00Z');
const STAMP = '20261110T170000Z';
const utf16 = (s) => Buffer.from(`\uFEFF${s}`, 'utf16le');

function mkEnv({
  task = true, rule = true, distro = true, machineCa = true, userCa = true, proxy = true, elevated = true,
  exportFails = false, folder = true,
} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'retire-'));
  const hs = path.join(dir, 'remote-access', 'headscale');
  if (folder) {
    fs.mkdirSync(hs, { recursive: true });
    fs.writeFileSync(path.join(hs, 'ca.crt'), 'CRT');
    fs.writeFileSync(path.join(hs, 'ca.key'), 'KEY');
  }
  const m = { task, rule, distro, machineCa, userCa, proxy };
  const calls = [];
  const run = async (cmd, args, opts) => {
    const a = args.join(' ');
    calls.push(`${cmd} ${a}`);
    const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
    const no = (stderr = 'not found') => ({ code: 1, stdout: '', stderr });
    if (cmd === 'net') return elevated ? ok() : no('Access is denied');
    if (cmd === 'schtasks') {
      if (args[0] === '/Query') return m.task ? ok(args.includes('/XML') ? '<Task/>' : 'ok') : no();
      if (args[0] === '/End') return ok();
      if (args[0] === '/Delete') { m.task = false; return ok(); }
    }
    if (cmd === 'netsh' && args[0] === 'advfirewall') {
      if (args[2] === 'show') return m.rule ? ok('Rule Name: GLMPS Headscale 8443') : no('No rules match the specified criteria.');
      if (args[2] === 'delete') { m.rule = false; return ok(); }
    }
    if (cmd === 'netsh' && args[0] === 'interface') {
      if (args[2] === 'show') return ok(m.proxy ? 'Listen on ipv4:             Connect to ipv4:\n\nAddress         Port        Address         Port\n--------------- ----------  --------------- ----------\n192.168.1.50    8443        172.20.0.2      8443\n' : '');
      if (args[2] === 'delete') { m.proxy = false; return ok(); }
    }
    if (cmd === 'wsl.exe') {
      if (args[0] === '-l') return { code: 0, stdout: opts?.raw ? utf16(m.distro ? 'Ubuntu\r\nglmps-headscale\r\n' : 'Ubuntu\r\n') : '', stderr: '' };
      if (args[0] === '--export') {
        if (exportFails) return no('export failed');
        fs.writeFileSync(args[2], 'TAR');
        return ok();
      }
      if (args[0] === '--unregister') { m.distro = false; return ok(); }
    }
    if (cmd === 'certutil') {
      const user = args.includes('-user');
      const key = user ? 'userCa' : 'machineCa';
      const verb = args.find((x) => /^-(store|delstore)$/.test(x));
      assert.ok(args.includes(OLD_CA_THUMBPRINT), 'certutil must name the thumbprint');
      if (verb === '-store') {
        if (!m[key]) return no('Cert not found');
        const outFile = args[args.length - 1];
        if (outFile !== OLD_CA_THUMBPRINT) fs.writeFileSync(outFile, 'CER');
        return ok();
      }
      if (verb === '-delstore') { m[key] = false; return ok(); }
    }
    return no('unexpected');
  };
  return { dir, hs, m, calls, run };
}
const go = (e, argv = []) => runRetire({ argv, run: e.run, stateDir: e.dir, now: () => NOW });
const stepOf = (r, id) => r.steps.find((s) => s.id === id);
const destructive = (calls) => calls.filter((c) => /\/Delete|delete rule|delete v4tov4|--unregister|-delstore/.test(c));

test('decodeWslList decodes UTF-16LE buffers and plain strings', () => {
  assert.deepEqual(decodeWslList(utf16('Ubuntu\r\nglmps-headscale\r\n')), ['Ubuntu', 'glmps-headscale']);
  assert.deepEqual(decodeWslList('a\nb\n'), ['a', 'b']);
});

test('the pinned thumbprint is the unconstrained Headscale CA', () => {
  assert.equal(OLD_CA_THUMBPRINT, 'bd17b79a116262bbc2c2b75a12cb1eb7897b2b47');
});

test('dry run changes nothing and lists what apply would do', async () => {
  const e = mkEnv();
  const r = await go(e);
  assert.deepEqual(destructive(e.calls), []);
  assert.ok(fs.existsSync(path.join(e.hs, 'ca.key')));
  for (const id of ['task', 'firewall', 'portproxy', 'distro', 'ca-machine', 'ca-user', 'folder']) {
    assert.equal(stepOf(r, id).status, 'apply-will-do', id);
  }
  assert.equal(r.exitCode, 2);
  assert.ok(!fs.existsSync(path.join(e.dir, 'backups')));
});

test('apply removes every piece, backing up before each removal', async () => {
  const e = mkEnv();
  const r = await go(e, ['--apply']);
  assert.deepEqual({ ...e.m }, { task: false, rule: false, distro: false, machineCa: false, userCa: false, proxy: false });
  assert.equal(r.exitCode, 0);
  const bdir = path.join(e.dir, 'backups', `headscale-retirement-${STAMP}`);
  const files = fs.readdirSync(bdir).sort();
  assert.ok(files.some((f) => f.endsWith('.cer') && f.includes('machine')));
  assert.ok(files.some((f) => f.endsWith('.cer') && f.includes('user')));
  assert.ok(files.some((f) => f.endsWith('.tar')));
  assert.ok(files.some((f) => f.endsWith('.xml')));
  const idx = (re) => e.calls.findIndex((c) => re.test(c));
  assert.ok(idx(/--export/) < idx(/--unregister/));
  assert.ok(idx(/schtasks \/Query .*\/XML/) < idx(/schtasks \/Delete/));
  assert.ok(idx(/certutil -store Root/) < idx(/certutil -delstore Root/));
  assert.ok(idx(/certutil -user -store Root/) < idx(/certutil -user -delstore Root/));
});

test('the headscale folder is moved to a dated backup beside it, never deleted', async () => {
  const e = mkEnv();
  const r = await go(e, ['--apply']);
  const bak = path.join(e.dir, 'remote-access', `headscale.bak-${STAMP}`);
  assert.equal(fs.existsSync(e.hs), false);
  assert.equal(fs.readFileSync(path.join(bak, 'ca.key'), 'utf8'), 'KEY');
  assert.match(stepOf(r, 'folder').detail, /headscale\.bak-/);
});

test('a second apply is all done and issues no removal command', async () => {
  const e = mkEnv();
  await go(e, ['--apply']);
  e.calls.length = 0;
  const r = await go(e, ['--apply']);
  assert.equal(r.exitCode, 0);
  assert.deepEqual(r.steps.map((s) => s.status === 'done'), r.steps.map(() => true));
  assert.deepEqual(destructive(e.calls), []);
});

test('pieces already gone are done on a dry run', async () => {
  const e = mkEnv({ task: false, rule: false, distro: false, machineCa: false, userCa: false, proxy: false, folder: false });
  const r = await go(e);
  assert.equal(r.exitCode, 0);
  assert.deepEqual(r.steps.map((s) => s.status === 'done'), r.steps.map(() => true));
});

test('apply without elevation removes nothing and says to rerun elevated', async () => {
  const e = mkEnv({ elevated: false });
  const r = await go(e, ['--apply']);
  assert.deepEqual(destructive(e.calls), []);
  assert.equal(stepOf(r, 'elevation').status, 'needs-operator');
  assert.equal(stepOf(r, 'task').status, 'needs-operator');
  assert.match(stepOf(r, 'task').detail, /elevated terminal/);
  assert.ok(fs.existsSync(path.join(e.hs, 'ca.key')));
  assert.equal(r.exitCode, 2);
});

test('a failed distro export keeps the distro', async () => {
  const e = mkEnv({ exportFails: true });
  const r = await go(e, ['--apply']);
  assert.equal(stepOf(r, 'distro').status, 'needs-operator');
  assert.equal(e.m.distro, true);
});

test('only the pinned CA is touched, in both stores', async () => {
  const e = mkEnv();
  await go(e, ['--apply']);
  const cu = e.calls.filter((c) => c.startsWith('certutil'));
  assert.ok(cu.length >= 6);
  assert.ok(cu.every((c) => c.includes(OLD_CA_THUMBPRINT)));
  assert.ok(cu.some((c) => c.includes('-user')) && cu.some((c) => !c.includes('-user')));
});

test('the Tailscale client is only mentioned, never touched', async () => {
  const e = mkEnv();
  const r = await go(e, ['--apply']);
  assert.ok(!e.calls.some((c) => /tailscale|msiexec|winget|Uninstall/i.test(c)));
  assert.match(r.output, /Tailscale/);
  assert.match(r.output, /optional/i);
});

test('--json prints the step array', async () => {
  const e = mkEnv();
  const r = await go(e, ['--json']);
  assert.ok(Array.isArray(JSON.parse(r.output)));
});
