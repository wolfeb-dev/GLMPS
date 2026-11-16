import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { latestVersion, artifactUrl, upgradePlugin, stageFromExtracted, stageUpstream, globToRe, ensureLicense } from '../../scripts/plugin-upgrade.mjs';

const fetchJson = (map) => async (url) => ({ ok: true, json: async () => map[url] });

// L-a: artifactUrl now also returns the registry's own
// recorded digest (npm's dist.integrity, an SRI string; PyPI's
// digests.sha256, a bare hex string) alongside the URL, so stageUpstream can
// verify the downloaded artifact before ever extracting it.
test('latestVersion and artifactUrl read the npm and pypi registries, including the registry-recorded digest', async () => {
  const f = fetchJson({
    'https://registry.npmjs.org/mem0ai/latest': { version: '3.3.0' },
    'https://registry.npmjs.org/mem0ai/3.3.0': { dist: { tarball: 'https://t/mem0ai-3.3.0.tgz', integrity: 'sha512-abc123==' } },
    'https://pypi.org/pypi/gepa/json': { info: { version: '0.1.5' } },
    'https://pypi.org/pypi/gepa/0.1.5/json': { urls: [{ packagetype: 'sdist', url: 's' }, { packagetype: 'bdist_wheel', url: 'https://w/gepa.whl', digests: { sha256: 'deadbeef' } }] },
  });
  assert.equal(await latestVersion({ kind: 'npm', name: 'mem0ai' }, { fetchImpl: f }), '3.3.0');
  assert.deepEqual(await artifactUrl({ kind: 'npm', name: 'mem0ai' }, '3.3.0', { fetchImpl: f }), { url: 'https://t/mem0ai-3.3.0.tgz', integrity: 'sha512-abc123==' });
  assert.equal(await latestVersion({ kind: 'pypi', name: 'gepa' }, { fetchImpl: f }), '0.1.5');
  assert.deepEqual(await artifactUrl({ kind: 'pypi', name: 'gepa' }, '0.1.5', { fetchImpl: f }), { url: 'https://w/gepa.whl', sha256: 'deadbeef' });
});

test('artifactUrl tolerates a registry entry with no digest at all (a legacy package)', async () => {
  const f = fetchJson({
    'https://registry.npmjs.org/x/1.0.0': { dist: { tarball: 'https://t/x.tgz' } },
    'https://pypi.org/pypi/y/1.0.0/json': { urls: [{ packagetype: 'bdist_wheel', url: 'https://w/y.whl' }] },
  });
  assert.deepEqual(await artifactUrl({ kind: 'npm', name: 'x' }, '1.0.0', { fetchImpl: f }), { url: 'https://t/x.tgz', integrity: null });
  assert.deepEqual(await artifactUrl({ kind: 'pypi', name: 'y' }, '1.0.0', { fetchImpl: f }), { url: 'https://w/y.whl', sha256: null });
});

// L-a: a compromised CDN/mirror or a
// MITM must not be able to silently stage a swapped tarball/wheel into
// vendor/ - the downloaded bytes are checked against the registry's own
// recorded digest before extraction, exactly like a swapped npm tarball
// would be caught by a lockfile integrity check in a normal npm install.
test('stageUpstream refuses a downloaded npm tarball whose bytes do not match dist.integrity', async () => {
  const destDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-dest-'));
  const f = async (url) => {
    if (url === 'https://registry.npmjs.org/x/1.0.0') {
      return { ok: true, json: async () => ({ dist: { tarball: 'https://t/x-1.0.0.tgz', integrity: 'sha512-wrongDigest==' } }) };
    }
    return { ok: true, arrayBuffer: async () => Buffer.from('not the real tarball') };
  };
  await assert.rejects(
    stageUpstream({ upstream: { kind: 'npm', name: 'x', files: ['a.js'] }, version: '1.0.0', destDir, fetchImpl: f }),
    /integrity mismatch/,
  );
  assert.deepEqual(fs.readdirSync(destDir), [], 'nothing must be staged when the digest does not match');
});

