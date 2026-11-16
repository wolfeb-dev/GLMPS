#!/usr/bin/env node
// scripts/setup/deps-plan.mjs - what the setup wizard should offer per dependency.
// Prints name<TAB>action<TAB>installed<TAB>latest<TAB>command, one line each.
// Read-only: probes versions, never installs. --no-latest skips the winget
// lookups (offline), so nothing is reported outdated.
import { checkDeps, latestVersions, planDeps, planToTsv } from '../../server/lib/chassis/deps.js';

const latest = process.argv.includes('--no-latest') ? {} : latestVersions();
console.log(planToTsv(planDeps(checkDeps().results, latest)));
