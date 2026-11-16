// server/test/tap-updater.test.js
// Card glmps-2-0-runtime-67: the tap updates itself when idle, after checking the
// hash and the installed signer pin. The server, the Authenticode check and the
// zip extractor are injected, so every case runs on every platform; one case
// uses Windows' own tar.exe on a real zip.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createUpdater, validateAdvert, cleanupOld, tarExtractor, logonTaskRestarter, MANIFEST_FILE, OLD_SUFFIX, UPDATE_PATH } from '../../taps/tap-updater.js';
import { TAP_PROTOCOL_HEADER } from '../lib/kernel/tap-protocol.js';
import { LOGON_TASK_NAME } from '../../taps/tap-logon-task.js';

const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });
const mkTmp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); tmpDirs.push(d); return d; };
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const PIN = { thumbprint: 'C74BBD54C1211B9386A27E2904D2463908B6F9E9', mode: 'test', subject: 'CN=GLMPS Tap Test Signing' };
const OTHER = { ...PIN, thumbprint: 'A'.repeat(40) };

// A tap payload as a {relativePath: content} map, laid out the way build-tap writes it.
function payload(commit, { agent = `agent ${commit}`, extra = {}, pin = PIN, drop = [] } = {}) {
  const files = { 'taps/tap-agent.js': agent, 'hooks/a.js': `hook ${commit}`, ...extra };
  for (const d of drop) delete files[d];
  const entries = Object.fromEntries(Object.keys(files).map((k) => [k, sha(files[k])]));
  return {
    ...files,
    'node.exe': `node for ${commit}`,
    'package.json': '{ "type": "module" }\n',
    [MANIFEST_FILE]: JSON.stringify({ commit, files: entries }),
    'signer.json': JSON.stringify(pin),
    'tap.cat': `catalog ${commit}`,
  };
}
function writeTree(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
}
const readTree = (dir, rel) => fs.readFileSync(path.join(dir, rel), 'utf8');

// An installed tap: payload + the home data the agent owns.
function installed(commit = 'aaa1111') {
  const home = mkTmp('mc-tapupd-home-');
  writeTree(home, payload(commit));
  writeTree(home, { 'tap-config.json': '{"cfg":1}', 'token.dpapi': 'secret-blob', 'spool/seg-1.ndjson': 'rec\n', 'relay-queue.ndjson': 'q\n' });
  return home;
}

// The archive bytes are opaque here: the fake extractor maps them to a tree.
function release(files) {
  const archive = Buffer.from(`archive:${crypto.randomUUID()}`);
  return { archive, files, advert: { version: '0.2.0', commit: JSON.parse(files[MANIFEST_FILE]).commit, sha256: sha(archive), size: archive.length } };
}
function fakeServer(rel, { status = 200, header = (r) => r.advert.sha256, body = (r) => r.archive } = {}) {
  const calls = [];
  const fetch = async (url, opts) => {
    calls.push({ url, headers: opts.headers });
    const b = body(rel);
    return {
      status, headers: new Headers({ 'x-content-sha256': header(rel) ?? '' }),
      body: (async function* () { yield b.subarray(0, 3); yield b.subarray(3); })(),
    };
  };
  return { fetch, calls };
}
const fakeExtract = (rels) => (zip, dir) => {
  const bytes = fs.readFileSync(zip);
  const r = rels.find((x) => x.archive.equals(bytes));
  if (!r) return { error: 'not a zip' };
  writeTree(dir, r.files);
  return { ok: true };
};
// Stands in for Test-FileCatalog + Get-AuthenticodeSignature: the catalog is
// "signed" by whatever signer.json says, and tampered files show as changed.
const fakeVerify = ({ tampered = [] } = {}) => (dir) => {
  const pin = JSON.parse(fs.readFileSync(path.join(dir, 'signer.json'), 'utf8'));
  return { catalog: tampered.length ? 'ValidationFailed' : 'Valid', signature: 'UnknownError', thumbprint: pin.thumbprint, subject: pin.subject, missing: [], extra: [], changed: tampered };
};

