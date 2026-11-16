import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { upsertCandidate, approveCandidateIn, startTrialIn, load, rejectCandidateIn } from '../lib/governance/cross-agent-memory-store.js';
import { appendLessonRow, readLessonRows, lessonsCurrent } from '../lib/evaluation/lesson-ledger.js';
import { proposeShares, applyShares, parseProposal } from '../../scripts/share-memory.mjs';
import { seedMemoryStore } from '../lib/governance/memory-ship-seed.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mc-share-'));
const fact = (name, body) => ({ name, description: `about ${name}`, type: 'feedback', body, confidence: 0.9 });

function stateWithFacts(dir) {
  const a = upsertCandidate(dir, fact('small-commits', 'Prefer small commits.'), 'p1').item;
  approveCandidateIn(dir, a.id);
  const b = upsertCandidate(dir, fact('my-path', 'Keep notes under D:\\private\\notes.'), 'p1').item;
  approveCandidateIn(dir, b.id);
  startTrialIn(dir, b.id);
  const c = upsertCandidate(dir, fact('pending-one', 'not approved yet'), 'p1').item;
  const d = upsertCandidate(dir, fact('rejected-one', 'rejected fact'), 'p1').item;
  rejectCandidateIn(dir, d.id, 'no');
  appendLessonRow(dir, { type: 'created', lessonId: 'legacy:g1', kind: 'guard', title: 'Design before building a large change', provenance: { scope: 'global' }, createdAt: '2026-01-01T00:00:00.000Z' });
  appendLessonRow(dir, { type: 'created', lessonId: 'legacy:g2', kind: 'guard', title: 'Dormant guard', provenance: { scope: 'global' }, createdAt: '2026-01-01T00:00:00.000Z' });
  appendLessonRow(dir, { type: 'decayed', lessonId: 'legacy:g2', strength: 0.2, ts: '2026-02-01T00:00:00.000Z' });
  return { a, b, c, d };
}

const generator = (calls = []) => async (prompt) => {
  calls.push(prompt);
  if (/D:\\private/.test(prompt)) return 'Sure:\n```json\n{"shareable": false, "shareText": ""}\n```';
  return JSON.stringify({ shareable: true, shareText: 'Prefer small, reviewable commits.' });
};

