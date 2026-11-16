// The one release builder (card glmps-2-0-183). Everything that ships to other
// people (the desktop installer's kernel, the tap bundle's sources, the public
// mirror) is built here from an exact commit, never the working tree, copying
// only what the target's allowlist names. It then verifies the result and
// writes outDir only when every check passes.
//
// Spec: docs/specs/2026-11-12-glmps-2-0-183-release-build.md
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { PUBLIC_DENY, isPublicDenied } from './public-deny.mjs';
import { readTestedTrees } from '../server/lib/orchestration/tested-trees.js';
import { publicScanPatterns, publicScanHits, HISTORY_PATTERNS } from '../server/lib/governance/private-text-scan.js';
import { scriptImportsIn, scriptRefsIn } from './script-refs.mjs';

export const MANIFEST_FILE = 'release-manifest.json';
export const EXCEPTIONS_FILE = 'scripts/release-exceptions.json';

// Scripts are allowlisted per file (card glmps-2-0-183). A script ships only
// when shipped code, the installer or the wizard references it; the release
// test (server/test/release-scripts.test.js) resolves every reference and fails
// when one is not on these lists.
const SETUP_SCRIPTS = ['setup/deps-plan.mjs', 'setup/editor-setup.mjs', 'setup/glmps-setup.ps1', 'setup/glmps-setup.sh', 'setup/provision-graphify.mjs', 'setup/setup-status.mjs', 'setup/slack-connect.mjs', 'setup/slack-creds.mjs'];
const TAP_SCRIPTS = ['affected-tests.mjs', 'capability-synth.mjs', 'glmps-init.mjs', 'install-hooks-lib.mjs', 'install.mjs', 'lib/json-error.mjs', 'memory-lookup.mjs', 'scut-avatar-check.mjs', 'scut-setup.mjs', 'sync-project-dirs.mjs', 'touch.mjs', 'wiki-build-cli.mjs', 'wiki-build-lib.mjs'];
const KERNEL_SCRIPTS = [...TAP_SCRIPTS, 'dashboard-link.mjs', 'fetch-embed-model.mjs', 'nightly-run.mjs', 'provision-server-box.mjs', 'register-nightly-task.ps1', ...SETUP_SCRIPTS];
const scriptFiles = (list) => list.map((f) => `scripts/${f}`);

// Repo files the kernel reads at run time from outside its own dirs (card
// glmps-2-0-217): the runner's skill-cue vocabulary, and the vendor-tab wrapper
// server.js spawns with the shell modules it imports (node only, no Electron).
export const KERNEL_SKILL_CUES = 'docs/agents/skill-cues.md';
export const KERNEL_VENDOR_TAB = ['apps/shell/scripts/vendor-session.mjs', ...['agy-runner', 'launch-auth', 'launch-client', 'launch-runner', 'model-fallback', 'terminal-recipe', 'vendor-card', 'vendor-session'].map((m) => `apps/shell/src/lib/${m}.js`)];

