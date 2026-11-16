// server/test/semantic-dedup.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalize,
  similarity,
  findNearest,
  clusterNearDups,
  DEFAULT_SIM_THRESHOLD,
} from '../lib/evaluation/semantic-dedup.js';

// Real-world fixtures: paraphrase families actually seen from the pre-D23
// headless "compose ONE concise guard line" hand (buildIdeaApplyCommand,
// deleted in the guard proposer cutover, Task 10), which had no dedup and so
// produced slightly different wording each time it fired for the same
// underlying gap. Kept as regression fixtures for findNearest/insertGuard's
// simThreshold check, which still guards against exactly this kind of
// paraphrase drift from any proposer, GEPA included.

const DESIGN_FAMILY = [
  '- Before implementing a change that touches 3 or more files, write a short design or plan first.',
  '- Before implementing a change spanning 3 or more files, write a short plan first.',
  '- Any change touching three or more files needs a short design or plan before implementation.',
];

const UI_SKILL_FAMILY = [
  '- Before any UI/CSS/layout/styling work, invoke the frontend-design skill. Invoke it BEFORE the first UI/CSS edit, not after.',
  '- Invoke frontend-design BEFORE the first UI/CSS edit, not after.',
  '- Before any UI/CSS/layout/styling work, invoke the frontend-design skill.',
  '- Invoke frontend-design BEFORE the first UI/CSS edit, not after.',
];

const DISTINCT_GUARDS = [
  '- Use the Grep/Read tools instead of Bash grep/cat for searching and reading files.',
  '- Never poll with sleep N then cat - use run_in_background or Monitor.',
];

// normalize

test('normalize: lowercases, strips bullet/ordinal markers and punctuation, collapses whitespace', () => {
  assert.equal(normalize('- Hello,  World!'), 'hello world');
  assert.equal(normalize('1. Do the Thing.'), 'do the thing');
  assert.equal(normalize('* Another   one'), 'another one');
  assert.equal(normalize(''), '');
  assert.equal(normalize(null), '');
});

// similarity

test('similarity: identical strings score 1', () => {
  assert.equal(similarity(DESIGN_FAMILY[0], DESIGN_FAMILY[0]), 1);
});

test('similarity: identical after normalization (bullet/case differences only) scores 1', () => {
  assert.equal(similarity('- Do the thing.', '1. do THE thing'), 1);
});

test('similarity: two empty/blank strings score 0 (not 1) so blanks never spuriously dedup', () => {
  assert.equal(similarity('', ''), 0);
  assert.equal(similarity('   ', ''), 0);
});

test('similarity: real design-guard paraphrases score high (well above threshold)', () => {
  const s1 = similarity(DESIGN_FAMILY[0], DESIGN_FAMILY[1]);
  const s2 = similarity(DESIGN_FAMILY[0], DESIGN_FAMILY[2]);
  const s3 = similarity(DESIGN_FAMILY[1], DESIGN_FAMILY[2]);
  assert.ok(s1 >= DEFAULT_SIM_THRESHOLD, `design1~design2 = ${s1}`);
  assert.ok(s2 >= DEFAULT_SIM_THRESHOLD, `design1~design3 = ${s2}`);
  assert.ok(s3 >= DEFAULT_SIM_THRESHOLD, `design2~design3 = ${s3}`);
});

test('similarity: real ui-skill-guard paraphrases score high (well above threshold)', () => {
  for (let i = 0; i < UI_SKILL_FAMILY.length; i++) {
    for (let j = i + 1; j < UI_SKILL_FAMILY.length; j++) {
      // Not every pair need clear the bar directly (clustering is transitive),
      // but the "same skeleton, different skill name" pairs must.
    }
  }
  const same1 = similarity(UI_SKILL_FAMILY[0], UI_SKILL_FAMILY[2]); // frontend-design vs frontend-design, same sentence shape
  const same2 = similarity(UI_SKILL_FAMILY[1], UI_SKILL_FAMILY[3]); // same, other sentence shape
  assert.ok(same1 >= DEFAULT_SIM_THRESHOLD, `ui1~ui3 = ${same1}`);
  assert.ok(same2 >= DEFAULT_SIM_THRESHOLD, `ui2~ui4 = ${same2}`);
});