test('stageUpstream refuses a downloaded pypi wheel whose bytes do not match digests.sha256', async () => {
  const destDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-dest-'));
  const f = async (url) => {
    if (url === 'https://pypi.org/pypi/y/1.0.0/json') {
      return { ok: true, json: async () => ({ urls: [{ packagetype: 'bdist_wheel', url: 'https://w/y.whl', digests: { sha256: 'deadbeef' } }] }) };
    }
    return { ok: true, arrayBuffer: async () => Buffer.from('not the real wheel') };
  };
  await assert.rejects(
    stageUpstream({ upstream: { kind: 'pypi', name: 'y', files: ['y.py'] }, version: '1.0.0', destDir, fetchImpl: f }),
    /sha256 mismatch/,
  );
});

test('stageUpstream proceeds normally when the downloaded bytes match the registry digest', async () => {
  const destDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-dest-'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-src-'));
  fs.mkdirSync(path.join(tmp, 'package'));
  fs.writeFileSync(path.join(tmp, 'package', 'a.js'), 'real content');
  const content = Buffer.from('real npm tarball bytes');
  const goodIntegrity = `sha512-${crypto.createHash('sha512').update(content).digest('base64')}`;
  const f = async (url) => {
    if (url === 'https://registry.npmjs.org/x/1.0.0') {
      return { ok: true, json: async () => ({ dist: { tarball: 'https://t/x-1.0.0.tgz', integrity: goodIntegrity } }) };
    }
    return { ok: true, arrayBuffer: async () => content };
  };
  // extractTarGz shells out to the real `tar` binary, which the fake content
  // above is not a valid archive for - stubbing stageFromExtracted's list()
  // is not an option here (it is not injected through this call), so this
  // asserts the digest check itself passes (no "mismatch" rejection) even
  // though extraction afterward fails on the fake bytes, proving the two
  // steps are independent.
  await assert.rejects(
    stageUpstream({ upstream: { kind: 'npm', name: 'x', files: ['a.js'] }, version: '1.0.0', destDir, fetchImpl: f }),
    (e) => !/mismatch/i.test(e.message),
  );
});

function tmpPlugin() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-upg-'));
  fs.mkdirSync(path.join(dir, 'vendor', 'x'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'vendor', 'x', 'a.js'), 'old');
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({ name: 'x', contract: 'embed@1', upstream: [{ kind: 'npm', name: 'x', version: '1.0.0', files: ['a.js'], license: 'MIT' }], shims: {}, patches: [] }));
  return dir;
}
const deps = (over = {}) => ({
  latestVersion: async () => '1.1.0',
  stageUpstream: async ({ destDir }) => { fs.mkdirSync(destDir, { recursive: true }); fs.writeFileSync(path.join(destDir, 'a.js'), 'new'); },
  applyPatches: () => ({ ok: true, failed: null }),
  runTests: async () => true,
  openPr: async () => 'https://github.com/x/pull/1',
  ...over,
});
const vendorA = (dir) => fs.readFileSync(path.join(dir, 'vendor', 'x', 'a.js'), 'utf8');
const pinned = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8')).upstream[0].version;

test('an up-to-date plugin is a no-op', async () => {
  const dir = tmpPlugin();
  assert.equal((await upgradePlugin({ pluginDir: dir, deps: deps({ latestVersion: async () => '1.0.0' }) })).changed, false);
});
test('a clean upgrade replaces vendor, bumps plugin.json and opens a PR', async () => {
  const dir = tmpPlugin();
  const r = await upgradePlugin({ pluginDir: dir, deps: deps() });
  assert.deepEqual([r.from, r.to, r.changed, r.testsOk, r.pr], ['1.0.0', '1.1.0', true, true, 'https://github.com/x/pull/1']);
  assert.equal(vendorA(dir), 'new'); assert.equal(pinned(dir), '1.1.0');
});
test('a failed patch or failed tests restore vendor and plugin.json', async () => {
  for (const over of [{ applyPatches: () => ({ ok: false, failed: 'patches/0001-x.diff' }) }, { runTests: async () => false }]) {
    const dir = tmpPlugin();
    const r = await upgradePlugin({ pluginDir: dir, deps: deps(over) });
    assert.equal(r.pr, null); assert.equal(vendorA(dir), 'old'); assert.equal(pinned(dir), '1.0.0');
  }
});
function allFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? allFiles(p) : [p];
  });
}
test('a thrown stageUpstream restores vendor and plugin.json exactly, leaving no backup', async () => {
  const dir = tmpPlugin();
  await assert.rejects(
    upgradePlugin({ pluginDir: dir, deps: deps({ stageUpstream: async () => { throw new Error('boom'); } }) }),
    /boom/,
  );
  assert.equal(vendorA(dir), 'old');
  assert.equal(pinned(dir), '1.0.0');
  assert.equal(fs.readdirSync(dir).some((n) => n.startsWith('vendor.bak-')), false);
});

