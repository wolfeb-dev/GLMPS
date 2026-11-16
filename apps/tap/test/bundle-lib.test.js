// The tap bundle's pure library (card glmps-2-0-runtime-30). Runs in the root
// matrix with no install; the esbuild build and the parity run are
// `npm run smoke` in apps/tap (.github/workflows/tap.yml).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { HOOK_MANIFEST, planHookInstall } from '../../../scripts/install-hooks-lib.mjs';
import { tapEntries, rewriteImportMeta, unbundledImports, checkNodePin, sha256, buildOptions, STATUSLINE_TAP, TAP_AGENT, SPAWNED_SCRIPTS, INSTALLER_ENTRIES } from '../scripts/bundle-lib.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const TAP_ROOT = path.resolve(import.meta.dirname, '..');

test('the entries are every manifest script, the statusline tap and the spawned synth script', () => {
  const entries = tapEntries();
  for (const r of HOOK_MANIFEST) assert.ok(entries.includes(`${r.dir || 'hooks'}/${r.script}`), r.id);
  assert.ok(entries.includes(STATUSLINE_TAP));
  for (const s of SPAWNED_SCRIPTS) assert.ok(entries.includes(s));
  assert.ok(entries.includes(TAP_AGENT));
  assert.equal(TAP_AGENT, 'taps/tap-agent.js');
  assert.equal(entries.length, new Set(HOOK_MANIFEST.map((r) => r.script)).size + 2 + SPAWNED_SCRIPTS.length + INSTALLER_ENTRIES.length);
  for (const s of INSTALLER_ENTRIES) assert.ok(entries.includes(s));
  for (const e of entries) assert.ok(fs.existsSync(path.join(REPO_ROOT, e)), `${e} exists`);
});

test('an entry more than one folder deep is refused', () => {
  assert.throws(() => tapEntries([{ id: 'x', event: 'Stop', matcher: '', script: 'x.js', dir: 'hooks/lib' }]), /one folder deep/);
});

test('every spawned script is still spawned by path from a hook', () => {
  const tick = fs.readFileSync(path.join(REPO_ROOT, 'hooks', 'capability-synth-tick.js'), 'utf8');
  assert.match(tick, /'scripts', 'capability-synth\.mjs'/);
});