function make(home, rel, extra = {}) {
  const server = fakeServer(rel, extra.server);
  const restarts = [];
  let t = 1_000_000;
  const u = createUpdater({
    home, payloadRoot: home, platform: 'win32',
    fetch: server.fetch,
    getCreds: () => ({ config: { server: 'http://glmps:8123' }, token: 'client-tok' }),
    isIdle: extra.isIdle ?? (() => true),
    verify: extra.verify ?? fakeVerify(),
    extract: extra.extract ?? fakeExtract([rel]),
    restart: async (info) => { restarts.push(info); return extra.restartResult ?? { restarting: true }; },
    now: () => t, sleep: async () => {}, log: () => {},
    ...(extra.opts || {}),
  });
  return { u, server, restarts, tick: (ms) => { t += ms; } };
}

test('an advert is validated before anything acts on it', () => {
  const ok = { version: '0.2.0', commit: 'abc1234', sha256: 'a'.repeat(64), size: 10 };
  assert.deepEqual(validateAdvert(ok), ok);
  for (const bad of [null, 'x', {}, { ...ok, sha256: 'xyz' }, { ...ok, size: 0 }, { ...ok, size: 1.5 }, { ...ok, commit: 'not a commit!' }, { ...ok, commit: null }, { ...ok, version: 7 }]) {
    assert.equal(validateAdvert(bad), null, JSON.stringify(bad));
  }
});

test('the updater acts only from an installed tap bundle', () => {
  const home = installed();
  const fromCheckout = createUpdater({ home, payloadRoot: mkTmp('mc-tapupd-checkout-'), fetch: async () => { throw new Error('no'); }, getCreds: () => null, isIdle: () => true, log: () => {} });
  assert.equal(fromCheckout.status().state, 'disabled');
  assert.match(fromCheckout.status().reason, /not running from the tap home/);
  const bare = mkTmp('mc-tapupd-bare-');
  const noManifest = createUpdater({ home: bare, payloadRoot: bare, fetch: async () => { throw new Error('no'); }, getCreds: () => null, isIdle: () => true, log: () => {} });
  assert.equal(noManifest.status().state, 'disabled');
  assert.match(noManifest.status().reason, /tap-manifest\.json/);
});

test('the same commit is current; a different one is available and waits for idle', async () => {
  const home = installed('aaa1111');
  const rel = release(payload('bbb2222'));
  let idle = false;
  const { u, server } = make(home, rel, { isIdle: () => idle });
  u.offer({ ...rel.advert, commit: 'aaa1111' });
  assert.equal(u.status().state, 'current');
  assert.equal(u.status().installedCommit, 'aaa1111');
  u.offer(null);
  assert.equal(u.status().state, 'current', 'nothing published');

  u.offer(rel.advert);
  assert.equal(u.status().state, 'available');
  assert.deepEqual(u.status().available, rel.advert);
  await u.maybeApply();
  assert.equal(u.status().state, 'waiting-idle');
  assert.equal(server.calls.length, 0, 'nothing downloaded while busy');
  assert.equal(readTree(home, 'taps/tap-agent.js'), 'agent aaa1111');
});

test('idle: a voluntary update needs empty queues; a 426-driven one only needs nothing in flight', async () => {
  const home = installed();
  const rel = release(payload('bbb2222'));
  const asked = [];
  const { u } = make(home, rel, { isIdle: (o) => { asked.push(o); return o.required; } });
  u.offer(rel.advert);
  await u.maybeApply();
  assert.equal(u.status().state, 'waiting-idle');
  u.offer(rel.advert, { required: true });
  await u.maybeApply();
  assert.equal(u.status().state, 'applied');
  assert.deepEqual(asked.map((o) => o.required).slice(0, 2), [false, true]);
});

