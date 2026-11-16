#!/usr/bin/env node
// scripts/glmps-init.mjs - glmps init bootstrap CLI.
//
// Usage:
//   node scripts/glmps-init.mjs --engagement <name> [--search <dir>] [--handle <handle>] [--force]
//
// Steps:
//   1. Check required deps (node, git); warn on optional ones.
//   2. Discover installed harnesses and git repos under --search dirs.
//   3. Write glmps.profile.json in cwd (refuse to overwrite unless --force).
//   4. Run the full install (config, statusline, hooks) via runInstall from
//      install.mjs. Note: this passes install.mjs its OWN argv, not
//      glmps-init's - runInstall never parses process.argv itself.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { checkDeps, defaultRun } from '../server/lib/chassis/deps.js';
import { getPaths, configFileFor } from '../server/lib/paths.js';
import { configDefaults } from '../server/lib/config-defaults.js';
import { provisionGraphify } from '../server/lib/observability/graphify-toolchain.js';
import { discoverRepos, discoverHarnesses, buildProfileDraft } from '../server/lib/chassis/discover.js';
import { adapters } from '../server/lib/adapters/index.js';
import { runInstall } from './install.mjs';

// Arg parsing

function parseArgs(argv) {
  const args = { engagement: null, search: [], handle: null, force: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--engagement' && argv[i + 1]) { args.engagement = argv[++i]; }
    else if (a === '--search' && argv[i + 1]) { args.search.push(argv[++i]); }
    else if (a === '--handle' && argv[i + 1]) { args.handle = argv[++i]; }
    else if (a === '--force') { args.force = true; }
  }
  return args;
}

// The known-good graphify version: config.json's graphifyUpdate.pinned when
// set (null there means unpinned), else the shipped default.
function graphifyPin() {
  let user = {};
  try { user = JSON.parse(fs.readFileSync(configFileFor(), 'utf-8')); } catch { /* no config yet: defaults */ }
  const pinned = user?.graphifyUpdate?.pinned;
  return pinned === undefined ? configDefaults().graphifyUpdate.pinned : pinned;
}

// Main

function main() {
  const args = parseArgs(process.argv);

  if (!args.engagement) {
    console.error('Error: --engagement <name> is required.');
    process.exit(1);
  }

  // 1. Dependency check
  const depResult = checkDeps();
  if (!depResult.ok) {
    console.error(`Error: missing required dependencies: ${depResult.missingRequired.join(', ')}`);
    process.exit(1);
  }
  // graphify stays optional: a failed provision is reported, never fatal.
  if (!depResult.results.find(r => r.name === 'graphify')?.present) {
    const prov = provisionGraphify({ run: defaultRun, pinned: graphifyPin() });
    if (prov.action === 'installed') console.log(`graphify ${prov.version} installed via uv`);
    else console.warn(`Warning: graphify not provisioned (${prov.action}): ${prov.detail}`);
    if (prov.action === 'installed' || prov.action === 'installed-not-on-path') {
      depResult.results.find(r => r.name === 'graphify').present = true;
    }
  }
  const optional = depResult.results.filter(r => !r.required && !r.present);
  if (optional.length) {
    console.warn(`Warning: optional deps not found (degraded functionality): ${optional.map(r => r.name).join(', ')}`);
  }

  // 2. Discover harnesses + repos
  const P = getPaths(process.env);
  const harnesses = discoverHarnesses(P, adapters);
  const searchRoots = args.search.length ? args.search : [os.homedir()];
  const repoRoots = discoverRepos(searchRoots);

  // 3. Build and write profile draft
  const profilePath = path.join(process.cwd(), 'glmps.profile.json');
  if (fs.existsSync(profilePath) && !args.force) {
    console.error(`Error: ${profilePath} already exists. Pass --force to overwrite.`);
    process.exit(1);
  }
  const draft = buildProfileDraft({
    engagement: args.engagement,
    identity: { handle: args.handle },
    repoRoots,
    harnesses,
    stateDir: `~/.glmps/${args.engagement}`,
  });
  fs.writeFileSync(profilePath, JSON.stringify(draft, null, 2));
  console.log(`Profile written to: ${profilePath}`);

  // 4. Wire installer steps
  console.log('Running installer steps...');
  if (runInstall()) console.log('Done. Run the dashboard with: node server/server.js');
  else process.exit(2);
}

main();