test('stageFromExtracted refuses an entry outside root, even one an unsanitized archive tool might hand it', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-slip-'));
  const root = path.join(base, 'extracted');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'a.js'), 'legit');
  const secret = path.join(base, 'secret.txt');
  fs.writeFileSync(secret, 'outside root');
  const destDir = path.join(base, 'vendor', 'x');
  assert.equal(fs.existsSync(path.join(base, 'vendor', 'secret.txt')), false);
  const outsideDestBefore = allFiles(base).filter((f) => !f.startsWith(destDir + path.sep)).sort();
  // Simulate an extraction backend that (unlike real tar/zipfile, which
  // already refuse such entries) handed back a path escaping root: the
  // guard in stageFromExtracted must still keep it out of destDir and must
  // not write anywhere else on disk either.
  stageFromExtracted({ root, destDir, files: ['**'], list: () => [path.join(root, 'a.js'), secret] });
  assert.equal(fs.readFileSync(path.join(destDir, 'a.js'), 'utf8'), 'legit');
  assert.equal(fs.existsSync(path.join(destDir, 'secret.txt')), false);
  // The naive (unguarded) copy loop would land this one directory above
  // destDir, at base/vendor/secret.txt: a brand new file, not the original.
  assert.equal(fs.existsSync(path.join(base, 'vendor', 'secret.txt')), false);
  const outsideDestAfter = allFiles(base).filter((f) => !f.startsWith(destDir + path.sep)).sort();
  assert.deepEqual(outsideDestAfter, outsideDestBefore);
});

test('a failed PR step keeps the upgrade on disk and reports prError, not a restore', async () => {
  const dir = tmpPlugin();
  const r = await upgradePlugin({ pluginDir: dir, deps: deps({ openPr: async () => { throw new Error('gh pr create failed: rate limited'); } }) });
  assert.equal(r.changed, true);
  assert.equal(r.testsOk, true);
  assert.equal(r.pr, null);
  assert.equal(r.prError, 'gh pr create failed: rate limited');
  assert.equal(vendorA(dir), 'new');
  assert.equal(pinned(dir), '1.1.0');
  assert.equal(fs.readdirSync(dir).some((n) => n.startsWith('vendor.bak-')), false);
});

test('a pre-existing vendor.bak-* refuses to start a new upgrade, before touching anything', async () => {
  const dir = tmpPlugin();
  const stale = path.join(dir, 'vendor.bak-999');
  fs.mkdirSync(stale, { recursive: true });
  fs.writeFileSync(path.join(stale, 'marker.txt'), 'stale backup contents');
  await assert.rejects(upgradePlugin({ pluginDir: dir, deps: deps() }), /previous upgrade was interrupted/);
  assert.equal(vendorA(dir), 'old');
  assert.equal(pinned(dir), '1.0.0');
  assert.equal(fs.existsSync(stale), true);
});

test('stageFromExtracted refuses a symlinked directory entry and never descends into it', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-symlink-dir-'));
  const root = path.join(base, 'extracted');
  fs.mkdirSync(root, { recursive: true });
  const secretDir = path.join(base, 'secret-dir');
  fs.mkdirSync(secretDir);
  fs.writeFileSync(path.join(secretDir, 'inside.txt'), 'dir secret');
  const dirLink = path.join(root, 'evil-dir');
  // A junction needs no elevated privilege on Windows and is reported by
  // fs.lstatSync as a symlink, same as a real directory symlink elsewhere.
  fs.symlinkSync(secretDir, dirLink, process.platform === 'win32' ? 'junction' : 'dir');
  const destDir = path.join(base, 'vendor', 'x');
  assert.throws(() => stageFromExtracted({ root, destDir, files: ['**'] }), /refusing symlink in upstream archive: evil-dir/);
  // The walker must not have descended into the symlinked directory at all:
  // nothing from inside it should even be discoverable, let alone copied.
  assert.equal(fs.existsSync(path.join(destDir, 'evil-dir')), false);
});