// Tools that run the operator's own deployment, never a customer's. They are
// refused on the kernel and tap targets even if a list names them.
// The deployment tools pin the operator's own machine layout as safety rails, so
// they and the tests that import them stay out of public source too.
export const OPERATOR_DEPLOY_SCRIPTS = [/^scripts\/cutover/, /^scripts\/service\//, /^scripts\/shadow-/, /^scripts\/power\//, /^scripts\/cleanup-after-cutover/, /^scripts\/freeze/, /^scripts\/deploy-assets/];
export const isOperatorDeployScript = (p) => OPERATOR_DEPLOY_SCRIPTS.some((re) => re.test(norm(p)));
export const OPERATOR_ONLY_SCRIPTS = [
  ...OPERATOR_DEPLOY_SCRIPTS, /(^|\/)migrate-[^/]*$/, /-bench\.mjs$/,
  /^scripts\/(memory-probe-gen|plugin-upgrade|css-hex-gate|worktree-backfill|scut-migrate-archived-channels|export-public|check-prod-checkout)/,
  /^scripts\/(release-|share-memory|script-refs|public-deny|sync-agent-rules)/,
];
export const isOperatorOnlyScript = (p) => OPERATOR_ONLY_SCRIPTS.some((re) => re.test(norm(p)));

// Tests whose subject the public mirror does not carry (card glmps-2-0-227).
// A cloner's `npm test` must pass, so each is skipped (or its file dropped) in
// the mirror copy only, with the reason it cannot apply there. Titles are in
// source spelling, before the rename. A stale entry fails the build.
const NO_CI = 'the mirror ships no .github workflows';
const NO_LEGACY = 'the rename folds the legacy name into the current one, so the mirror has no legacy name to tell apart';
const NO_SERVICE = 'the mirror drops the operator service scripts this spawns';
const NO_EXCEPTIONS = 'its kernel build excuses scan hits from scripts/release-exceptions.json, which the mirror does not ship';
export const MIRROR_TEST_SKIPS = [
  { file: 'server/test/agent-rules.test.js', test: 'AC-4: GEMINI.md and AGENTS.md carry the CLAUDE.md rules exactly (run node scripts/sync-agent-rules.mjs when this fails)', reason: 'agent instruction files do not ship' },
  { file: 'server/test/graphify-integrations.test.js', test: 'the runtime repo (a ship repo) carries every graphify agent integration in source', reason: 'agent instruction files do not ship' },
  { file: 'apps/shell/test/kernel-stage-lib.test.js', test: 'the Shell CI unpacked build opts out of the ship graph and the tested-commit rule, since its fresh runner has neither', reason: NO_CI },
  { file: 'apps/shell/test/kernel-stage-lib.test.js', test: 'the Shell CI unpacked build also opts out of the wiki, since its fresh runner has none', reason: NO_CI },
  { file: 'server/test/plugin-node-floor.test.js', test: 'CI test job matrix runs node 22, 24 and 26, and does not run node 20', reason: NO_CI },
  { file: 'server/test/plugin-node-floor.test.js', test: 'CI keeps a single Windows leg (on node 24), excluding windows for the other two versions', reason: NO_CI },
  { file: 'server/test/plugin-node-floor.test.js', test: 'CI runs the Windows leg only on workflow_dispatch and cancels superseded runs', reason: NO_CI },
  { file: 'server/test/plugin-node-floor.test.js', test: 'no workflow runs per PR or per push: nightly schedule and workflow_dispatch only', reason: NO_CI },
  { file: 'server/test/state-dir.test.js', test: 'resolution order: GLMPS_STATE_DIR > GLMPS_STATE_DIR > ~/.glmps2 (if present) > ~/.' + 'glmps', reason: NO_LEGACY },
  { file: 'server/test/state-dir.test.js', test: 'getPaths honours GLMPS_STATE_DIR ahead of GLMPS_STATE_DIR', reason: NO_LEGACY },
  { file: 'server/test/state-dir-seam.test.js', test: 'the seam itself still names the old folder, so the scan is not vacuous', reason: NO_LEGACY },
  { file: 'server/test/prod-checkout.test.js', test: 'CLI exits 0 on a clean checkout', reason: NO_SERVICE },
  { file: 'server/test/prod-checkout.test.js', test: 'CLI exits 1 and prints dirty files and ahead commits', reason: NO_SERVICE },
  { file: 'server/test/prod-checkout.test.js', test: 'CLI --upstream selects the ref and a bad ref exits 1', reason: NO_SERVICE },
  { file: 'server/test/deploy-assets-cli.test.js', reason: 'the mirror drops scripts/deploy-assets.mjs, the operator tool this spawns' },
  { file: 'server/test/release-public-kernel-smoke.test.js', reason: NO_EXCEPTIONS },
  // Titles built from a template literal are matched in their source spelling.
  { file: 'server/test/release-scripts.test.js', test: '${target}: every script the shipped tree references is shipped, and operator-only references are the known findings', reason: NO_EXCEPTIONS },
  { file: 'server/test/release-scripts.test.js', test: '${target}: LICENSE and THIRD_PARTY_NOTICES.md ship', reason: NO_EXCEPTIONS },
  { file: 'server/test/release-scripts.test.js', test: 'the kernel and tap package.json omit the service npm scripts, and the manifest records them', reason: NO_EXCEPTIONS },
  { file: 'server/test/fixed-sleep-ratchet.test.js', test: 'no test file adds a fixed sleep beyond its baseline', reason: 'its baseline counts test files the mirror drops' },
];

// Allowlist profiles. include: repo paths (file or dir prefix) a target may
// ship; map: source prefix -> output prefix; skipTests: tests never ship.
export const PROFILES = {
  kernel: {
    public: false,
    skipTests: true,
    include: ['server', 'web', 'taps', 'hooks', 'plugins', ...scriptFiles(KERNEL_SCRIPTS), 'README.md', 'docs/offering', 'docs/wiki', KERNEL_SKILL_CUES, ...KERNEL_VENDOR_TAB, 'assets/scut', 'assets/agents', 'product/seed', 'package.json', 'config.example.json', 'LICENSE', 'THIRD_PARTY_NOTICES.md'],
    exclude: [],
    denyOperatorOnly: true,
    prunePackageScripts: true,
    map: [],
    // The operator's global instructions never ship raw: only their ship-marked sections.
    generated: [{ from: 'assets/CLAUDE.global.md', out: 'assets/CLAUDE.global.md' }],
  },
  // The sources the tap bundle is esbuilt from; apps/tap bundles them into dist.
  tap: {
    public: false,
    skipTests: true,
    include: ['server', 'hooks', 'taps', ...scriptFiles(TAP_SCRIPTS), 'plugins', 'package.json', 'LICENSE', 'THIRD_PARTY_NOTICES.md'],
    exclude: [],
    denyOperatorOnly: true,
    prunePackageScripts: true,
    map: [],
    generated: [],
  },
  mirror: {
    public: true,
    skipTests: false,
    dropOperatorDeploy: true,
    include: [
      'server', 'web', 'taps', 'hooks', 'plugins', 'scripts', 'apps', 'companion', 'docs/offering', 'docs/wiki', 'docs/media', KERNEL_SKILL_CUES, 'assets/scut', 'assets/agents',
      'package.json', 'config.example.json', 'test.env', 'README.md', 'CHANGELOG.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md',
      '.gitattributes', '.gitignore',
    ],
    // The real-repo test needs the denied exporter and this repo's own history;
    // the exceptions file quotes the very strings the scan exists to keep out;
    // the installer publisher is an operator tool, refused on kernel and tap too.
    exclude: ['server/test/release-real-repo.test.js', 'scripts/release-exceptions.json', 'scripts/release-installer.mjs', 'server/test/release-installer.test.js'],
    testSkips: MIRROR_TEST_SKIPS,
    map: [],
    // A contributor file from the ship-marked sections of the repo CLAUDE.md.
    generated: [{ from: 'CLAUDE.md', out: 'CLAUDE.md' }],
  },
};

const SECRET_FILE = [
  /^config\.json$/,
  /^\.env(\..*)?$/,
  /\.(pem|key|p12|pfx)$/i,
  // A stylesheet holds no credential, and web/shared/tokens.css is the design
  // tokens every other sheet reads (card glmps-2-0-217).
  /^\.?(token|secret)s?(?!\.css$)(\..*)?$/i,
  /^scut(-creds.*)?\.json$/,
];
const TOOLING_DIRS = new Set(['node_modules', 'graphify-out', '.git']);
const TEST_FILE = /\.test\.m?js$/;

const norm = (p) => String(p ?? '').replace(/\\/g, '/').replace(/^\.\//, '');
const underPrefix = (f, d) => f === d || f.startsWith(d + '/');

// The rule that refuses `rel` on every target, or null. It beats every allowlist.
export function globalDeny(rel) {
  const f = norm(rel);
  const segs = f.split('/');
  const base = segs[segs.length - 1];
  if (isPublicDenied(f, PUBLIC_DENY)) return 'public-deny list';
  if (SECRET_FILE.some((re) => re.test(base))) return 'secret, env or key file';
  if (/^(CLAUDE|AGENTS|GEMINI)\.md$/.test(base)) return 'agent instruction file';
  if (segs.some((s) => s === '.claude' || s === '.github')) return '.claude or .github dir';
  if (segs.some((s) => TOOLING_DIRS.has(s))) return 'tooling dir';
  // docs/wiki is the wiki's page plan and voice (card glmps-2-0-193): the installed
  // copy rebuilds from them. docs/media is the README's screenshot and video, which
  // only the mirror lists (card glmps-2-0-212). Every other docs/ path is planning.
  if (underPrefix(f, 'docs') && !underPrefix(f, 'docs/offering') && !underPrefix(f, 'docs/wiki') && !underPrefix(f, 'docs/media') && f !== KERNEL_SKILL_CUES) return 'planning docs';
  if (underPrefix(f, 'assets') && !underPrefix(f, 'assets/scut') && !underPrefix(f, 'assets/agents')) return 'operator assets';
  return null;
}

// What `rel` becomes in the output of `profile`, null when it is not allowed,
// or { deny } when the global denylist refuses it.
export function classify(rel, profile) {
  const f = norm(rel);
  const deny = globalDeny(f);
  if (deny) return { deny };
  if (profile.dropOperatorDeploy && isOperatorDeployScript(f)) return null;
  if (profile.denyOperatorOnly && isOperatorOnlyScript(f)) return { deny: 'operator-only script' };
  if (!profile.include.some((d) => underPrefix(f, d))) return null;
  if (profile.exclude.some((d) => underPrefix(f, d))) return null;
  if (profile.skipTests && (f.split('/').includes('test') || TEST_FILE.test(f))) return null;
  for (const [from, to] of profile.map) if (underPrefix(f, from)) return { out: to + f.slice(from.length) };
  return { out: f };
}

// The private-text scan lives in the kernel (server/lib/governance/private-text-scan.js)
// so the wiki build shares it; re-exported so existing imports keep working.
export { publicScanPatterns, publicScanHits, HISTORY_PATTERNS };

// A section starts at a `# ` or `## ` heading (outside a code fence) and carries
// a marker as the first non-blank line under it: `<!-- ship -->` or
// `<!-- dev-only -->`. Unmarked means dev-only, so a new section fails closed.
// A section's text is copied whole, never edited; only the marker line goes.
const MARKER = /^\s*<!--\s*(ship|dev-only|ship-as:\s*(\S+))\s*-->\s*$/;
const COMMENT_LINE = /^\s*<!--.*-->\s*$/;

// The marker is the first non-blank line under a heading, or the first marker
// after leading comment lines (a section may open with an anchor comment that
// another writer depends on). ship-as: <repo path> ships that file's text as the
// section body, so a section can carry a customer wording while the source keeps
// the operator's own.
function findMarker(body) {
  for (let i = 0; i < body.length; i++) {
    if (body[i].trim() === '') continue;
    const m = MARKER.exec(body[i]);
    if (m) return { index: i, kind: m[2] ? 'ship-as' : m[1], source: m[2] ?? null };
    if (!COMMENT_LINE.test(body[i])) return null;
  }
  return null;
}

export function compileShipSections(text, { readSource = null } = {}) {
  const sections = [{ heading: null, name: '(preamble)', body: [] }];
  let fence = false;
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (/^\s*```/.test(line)) fence = !fence;
    const h = !fence && /^#{1,2} +(.*)$/.exec(line);
    if (h) sections.push({ heading: line, name: h[1].trim(), body: [] });
    else sections[sections.length - 1].body.push(line);
  }
  const ship = [];
  const dev = [];
  const out = [];
  for (const sec of sections) {
    const marker = findMarker(sec.body);
    if (sec.heading && marker && marker.kind === 'ship-as') {
      if (!readSource) throw new Error(`section "${sec.name}" is ship-as ${marker.source} but no source reader was given`);
      const src = readSource(marker.source);
      if (src == null) throw new Error(`section "${sec.name}" names ship-as ${marker.source}, which is not in the commit`);
      const body = String(src).split(/\r?\n/);
      while (body.length && body[0].trim() === '') body.shift();
      while (body.length && body[body.length - 1].trim() === '') body.pop();
      out.push([sec.heading, ...body].join('\n'));
      ship.push(sec.name);
    } else if (sec.heading && marker && marker.kind === 'ship') {
      const body = sec.body.filter((_, i) => i !== marker.index);
      while (body.length && body[body.length - 1].trim() === '') body.pop();
      out.push([sec.heading, ...body].join('\n'));
      ship.push(sec.name);
    } else if (sec.heading || sec.body.some((l) => l.trim() !== '')) {
      dev.push(sec.name);
    }
  }
  return { text: out.length ? out.join('\n\n') + '\n' : '', ship, dev };
}

// Removes every npm script whose command names a scripts/ file outside `shipped`.
// Returns the original text untouched when nothing is dropped.
export function prunePackageScripts(text, shipped) {
  let pkg;
  try { pkg = JSON.parse(text); } catch { return { text, dropped: [] }; }
  if (!pkg?.scripts || typeof pkg.scripts !== 'object') return { text, dropped: [] };
  const dropped = [];
  const scripts = {};
  for (const [name, cmd] of Object.entries(pkg.scripts)) {
    if ([...scriptRefsIn('package.json', String(cmd))].some((r) => !shipped.has(r))) dropped.push(name);
    else scripts[name] = cmd;
  }
  if (!dropped.length) return { text, dropped };
  return { text: JSON.stringify({ ...pkg, scripts }, null, 2) + '\n', dropped };
}

export function isInstructionFile(out) {
  return /(^|\/)(CLAUDE|AGENTS|GEMINI)(\.global)?\.md$/.test(out) || /(^|\/)agents\/.+\.md$/.test(out) || /^product\/seed\//.test(out);
}

// Applies a target's testSkips: an entry with only `file` drops that test file;
// one with `test` (the exact title in source spelling) turns that test( call
// into test.skip(, so a cloner's summary counts it as skipped instead of hiding
// it. An entry that matches nothing is a violation: the list must not go stale.
export function applyTestSkips(picked, blobs, skips) {
  const violations = [];
  const drop = new Set();
  const out = blobs.slice();
  for (const s of skips) {
    const i = picked.findIndex((p) => p.path === s.file);
    if (i < 0 || drop.has(i)) { violations.push({ path: s.file, rule: 'test-skip', sample: `no shipped file ${s.file} for a test-skip entry` }); continue; }
    if (s.test == null) { drop.add(i); continue; }
    const text = out[i].toString('utf8');
    const calls = ['\'', '"', '`'].map((q) => `test(${q}${s.test}${q}`).filter((c) => text.includes(c));
    const n = calls.reduce((acc, c) => acc + text.split(c).length - 1, 0);
    if (n !== 1) { violations.push({ path: s.file, rule: 'test-skip', sample: `${n} test() calls titled ${JSON.stringify(s.test)} (expected exactly 1)` }); continue; }
    out[i] = Buffer.from(text.replace(calls[0], () => `test.skip${calls[0].slice(4)}`), 'utf8');
  }
  return { picked: picked.filter((_, i) => !drop.has(i)), blobs: out.filter((_, i) => !drop.has(i)), violations };
}

const isBinary = (buf) => buf.subarray(0, 8000).includes(0);
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function git(repoRoot, args, input) {
  return execFileSync('git', ['-C', repoRoot, ...args], { maxBuffer: 1024 * 1024 * 1024, ...(input ? { input } : {}) });
}

function readAtCommit(repoRoot, commit, rel) {
  try { return git(repoRoot, ['show', `${commit}:${rel}`]).toString('utf8'); } catch { return null; }
}

function listTree(repoRoot, commit) {
  const out = git(repoRoot, ['ls-tree', '-r', '-z', commit]).toString('utf8');
  return out.split('\0').filter(Boolean).flatMap((line) => {
    const m = /^(\d+) (\w+) ([0-9a-f]+)\t(.*)$/s.exec(line);
    return m && m[2] === 'blob' ? [{ mode: m[1], sha: m[3], path: m[4] }] : [];
  });
}

// One git process for every blob: `cat-file --batch` answers "<sha> blob <size>\n<bytes>\n".
function readBlobs(repoRoot, shas) {
  if (!shas.length) return [];
  const buf = git(repoRoot, ['cat-file', '--batch'], shas.join('\n') + '\n');
  const out = [];
  let pos = 0;
  for (const sha of shas) {
    const nl = buf.indexOf(10, pos);
    const [, type, size] = buf.subarray(pos, nl).toString('utf8').split(' ');
    if (type !== 'blob') throw new Error(`cat-file did not return a blob for ${sha}`);
    const n = Number(size);
    out.push(buf.subarray(nl + 1, nl + 1 + n));
    pos = nl + 1 + n + 1;
  }
  return out;
}

function walk(dir) {
  const acc = [];
  const rec = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) rec(p);
      else acc.push(path.relative(dir, p).split(path.sep).join('/'));
    }
  };
  rec(dir);
  return acc.sort();
}

