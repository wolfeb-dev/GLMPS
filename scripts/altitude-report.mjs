#!/usr/bin/env node
// scripts/altitude-report.mjs
//
// How in-the-weeds are we actually writing? Scores every agent-authored devlog
// on the real board and prints the distribution, so the effect of the reporting
// contract (docs/comms-altitude.md) is measured rather than asserted.
//
// The baseline recorded in that doc came from this script on 2026-08-22. Re-run
// it later and compare; the number that matters is the share of posts whose
// FIRST LINE already names two or more internal identifiers.
//
//   node scripts/altitude-report.mjs [--since 2026-08-22] [--json]
//
// Read-only. Zero runtime dependencies.

import path from 'node:path';
import { scoreAltitude, internalIdentifiers, engineerAsks, LEAD_IDENTIFIER_LIMIT, UNFOLDED_CHAR_LIMIT }
  from '../server/lib/scut/altitude.js';
import * as backlogStore from '../server/lib/orchestration/backlog-store.js';
import { resolveStateDir } from '../server/lib/state-dir.js';

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? null : (argv[i + 1] ?? '');
};
const asJson = argv.includes('--json');
const since = flag('--since');

const stateDir = resolveStateDir();
const storePath = path.join(stateDir, 'backlog', 'store.json');

// load() replays the change log on top of the snapshot; store.json alone is stale.
const store = backlogStore.load(stateDir);
if (store.loadError) {
  console.error(`cannot read the board at ${storePath}: ${store.loadError.message}`);
  process.exit(1);
}

const posts = [];
for (const item of store.items ?? []) {
  for (const entry of item.devLog ?? []) {
    if (entry.by !== 'agent') continue;
    const text = typeof entry.text === 'string' ? entry.text.trim() : '';
    if (!text) continue;
    if (since && String(entry.ts ?? '') < since) continue;
    posts.push({ id: item.id, ts: entry.ts, text });
  }
}

if (!posts.length) {
  console.error(since ? `no agent devlogs since ${since}` : 'no agent devlogs on this board');
  process.exit(1);
}

const quantile = (values, p) => {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) * p)];
};
const pct = (n) => `${Math.round((n / posts.length) * 100)}%`;

const scored = posts.map((p) => ({ ...p, ...scoreAltitude(p.text) }));
const chars = scored.map((s) => s.signals.chars);
const leadIds = scored.map((s) => s.signals.leadIdentifiers);
const allIds = scored.map((s) => s.signals.identifiers);

const summary = {
  posts: posts.length,
  tickets: new Set(posts.map((p) => p.id)).size,
  since: since ?? 'all time',
  leadInTheWeeds: scored.filter((s) => s.signals.leadIdentifiers >= LEAD_IDENTIFIER_LIMIT).length,
  leadAnyIdentifier: scored.filter((s) => s.signals.leadIdentifiers >= 1).length,
  folded: scored.filter((s) => s.signals.hasFold).length,
  longUnfolded: scored.filter((s) => s.signals.chars > UNFOLDED_CHAR_LIMIT && !s.signals.hasFold).length,
  flagged: scored.filter((s) => s.level === 'deep').length,
  charsMedian: quantile(chars, 0.5),
  charsP90: quantile(chars, 0.9),
  identifiersMedian: quantile(allIds, 0.5),
  leadIdentifiersP90: quantile(leadIds, 0.9),
  engineerAskPosts: posts.filter((p) => engineerAsks(p.text).length > 0).length,
  engineerAsks: posts.reduce((n, p) => n + engineerAsks(p.text).length, 0),
};

if (asJson) {
  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}

console.log(`Reporting altitude over ${summary.posts} agent devlogs on ${summary.tickets} tickets (${summary.since})`);
console.log('');
console.log(`  lead names ${LEAD_IDENTIFIER_LIMIT}+ internal identifiers   ${pct(summary.leadInTheWeeds).padStart(4)}   <- the one that matters`);
console.log(`  lead names any internal identifier    ${pct(summary.leadAnyIdentifier).padStart(4)}`);
console.log(`  has a Details: fold                   ${pct(summary.folded).padStart(4)}`);
console.log(`  over ${UNFOLDED_CHAR_LIMIT} chars with no fold          ${pct(summary.longUnfolded).padStart(4)}`);
console.log(`  flagged overall                       ${pct(summary.flagged).padStart(4)}`);
console.log('');
console.log(`  length      median ${summary.charsMedian}   p90 ${summary.charsP90}`);
console.log(`  identifiers median ${summary.identifiersMedian}   lead p90 ${summary.leadIdentifiersP90}`);
console.log('');
console.log(`  posts asking an engineer-owned question ${pct(summary.engineerAskPosts).padStart(4)}   (${summary.engineerAsks} asks; a floor, see docs/comms-altitude.md)`);

const worst = scored
  .filter((s) => s.level === 'deep')
  .sort((a, b) => b.signals.leadIdentifiers - a.signals.leadIdentifiers)
  .slice(0, 5);
if (worst.length) {
  console.log('\nDetails: the leads furthest into the weeds\n');
  for (const w of worst) {
    const lead = w.text.split('\n').find((l) => l.trim()) ?? '';
    console.log(`  ${w.id}  ${w.signals.leadIdentifiers} ids in the lead`);
    console.log(`    ${lead.slice(0, 110)}${lead.length > 110 ? '...' : ''}`);
    console.log(`    ${internalIdentifiers(lead).slice(0, 6).join(', ')}`);
  }
}
