//
// Measures whether the fault path finds a fact by situation, not by its own
// wording. Curated-index demotion and distilled-fact surfacing both depend on
// this. Pure apart from the injected lookup.

import fs from 'node:fs';
import path from 'node:path';
import { lookupFacts } from './memory-fault.js';

export const RECALL_FLOOR = 0.8;
const MIN_PROBES = 20;

export function probesFile(stateDir) { return path.join(stateDir, 'memory', 'probes.json'); }

export function readProbes(stateDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(probesFile(stateDir), 'utf8'));
    return Array.isArray(parsed) ? parsed.filter((p) => p && p.q && p.expect) : [];
  } catch { return []; }
}

// tier defaults to 'curated': this scorer exists to gate CURATED-index demotion,
// so it must measure whether a curated fact is re-findable among CURATED results
// only. Scoring the combined pool would conflate demotion safety with L3 search
// noise - populating the distilled pool would silently lower the gate's recall
// (it did: 79% -> 65% on deploy) though curated re-findability was unchanged.
export function scoreProbes(memoryDir, probes, { k = 5, tier = 'curated', lookup = lookupFacts } = {}) {
  const list = Array.isArray(probes) ? probes : [];
  const misses = [];
  let hits = 0; let reciprocalSum = 0;
  for (const probe of list) {
    let got = [];
    try { got = lookup(memoryDir, probe.q, { k, tier }).map((h) => h.target); } catch { got = []; }
    const rank = got.indexOf(probe.expect);
    if (rank >= 0) { hits += 1; reciprocalSum += 1 / (rank + 1); }
    else misses.push({ q: probe.q, expect: probe.expect, got });
  }
  const total = list.length;
  return { total, hits, recallAtK: total ? hits / total : 0, mrr: total ? reciprocalSum / total : 0, misses };
}

export function demotionAllowed(report, { floor = RECALL_FLOOR } = {}) {
  const total = Number(report?.total) || 0;
  const recall = Number(report?.recallAtK) || 0;
  if (total < MIN_PROBES) return { allowed: false, reason: `probe set too small (${total} < ${MIN_PROBES})` };
  if (recall < floor) return { allowed: false, reason: `recall@k ${recall.toFixed(2)} below floor ${floor}` };
  return { allowed: true, reason: `recall@k ${recall.toFixed(2)} at or above floor ${floor}` };
}
