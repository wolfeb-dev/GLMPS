import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildRelease, resolveTestedTree, compileShipSections, classify, globalDeny, PROFILES, KERNEL_SKILL_CUES, KERNEL_VENDOR_TAB, MANIFEST_FILE } from '../../scripts/release-builder.mjs';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

function put(root, rel, body = 'x') {
  const f = path.join(root, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, body);
}

const FILES = {
  'server/server.js': 'console.log(1);\n',
  'server/lib/paths.js': 'export const a = 1;\n',
  'server/test/x.test.js': 'test\n',
  'server/lib/y.test.js': 'test\n',
  'web/index.html': '<p>hi</p>\n',
  'scripts/tool.mjs': 'export {};\n',
  'scripts/install.mjs': 'export {};\n',
  'LICENSE': 'MIT\n',
  'THIRD_PARTY_NOTICES.md': 'notices\n',
  'docs/offering/lib.json': '{}\n',
  'docs/specs/s.md': 'plan\n',
  'docs/wiki/pages.json': '{}\n',
  'docs/wiki/style.md': 'voice\n',
  'AGENTS.md': 'Card glmps-2-0-12 history\n',
  'CLAUDE.md': '# Repo\nintro D:\\private\n\n## Architecture\n<!-- ship -->\nAdapters per tool.\n\n## Internal\n<!-- dev-only -->\nC:\\Users\\op rules\n\n## Unmarked\nnot shipped\n',
  '.claude/settings.json': '{}\n',
  '.github/workflows/ci.yml': 'on: push\n',
  'assets/CLAUDE.global.md': '- hot list D:\\private\n\n## Approach\n<!-- ship -->\nBe careful.\n\n## This machine\n<!-- dev-only -->\nC:\\Users\\op\n\n## Unmarked\nsecret rule\n',
  'assets/agents/a.md': 'operator agent\n',
  'assets/scut/app-icon.png': 'png\n',
  'package.json': '{}\n',
  'config.example.json': '{}\n',
  'config.json': '{"secret":1}\n',
  '.env': 'A=1\n',
  'server/lib/keys/id.pem': 'pem\n',
  'notes/unlisted.txt': 'not on any allowlist\n',
  'README.md': 'readme\n',
  'CHANGELOG.md': '# Changelog\n',
  'test.env': 'GLMPS_TEST=1\n',
};

function fixture(files = FILES) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-release-'));
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 't@example.com');
  git(repo, 'config', 'user.name', 't');
  git(repo, 'config', 'commit.gpgsign', 'false');
  for (const [rel, body] of Object.entries(files)) put(repo, rel, body);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'fixture');
  const tree = git(repo, 'rev-parse', 'HEAD^{tree}');
  const green = { source: 'main-suite', sha: git(repo, 'rev-parse', 'HEAD'), treeSha: tree, verdict: 'pass' };
  return { tmp, repo, out: path.join(tmp, 'out'), tree, green };
}

const list = (dir) => {
  const acc = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); e.isDirectory() ? walk(p) : acc.push(path.relative(dir, p).replaceAll('\\', '/')); } };
  walk(dir);
  return acc.sort();
};
const cleanup = (f) => fs.rmSync(f.tmp, { recursive: true, force: true });
const build = (f, over = {}) => buildRelease({ repoRoot: f.repo, commit: 'HEAD', target: 'kernel', outDir: f.out, testedTree: f.green, testSkips: [], now: () => 1_700_000_000_000, ...over });

test('kernel ships its allowlist only, compiles the ship sections into assets, and drops tests, planning, secrets and the raw operator instructions', () => {
  const f = fixture();
  try {
    const r = build(f);
    assert.equal(r.ok, true, JSON.stringify(r.violations));
    assert.deepEqual(list(f.out), [
      MANIFEST_FILE, 'assets/CLAUDE.global.md', 'assets/agents/a.md', 'assets/scut/app-icon.png',
      'README.md', 'config.example.json', 'docs/offering/lib.json', 'docs/wiki/pages.json', 'docs/wiki/style.md', 'package.json', 'scripts/install.mjs', 'LICENSE', 'THIRD_PARTY_NOTICES.md',
      'server/lib/paths.js', 'server/server.js', 'web/index.html',
    ].sort());
    assert.equal(fs.readFileSync(path.join(f.out, 'assets/CLAUDE.global.md'), 'utf8'), '## Approach\nBe careful.\n');
    assert.equal(fs.readFileSync(path.join(f.out, 'assets/agents/a.md'), 'utf8'), 'operator agent\n');
  } finally { cleanup(f); }
});