test('propose asks the injected generator about approved, trialing and kept facts and active lessons only, and changes no state', async () => {
  const dir = tmp();
  try {
    const ids = stateWithFacts(dir);
    const before = JSON.stringify([load(dir), readLessonRows(dir)]);
    const calls = [];
    const rows = await proposeShares({ stateDir: dir, generate: generator(calls) });
    assert.deepEqual(rows.map((r) => r.id).sort(), [ids.a.id, ids.b.id, 'legacy:g1'].sort());
    assert.equal(calls.length, 3);
    const a = rows.find((r) => r.id === ids.a.id);
    assert.deepEqual({ kind: a.kind, approved: a.approved, shareable: a.proposed.shareable, shareText: a.proposed.shareText }, { kind: 'memory', approved: false, shareable: true, shareText: 'Prefer small, reviewable commits.' });
    assert.match(a.original, /Prefer small commits/);
    assert.equal(rows.find((r) => r.id === ids.b.id).proposed.shareable, false);
    assert.equal(rows.find((r) => r.id === 'legacy:g1').kind, 'lesson');
    assert.equal(JSON.stringify([load(dir), readLessonRows(dir)]), before);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a generator answer that is not the expected JSON becomes a not-shareable row with an error, not a crash', async () => {
  const dir = tmp();
  try {
    stateWithFacts(dir);
    const rows = await proposeShares({ stateDir: dir, generate: async () => 'I cannot do that' });
    assert.equal(rows.every((r) => r.proposed.shareable === false && r.error), true);
    assert.deepEqual(parseProposal('{"shareable":true,"shareText":"x"}'), { shareable: true, shareText: 'x' });
    assert.equal(parseProposal('nope'), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('apply takes only operator-approved rows, sets the flags in state, and writes a seed of share text with no ids', async () => {
  const dir = tmp();
  try {
    const ids = stateWithFacts(dir);
    const rows = await proposeShares({ stateDir: dir, generate: generator() });
    const review = rows.map((r) => ({ ...r, approved: r.id === ids.a.id || r.id === 'legacy:g1' }));
    const seedFile = path.join(dir, 'seed', 'memory.json');
    const res = applyShares({ stateDir: dir, review, seedFile, now: 1_700_000_000_000 });
    assert.deepEqual(res.applied.sort(), [ids.a.id, 'legacy:g1'].sort());
    assert.equal(load(dir).items.find((i) => i.id === ids.a.id).shareable, true);
    assert.equal('shareable' in load(dir).items.find((i) => i.id === ids.b.id), false);
    assert.equal(lessonsCurrent(readLessonRows(dir)).get('legacy:g1').shareable, true);
    const seed = JSON.parse(fs.readFileSync(seedFile, 'utf8'));
    assert.deepEqual(seed, { version: 1, items: [{ kind: 'lesson', text: 'Prefer small, reviewable commits.' }, { kind: 'memory', text: 'Prefer small, reviewable commits.' }] });
    assert.doesNotMatch(fs.readFileSync(seedFile, 'utf8'), /legacy:|small-commits|p1|provenance/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('apply refuses share text that fails the history or PII scan, and says why', async () => {
  const dir = tmp();
  try {
    const ids = stateWithFacts(dir);
    const review = [
      { kind: 'memory', id: ids.a.id, approved: true, proposed: { shareable: true, shareText: 'See D:\\private\\x for details' } },
      { kind: 'memory', id: ids.b.id, approved: true, proposed: { shareable: true, shareText: 'Per glmps-2-0-12 do this' } },
      { kind: 'lesson', id: 'legacy:g1', approved: true, proposed: { shareable: true, shareText: 'Owned by opname' } },
    ];
    const seedFile = path.join(dir, 'seed.json');
    const res = applyShares({ stateDir: dir, review, seedFile, privateNames: ['opname'] });
    assert.deepEqual(res.applied, []);
    assert.deepEqual(res.refused.map((r) => r.id).sort(), [ids.a.id, ids.b.id, 'legacy:g1'].sort());
    assert.equal(fs.existsSync(seedFile) && JSON.parse(fs.readFileSync(seedFile, 'utf8')).items.length > 0, false);
    assert.equal('shareable' in load(dir).items.find((i) => i.id === ids.a.id), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the first-run seed fills an empty or absent memory store from the bundle and never overwrites existing items', () => {
  const dir = tmp();
  try {
    const bundle = path.join(dir, 'bundle');
    const state = path.join(dir, 'state');
    fs.mkdirSync(path.join(bundle, 'product', 'seed'), { recursive: true });
    fs.writeFileSync(path.join(bundle, 'product', 'seed', 'memory.json'), JSON.stringify({ version: 1, items: [{ kind: 'memory', text: 'Prefer small commits.' }, { kind: 'lesson', text: 'Design before building.' }] }));

    assert.deepEqual(seedMemoryStore({ bundleDir: bundle, stateDir: state }), { seeded: false, reason: 'not an installed bundle' });
    fs.writeFileSync(path.join(bundle, 'bundle.json'), '{}');
    const r = seedMemoryStore({ bundleDir: bundle, stateDir: state });
    assert.deepEqual({ seeded: r.seeded, count: r.count }, { seeded: true, count: 2 });
    const items = load(state).items;
    assert.deepEqual(items.map((i) => [i.status, i.fact.body]).sort(), [['approved', 'Design before building.'], ['approved', 'Prefer small commits.']]);
    assert.equal(items.every((i) => i.sourceProject === 'bundle-seed'), true);

    assert.deepEqual(seedMemoryStore({ bundleDir: bundle, stateDir: state }), { seeded: false, reason: 'memory store already has items' });
    assert.equal(load(state).items.length, 2);

    const other = path.join(dir, 'state2');
    upsertCandidate(other, fact('mine', 'my own fact'), 'p');
    assert.equal(seedMemoryStore({ bundleDir: bundle, stateDir: other }).seeded, false);
    assert.deepEqual(load(other).items.map((i) => i.fact.name), ['mine']);

    fs.writeFileSync(path.join(bundle, 'product', 'seed', 'memory.json'), 'not json');
    assert.equal(seedMemoryStore({ bundleDir: bundle, stateDir: path.join(dir, 'state3') }).seeded, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