test('a module inlined into another bundle keeps its own import.meta.url', () => {
  const out = rewriteImportMeta('if (fileURLToPath(import.meta.url) === process.argv[1]) main();', path.join('hooks', 'plan-gate.js'));
  assert.doesNotMatch(out, /fileURLToPath\(import\.meta\.url\)/);
  const expr = /new URL\(("[^"]+"), import\.meta\.url\)\.href/.exec(out);
  assert.ok(expr, out);
  // Evaluated from the bundle that inlines it, the URL is the module's own file.
  const bundleUrl = 'file:///C:/tap/hooks/test-file-guard.js';
  assert.equal(new URL(JSON.parse(expr[1]), bundleUrl).href, 'file:///C:/tap/hooks/plan-gate.js');
  const lib = rewriteImportMeta('x(import.meta.url)', path.join('server', 'lib', 'paths.js'));
  assert.equal(new URL(JSON.parse(/\(("[^"]+")/.exec(lib)[1]), bundleUrl).href, 'file:///C:/tap/server/lib/paths.js');
});

test('import.meta.dirname and filename are refused rather than left pointing at the bundle', () => {
  assert.throws(() => rewriteImportMeta('const d = import.meta.dirname;', 'server/lib/a.js'), /server\/lib\/a\.js uses import\.meta\.dirname/);
  assert.throws(() => rewriteImportMeta('const f = import.meta.filename;', 'server/lib/a.js'), /import\.meta\.filename/);
});

test('the output check allows node: builtins and flags anything else', () => {
  assert.deepEqual(unbundledImports('await import("node:fs"); import(\'node:child_process\')'), []);
  assert.equal(unbundledImports('await import(pathToFileURL(p).href)').length, 1);
  assert.equal(unbundledImports('await import("./x.js")').length, 1);
  assert.equal(unbundledImports('throw Error(\'Dynamic require of "fs" is not supported\')').length, 1);
});

test('no tap entry computes an import specifier at run time', () => {
  for (const e of tapEntries()) {
    const src = fs.readFileSync(path.join(REPO_ROOT, e), 'utf8');
    for (const m of src.matchAll(/\bimport\s*\(\s*([^)]*?)\s*\)/g)) {
      assert.match(m[1], /^(["'])[^"']+\1$/, `${e}: ${m[0]} is not a literal, so the tap bundle cannot inline it`);
    }
  }
});

test('the Node pin refuses a wrong size or hash', () => {
  const buf = Buffer.from('not node');
  const pin = { size: buf.length, sha256: sha256(buf) };
  assert.equal(checkNodePin(buf, pin), null);
  assert.match(checkNodePin(buf, { ...pin, size: 1 }), /bytes/);
  assert.match(checkNodePin(buf, { ...pin, sha256: '0'.repeat(64) }), /SHA-256/);
});

test('node-pin.json names one release, its win-x64 node.exe and a full hash', () => {
  const pin = JSON.parse(fs.readFileSync(path.join(TAP_ROOT, 'node-pin.json'), 'utf8'));
  assert.match(pin.version, /^v\d+\.\d+\.\d+$/);
  assert.equal(pin.url, `https://nodejs.org/dist/${pin.version}/win-x64/node.exe`);
  assert.match(pin.sha256, /^[0-9a-f]{64}$/);
  assert.ok(Number.isInteger(pin.size) && pin.size > 0);
});

test('.mjs entries build separately so they keep the name the manifest uses', () => {
  const builds = buildOptions({ repoRoot: REPO_ROOT, outDir: '/out', entries: tapEntries() });
  assert.equal(builds.length, 2);
  assert.ok(builds[0].entryPoints.every((e) => e.endsWith('.js')));
  assert.deepEqual(builds[1].outExtension, { '.js': '.mjs' });
  assert.ok(builds.every((b) => b.bundle && b.format === 'esm' && b.platform === 'node' && !b.splitting));
});

test('the installer pointed at a tap folder builds commands for files the bundle contains', () => {
  const tapDir = 'C:\\Users\\u\\AppData\\Local\\GLMPS\\tap';
  const { added } = planHookInstall({}, { repoRoot: tapDir, nodePath: `${tapDir}\\node.exe` });
  assert.equal(added.length, HOOK_MANIFEST.length);
  const entries = new Set(tapEntries());
  for (const a of added) {
    const script = /"[^"]+\\tap\\([^"]+)"$/.exec(a.command)[1].replaceAll('\\', '/');
    assert.ok(entries.has(script), `${a.id} runs ${script}`);
    assert.ok(a.command.startsWith(`"${tapDir}\\node.exe" `));
  }
});

// The tap is bundled from an extraction of the commit the release builder
// verified, never from the working tree.
test('extractTapSources extracts the committed tap sources only, and refuses an untested commit', async () => {
  const { execFileSync } = await import('node:child_process');
  const os = await import('node:os');
  const { extractTapSources } = await import('../scripts/bundle-lib.mjs');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-tap-'));
  const repo = path.join(tmp, 'repo');
  const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim();
  try {
    fs.mkdirSync(repo);
    git('init', '-q');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 't');
    git('config', 'commit.gpgsign', 'false');
    for (const [rel, body] of Object.entries({ 'hooks/h.js': 'committed', 'server/lib/a.js': 'a', 'server/test/a.test.js': 't', 'web/index.html': '<p>', 'CLAUDE.md': 'private', 'assets/CLAUDE.global.md': 'private' })) {
      fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
      fs.writeFileSync(path.join(repo, rel), body);
    }
    git('add', '-A');
    git('commit', '-q', '-m', 'f');
    fs.writeFileSync(path.join(repo, 'hooks/h.js'), 'edited in the working tree');
    const green = { source: 'main-suite', treeSha: git('rev-parse', 'HEAD^{tree}'), verdict: 'pass' };
    const workDir = path.join(tmp, 'src');
    const m = extractTapSources({ repoRoot: repo, commit: 'HEAD', workDir, testedTree: green });
    assert.equal(fs.readFileSync(path.join(workDir, 'hooks/h.js'), 'utf8'), 'committed');
    assert.deepEqual(m.files.map((f) => f.path), ['hooks/h.js', 'server/lib/a.js']);
    assert.equal(fs.existsSync(path.join(workDir, 'CLAUDE.md')), false);
    assert.equal(fs.existsSync(path.join(workDir, 'assets')), false);
    assert.throws(() => extractTapSources({ repoRoot: repo, commit: 'HEAD', workDir: path.join(tmp, 'src2'), testedTree: null }), /no green full-suite record/);
    assert.equal(extractTapSources({ repoRoot: repo, commit: 'HEAD', workDir: path.join(tmp, 'src3'), testedTree: null, untested: true }).untested, true);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
