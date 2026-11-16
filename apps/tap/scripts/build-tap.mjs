// npm run build: bundles the hooks, the statusline tap and the server/lib
// modules they import into dist/tap/, beside the pinned node.exe.
//   --out <dir>   write somewhere other than dist/tap
//   --untested    dev only: skip the tested-commit rule (or GLMPS_UNTESTED=1)
// The bundle is built from the HEAD commit by the release builder, not the working tree.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as esbuild from 'esbuild';
import { HOOK_MANIFEST } from '../../../scripts/install-hooks-lib.mjs';
import { TAP_AGENT, buildOptions, checkNodePin, extractTapSources, sha256, tapEntries, unbundledImports } from './bundle-lib.mjs';
import { resolveTestedTree } from '../../../scripts/release-builder.mjs';
import { getPaths } from '../../../server/lib/paths.js';

const TAP_ROOT = path.resolve(import.meta.dirname, '..');
const REPO_ROOT = path.resolve(TAP_ROOT, '..', '..');
const PIN = JSON.parse(fs.readFileSync(path.join(TAP_ROOT, 'node-pin.json'), 'utf8'));

async function pinnedNode() {
  const cached = path.join(TAP_ROOT, '.cache', `node-${PIN.version}-win-x64.exe`);
  if (fs.existsSync(cached) && !checkNodePin(fs.readFileSync(cached), PIN)) return cached;
  const res = await fetch(PIN.url);
  if (!res.ok) throw new Error(`downloading ${PIN.url}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const bad = checkNodePin(buf, PIN);
  if (bad) throw new Error(`refusing ${PIN.url}: ${bad}`);
  fs.mkdirSync(path.dirname(cached), { recursive: true });
  fs.writeFileSync(cached, buf);
  return cached;
}

export async function buildTap({ outDir = path.join(TAP_ROOT, 'dist', 'tap'), untested = process.env.GLMPS_UNTESTED === '1', stateDir = getPaths(process.env).stateDir } = {}) {
  const entries = tapEntries();
  const commitFull = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  const testedTree = untested ? null : resolveTestedTree({ stateDir, repoRoot: REPO_ROOT, commit: commitFull });
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glmps-tap-src-'));
  fs.rmSync(outDir, { recursive: true, force: true });
  let release;
  try {
    release = extractTapSources({ repoRoot: REPO_ROOT, commit: commitFull, workDir: path.join(workDir, 'src'), testedTree, untested, privateNames: [os.userInfo().username] });
    for (const opts of buildOptions({ repoRoot: path.join(workDir, 'src'), outDir, entries })) await esbuild.build(opts);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }

  const files = {};
  for (const e of entries) {
    const code = fs.readFileSync(path.join(outDir, e));
    const left = unbundledImports(code.toString('utf8'));
    if (left.length) throw new Error(`${e} still loads modules from a checkout: ${left.join(', ')}`);
    files[e] = sha256(code);
  }
  fs.writeFileSync(path.join(outDir, 'package.json'), '{ "type": "module" }\n');
  fs.copyFileSync(await pinnedNode(), path.join(outDir, 'node.exe'));

  const commit = commitFull.slice(0, 7);
  const manifest = {
    node: { version: PIN.version, sha256: PIN.sha256 },
    commit,
    builtAt: new Date().toISOString(),
    release: { treeSha: release.treeSha, untested: release.untested },
    hooks: HOOK_MANIFEST,
    statusline: 'taps/statusline-chain.js',
    agent: TAP_AGENT,
    files,
  };
  fs.writeFileSync(path.join(outDir, 'tap-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return { outDir, manifest };
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  const i = process.argv.indexOf('--out');
  const { outDir, manifest } = await buildTap({ ...(i > 0 ? { outDir: path.resolve(process.argv[i + 1]) } : {}), ...(process.argv.includes('--untested') ? { untested: true } : {}) });
  console.log(`tap bundle: ${Object.keys(manifest.files).length} entries, node ${manifest.node.version}, kernel ${manifest.commit} -> ${outDir}`);
}
