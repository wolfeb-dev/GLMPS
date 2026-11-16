#!/usr/bin/env node
// scripts/plan-lint.mjs  -  exits non-zero if a plan contains un-justified deferral.
//
// Two modes:
//   plan-lint.mjs <file.md> [<file2.md> ...]   lint exactly the given files.
//   plan-lint.mjs --changed                    lint only plan docs touched on
//                                               this branch (vs `git merge-base
//                                               main HEAD`) plus any dirty or
//                                               untracked plan docs. Legacy
//                                               plans nobody touched this branch
//                                               are never linted, so the rule
//                                               applies going forward without
//                                               retroactively failing the
//                                               ~10 pre-existing plan docs.
//
// --changed resolves its file list with git. If any git command errors (no
// main branch, detached HEAD, not a repo, etc.) it FAILS OPEN: lint nothing,
// exit 0. The done-gate must never break on a git edge case.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { scanDeferrals } from '../server/lib/governance/deferral-scan.js';

const PLAN_RE = /^docs\/(?:specs|superpowers\/plans)\/.*\.md$/;

function git(args) {
  // stderr ignored so git's own "fatal: ..." does not leak to the console on
  // the fail-open path (the catch below handles the failure); stdout is piped
  // so we still capture the result.
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

// A porcelain line for a rename is `R  old -> new`; we want the NEW path.
// Everything else is `XY path`. slice(3) drops the 2 status chars + space.
function porcelainPath(line) {
  const rest = line.slice(3).trim();
  const arrow = rest.indexOf(' -> ');
  return arrow >= 0 ? rest.slice(arrow + 4).trim() : rest;
}

function resolveChangedPlanFiles() {
  try {
    const mergeBase = git(['merge-base', 'main', 'HEAD']);
    const diffed = git(['diff', '--name-only', '--diff-filter=ACMR', mergeBase, 'HEAD'])
      .split('\n')
      .filter(Boolean);
    // -uall: a brand-new folder (the first docs/specs/ in a repo) is otherwise
    // reported as the folder, never as the spec inside it.
    const dirty = git(['status', '--porcelain', '--untracked-files=all'])
      .split('\n')
      .filter(Boolean)
      .map(porcelainPath);
    const files = new Set([...diffed, ...dirty]);
    return [...files].filter((f) => PLAN_RE.test(f) && fs.existsSync(f));
  } catch {
    // Fail open: never let a git edge case break the done-gate.
    return [];
  }
}

function lintFiles(files) {
  let totalFindings = 0;
  for (const file of files) {
    const findings = scanDeferrals(fs.readFileSync(file, 'utf8'));
    if (!findings.length) {
      console.log(`plan-lint: ${file} has no un-justified deferrals`);
      continue;
    }
    totalFindings += findings.length;
    for (const f of findings) console.error(`  ${file}:${f.line}  ${f.marker}  ${f.text}`);
  }
  return totalFindings;
}

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('usage: plan-lint.mjs <plan.md> [<plan2.md> ...] | --changed');
  process.exit(2);
}

let files;
if (args.includes('--changed')) {
  files = resolveChangedPlanFiles();
  if (!files.length) {
    console.log('plan-lint: --changed found no plan docs to lint');
    process.exit(0);
  }
} else {
  files = args;
}

const totalFindings = lintFiles(files);
if (totalFindings > 0) {
  console.error(`plan-lint: ${totalFindings} deferral(s). Fold them into the plan or mark OUT-OF-SCOPE: <reason>.`);
  process.exit(1);
}
process.exit(0);