// Vendored bundles carry their own upstream strings; only they, and prefix dirs
// of test fixtures, may excuse a pattern without pinning the exact text.
const VENDORED = /(^|\/)vendor\/|^web\/(huddle-assets|wiki-assets)\/|\.min\.js$/;

function exceptionMatches(ex, rel, pattern, match, target) {
  if (!ex || typeof ex.reason !== 'string' || !ex.reason.trim()) return false;
  if (ex.pattern !== pattern) return false;
  if (ex.target && ex.target !== target) return false;
  const p = norm(ex.path);
  const prefix = p.endsWith('/');
  if (!(rel === p || (prefix && rel.startsWith(p)))) return false;
  if (typeof ex.match !== 'string' || !ex.match) return false;
  if (ex.match === '*') return prefix || VENDORED.test(rel);
  return ex.match === match;
}

/**
 * The latest main-suite record for the commit's tree, or null. The builder
 * decides whether that record is green.
 */
export function resolveTestedTree({ stateDir, repoRoot, commit }) {
  const treeSha = git(repoRoot, ['rev-parse', '--verify', `${commit}^{tree}`]).toString('utf8').trim();
  const all = readTestedTrees(stateDir);
  for (let i = all.length - 1; i >= 0; i--) if (all[i].source === 'main-suite' && all[i].treeSha === treeSha) return all[i];
  return null;
}