test('stageFromExtracted refuses a symlinked file entry (does not follow it via copyFileSync)', (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-symlink-file-'));
  const root = path.join(base, 'extracted');
  fs.mkdirSync(root, { recursive: true });
  const secretFile = path.join(base, 'secret-file.txt');
  fs.writeFileSync(secretFile, 'file secret');
  const fileLink = path.join(root, 'evil-file');
  try {
    fs.symlinkSync(secretFile, fileLink, 'file');
  } catch (e) {
    t.skip(`file symlink creation not permitted on this host (${e.code}): skipping this case`);
    return;
  }
  const destDir = path.join(base, 'vendor', 'x');
  assert.throws(() => stageFromExtracted({ root, destDir, files: ['**'] }), /refusing symlink in upstream archive: evil-file/);
  assert.equal(fs.existsSync(path.join(destDir, 'evil-file')), false);
});

test('dry-run reports the target and stages nothing', async () => {
  const dir = tmpPlugin();
  const r = await upgradePlugin({ pluginDir: dir, dryRun: true, deps: deps() });
  assert.equal(r.to, '1.1.0'); assert.equal(r.changed, false); assert.equal(vendorA(dir), 'old');
});

test('stageUpstream cleans up its temp download dir even when the download throws mid-way', async () => {
  const before = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('mc-plugin-dl-'));
  const f = async (url) => {
    if (url === 'https://registry.npmjs.org/x/1.0.0') return { ok: true, json: async () => ({ dist: { tarball: 'https://t/x-1.0.0.tgz' } }) };
    throw new Error('network down');
  };
  const destDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-dest-'));
  await assert.rejects(
    stageUpstream({ upstream: { kind: 'npm', name: 'x', files: ['a.js'] }, version: '1.0.0', destDir, fetchImpl: f }),
    /network down/,
  );
  const after = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('mc-plugin-dl-'));
  assert.deepEqual(after, before);
});

test('globToRe: a doubled-star directory segment matches zero, one, or several directories', () => {
  const re = globToRe('a/**/b');
  assert.match('a/b', re);
  assert.match('a/x/b', re);
  assert.match('a/x/y/b', re);
  assert.equal(re.test('a/b/c'), false);
  assert.equal(re.test('x/a/b'), false);
});
test('globToRe: this is exactly the bug found in review - v3/**/*.js must match v3/external.js, not just nested files', () => {
  const re = globToRe('v3/**/*.js');
  assert.match('v3/external.js', re);
  assert.match('v3/helpers/enumUtil.js', re);
  assert.match('v3/locales/en.js', re);
  assert.equal(re.test('v3/external.ts'), false);
});
test('globToRe: a leading doubled-star segment matches with or without a directory prefix', () => {
  const re = globToRe('**/x');
  assert.match('x', re);
  assert.match('a/x', re);
  assert.match('a/b/x', re);
});
test('globToRe: a bare trailing "**" still matches anything under the prefix, including nested paths (unchanged behavior)', () => {
  const re = globToRe('v3/**');
  assert.match('v3/a', re);
  assert.match('v3/a/b/c', re);
  assert.equal(globToRe('**').test('anything/at/all'), true);
});

test('stageFromExtracted: v3/**/*.js (the real pattern from plugins/mem0/plugin.json) matches a file directly under v3/ as well as nested ones', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-globstar-'));
  const root = path.join(base, 'extracted');
  fs.mkdirSync(path.join(root, 'v3', 'helpers'), { recursive: true });
  fs.writeFileSync(path.join(root, 'v3', 'external.js'), 'top-level');
  fs.writeFileSync(path.join(root, 'v3', 'helpers', 'util.js'), 'nested');
  fs.writeFileSync(path.join(root, 'v3', 'external.d.ts'), 'not js, must not copy');
  const destDir = path.join(base, 'vendor', 'zod');
  stageFromExtracted({ root, destDir, files: ['v3/**/*.js'] });
  assert.equal(fs.readFileSync(path.join(destDir, 'v3', 'external.js'), 'utf8'), 'top-level');
  assert.equal(fs.readFileSync(path.join(destDir, 'v3', 'helpers', 'util.js'), 'utf8'), 'nested');
  assert.equal(fs.existsSync(path.join(destDir, 'v3', 'external.d.ts')), false);
});