test('a verified update downloads with the client token, swaps the payload, keeps home data, drops stale files and restarts', async () => {
  const home = installed('aaa1111');
  const rel = release(payload('bbb2222', { extra: { 'hooks/new.js': 'new hook' }, drop: ['hooks/a.js'] }));
  const { u, server, restarts } = make(home, rel);
  u.offer(rel.advert);
  await u.maybeApply();
  assert.equal(u.status().state, 'applied', u.status().reason);

  assert.equal(server.calls.length, 1);
  assert.equal(server.calls[0].url, `http://glmps:8123${UPDATE_PATH}`);
  assert.equal(server.calls[0].headers.authorization, 'Bearer client-tok');
  assert.ok(server.calls[0].headers[TAP_PROTOCOL_HEADER]);

  assert.equal(readTree(home, 'taps/tap-agent.js'), 'agent bbb2222');
  assert.equal(readTree(home, 'node.exe'), 'node for bbb2222');
  assert.equal(readTree(home, 'hooks/new.js'), 'new hook');
  assert.equal(fs.existsSync(path.join(home, 'hooks/a.js')), false, 'a file the new release dropped is gone');
  for (const [rel2, want] of [['tap-config.json', '{"cfg":1}'], ['token.dpapi', 'secret-blob'], ['spool/seg-1.ndjson', 'rec\n'], ['relay-queue.ndjson', 'q\n']]) {
    assert.equal(readTree(home, rel2), want, `${rel2} kept`);
  }
  assert.equal(fs.existsSync(path.join(home, 'update', 'staged')), false, 'staging cleaned');
  assert.equal(fs.existsSync(path.join(home, 'update', 'download.zip')), false, 'download cleaned');
  assert.deepEqual(restarts, [{ from: 'aaa1111', to: 'bbb2222' }]);
  assert.equal(u.status().installedCommit, 'bbb2222');

  // The old files were renamed aside (a running node.exe cannot be deleted); the next start removes them.
  assert.ok(fs.existsSync(path.join(home, `node.exe${OLD_SUFFIX}`)));
  assert.equal(cleanupOld(home).removed, 7, '6 replaced files and 1 dropped one');
  assert.equal(fs.existsSync(path.join(home, `node.exe${OLD_SUFFIX}`)), false);
  assert.equal(readTree(home, 'spool/seg-1.ndjson'), 'rec\n');

  u.offer(rel.advert);
  assert.equal(u.status().state, 'applied', 'an applied update is sticky until the restart');
});

test('a hash mismatch is refused, the install is untouched, and the same archive is not fetched again', async () => {
  const home = installed('aaa1111');
  const rel = release(payload('bbb2222'));
  const forged = { ...rel.advert, sha256: 'f'.repeat(64) };
  const { u, server, restarts } = make(home, rel, { server: { header: () => forged.sha256 } });
  u.offer(forged);
  await u.maybeApply();
  assert.equal(u.status().state, 'refused');
  assert.match(u.status().reason, /SHA-256/);
  assert.equal(readTree(home, 'taps/tap-agent.js'), 'agent aaa1111');
  assert.equal(restarts.length, 0);
  await u.maybeApply();
  assert.equal(server.calls.length, 1, 'a refused archive is not downloaded again');
  u.offer({ ...rel.advert, sha256: 'e'.repeat(64) });
  assert.equal(u.status().state, 'available', 'a different archive is offered afresh');
});

test('a header that disagrees with the advert, or a body larger than advertised, is refused', async () => {
  const home = installed();
  const rel = release(payload('bbb2222'));
  const a = make(home, rel, { server: { header: () => 'd'.repeat(64) } });
  a.u.offer(rel.advert);
  await a.u.maybeApply();
  assert.equal(a.u.status().state, 'refused');
  assert.match(a.u.status().reason, /x-content-sha256/);

  const b = make(home, rel, { server: { body: (r) => Buffer.concat([r.archive, Buffer.from('more')]) } });
  b.u.offer(rel.advert);
  await b.u.maybeApply();
  assert.equal(b.u.status().state, 'refused');
  assert.match(b.u.status().reason, /larger than/);
  assert.equal(readTree(home, 'taps/tap-agent.js'), 'agent aaa1111');
});

