import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreProbes, demotionAllowed, RECALL_FLOOR } from '../lib/evaluation/memory-probe.js';

function stubLookup(map) {
  return (_m, q) => (map[q] || []).map((target, i) => ({ target, title: target, score: 1 - i * 0.1, excerpt: '', tier: 'curated' }));
}

test('recallAtK counts a hit anywhere in the top-k', () => {
  const lookup = stubLookup({ q1: ['x.md', 'a.md'], q2: ['b.md'] });
  const r = scoreProbes('/m', [{ q: 'q1', expect: 'a.md' }, { q: 'q2', expect: 'b.md' }], { k: 5, lookup });
  assert.equal(r.hits, 2);
  assert.equal(r.recallAtK, 1);
});

test('scoreProbes passes tier: "curated" to the lookup by default (gate scope)', () => {
  const seen = [];
  const lookup = (_m, _q, opts) => { seen.push(opts?.tier); return [{ target: 'a.md', tier: 'curated' }]; };
  scoreProbes('/m', [{ q: 'q', expect: 'a.md' }], { k: 5, lookup });
  assert.deepEqual(seen, ['curated']);
});

test('mrr rewards rank 1 over rank 2 and lists misses', () => {
  const lookup = stubLookup({ a: ['a.md'], b: ['x.md', 'b.md'], c: ['x.md', 'y.md'] });
  const r = scoreProbes('/m', [{ q: 'a', expect: 'a.md' }, { q: 'b', expect: 'b.md' }, { q: 'c', expect: 'c.md' }], { k: 5, lookup });
  assert.equal(r.recallAtK, 2 / 3);
  assert.equal(Math.round(r.mrr * 1000) / 1000, 0.5);
  assert.equal(r.misses.length, 1);
  assert.deepEqual(r.misses[0].got, ['x.md', 'y.md']);
});

test('empty probe set never passes', () => {
  const r = scoreProbes('/m', [], { lookup: stubLookup({}) });
  assert.equal(r.recallAtK, 0);
  assert.equal(demotionAllowed(r).allowed, false);
});

test('demotionAllowed opens only at or above the floor with enough probes', () => {
  assert.equal(demotionAllowed({ total: 40, recallAtK: RECALL_FLOOR }).allowed, true);
  assert.equal(demotionAllowed({ total: 40, recallAtK: RECALL_FLOOR - 0.01 }).allowed, false);
  assert.match(demotionAllowed({ total: 5, recallAtK: 1 }).reason, /probe set too small/i);
});
