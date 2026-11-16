#!/usr/bin/env node
// scripts/touch.mjs
//
// `glmps touch <type> <ref>` - record one human intervention on agent-authored
// work (handoff Part C).
//
// Some human touches are auto-capturable (a PR review comment, a revert commit
// found by revert-scan). Most are not: a human quietly fixing an agent's diff
// before merging leaves no machine-readable trace anywhere. This CLI is the
// manual path for those, so the autonomy metrics measure what actually
// happened rather than only what happened to be instrumented.
//
// Usage:
//   node scripts/touch.mjs <type> <ref> [--class=<taskClass>] [--note="..."]
//   node scripts/touch.mjs --list
//
// Types: review-comment | manual-edit | manual-revert | manual-rerun
//
// Examples:
//   node scripts/touch.mjs manual-edit https://github.com/o/r/pull/7 --class=feature
//   node scripts/touch.mjs manual-revert 1a2b3c4d --note="broke the nightly gate"
import process from 'node:process';
import { getPaths } from '../server/lib/paths.js';
import { TOUCH_TYPES, recordTouch, readTouches, autonomyMetrics } from '../server/lib/evaluation/autonomy-telemetry.js';

function usage(exitCode = 0) {
  const out = exitCode === 0 ? console.log : console.error;
  out('usage: node scripts/touch.mjs <type> <ref> [--class=<taskClass>] [--note="..."]');
  out(`       types: ${TOUCH_TYPES.join(' | ')}`);
  out('       node scripts/touch.mjs --list        show recent touches and current rates');
  process.exit(exitCode);
}

function flag(args, name) {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
}

const args = process.argv.slice(2);
if (args.length === 0 || args.includes('--help') || args.includes('-h')) usage(0);

const P = getPaths(process.env);

if (args.includes('--list')) {
  const touches = readTouches(P.stateDir);
  if (touches.length === 0) {
    console.log('no human touches recorded yet');
    process.exit(0);
  }
  for (const t of touches.slice(-20)) {
    console.log(`${t.ts}  ${t.type.padEnd(15)} ${t.taskClass.padEnd(10)} ${t.ref ?? ''}`);
  }
  // Merges are not tracked by this CLI, so the rates that need a merge
  // denominator are reported as unavailable rather than invented.
  const m = autonomyMetrics(touches, [], { windowDays: 7, now: Date.now() });
  console.log('');
  console.log('last 7 days, touches per task class (merge-denominated rates need merge data):');
  for (const [cls, v] of Object.entries(m.byTaskClass)) {
    console.log(`  ${cls.padEnd(12)} touches=${v.touches} merges=${v.merges}`);
  }
  process.exit(0);
}

const [type, ref] = args.filter((a) => !a.startsWith('--'));
if (!type || !ref) usage(1);
if (!TOUCH_TYPES.includes(type)) {
  console.error(`unknown touch type: ${type}`);
  usage(1);
}

try {
  const e = recordTouch(P.stateDir, {
    type,
    ref,
    taskClass: flag(args, 'class') ?? 'other',
    note: flag(args, 'note'),
    actor: process.env.GLMPS_ACTOR || 'operator',
  });
  console.log(`recorded ${e.payload.type} on ${e.payload.ref} (class ${e.payload.taskClass})`);
} catch (err) {
  console.error(`failed to record touch: ${err.message}`);
  process.exit(1);
}
