// D24: one command moves a plugin to a new upstream release. It only ever
// proposes a pull request; a human merges.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

async function getJson(url, fetchImpl) { const r = await fetchImpl(url); if (!r.ok) throw new Error(`GET ${url} failed`); return r.json(); }
export async function latestVersion(u, { fetchImpl = fetch } = {}) {
  return u.kind === 'npm' ? (await getJson(`https://registry.npmjs.org/${u.name}/latest`, fetchImpl)).version
    : (await getJson(`https://pypi.org/pypi/${u.name}/json`, fetchImpl)).info.version;
}
// L-a: also returns the registry's own recorded digest
// (npm's dist.integrity, an SRI string like "sha512-<base64>"; PyPI's
// digests.sha256, a bare hex string) so stageUpstream can verify the
// downloaded bytes before ever extracting them - a compromised CDN/mirror or
// a MITM must not be able to silently stage a swapped tarball/wheel into
// vendor/. A registry entry with no digest at all (some legacy packages)
// returns null: verifyDigest treats that as nothing to check, not a failure.
export async function artifactUrl(u, version, { fetchImpl = fetch } = {}) {
  if (u.kind === 'npm') {
    const meta = await getJson(`https://registry.npmjs.org/${u.name}/${version}`, fetchImpl);
    return { url: meta.dist.tarball, integrity: meta.dist.integrity || null };
  }
  const meta = await getJson(`https://pypi.org/pypi/${u.name}/${version}/json`, fetchImpl);
  const w = meta.urls.find((x) => x.packagetype === 'bdist_wheel');
  if (!w) throw new Error(`${u.name} ${version} has no wheel`);
  return { url: w.url, sha256: w.digests?.sha256 || null };
}
function verifyDigest(buf, { integrity, sha256 } = {}) {
  if (integrity) {
    const [algo, expected] = integrity.split('-');
    const actual = crypto.createHash(algo).update(buf).digest('base64');
    if (actual !== expected) throw new Error(`integrity mismatch (${algo}): expected ${expected}, got ${actual}`);
  } else if (sha256) {
    const actual = crypto.createHash('sha256').update(buf).digest('hex');
    if (actual !== sha256) throw new Error(`sha256 mismatch: expected ${sha256}, got ${actual}`);
  }
}
function run(cmd, args, opts = {}) { const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts }); if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')}: ${r.stderr || r.stdout}`); return r.stdout; }
// Translates a glob into a RegExp, char by char, so a doubled-star directory
// segment ("**/") can become an *optional* "zero or more whole path segments"
// group instead of a literal ".*" spliced between the pattern's two halves.
// The previous version (`g.split('**').join('.*')`) always re-inserted
// whatever literal text followed the "**" verbatim, including its leading
// "/" - so "v3/**/*.js" compiled to "v3/.*\/[^/]*\.js", which requires an
// extra "/" beyond "v3/" and therefore never matched "v3/external.js" (only
// files at least one directory deeper, like "v3/helpers/x.js", matched). A
// bare "**" not adjacent to a "/" keeps its old meaning: match anything,
// including further "/" separators.
export function globToRe(g) {
  let re = '';
  for (let i = 0; i < g.length;) {
    if (g[i] === '*' && g[i + 1] === '*') {
      if (g[i + 2] === '/') { re += '(?:.*/)?'; i += 3; }
      else { re += '.*'; i += 2; }
    } else if (g[i] === '*') {
      re += '[^/]*'; i += 1;
    } else {
      re += g[i].replace(/[.+^${}()|[\]\\]/g, '\\$&'); i += 1;
    }
  }
  return new RegExp('^' + re + '$');
}
// A symlink (or, on Windows, a junction - fs.lstatSync also reports those
// as a symlink) is returned as a leaf entry, never recursed into: the
// per-entry lstat check in stageFromExtracted is what actually refuses it,
// but the walk itself must not descend through it to discover, and hand
// back, whatever lives on the other side.
function listFiles(d) {
  return fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(d, e.name);
    if (e.isSymbolicLink()) return [p];
    return e.isDirectory() ? listFiles(p) : [p];
  });
}

// npm tarballs are extracted with GNU tar's relative-path form: cwd is set to
// the download dir and both the archive name and the -C target are passed
// as bare relative names, so no drive letter ever reaches an argument. GNU
// tar only treats an archive name as a remote HOST:FILE spec when a colon
// appears in that argument; Windows' bundled bsdtar (System32\tar.exe) has
// no --force-local flag at all and errors out if it is passed. Relative
// paths make both tars behave identically without needing to sniff which
// one is on PATH.
function extractTarGz(file, outDir) {
  const cwd = path.dirname(file);
  const archiveName = path.basename(file);
  const outName = path.basename(outDir);
  run('tar', ['-xzf', archiveName, '-C', outName], { cwd });
}

