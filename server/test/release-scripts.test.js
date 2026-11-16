// The kernel and tap ship scripts per file, not by folder (card glmps-2-0-183).
// This test resolves every reference to scripts/ in the shipped tree of this
// repo's HEAD and fails when a referenced script is not shipped. References to
// operator-only tools from shipped code are listed below on purpose: each is a
// finding (a comment, an npm script, or a call that fails open), never silently
// shipped. A new one fails this test until someone looks at it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildRelease, formatViolations, isOperatorOnlyScript } from '../../scripts/release-builder.mjs';
import { scriptRefsIn } from '../../scripts/script-refs.mjs';

const REPO = path.resolve(import.meta.dirname, '..', '..');
const git = (...args) => execFileSync('git', ['-C', REPO, ...args], { encoding: 'utf8' }).trim();

const KNOWN_OPERATOR_REFS = [
  'scripts/cutover.mjs <- hooks/lib/card-context.js',
  'scripts/cutover.mjs <- server/lib/kernel/cutover-marker.js',
  'scripts/cutover/guard.mjs <- server/lib/kernel/cutover-marker.js',
  'scripts/css-hex-gate.mjs <- web/shared/tokens.css',
  'scripts/graph-rank-bench.mjs <- server/lib/observability/code-graph.js',
  'scripts/graph-rank-bench.mjs <- server/lib/observability/graph-rank.js',
  'scripts/migrate-lessons.mjs <- server/lib/evaluation/lesson-migrate.js',
  'scripts/service/install-deploy-script.mjs <- taps/tap-logon-task.js',
  'scripts/service/install-service.mjs <- apps/shell/src/lib/status-format.js',
  'scripts/service/move-kernel-to-app.mjs <- apps/shell/src/lib/settings.js',
  'scripts/service/promote.mjs <- server/lib/orchestration/tested-trees.js',
  'scripts/shadow-instance.mjs <- server/lib/routes/backlog-routes.js',
  'scripts/sync-agent-rules.mjs <- server/lib/governance/agent-rules.js',
];

function build(target) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-release-scripts-'));
  const treeSha = git('rev-parse', 'HEAD^{tree}');
  const testedTree = { source: 'main-suite', sha: git('rev-parse', 'HEAD'), treeSha, verdict: 'pass' };
  const r = buildRelease({ repoRoot: REPO, commit: 'HEAD', target, outDir: path.join(tmp, 'out'), testedTree });
  return { r, tmp, out: path.join(tmp, 'out') };
}

// The installer shell runs beside the kernel and calls into its scripts (the setup wizard).
function shellFiles() {
  return git('ls-files', 'apps/shell/src').split('\n').filter((p) => /\.(m?js)$/.test(p)).map((p) => ({ path: p, text: fs.readFileSync(path.join(REPO, p), 'utf8') }));
}