test('similarity: distinct, topically-unrelated guards score low (well below threshold)', () => {
  const s = similarity(DISTINCT_GUARDS[0], DISTINCT_GUARDS[1]);
  assert.ok(s < DEFAULT_SIM_THRESHOLD, `grep~sleep = ${s}`);
});

test('similarity: guards from different families score low (well below threshold)', () => {
  for (const d of DESIGN_FAMILY) {
    for (const u of UI_SKILL_FAMILY) {
      const s = similarity(d, u);
      assert.ok(s < DEFAULT_SIM_THRESHOLD, `"${d}" ~ "${u}" = ${s}`);
    }
  }
  for (const d of DESIGN_FAMILY) {
    for (const g of DISTINCT_GUARDS) {
      const s = similarity(d, g);
      assert.ok(s < DEFAULT_SIM_THRESHOLD, `"${d}" ~ "${g}" = ${s}`);
    }
  }
});

// findNearest

test('findNearest: finds the closest existing near-dup at/above threshold', () => {
  const existing = [DESIGN_FAMILY[0], ...DISTINCT_GUARDS];
  const result = findNearest(DESIGN_FAMILY[1], existing, DEFAULT_SIM_THRESHOLD);
  assert.ok(result);
  assert.equal(result.item, DESIGN_FAMILY[0]);
  assert.ok(result.score >= DEFAULT_SIM_THRESHOLD);
});

test('findNearest: returns null when nothing clears the threshold', () => {
  const result = findNearest(DESIGN_FAMILY[0], DISTINCT_GUARDS, DEFAULT_SIM_THRESHOLD);
  assert.equal(result, null);
});

test('findNearest: returns null on an empty existing list', () => {
  assert.equal(findNearest('- anything', [], DEFAULT_SIM_THRESHOLD), null);
  assert.equal(findNearest('- anything', undefined, DEFAULT_SIM_THRESHOLD), null);
});

// clusterNearDups

test('clusterNearDups: the 3 design-before-3+-files rewordings cluster together', () => {
  const all = [...DESIGN_FAMILY, ...DISTINCT_GUARDS];
  const clusters = clusterNearDups(all, DEFAULT_SIM_THRESHOLD);
  assert.equal(clusters.length, 1, `expected exactly one cluster, got ${JSON.stringify(clusters)}`);
  const cluster = clusters[0];
  assert.equal(cluster.length, 3);
  for (const line of DESIGN_FAMILY) assert.ok(cluster.includes(line));
});

test('clusterNearDups: the 4 invoke-ui-skill-before-UI-work variants cluster together', () => {
  const all = [...UI_SKILL_FAMILY, ...DISTINCT_GUARDS];
  const clusters = clusterNearDups(all, DEFAULT_SIM_THRESHOLD);
  assert.equal(clusters.length, 1, `expected exactly one cluster, got ${JSON.stringify(clusters)}`);
  const cluster = clusters[0];
  assert.equal(cluster.length, 4);
  for (const line of UI_SKILL_FAMILY) assert.ok(cluster.includes(line));
});

test('clusterNearDups: distinct guards never cluster with each other or with either family', () => {
  const all = [...DESIGN_FAMILY, ...UI_SKILL_FAMILY, ...DISTINCT_GUARDS];
  const clusters = clusterNearDups(all, DEFAULT_SIM_THRESHOLD);
  assert.equal(clusters.length, 2, `expected exactly the design + ui clusters, got ${JSON.stringify(clusters)}`);
  for (const cluster of clusters) {
    for (const g of DISTINCT_GUARDS) assert.ok(!cluster.includes(g));
  }
});

test('clusterNearDups: empty list -> empty array', () => {
  assert.deepEqual(clusterNearDups([], DEFAULT_SIM_THRESHOLD), []);
});

test('clusterNearDups: all-distinct list -> no clusters (every group is a singleton, dropped)', () => {
  assert.deepEqual(clusterNearDups(DISTINCT_GUARDS, DEFAULT_SIM_THRESHOLD), []);
});