test('a failed signature check, another signer, a wrong commit or a payload naming home data is refused', async () => {
  const cases = [
    ['tampered', release(payload('bbb2222')), { verify: fakeVerify({ tampered: ['taps/tap-agent.js'] }) }, /signature check.*differ/],
    ['re-pinned', release(payload('bbb2222', { pin: OTHER })), {}, /not the pinned signer/],
    ['commit', (() => { const r = release(payload('ccc3333')); return { ...r, advert: { ...r.advert, commit: 'bbb2222' } }; })(), {}, /ccc3333.*bbb2222|bbb2222.*ccc3333/],
    ['home data', release(payload('bbb2222', { extra: { 'token.dpapi': 'evil' } })), {}, /token\.dpapi/],
  ];
  for (const [name, rel, extra, re] of cases) {
    const home = installed('aaa1111');
    const { u, restarts } = make(home, rel, extra);
    u.offer(rel.advert);
    await u.maybeApply();
    assert.equal(u.status().state, 'refused', name);
    assert.match(u.status().reason, re, name);
    assert.equal(readTree(home, 'taps/tap-agent.js'), 'agent aaa1111', name);
    assert.equal(readTree(home, 'token.dpapi'), 'secret-blob', name);
    assert.equal(restarts.length, 0, name);
    assert.equal(fs.existsSync(path.join(home, 'update', 'staged')), false, `${name}: staging cleaned`);
  }
});

test('the pin is the installed one even when the payload carries a matching-looking signer', async () => {
  const home = installed('aaa1111');
  fs.writeFileSync(path.join(home, 'signer.json'), JSON.stringify(OTHER));
  const rel = release(payload('bbb2222'));
  const { u } = make(home, rel);
  u.offer(rel.advert);
  await u.maybeApply();
  assert.equal(u.status().state, 'refused');
  assert.match(u.status().reason, new RegExp(OTHER.thumbprint));
});

test('a network failure or a non-200 answer is a failure that retries after the backoff', async () => {
  const home = installed();
  const rel = release(payload('bbb2222'));
  const { u, server, tick } = make(home, rel, { server: { status: 503 } });
  u.offer(rel.advert);
  await u.maybeApply();
  assert.equal(u.status().state, 'failed');
  assert.match(u.status().reason, /503/);
  await u.maybeApply();
  assert.equal(server.calls.length, 1, 'held off');
  tick(10 * 60_000);
  await u.maybeApply();
  assert.equal(server.calls.length, 2, 'retried after the backoff');

  const unpaired = createUpdater({ home, payloadRoot: home, platform: 'win32', fetch: server.fetch, getCreds: () => null, isIdle: () => true, log: () => {}, verify: fakeVerify(), extract: fakeExtract([rel]), restart: async () => ({}) });
  unpaired.offer(rel.advert);
  await unpaired.maybeApply();
  assert.equal(unpaired.status().state, 'failed');
  assert.match(unpaired.status().reason, /paired/);
});

test('a swap that fails part way puts every file back', async () => {
  const home = installed('aaa1111');
  const rel = release(payload('bbb2222', { extra: { 'hooks/new.js': 'new hook' } }));
  let renames = 0;
  const realRename = fs.renameSync;
  const flaky = { ...fs, renameSync: (a, b) => { if (++renames === 5) throw Object.assign(new Error('EBUSY: locked'), { code: 'EBUSY' }); return realRename(a, b); } };
  const { u, restarts } = make(home, rel, { opts: { fs: flaky } });
  u.offer(rel.advert);
  await u.maybeApply();
  assert.equal(u.status().state, 'failed');
  assert.match(u.status().reason, /EBUSY/);
  for (const [f, want] of Object.entries(payload('aaa1111'))) assert.equal(readTree(home, f), want, `${f} restored`);
  assert.equal(fs.existsSync(path.join(home, 'hooks/new.js')), false);
  assert.equal(fs.readdirSync(home, { recursive: true }).filter((f) => String(f).endsWith(OLD_SUFFIX)).length, 0, 'no leftovers');
  assert.equal(restarts.length, 0);
});