/**
 * Builds one target from `commit`. Returns { ok, manifest, violations };
 * outDir is written only when ok.
 *   testedTree: the main-suite record the caller found for the commit's tree
 *   untested:   dev-only bypass of the tested-commit rule, refused on a public build
 *   publicBuild: apply the public-flip scan to every text file (always on for mirror)
 *   renames:    literal [from, to] replacements applied to text files (mirror)
 *   exceptions: scan-hit exceptions; defaults to the commit's scripts/release-exceptions.json
 *   testSkips:  tests to skip, or test files to drop, in the output; defaults to the target's list
 */
export function buildRelease({ repoRoot, commit, target, outDir, privateNames = [], testedTree = null, untested = false, publicBuild = false, renames = [], exceptions = null, testSkips = null, now = Date.now }) {
  const profile = PROFILES[target];
  if (!profile) throw new Error(`unknown release target ${target} (expected ${Object.keys(PROFILES).join(', ')})`);
  const isPublic = publicBuild || profile.public;
  const fail = (violations) => ({ ok: false, manifest: null, violations });
  fs.rmSync(outDir, { recursive: true, force: true });

  if (untested && isPublic) return fail([{ path: '', rule: 'untested-public', sample: 'a public build may not skip the tested-commit rule' }]);

  let sha;
  let treeSha;
  let entries;
  try {
    sha = git(repoRoot, ['rev-parse', '--verify', `${commit}^{commit}`]).toString('utf8').trim();
    treeSha = git(repoRoot, ['rev-parse', '--verify', `${commit}^{tree}`]).toString('utf8').trim();
    entries = listTree(repoRoot, sha);
  } catch (e) {
    return fail([{ path: '', rule: 'source', sample: `cannot read ${commit} in ${repoRoot}: ${String(e.message).split('\n')[0]}` }]);
  }

  if (!untested) {
    const t = testedTree;
    const green = t && t.source === 'main-suite' && t.verdict === 'pass' && t.treeSha === treeSha;
    if (!green) {
      return fail([{ path: '', rule: 'untested', sample: t ? `record ${t.sha ?? '?'} (${t.verdict ?? '?'}) does not show a green full run on tree ${treeSha}` : `no green full-suite record for tree ${treeSha}` }]);
    }
  }

  const picked = [];
  for (const e of entries) {
    const c = classify(e.path, profile);
    if (c?.out) picked.push({ ...e, out: c.out });
  }
  for (const g of profile.generated ?? []) {
    const e = entries.find((x) => x.path === g.from);
    if (e) picked.push({ ...e, out: g.out, generated: 'ship-sections' });
  }
  picked.sort((a, b) => (a.out < b.out ? -1 : a.out > b.out ? 1 : 0));

  let list = exceptions;
  if (list === null) {
    const exEntry = entries.find((e) => e.path === EXCEPTIONS_FILE);
    try { list = exEntry ? JSON.parse(readBlobs(repoRoot, [exEntry.sha])[0].toString('utf8')) : []; } catch { list = []; }
  }
  if (!Array.isArray(list)) list = [];

  let blobs = readBlobs(repoRoot, picked.map((p) => p.sha));
  let droppedNpmScripts = null;
  if (profile.dropOperatorDeploy) {
    // A test or script that imports a script this build does not ship cannot load
    // for the customer, so it goes too, until nothing else falls out.
    for (;;) {
      const present = new Set(picked.map((p) => p.path));
      const keep = picked.map((p, i) => !((TEST_FILE.test(p.path) || underPrefix(p.path, 'scripts')) && [...scriptImportsIn(p.path, blobs[i].toString('utf8'))].some((r) => !present.has(r))));
      if (keep.every(Boolean)) break;
      blobs = blobs.filter((_, i) => keep[i]);
      picked.splice(0, picked.length, ...picked.filter((_, i) => keep[i]));
    }
  }
  const tmp = `${outDir}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  const violations = [];
  const skips = testSkips ?? profile.testSkips ?? [];
  if (skips.length) {
    const r = applyTestSkips(picked, blobs, skips);
    blobs = r.blobs;
    picked.splice(0, picked.length, ...r.picked);
    violations.push(...r.violations);
  }
  const files = [];
  const patterns = publicScanPatterns(privateNames);
  const usedExceptions = new Set();
  const hit = (rel, pattern, match, sample) => {
    const ex = list.find((x) => exceptionMatches(x, rel, pattern, match, target));
    // The manifest ships, so a name pattern is recorded without the name it excuses.
    if (ex) usedExceptions.add(pattern.startsWith('name ') ? `${norm(ex.path)} private name` : `${norm(ex.path)} ${ex.pattern} ${ex.match}`);
    else violations.push({ path: rel, rule: pattern, match, sample });
  };

  try {
    fs.mkdirSync(tmp, { recursive: true });
    // An npm script that names a scripts/ file this target does not ship would fail
    // for the customer, so the generated package.json omits it (and says so).
    const shipped = new Set(picked.map((p) => p.out));
    picked.forEach((p, i) => {
      let buf = blobs[i];
      if (profile.prunePackageScripts && p.out === 'package.json') {
        const r = prunePackageScripts(buf.toString('utf8'), shipped);
        droppedNpmScripts = r.dropped;
        if (r.dropped.length) { buf = Buffer.from(r.text, 'utf8'); p = { ...p, generated: 'package-json' }; }
      }
      if (p.generated === 'ship-sections') {
        let compiled;
        try {
          compiled = compileShipSections(buf.toString('utf8'), { readSource: (rel) => readAtCommit(repoRoot, sha, rel) }).text;
        } catch (e) {
          violations.push({ path: p.out, rule: 'ship-sections', sample: e.message });
          return;
        }
        if (!compiled) return;
        buf = Buffer.from(compiled, 'utf8');
      }
      const binary = isBinary(buf);
      if (!binary) {
        let s = buf.toString('utf8');
        for (const [a, b] of renames) s = s.split(a).join(b);
        buf = Buffer.from(s, 'utf8');
      }
      const dest = path.join(tmp, ...p.out.split('/'));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, buf);
      if (p.mode === '100755') fs.chmodSync(dest, 0o755);
      files.push({ path: p.out, sha256: sha256(buf), ...(p.out !== p.path || p.generated ? { from: p.path } : {}), ...(p.generated ? { generated: p.generated } : {}), text: !binary });
    });

    // Verification runs on what is on disk, not on what the loop believed it wrote.
    const onDisk = walk(tmp);
    const listed = files.map((f) => f.path);
    if (onDisk.length !== listed.length || onDisk.some((f, i) => f !== listed[i])) {
      violations.push({ path: '', rule: 'manifest', sample: 'manifest file list differs from the files on disk' });
    }
    for (const f of files) {
      const src = f.from ?? f.path;
      const c = f.generated && f.generated !== 'package-json' ? ((profile.generated ?? []).some((g) => g.from === src && g.out === f.path) ? { out: f.path } : null) : classify(src, profile);
      if (!c?.out || c.out !== f.path) violations.push({ path: f.path, rule: globalDeny(src) ? `deny: ${globalDeny(src)}` : 'allowlist', sample: `${src} is not allowed on target ${target}` });
      if (!f.text) continue;
      const text = fs.readFileSync(path.join(tmp, ...f.path.split('/')), 'utf8');
      if (isPublic || isInstructionFile(f.path)) {
        for (const h of publicScanHits(text, patterns)) hit(f.path, h.pattern, h.match, h.sample);
      }
      if (isInstructionFile(f.path)) {
        for (const h of publicScanHits(text, HISTORY_PATTERNS)) hit(f.path, h.pattern, h.match, h.sample);
      }
    }
    if (violations.length) {
      fs.rmSync(tmp, { recursive: true, force: true });
      return fail(violations);
    }

    const manifest = {
      schema: 1,
      commit: sha,
      treeSha,
      target,
      public: isPublic,
      untested: !!untested,
      testedTree: untested ? null : testedTree,
      files: files.map(({ text: _t, ...f }) => f),
      ...(droppedNpmScripts ? { droppedNpmScripts } : {}),
      scan: { ok: true, exceptionsUsed: [...usedExceptions].sort() },
      builtAt: new Date(now()).toISOString(),
    };
    fs.writeFileSync(path.join(tmp, MANIFEST_FILE), JSON.stringify(manifest, null, 2) + '\n');
    fs.mkdirSync(path.dirname(outDir), { recursive: true });
    fs.renameSync(tmp, outDir);
    return { ok: true, manifest, violations: [] };
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
}

export function formatViolations(violations) {
  return violations.map((v) => `  ${v.path || '(build)'}: ${v.rule}${v.sample ? ` | ${JSON.stringify(v.sample)}` : ''}`).join('\n');
}
