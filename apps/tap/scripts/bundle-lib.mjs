// The pure half of the tap build (card glmps-2-0-runtime-30): which files are
// bundled, the import.meta rewrite, the output check and the Node pin check.
// No esbuild import here, so the root test matrix runs it with no install;
// build-tap.mjs owns the esbuild call and the download.
import crypto from 'node:crypto';
import path from 'node:path';
import { HOOK_MANIFEST } from '../../../scripts/install-hooks-lib.mjs';
import { buildRelease, formatViolations } from '../../../scripts/release-builder.mjs';

export const STATUSLINE_TAP = 'taps/statusline-chain.js';
export const TAP_AGENT = 'taps/tap-agent.js';
// Not a manifest row: capability-synth-tick.js spawns it by path.
export const SPAWNED_SCRIPTS = ['scripts/capability-synth.mjs'];
// The installer (task 7): tap-setup runs install.mjs from the tap home. Both
// change settings.json when run with no input, so the hook smoke never runs them.
export const INSTALLER_ENTRIES = ['scripts/install.mjs', 'taps/tap-setup.mjs'];

// Repo-relative, '/'-separated, one entry per distinct file.
export function tapEntries(manifest = HOOK_MANIFEST) {
  const out = new Set(manifest.map((r) => `${r.dir || 'hooks'}/${r.script}`));
  out.add(STATUSLINE_TAP);
  out.add(TAP_AGENT);
  for (const s of SPAWNED_SCRIPTS) out.add(s);
  for (const s of INSTALLER_ENTRIES) out.add(s);
  const entries = [...out].sort();
  // rewriteImportMeta resolves '../<repo path>' against the bundle's own URL,
  // which is right only when every bundle sits one folder below the tap root.
  for (const e of entries) {
    if (e.split('/').length !== 2) throw new Error(`tap entry ${e} is not one folder deep; the import.meta rewrite assumes it is`);
  }
  return entries;
}

// esbuild inlines every module into the entry that imports it, so a bare
// import.meta.url would name the entry, not the module: plan-gate.js inlined
// into test-file-guard.js would pass its own main-script check and run.
// Each module instead gets the URL its original file has under the tap root.
export function rewriteImportMeta(source, repoRel) {
  const rel = repoRel.split(path.sep).join('/');
  if (/\bimport\.meta\.(dirname|filename)\b/.test(source)) {
    throw new Error(`${rel} uses import.meta.dirname or import.meta.filename, which the tap bundle does not rewrite yet`);
  }
  const url = `new URL(${JSON.stringify(`../${rel}`)}, import.meta.url).href`;
  return source.replace(/\bimport\.meta\.url\b/g, url);
}

export function importMetaPlugin(repoRoot) {
  return {
    name: 'glmps-import-meta',
    setup(build) {
      build.onLoad({ filter: /\.m?js$/ }, async (args) => {
        const rel = path.relative(repoRoot, args.path);
        if (rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
        const fs = await import('node:fs');
        return { contents: rewriteImportMeta(fs.readFileSync(args.path, 'utf8'), rel), loader: 'js' };
      });
    },
  };
}

// A dynamic import left in the output is a module the client would have to
// load from a checkout it does not have. node: builtins are the exception.
export function unbundledImports(code) {
  const found = [];
  for (const m of code.matchAll(/\bimport\s*\(\s*([^)]*?)\s*\)/g)) {
    if (!/^(["'`])node:[\w/]+\1$/.test(m[1])) found.push(m[0]);
  }
  if (/Dynamic require of/.test(code)) found.push('require() of a module esbuild could not bundle');
  return found;
}

export function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export function checkNodePin(buf, pin) {
  if (buf.length !== pin.size) return `node.exe is ${buf.length} bytes, the pin says ${pin.size}`;
  const got = sha256(buf);
  if (got !== pin.sha256) return `node.exe SHA-256 is ${got}, the pin says ${pin.sha256}`;
  return null;
}

export function buildOptions({ repoRoot, outDir, entries }) {
  const common = {
    absWorkingDir: repoRoot,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22.5',
    outbase: repoRoot,
    outdir: outDir,
    splitting: false,
    legalComments: 'none',
    logLevel: 'silent',
    plugins: [importMetaPlugin(repoRoot)],
  };
  // esbuild writes one extension per build, so .mjs entries get their own
  // build to keep the names the hook manifest refers to.
  const js = entries.filter((e) => e.endsWith('.js'));
  const mjs = entries.filter((e) => e.endsWith('.mjs'));
  const builds = [];
  if (js.length) builds.push({ ...common, entryPoints: js });
  if (mjs.length) builds.push({ ...common, entryPoints: mjs, outExtension: { '.js': '.mjs' } });
  return builds;
}

// Extracts the tap target of the release builder (the committed sources the
// bundle may read, scanned and recorded) into workDir and returns its manifest.
// esbuild then bundles from workDir, so the working tree never reaches the tap.
export function extractTapSources({ repoRoot, commit, workDir, testedTree = null, untested = false, privateNames = [], now = Date.now }) {
  const r = buildRelease({ repoRoot, commit, target: 'tap', outDir: workDir, testedTree, untested, privateNames, now });
  if (!r.ok) throw new Error(`release build refused ${commit}:\n${formatViolations(r.violations)}`);
  return r.manifest;
}