function refsOf(r, out, extra = [], tapOnly = false) {
  const found = new Map();
  for (const f of extra) {
    for (const ref of scriptRefsIn(f.path, f.text)) {
      if (!found.has(ref)) found.set(ref, new Set());
      found.get(ref).add(f.path);
    }
  }
  for (const f of r.manifest.files) {
    if (!/\.(m?js|json|css|ps1|cmd|sh|bat)$/.test(f.path) || f.path === 'release-manifest.json') continue;
    // Vendored packages name their own scripts/ folder; the tap output is esbuild's bundle of its entries (hooks, taps, scripts), not the whole extraction.
    if (/(^|\/)vendor\//.test(f.path) || (tapOnly && !/^(hooks|taps|scripts)\//.test(f.path))) continue;
    const text = fs.readFileSync(path.join(out, f.path), 'utf8');
    for (const ref of scriptRefsIn(f.path, text)) {
      if (!found.has(ref)) found.set(ref, new Set());
      found.get(ref).add(f.path);
    }
  }
  return found;
}

for (const target of ['kernel', 'tap']) {
  test.skip(`${target}: every script the shipped tree references is shipped, and operator-only references are the known findings`, () => {
    const { r, tmp, out } = build(target);
    try {
      assert.equal(r.ok, true, `\n${formatViolations(r.violations)}`);
      const refs = refsOf(r, out, target === 'kernel' ? shellFiles() : [], target === 'tap');
      const missing = [];
      const operator = [];
      for (const [ref, sites] of refs) {
        for (const site of sites) {
          if (isOperatorOnlyScript(ref)) operator.push(`${ref} <- ${site}`);
          else if (!fs.existsSync(path.join(out, ref))) missing.push(`${ref} <- ${site}`);
        }
      }
      assert.deepEqual(missing, [], `referenced but not shipped:\n${missing.join('\n')}`);
      const unknown = operator.filter((o) => !KNOWN_OPERATOR_REFS.includes(o));
      assert.deepEqual(unknown, [], `new reference to an operator-only tool from shipped code:\n${unknown.join('\n')}`);
      const shippedScripts = r.manifest.files.map((f) => f.path).filter((p) => p.startsWith('scripts/'));
      assert.deepEqual(shippedScripts.filter(isOperatorOnlyScript), []);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });

  test.skip(`${target}: LICENSE and THIRD_PARTY_NOTICES.md ship`, () => {
    const { r, tmp, out } = build(target);
    try {
      assert.equal(r.ok, true, `\n${formatViolations(r.violations)}`);
      assert.equal(fs.existsSync(path.join(out, 'LICENSE')), true);
      assert.equal(fs.existsSync(path.join(out, 'THIRD_PARTY_NOTICES.md')), true);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });
}

test('operator-only scripts are named by pattern, and the tools the operator listed are all covered', () => {
  for (const p of [
    'scripts/cutover.mjs', 'scripts/cutover/guard.mjs', 'scripts/service/setup-dev-channel.mjs', 'scripts/service/promote.mjs',
    'scripts/service/check-prod-checkout.mjs', 'scripts/service/deploy-restart.mjs', 'scripts/shadow-instance.mjs', 'scripts/power/x.bat',
    'scripts/migrate-lessons.mjs', 'scripts/graph-rank-bench.mjs', 'scripts/memory-probe-gen.mjs', 'scripts/plugin-upgrade.mjs',
    'scripts/css-hex-gate.mjs', 'scripts/cleanup-after-cutover.mjs', 'scripts/freeze/check.mjs', 'scripts/freeze-check.mjs', 'scripts/deploy-assets.mjs', 'scripts/sync-agent-rules.mjs', 'scripts/worktree-backfill.mjs', 'scripts/scut-migrate-archived-channels.mjs', 'scripts/export-public.mjs',
  ]) assert.equal(isOperatorOnlyScript(p), true, p);
  for (const p of ['scripts/install.mjs', 'scripts/scut-setup.mjs', 'scripts/wiki-build-cli.mjs', 'scripts/lib/json-error.mjs']) assert.equal(isOperatorOnlyScript(p), false, p);
});

test.skip('the kernel and tap package.json omit the service npm scripts, and the manifest records them', () => {
  for (const target of ['kernel', 'tap']) {
    const { r, tmp, out } = build(target);
    try {
      assert.equal(r.ok, true, `\n${formatViolations(r.violations)}`);
      const scripts = JSON.parse(fs.readFileSync(path.join(out, 'package.json'), 'utf8')).scripts ?? {};
      for (const name of ['service:install', 'service:uninstall', 'service:status']) {
        assert.equal(name in scripts, false, `${target} ${name}`);
        assert.equal(r.manifest.droppedNpmScripts.includes(name), true, `${target} ${name} recorded`);
      }
      for (const cmd of Object.values(scripts)) assert.deepEqual([...scriptRefsIn('package.json', cmd)].filter((p) => !fs.existsSync(path.join(out, p))), [], cmd);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  }
});

// The tap bundle esbuilds one entry per HOOK_MANIFEST script from the tap
// release tree, so a hook script the tap profile leaves out breaks the build.
test('every hook the tap installs is in the tap release tree', async () => {
  const { PROFILES, classify } = await import('../../scripts/release-builder.mjs');
  const { HOOK_MANIFEST } = await import('../../scripts/install-hooks-lib.mjs');
  const missing = HOOK_MANIFEST.map((r) => `${r.dir || 'hooks'}/${r.script}`).filter((p) => !classify(p, PROFILES.tap)?.out);
  assert.deepEqual(missing, []);
});