test('compileShipSections keeps ship sections whole, drops dev-only and unmarked ones, and never edits a section body', () => {
  const src = [
    'preamble line', '', '# Title', 'title body', '', '## A', '<!-- ship -->', 'a1', '```', '## not a heading', '```', 'a2', '',
    '## B', '<!-- dev-only -->', 'b1', '', '## C', 'c1 unmarked', '', '### Sub', '<!-- ship -->', 'sub', '',
    '## D', '', '<!-- ship -->', 'd1', '', '## E', 'text', '<!-- ship -->', 'e1', '',
  ].join('\r\n');
  const r = compileShipSections(src);
  assert.equal(r.text, '## A\na1\n```\n## not a heading\n```\na2\n\n## D\n\nd1\n');
  assert.deepEqual(r.ship, ['A', 'D']);
  assert.deepEqual(r.dev, ['(preamble)', 'Title', 'B', 'C', 'E']);
  assert.equal(compileShipSections('## Z\nno markers\n').text, '');
  assert.equal(compileShipSections('').text, '');
});

test('compileShipSections ships a ship-as section with the named file as its body, and finds a marker below a leading comment', () => {
  const src = [
    '## R', '<!-- ship-as: product/sections/r.md -->', 'private r', '',
    '## G', '<!-- anchor comment the guard writer relies on -->', '<!-- ship-as: product/sections/g.md -->', 'private g', '',
    '## H', '<!-- anchor only -->', 'h1', '',
  ].join('\n');
  const files = { 'product/sections/r.md': 'generic r\n', 'product/sections/g.md': '\ngeneric g\n\n' };
  const r = compileShipSections(src, { readSource: (p) => files[p] ?? null });
  assert.equal(r.text, '## R\ngeneric r\n\n## G\ngeneric g\n');
  assert.deepEqual(r.ship, ['R', 'G']);
  assert.deepEqual(r.dev, ['H']);
  assert.throws(() => compileShipSections('## X\n<!-- ship-as: product/sections/missing.md -->\nx\n', { readSource: () => null }), /missing\.md/);
  assert.throws(() => compileShipSections('## X\n<!-- ship-as: product/sections/x.md -->\nx\n'), /ship-as/);
});