test('ensureLicense: no-op when the staged output already has a LICENSE/NOTICE file', async () => {
  const destDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-lic-'));
  fs.writeFileSync(path.join(destDir, 'LICENSE'), 'already here');
  const fetchImpl = async () => { throw new Error('must not be called'); };
  const wrote = await ensureLicense({ destDir, licenseUrl: 'https://example/LICENSE', fetchImpl });
  assert.equal(wrote, false);
  assert.equal(fs.readFileSync(path.join(destDir, 'LICENSE'), 'utf8'), 'already here');
});
test('ensureLicense: no-op when no licenseUrl is given', async () => {
  const destDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-lic-'));
  const fetchImpl = async () => { throw new Error('must not be called'); };
  const wrote = await ensureLicense({ destDir, licenseUrl: undefined, fetchImpl });
  assert.equal(wrote, false);
  assert.equal(fs.existsSync(path.join(destDir, 'LICENSE')), false);
});
test('ensureLicense: fetches and writes LICENSE when the staged output has none, via an injected fetchImpl', async () => {
  const destDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-lic-'));
  fs.mkdirSync(path.join(destDir, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(destDir, 'dist', 'index.mjs'), 'export {};');
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return { ok: true, arrayBuffer: async () => new TextEncoder().encode('Apache License 2.0 text').buffer };
  };
  const wrote = await ensureLicense({ destDir, licenseUrl: 'https://raw.githubusercontent.com/mem0ai/mem0/abc123/LICENSE', fetchImpl });
  assert.equal(wrote, true);
  assert.deepEqual(calls, ['https://raw.githubusercontent.com/mem0ai/mem0/abc123/LICENSE']);
  assert.equal(fs.readFileSync(path.join(destDir, 'LICENSE'), 'utf8'), 'Apache License 2.0 text');
});
test('ensureLicense: a licenseUrl fetch that fails throws rather than silently leaving no LICENSE', async () => {
  const destDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-lic-'));
  const fetchImpl = async () => ({ ok: false });
  await assert.rejects(
    ensureLicense({ destDir, licenseUrl: 'https://example/LICENSE', fetchImpl }),
    /GET https:\/\/example\/LICENSE failed/,
  );
  assert.equal(fs.existsSync(path.join(destDir, 'LICENSE')), false);
});
test('ensureLicense: a LICENSE nested in a subdirectory (e.g. a pypi dist-info dir) still counts as "already has one"', async () => {
  const destDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-lic-'));
  fs.mkdirSync(path.join(destDir, 'pkg-1.0.dist-info'), { recursive: true });
  fs.writeFileSync(path.join(destDir, 'pkg-1.0.dist-info', 'LICENSE'), 'nested license');
  const fetchImpl = async () => { throw new Error('must not be called'); };
  const wrote = await ensureLicense({ destDir, licenseUrl: 'https://example/LICENSE', fetchImpl });
  assert.equal(wrote, false);
});

// Real network smoke test, skipped by default: stages a real, tiny npm
// tarball and a real, tiny pypi wheel end to end (download, extract, copy
// matched files). Run with GLMPS_NET_TESTS=1 to exercise the real tar / python
// zipfile extraction path this suite otherwise never touches.
test('stageUpstream stages a real npm tarball and a real pypi wheel', { skip: process.env.GLMPS_NET_TESTS !== '1' ? 'set GLMPS_NET_TESTS=1 to run (network)' : false }, async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-net-'));
  const npmDest = path.join(base, 'left-pad');
  await stageUpstream({ upstream: { kind: 'npm', name: 'left-pad', files: ['package.json', 'index.js'] }, version: '1.3.0', destDir: npmDest });
  const npmFiles = allFiles(npmDest).map((f) => path.relative(npmDest, f).split(path.sep).join('/')).sort();
  assert.deepEqual(npmFiles, ['index.js', 'package.json']);

  const pypiDest = path.join(base, 'six');
  await stageUpstream({ upstream: { kind: 'pypi', name: 'six', files: ['six.py'] }, version: '1.16.0', destDir: pypiDest });
  const pypiFiles = allFiles(pypiDest).map((f) => path.relative(pypiDest, f).split(path.sep).join('/')).sort();
  // stageUpstream always copies LICENSE/NOTICE files alongside whatever
  // `files` matches; six's wheel ships one under its dist-info metadata dir.
  assert.deepEqual(pypiFiles, ['six-1.16.0.dist-info/LICENSE', 'six.py']);
});