// Copies only the paths matched by `files` (plus LICENSE/NOTICE) from an
// already-extracted `root` into `destDir`. `list` is injectable so the
// escape guard below can be unit-tested without a real archive: `rel` is
// always built from `path.relative(root, f)`, which node normalizes so that
// any path outside `root` comes back with a leading '..' segment (never one
// buried in the middle) - refusing that prefix is a complete guard against
// zip-slip / tar path traversal reaching outside destDir, however `f` was
// discovered.
export function stageFromExtracted({ root, destDir, files, list = listFiles }) {
  const res = (files || ['**']).map(globToRe);
  fs.mkdirSync(destDir, { recursive: true });
  for (const f of list(root)) {
    const rel = path.relative(root, f).split(path.sep).join('/');
    if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
    // Refuse any symlink outright rather than silently skip it: copyFileSync
    // follows symlinks on read, so a symlinked file would otherwise land
    // whatever it points to (host file content) inside destDir.
    if (fs.lstatSync(f).isSymbolicLink()) throw new Error(`refusing symlink in upstream archive: ${rel}`);
    if (/^(LICENSE|NOTICE)/i.test(path.basename(rel)) || res.some((re) => re.test(rel))) {
      const dest = path.join(destDir, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(f, dest);
    }
  }
}

// True if `dir` (searched recursively, e.g. a pypi wheel's *.dist-info/
// subdirectory) already has a file stageFromExtracted would have recognized
// as a license under its own `LICENSE|NOTICE` rule.
function hasLicenseFile(dir) {
  return fs.existsSync(dir) && listFiles(dir).some((f) => /^(LICENSE|NOTICE)/i.test(path.basename(f)));
}
// Some upstream npm tarballs (e.g. mem0ai's) ship no LICENSE/NOTICE file at
// all, even though the package declares a license in package.json. When the
// author supplies `upstream.licenseUrl` (pinned to the exact tag or commit
// the staged version was published from, per plugin.json) and the staged
// output has no license file of its own, this fetches that URL and writes it
// as `destDir/LICENSE` - so `vendor/` keeps a real license text on disk
// without a hand-added file that the next `stageUpstream` run would wipe.
// Returns whether it wrote anything, for tests.
export async function ensureLicense({ destDir, licenseUrl, fetchImpl = fetch }) {
  if (!licenseUrl || hasLicenseFile(destDir)) return false;
  const res = await fetchImpl(licenseUrl);
  if (!res.ok) throw new Error(`GET ${licenseUrl} failed`);
  fs.writeFileSync(path.join(destDir, 'LICENSE'), Buffer.from(await res.arrayBuffer()));
  return true;
}

export async function stageUpstream({ upstream, version, destDir, fetchImpl = fetch }) {
  const { url, integrity, sha256 } = await artifactUrl(upstream, version, { fetchImpl });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-plugin-dl-'));
  try {
    const file = path.join(tmp, path.basename(new URL(url).pathname));
    const buf = Buffer.from(await (await fetchImpl(url)).arrayBuffer());
    verifyDigest(buf, { integrity, sha256 });
    fs.writeFileSync(file, buf);
    const out = path.join(tmp, 'x'); fs.mkdirSync(out);
    if (upstream.kind === 'npm') extractTarGz(file, out);
    else run('python', ['-m', 'zipfile', '-e', file, out]);
    const root = upstream.kind === 'npm' ? path.join(out, 'package') : out;
    stageFromExtracted({ root, destDir, files: upstream.files });
    await ensureLicense({ destDir, licenseUrl: upstream.licenseUrl, fetchImpl });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
export function applyPatches({ pluginDir, patches, runGit = (args) => spawnSync('git', args, { cwd: pluginDir, encoding: 'utf8' }) }) {
  for (const p of patches) {
    if (runGit(['apply', '--check', p]).status !== 0 || runGit(['apply', p]).status !== 0) return { ok: false, failed: p };
  }
  return { ok: true, failed: null };
}
const win = process.platform === 'win32';
const realDeps = {
  latestVersion, stageUpstream, applyPatches,
  runTests: async (pluginDir) => spawnSync(process.execPath, ['--test', path.join(pluginDir, 'test')], { stdio: 'inherit' }).status === 0
    && spawnSync(win ? 'npm.cmd' : 'npm', ['test'], { stdio: 'inherit', shell: win }).status === 0,
  openPr: async ({ name, to, body }) => {
    run('git', ['checkout', '-b', `plugin-upgrade/${name}-${to}`]);
    run('git', ['add', '-A', path.join('plugins', name)]);
    run('git', ['commit', '-m', `chore(plugins): upgrade ${name} to ${to}`]);
    run('git', ['push', '-u', 'origin', 'HEAD']);
    return run('gh', ['pr', 'create', '--title', `Upgrade plugin ${name} to ${to}`, '--body', body]).trim();
  },
};
export async function upgradePlugin({ pluginDir, to = null, dryRun = false, noPr = false, deps = realDeps }) {
  // A vendor.bak-* left behind by a killed or crashed prior run means that
  // run's own restore never happened: refuse to start a new upgrade on top
  // of it, before reading or touching anything else in pluginDir.
  const staleBackup = fs.existsSync(pluginDir) ? fs.readdirSync(pluginDir).find((n) => n.startsWith('vendor.bak-')) : null;
  if (staleBackup) throw new Error(`previous upgrade was interrupted: restore ${path.join(pluginDir, staleBackup)} to vendor/ (or delete it) before retrying`);
  const metaFile = path.join(pluginDir, 'plugin.json'); const metaText = fs.readFileSync(metaFile, 'utf8'); const meta = JSON.parse(metaText);
  const primary = meta.upstream[0]; const from = primary.version;
  const target = to || await deps.latestVersion(primary);
  if (target === from || dryRun) return { from, to: target, changed: false, patchFailed: null, testsOk: null, pr: null, prError: null };
  const vendor = path.join(pluginDir, 'vendor');
  let backup, restore;
  try {
    backup = `${vendor}.bak-${Date.now()}`;
    fs.renameSync(vendor, backup);
    restore = () => { fs.rmSync(vendor, { recursive: true, force: true }); fs.renameSync(backup, vendor); fs.writeFileSync(metaFile, metaText); };
    for (const u of meta.upstream) {
      const v = u === primary ? target : u.version;
      await deps.stageUpstream({ upstream: u, version: v, destDir: path.join(vendor, u.name) });
      u.version = v;
    }
    const p = deps.applyPatches({ pluginDir, patches: meta.patches || [] });
    if (!p.ok) { restore(); return { from, to: target, changed: false, patchFailed: p.failed, testsOk: null, pr: null, prError: null }; }
    fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2) + '\n');
    if (!(await deps.runTests(pluginDir))) { restore(); return { from, to: target, changed: false, patchFailed: null, testsOk: false, pr: null, prError: null }; }
  } catch (e) {
    if (restore) restore();
    throw e;
  }
  // Patches applied and tests passed: the upgrade is committed to disk from
  // here on regardless of what happens next. A failed PR step must not
  // trigger a restore - the backup is already gone by the time openPr runs,
  // so restoring here would delete the (good) upgraded vendor/ and then
  // fail trying to rename a backup that no longer exists, masking the real
  // error and leaving plugin.json pointing at a deleted tree.
  fs.rmSync(backup, { recursive: true, force: true });
  const changelog = primary.kind === 'npm' ? `https://www.npmjs.com/package/${primary.name}/v/${target}` : `https://pypi.org/project/${primary.name}/${target}/`;
  let pr = null; let prError = null;
  if (!noPr) {
    try {
      pr = await deps.openPr({ name: meta.name, to: target, body: `Upstream ${primary.name} ${from} -> ${target}. Patches re-applied cleanly; plugin tests and the full suite pass.\n\nChangelog: ${changelog}\n\n\uD83E\uDD16 Generated with [Claude Code](https://claude.com/claude-code)` });
    } catch (e) {
      prError = e.message;
    }
  }
  return { from, to: target, changed: true, patchFailed: null, testsOk: true, pr, prError };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const [name, ...rest] = process.argv.slice(2);
  if (!name) { console.error('usage: node scripts/plugin-upgrade.mjs <plugin> [--to <v>] [--dry-run] [--no-pr]'); process.exit(2); }
  const to = rest.includes('--to') ? rest[rest.indexOf('--to') + 1] : null;
  upgradePlugin({ pluginDir: path.resolve('plugins', name), to, dryRun: rest.includes('--dry-run'), noPr: rest.includes('--no-pr') })
    .then((r) => { console.log(JSON.stringify(r, null, 2)); process.exit(r.patchFailed || r.testsOk === false || r.prError ? 1 : 0); })
    .catch((e) => { console.error(e.message); process.exit(1); });
}