test('the kernel compiles a ship-as section from the commit, not the working tree', () => {
  const f = fixture({
    ...FILES,
    'assets/CLAUDE.global.md': FILES['assets/CLAUDE.global.md'] + '\n## Style\n<!-- ship-as: product/sections/style.md -->\nPersonal style notes.\n',
    'product/sections/style.md': 'Write plainly.\n',
  });
  try {
    fs.writeFileSync(path.join(f.repo, 'product', 'sections', 'style.md'), 'UNCOMMITTED\n');
    const r = build(f, { target: 'kernel' });
    assert.equal(r.ok, true, JSON.stringify(r.violations));
    const out = fs.readFileSync(path.join(f.out, 'assets', 'CLAUDE.global.md'), 'utf8');
    assert.match(out, /## Style\nWrite plainly\.\n/);
    assert.doesNotMatch(out, /Personal style|UNCOMMITTED/);
  } finally { cleanup(f); }
});

test('the mirror emits a contributor CLAUDE.md from the ship sections of the repo CLAUDE.md, never the raw file', () => {
  const f = fixture();
  try {
    const r = build(f, { target: 'mirror' });
    assert.equal(r.ok, true, JSON.stringify(r.violations));
    assert.equal(fs.readFileSync(path.join(f.out, 'CLAUDE.md'), 'utf8'), '## Architecture\nAdapters per tool.\n');
    assert.equal(fs.existsSync(path.join(f.out, 'AGENTS.md')), false);
    assert.equal(r.manifest.files.find((x) => x.path === 'CLAUDE.md').generated, 'ship-sections');
  } finally { cleanup(f); }
});

test('a build with no ship sections emits no instructions file and still succeeds', () => {
  const f = fixture({ ...FILES, 'assets/CLAUDE.global.md': '## Only dev\n<!-- dev-only -->\nx\n' });
  try {
    const r = build(f);
    assert.equal(r.ok, true, JSON.stringify(r.violations));
    assert.equal(fs.existsSync(path.join(f.out, 'assets/CLAUDE.global.md')), false);
  } finally { cleanup(f); }
});

test('the kernel ships product/seed, and a private build scans the seed like an instruction file', () => {
  const ok = fixture({ ...FILES, 'product/seed/memory.json': '{"version":1,"items":[{"kind":"memory","text":"Prefer small commits."}]}\n' });
  const bad = fixture({ ...FILES, 'product/seed/memory.json': '{"version":1,"items":[{"kind":"memory","text":"Per glmps-2-0-12 see D:\\\\x"}]}\n' });
  try {
    const r = build(ok);
    assert.equal(r.ok, true, JSON.stringify(r.violations));
    assert.equal(fs.existsSync(path.join(ok.out, 'product/seed/memory.json')), true);
    const b = build(bad);
    assert.equal(b.ok, false);
    assert.deepEqual(b.violations.map((v) => `${v.path}|${v.rule}`).sort(), ['product/seed/memory.json|drive path', 'product/seed/memory.json|ticket id']);
  } finally { cleanup(ok); cleanup(bad); }
});

test('the mirror drops the operator deployment tools and the tests that import them, so no dev layout reaches public source', () => {
  const f = fixture({
    ...FILES,
    'scripts/shadow-instance.mjs': 'export const x = 1;\n',
    'scripts/service/promote.mjs': 'export {};\n',
    'scripts/cutover/guard.mjs': 'export {};\n',
    'scripts/power/reset.bat': 'rem\n',
    'server/test/shadow.test.js': "import '../../scripts/shadow-instance.mjs';\n",
    'server/test/promote.test.js': "const m = await import('../../scripts/service/promote.mjs');\n",
    'server/test/mention.test.js': "const s = 'scripts/shadow-instance.mjs';\n",
    'server/test/quoted.test.js': "const f = { 'x.test.js': \"import '../../scripts/shadow-instance.mjs';\" };\n",
    'server/test/plain.test.js': "import '../lib/paths.js';\n",
  });
  try {
    const r = build(f, { target: 'mirror' });
    assert.equal(r.ok, true, JSON.stringify(r.violations));
    const out = list(f.out);
    for (const gone of ['scripts/shadow-instance.mjs', 'scripts/service/promote.mjs', 'scripts/cutover/guard.mjs', 'scripts/power/reset.bat', 'server/test/shadow.test.js', 'server/test/promote.test.js']) assert.equal(out.includes(gone), false, gone);
    for (const kept of ['scripts/tool.mjs', 'scripts/install.mjs', 'server/test/plain.test.js', 'server/test/x.test.js', 'server/test/mention.test.js', 'server/test/quoted.test.js']) assert.equal(out.includes(kept), true, kept);
  } finally { cleanup(f); }
});

test('the mirror drops, to a fixed point, tests and scripts that import a script it does not ship, multi-line imports included (card glmps-2-0-227)', () => {
  const f = fixture({
    ...FILES,
    'scripts/shadow-instance.mjs': 'export const x = 1;\n',
    'scripts/snapshot.mjs': "import {\n  x,\n} from './shadow-instance.mjs';\nexport const y = x;\n",
    'scripts/retire.mjs': "import { y } from './snapshot.mjs';\nexport const z = y;\n",
    'server/test/multi.test.js': "import {\n  x,\n} from '../../scripts/shadow-instance.mjs';\n",
    'server/test/retire.test.js': "import { z } from '../../scripts/retire.mjs';\n",
    'server/test/kept.test.js': "import {\n  a,\n} from '../lib/paths.js';\n",
  });
  try {
    const r = build(f, { target: 'mirror' });
    assert.equal(r.ok, true, JSON.stringify(r.violations));
    const out = list(f.out);
    for (const gone of ['scripts/shadow-instance.mjs', 'scripts/snapshot.mjs', 'scripts/retire.mjs', 'server/test/multi.test.js', 'server/test/retire.test.js']) assert.equal(out.includes(gone), false, gone);
    for (const kept of ['scripts/tool.mjs', 'server/test/kept.test.js']) assert.equal(out.includes(kept), true, kept);
  } finally { cleanup(f); }
});

test('mirror test skips: a titled entry becomes test.skip, a file entry drops the file, and a stale entry refuses the build (card glmps-2-0-227)', () => {
  const f = fixture({
    ...FILES,
    'server/test/a.test.js': "test('reads the CI workflow', () => {});\ntest('stays', () => {});\n",
    'server/test/b.test.js': "test('spawns a dropped tool', () => {});\n",
  });
  const skips = [
    { file: 'server/test/a.test.js', test: 'reads the CI workflow', reason: 'r' },
    { file: 'server/test/b.test.js', reason: 'r' },
  ];
  try {
    const r = build(f, { target: 'mirror', testSkips: skips });
    assert.equal(r.ok, true, JSON.stringify(r.violations));
    assert.equal(fs.readFileSync(path.join(f.out, 'server/test/a.test.js'), 'utf8'), "test.skip('reads the CI workflow', () => {});\ntest('stays', () => {});\n");
    assert.equal(list(f.out).includes('server/test/b.test.js'), false);
    for (const stale of [{ file: 'server/test/a.test.js', test: 'renamed away', reason: 'r' }, { file: 'server/test/gone.test.js', reason: 'r' }]) {
      const s = build(f, { target: 'mirror', testSkips: [stale] });
      assert.equal(s.ok, false, JSON.stringify(stale));
      assert.deepEqual(s.violations.map((v) => `${v.path}|${v.rule}`), [`${stale.file}|test-skip`]);
    }
  } finally { cleanup(f); }
});

test('every mirror test skip names a file and a reason', () => {
  assert.ok(PROFILES.mirror.testSkips.length > 0);
  for (const s of PROFILES.mirror.testSkips) {
    assert.match(s.file, /\.test\.m?js$/, JSON.stringify(s));
    assert.ok(typeof s.reason === 'string' && s.reason.trim(), JSON.stringify(s));
  }
});

test('the installer-release tool and its test stay out of the mirror, as they do the kernel and tap (card glmps-2-0-210)', () => {
  for (const rel of ['scripts/release-installer.mjs', 'server/test/release-installer.test.js']) {
    assert.equal(classify(rel, PROFILES.mirror), null, rel);
  }
  assert.deepEqual(classify('scripts/release-installer.mjs', PROFILES.kernel), { deny: 'operator-only script' });
  assert.deepEqual(classify('scripts/release-builder.mjs', PROFILES.mirror), { out: 'scripts/release-builder.mjs' }, 'the builder itself still ships');
});

test('tap ships the bundle sources only', () => {
  const f = fixture();
  try {
    const r = build(f, { target: 'tap' });
    assert.equal(r.ok, true, JSON.stringify(r.violations));
    assert.deepEqual(list(f.out), [MANIFEST_FILE, 'package.json', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'scripts/install.mjs', 'server/lib/paths.js', 'server/server.js'].sort());
  } finally { cleanup(f); }
});

test('mirror keeps tests but drops planning, agent instruction files, dot dirs and the operator assets', () => {
  const f = fixture();
  try {
    const r = build(f, { target: 'mirror' });
    assert.equal(r.ok, true, JSON.stringify(r.violations));
    assert.deepEqual(list(f.out), [
      MANIFEST_FILE, 'CHANGELOG.md', 'CLAUDE.md', 'README.md', 'assets/agents/a.md', 'assets/scut/app-icon.png', 'config.example.json', 'docs/offering/lib.json', 'docs/wiki/pages.json', 'docs/wiki/style.md', 'package.json',
      'LICENSE', 'THIRD_PARTY_NOTICES.md', 'scripts/install.mjs', 'scripts/tool.mjs', 'server/lib/paths.js', 'server/lib/y.test.js', 'server/server.js', 'server/test/x.test.js', 'test.env', 'web/index.html',
    ].sort());
  } finally { cleanup(f); }
});

test('the mirror applies its identifier renames and scans the renamed text', () => {
  const f = fixture({ ...FILES, 'server/lib/m.js': 'GLMPS\n' });
  try {
    const r = build(f, { target: 'mirror', renames: [['GLMPS', 'GLMPS']] });
    assert.equal(r.ok, true, JSON.stringify(r.violations));
    assert.equal(fs.readFileSync(path.join(f.out, 'server/lib/m.js'), 'utf8'), 'GLMPS\n');
  } finally { cleanup(f); }
});

test('the global deny list beats an allowlisted path', () => {
  const f = fixture({ ...FILES, 'server/lib/CLAUDE.md': 'x\n', 'web/.env.local': 'K=1\n', 'server/lib/secret.json': '{}\n', 'docs/offering/.claude/x.md': 'x\n' });
  try {
    const r = build(f);
    assert.equal(r.ok, true, JSON.stringify(r.violations));
    const out = list(f.out);
    for (const banned of ['server/lib/CLAUDE.md', 'web/.env.local', 'docs/offering/.claude/x.md', 'config.json', '.env', 'server/lib/keys/id.pem']) assert.equal(out.includes(banned), false, banned);
  } finally { cleanup(f); }
});

// The credential-name rule once dropped web/shared/tokens.css, so every installed
// dashboard rendered with no palette, spacing or fonts (card glmps-2-0-217).
test('a design-token stylesheet ships while token and secret files stay refused', () => {
  for (const p of ['web/shared/tokens.css', 'web/tokens.css', 'web/secrets.css']) assert.equal(globalDeny(p), null, p);
  for (const p of ['tokens', 'tokens.json', 'token.txt', '.tokens', 'secret.json', 'web/secrets.yaml', 'server/lib/token.js']) assert.ok(globalDeny(p), p);
  const kernel = classify('web/shared/tokens.css', PROFILES.kernel);
  assert.deepEqual(kernel, { out: 'web/shared/tokens.css' });
});

test('no tracked dashboard file under web/ is dropped by a global deny rule', () => {
  const tracked = execFileSync('git', ['ls-files', 'web'], { cwd: path.resolve(import.meta.dirname, '..', '..'), encoding: 'utf8' }).split('\n').filter(Boolean);
  assert.ok(tracked.length > 0);
  const denied = tracked.map((f) => [f, globalDeny(f)]).filter(([, d]) => d);
  assert.deepEqual(denied, []);
});

// The README is the mirror's front page, so every local file it shows or links
// must ship there, and its media stays out of the installer (card glmps-2-0-212).
test('every local file the README references ships in the mirror, and README media stays out of the kernel', () => {
  const repo = path.resolve(import.meta.dirname, '..', '..');
  const readme = fs.readFileSync(path.join(repo, 'README.md'), 'utf8');
  const refs = [...readme.matchAll(/(?:src="|\]\()([^"):#?]+)(?=[")#?])/g)].map((m) => m[1]).filter((r) => !/^[a-z]+:/i.test(r) && !r.startsWith('#'));
  assert.ok(refs.some((r) => r.startsWith('docs/media/')), 'README shows media from docs/media');
  for (const r of refs) {
    assert.ok(fs.existsSync(path.join(repo, r)), `${r} exists`);
    const c = classify(r, PROFILES.mirror);
    assert.ok(c && !c.deny, `${r} ships in the mirror`);
  }
  assert.equal(classify('docs/media/tour.mp4', PROFILES.kernel), null);
  assert.equal(classify('docs/agents/issue-tracker.md', PROFILES.mirror)?.deny, 'planning docs');
});

test('the kernel ships the skill-cue vocabulary and the vendor-tab wrapper with every module it imports', () => {
  const repo = path.resolve(import.meta.dirname, '..', '..');
  const ships = (p) => { const c = classify(p, PROFILES.kernel); return !!c && !c.deny; };
  assert.ok(ships(KERNEL_SKILL_CUES), KERNEL_SKILL_CUES);
  assert.equal(classify('docs/agents/issue-tracker.md', PROFILES.kernel)?.deny, 'planning docs');
  assert.equal(ships('apps/shell/src/main.js'), false);
  const seen = new Set();
  const walk = (rel) => {
    if (seen.has(rel)) return;
    seen.add(rel);
    const text = fs.readFileSync(path.join(repo, rel), 'utf8');
    for (const m of text.matchAll(/\bimport\s*(?:[^'"]*?from\s*)?['"](\.{1,2}\/[^'"]+)['"]/g)) walk(path.posix.join(path.posix.dirname(rel), m[1]));
  };
  walk('apps/shell/scripts/vendor-session.mjs');
  assert.deepEqual([...seen].sort(), [...KERNEL_VENDOR_TAB].sort());
  for (const p of seen) assert.ok(ships(p), p);
});

test('uncommitted edits and untracked files never ship', () => {
  const f = fixture();
  try {
    put(f.repo, 'server/server.js', 'EDITED\n');
    put(f.repo, 'server/lib/new.js', 'untracked\n');
    const r = build(f);
    assert.equal(r.ok, true);
    assert.equal(fs.readFileSync(path.join(f.out, 'server/server.js'), 'utf8'), 'console.log(1);\n');
    assert.equal(fs.existsSync(path.join(f.out, 'server/lib/new.js')), false);
  } finally { cleanup(f); }
});

test('an untested commit is refused and leaves no output', () => {
  const f = fixture();
  try {
    for (const testedTree of [null, { ...f.green, verdict: 'fail' }, { ...f.green, treeSha: 'deadbeef' }, { ...f.green, source: 'pr' }]) {
      const r = build(f, { testedTree });
      assert.equal(r.ok, false);
      assert.equal(r.violations[0].rule, 'untested');
      assert.equal(fs.existsSync(f.out), false);
    }
  } finally { cleanup(f); }
});

test('--untested builds a private target and is recorded; a public build refuses it', () => {
  const f = fixture();
  try {
    const r = build(f, { testedTree: null, untested: true });
    assert.equal(r.ok, true, JSON.stringify(r.violations));
    assert.equal(r.manifest.untested, true);
    assert.equal(r.manifest.testedTree, null);
    for (const over of [{ target: 'mirror' }, { publicBuild: true }]) {
      const p = build(f, { testedTree: null, untested: true, ...over });
      assert.equal(p.ok, false);
      assert.equal(p.violations[0].rule, 'untested-public');
      assert.equal(fs.existsSync(f.out), false);
    }
  } finally { cleanup(f); }
});

test('a public scan hit fails with path, rule and sample, leaves no output, and an exception entry lets it pass', () => {
  const f = fixture({ ...FILES, 'web/index.html': 'see C:\\Users\\op\\x and OpName\n' });
  try {
    const r = build(f, { publicBuild: true, privateNames: ['opname'], exceptions: [] });
    assert.equal(r.ok, false);
    const rules = r.violations.map((v) => `${v.path}|${v.rule}`).sort();
    assert.deepEqual(rules, ['web/index.html|drive path', 'web/index.html|name opname']);
    assert.match(r.violations[0].sample, /C:|OpName/);
    assert.equal(fs.existsSync(f.out), false);

    const ok = build(f, { publicBuild: true, privateNames: ['opname'], exceptions: [
      { path: 'web/index.html', pattern: 'drive path', match: 'C:\\Users\\op\\x', reason: 'fixture' },
      { path: 'web/index.html', pattern: 'name opname', match: 'OpName', reason: 'fixture' },
    ] });
    assert.equal(ok.ok, true, JSON.stringify(ok.violations));
    assert.deepEqual(ok.manifest.scan.exceptionsUsed.length, 2);

    const noReason = build(f, { publicBuild: true, privateNames: ['opname'], exceptions: [{ path: 'web/index.html', pattern: 'drive path', match: 'C:\\Users\\op\\x', reason: ' ' }] });
    assert.equal(noReason.ok, false);
  } finally { cleanup(f); }
});

test('exceptions come from the committed scripts/release-exceptions.json by default', () => {
  const f = fixture({ ...FILES, 'web/index.html': 'C:\\x\n', 'scripts/release-exceptions.json': JSON.stringify([{ path: 'web/index.html', pattern: 'drive path', match: 'C:\\x', reason: 'fixture' }]) });
  try {
    assert.equal(build(f, { publicBuild: true }).ok, true);
  } finally { cleanup(f); }
});

// card glmps-2-0-225: the manifest ships, so an excused private-name hit must
// not spell the name out in it.
test('the manifest records an excused private-name hit without the name', () => {
  const f = fixture({ ...FILES, 'web/index.html': 'a vault of words\n' });
  try {
    const r = build(f, { publicBuild: true, privateNames: ['Vault'], exceptions: [{ path: 'web/index.html', pattern: 'name Vault', match: 'vault', reason: 'the plain word' }] });
    assert.equal(r.ok, true, JSON.stringify(r.violations));
    assert.deepEqual(r.manifest.scan.exceptionsUsed, ['web/index.html private name']);
    assert.doesNotMatch(JSON.stringify(r.manifest), /vault/i);
  } finally { cleanup(f); }
});

test('a private build scans only instruction and agent files, for private paths and dev history', () => {
  const f = fixture({
    ...FILES,
    'web/index.html': 'C:\\code\\fine on a private build\n',
    'assets/CLAUDE.global.md': '## Approach\n<!-- ship -->\nCard glmps-2-0-99 and mc-12\n\n## Learned guards\n<!-- ship -->\nGLMPS-managed cross-agent memory. D:\\x\n\n## Dev\n<!-- dev-only -->\nD:\\fine and glmps-2-0-5\n',
  });
  try {
    const r = build(f, { exceptions: [] });
    assert.equal(r.ok, false);
    assert.deepEqual(r.violations.map((v) => `${v.path}|${v.rule}`).sort(), [
      'assets/CLAUDE.global.md|drive path', 'assets/CLAUDE.global.md|memory block', 'assets/CLAUDE.global.md|ticket id', 'assets/CLAUDE.global.md|ticket id',
    ]);
    assert.equal(fs.existsSync(f.out), false);
  } finally { cleanup(f); }
});

test('two builds of the same commit are byte-identical apart from the build time', () => {
  const f = fixture();
  try {
    const a = build(f, { outDir: path.join(f.tmp, 'a'), now: () => 1_000 });
    const b = build(f, { outDir: path.join(f.tmp, 'b'), now: () => 9_000 });
    assert.notEqual(a.manifest.builtAt, b.manifest.builtAt);
    assert.deepEqual({ ...a.manifest, builtAt: 0 }, { ...b.manifest, builtAt: 0 });
    for (const rel of list(path.join(f.tmp, 'a')).filter((p) => p !== MANIFEST_FILE)) {
      assert.deepEqual(fs.readFileSync(path.join(f.tmp, 'a', rel)), fs.readFileSync(path.join(f.tmp, 'b', rel)), rel);
    }
  } finally { cleanup(f); }
});

test('the manifest names the commit, tree, target, hashed file list and the tested-tree record, and matches the disk', () => {
  const f = fixture();
  try {
    const r = build(f);
    const m = JSON.parse(fs.readFileSync(path.join(f.out, MANIFEST_FILE), 'utf8'));
    assert.deepEqual(m, r.manifest);
    assert.equal(m.commit, git(f.repo, 'rev-parse', 'HEAD'));
    assert.equal(m.treeSha, f.tree);
    assert.equal(m.target, 'kernel');
    assert.equal(m.builtAt, new Date(1_700_000_000_000).toISOString());
    assert.deepEqual(m.testedTree, f.green);
    assert.deepEqual(m.files.map((x) => x.path), list(f.out).filter((p) => p !== MANIFEST_FILE));
    const pkg = m.files.find((x) => x.path === 'assets/CLAUDE.global.md');
    assert.equal(pkg.from, 'assets/CLAUDE.global.md');
    assert.equal(pkg.generated, 'ship-sections');
    assert.match(pkg.sha256, /^[0-9a-f]{64}$/);
  } finally { cleanup(f); }
});

test('an unreadable commit is a violation, not a crash, and a stale outDir is cleared', () => {
  const f = fixture();
  try {
    put(f.out, 'stale.js');
    const r = build(f, { commit: 'nope' });
    assert.equal(r.ok, false);
    assert.equal(r.violations[0].rule, 'source');
    assert.equal(fs.existsSync(f.out), false);
  } finally { cleanup(f); }
});

test('resolveTestedTree finds the latest main-suite record for the commit tree in a temp state dir', () => {
  const f = fixture();
  try {
    const stateDir = path.join(f.tmp, 'state');
    const rows = [
      { source: 'main-suite', sha: 'a', treeSha: f.tree, verdict: 'pass' },
      { source: 'main-suite', sha: 'b', treeSha: 'other', verdict: 'pass' },
    ];
    put(stateDir, 'ledgers/tested-trees.jsonl', rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    assert.equal(resolveTestedTree({ stateDir, repoRoot: f.repo, commit: 'HEAD' }).sha, 'a');
    assert.equal(resolveTestedTree({ stateDir: path.join(f.tmp, 'empty'), repoRoot: f.repo, commit: 'HEAD' }), null);
  } finally { cleanup(f); }
});

test('an exception pins the exact hit: a second, different path in an excepted file fails the build', () => {
  const f = fixture({ ...FILES, 'web/index.html': 'see C:\\one\\a\n' });
  try {
    const row = { path: 'web/index.html', pattern: 'drive path', match: 'C:\\one\\a', reason: 'fixture' };
    assert.equal(build(f, { publicBuild: true, exceptions: [row] }).ok, true);
    put(f.repo, 'web/index.html', 'see C:\\one\\a and D:\\other\\b\n');
    git(f.repo, 'commit', '-qam', 'second path');
    const g = { ...f.green, treeSha: git(f.repo, 'rev-parse', 'HEAD^{tree}') };
    const r = build(f, { publicBuild: true, exceptions: [row], testedTree: g });
    assert.equal(r.ok, false);
    assert.deepEqual(r.violations.map((v) => `${v.rule}|${v.match}`), ['drive path|D:\\other\\b']);
    assert.equal(fs.existsSync(f.out), false);
  } finally { cleanup(f); }
});

test('an exception row needs a match; a wildcard match is honoured only for a prefix dir or a vendored bundle', () => {
  const f = fixture({ ...FILES, 'web/index.html': 'C:\\x\n', 'web/vendor/lib.min.js': 'C:\\y\n', 'server/test/t.test.js': 'C:\\z\n' });
  try {
    const rows = (extra) => [
      { path: 'server/test/', pattern: 'drive path', match: '*', reason: 'fixtures' },
      { path: 'web/vendor/lib.min.js', pattern: 'drive path', match: '*', reason: 'vendored' },
      ...extra,
    ];
    const noMatch = build(f, { publicBuild: true, exceptions: rows([{ path: 'web/index.html', pattern: 'drive path', reason: 'r' }]) });
    assert.deepEqual(noMatch.violations.map((v) => v.path), ['web/index.html']);
    const wild = build(f, { publicBuild: true, exceptions: rows([{ path: 'web/index.html', pattern: 'drive path', match: '*', reason: 'r' }]) });
    assert.deepEqual(wild.violations.map((v) => v.path), ['web/index.html']);
    assert.equal(build(f, { publicBuild: true, exceptions: rows([{ path: 'web/index.html', pattern: 'drive path', match: 'C:\\x', reason: 'r' }]) }).ok, true);
  } finally { cleanup(f); }
});

test('kernel and tap emit package.json without the npm scripts that name an unshipped script, and record them', () => {
  const pkg = JSON.stringify({ name: 'x', scripts: { setup: 'node scripts/install.mjs', svc: 'node scripts/service/x.mjs --flag', both: 'node scripts/install.mjs && node scripts/shadow-instance.mjs', test: 'node --test' } }, null, 2) + '\n';
  const f = fixture({ ...FILES, 'package.json': pkg });
  try {
    for (const target of ['kernel', 'tap']) {
      const r = build(f, { target });
      assert.equal(r.ok, true, JSON.stringify(r.violations));
      const out = JSON.parse(fs.readFileSync(path.join(f.out, 'package.json'), 'utf8'));
      assert.deepEqual(Object.keys(out.scripts), ['setup', 'test']);
      assert.equal(out.name, 'x');
      assert.deepEqual(r.manifest.droppedNpmScripts, ['svc', 'both']);
      assert.equal(r.manifest.files.find((x) => x.path === 'package.json').generated, 'package-json');
    }
    const m = build(f, { target: 'mirror' });
    assert.equal(m.ok, true, JSON.stringify(m.violations));
    assert.equal(fs.readFileSync(path.join(f.out, 'package.json'), 'utf8'), pkg);
    assert.equal(m.manifest.droppedNpmScripts, undefined);
  } finally { cleanup(f); }
});

test('a package.json whose scripts all resolve ships byte for byte, with an empty dropped list', () => {
  const pkg = '{"scripts":{"setup":"node scripts/install.mjs"}}\n';
  const f = fixture({ ...FILES, 'package.json': pkg });
  try {
    const r = build(f);
    assert.equal(fs.readFileSync(path.join(f.out, 'package.json'), 'utf8'), pkg);
    assert.deepEqual(r.manifest.droppedNpmScripts, []);
  } finally { cleanup(f); }
});
