#!/usr/bin/env node
// scripts/install-deletion-guard.mjs - operator step for card glmps-2-0-runtime-127.
//   node scripts/install-deletion-guard.mjs          dry run: print what would change
//   node scripts/install-deletion-guard.mjs --apply  back up settings.json, then install
//
// Wires the deletion-guard PreToolUse hook into Claude Code's settings.json.
// The hook manifest is the only registration path, so --apply runs
// `install.mjs --hooks-only`, which also records the entry for --uninstall.
// That run adds every manifest row missing from settings.json, not only this
// one; the dry run lists them all. Idempotent: an installed guard is adopted,
// never duplicated. Run it from the checkout the hook should point at
// (the deployed one, <runtime-checkout>).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { spawnSync } from 'node:child_process';
import { planHookInstall, resolveInstallPaths } from './install-hooks-lib.mjs';

const repoRoot = path.dirname(path.dirname(url.fileURLToPath(import.meta.url)));
const GUARD_ID = 'deletion-guard';

function readSettings(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw new Error(`${file} could not be read as JSON (${e.message}); nothing was changed`);
  }
}

function main(argv) {
  const unknown = argv.filter((a) => a !== '--apply');
  if (unknown.length) { console.error(`unknown flag '${unknown[0]}'; the only flag is --apply. Nothing was changed.`); return 2; }
  const apply = argv.includes('--apply');
  const { settingsFile } = resolveInstallPaths({ env: process.env, homedir: os.homedir() });
  const settings = readSettings(settingsFile);
  const { added, entries } = planHookInstall(settings, { repoRoot, nodePath: process.execPath });
  const guard = entries.find((e) => e.id === GUARD_ID);

  console.log(`settings: ${settingsFile}`);
  console.log(`checkout: ${repoRoot}`);
  if (/[\\/]runner[\\/]worktrees[\\/]/i.test(repoRoot)) {
    console.log('WARNING: this is a runner worktree, which the server reclaims; run this from the deployed checkout instead.');
  }
  if (guard.status === 'adopted') {
    console.log(`deletion-guard: already installed (${guard.command}). Nothing to do.`);
    return 0;
  }
  console.log(`deletion-guard: would add PreToolUse [${guard.matcher}] ${guard.command}`);
  const others = added.filter((a) => a.id !== GUARD_ID);
  if (others.length) console.log(`also missing from settings.json and added by the same run: ${others.map((a) => a.id).join(', ')}`);
  if (!apply) { console.log('dry run: nothing changed. Re-run with --apply to install.'); return 0; }

  if (fs.existsSync(settingsFile)) {
    const backup = `${settingsFile}.deletion-guard-${new Date().toISOString().replace(/[:.]/g, '-')}.bak`;
    fs.copyFileSync(settingsFile, backup);
    console.log(`backed up settings.json to ${backup}`);
  }
  const r = spawnSync(process.execPath, [path.join(repoRoot, 'scripts', 'install.mjs'), '--hooks-only'], { stdio: 'inherit', env: process.env });
  if (r.status !== 0) { console.error(`install.mjs --hooks-only exited ${r.status}; see its output above.`); return r.status || 1; }
  const after = planHookInstall(readSettings(settingsFile), { repoRoot, nodePath: process.execPath }).entries.find((e) => e.id === GUARD_ID);
  console.log(after.status === 'adopted' ? 'deletion-guard: installed. New Claude Code sessions pick it up.' : 'deletion-guard: NOT found in settings.json after the install.');
  return after.status === 'adopted' ? 0 : 1;
}

if (process.argv[1] && import.meta.url === url.pathToFileURL(process.argv[1]).href) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exitCode = 2; }
}