test('the swap waits for in-flight work to finish, and gives up rather than cut a request off', async () => {
  const home = installed('aaa1111');
  const rel = release(payload('bbb2222'));
  let busyChecks = 0;
  // Idle when asked to start, then a request arrives during the download and stays.
  const { u } = make(home, rel, { isIdle: (o) => (o.inFlightOnly ? (++busyChecks, false) : true) });
  u.offer(rel.advert);
  await u.maybeApply();
  assert.equal(u.status().state, 'waiting-idle');
  assert.ok(busyChecks > 1, 'polled before giving up');
  assert.equal(readTree(home, 'taps/tap-agent.js'), 'agent aaa1111');
});

test('restart outcome is reported: no logon task leaves the update applied but pending', async () => {
  const home = installed('aaa1111');
  const rel = release(payload('bbb2222'));
  const { u } = make(home, rel, { restartResult: { restarting: false, reason: 'GLMPS_TAP_HOME is set, so there is no logon task' } });
  u.offer(rel.advert);
  await u.maybeApply();
  assert.equal(u.status().state, 'applied');
  assert.match(u.status().reason, /restart pending.*GLMPS_TAP_HOME/);
});

test('tarExtractor unpacks a real zip with Windows tar.exe', { skip: process.platform !== 'win32' && 'tar.exe and zip extraction are Windows-only here' }, () => {
  const src = mkTmp('mc-tapupd-src-');
  writeTree(src, { 'taps/tap-agent.js': 'x', 'node.exe': 'y' });
  const zip = path.join(mkTmp('mc-tapupd-zip-'), 'u.zip');
  const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  assert.equal(spawnSync(tar, ['-a', '-c', '-f', zip, '-C', src, '.'], { windowsHide: true }).status, 0);
  const out = mkTmp('mc-tapupd-out-');
  assert.deepEqual(tarExtractor()(zip, out), { ok: true });
  assert.equal(readTree(out, 'taps/tap-agent.js'), 'x');
  assert.match(tarExtractor()(path.join(out, 'node.exe'), mkTmp('mc-tapupd-bad-')).error, /tar/);
});

test('the restart is handed to a hidden, detached helper that starts the logon task after this process exits', () => {
  const calls = [];
  const spawn = (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { unref: () => { calls.at(-1).unref = true; } }; };
  const home = mkTmp('mc-tapupd-rs-');
  const r = logonTaskRestarter({ home, spawn, env: { PATH: 'x' }, pid: 4242 })();
  assert.deepEqual(r, { restarting: true });
  assert.equal(calls.length, 1);
  const [c] = calls;
  assert.equal(c.cmd, 'powershell.exe');
  assert.ok(c.args.includes('-NonInteractive') && c.args.includes('Hidden'));
  assert.match(c.args.at(-1), /Get-Process -Id \$p/, 'waits for the old agent to exit');
  assert.match(c.args.at(-1), /Schedule\.Service.*\.Run\(\$null\)/, 'starts the task through the COM API, no child console');
  assert.equal(c.opts.detached, true);
  assert.equal(c.opts.windowsHide, true);
  assert.equal(c.opts.stdio, 'ignore');
  assert.equal(c.opts.env.GLMPS_TAP_PID, '4242');
  assert.equal(c.opts.env.GLMPS_TAP_TASK, LOGON_TASK_NAME);
  assert.equal(c.opts.env.GLMPS_TAP_LOG, path.join(home, 'update', 'restart.log'));
  assert.equal(c.unref, true);

  const none = logonTaskRestarter({ home, spawn, env: { GLMPS_TAP_HOME: home } })();
  assert.equal(none.restarting, false);
  assert.match(none.reason, /no logon task/);
  assert.equal(calls.length, 1, 'nothing spawned without a task');
});
