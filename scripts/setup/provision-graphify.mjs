#!/usr/bin/env node
// scripts/setup/provision-graphify.mjs - installs graphify through the same
// provisionGraphify path `glmps init` uses (uv tool install, pinned when the
// shipped default pins a version). Prints the outcome; exit 3 when uv is
// missing so the wizard can offer to install it.
import { defaultRun } from '../../server/lib/chassis/deps.js';
import { configDefaults } from '../../server/lib/config-defaults.js';
import { provisionGraphify } from '../../server/lib/observability/graphify-toolchain.js';

const prov = provisionGraphify({ run: defaultRun, pinned: configDefaults().graphifyUpdate.pinned });
console.log(prov.action === 'installed' || prov.action === 'present' ? `graphify ${prov.version} ready (${prov.action})` : `graphify not provisioned (${prov.action}): ${prov.detail}`);
process.exit(prov.action === 'uv-missing' ? 3 : prov.action === 'failed' || prov.action === 'installed-not-on-path' ? 1 : 0);
