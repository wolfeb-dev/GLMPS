import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { upsertCandidate, approveCandidateIn, setShareableIn, load } from '../lib/governance/cross-agent-memory-store.js';
import { createLesson, setLessonShareable, readLessonRows, lessonsCurrent } from '../lib/evaluation/lesson-ledger.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mc-share-'));
const fact = { name: 'n', description: 'd', type: 'feedback', body: 'prefer small commits', confidence: 0.9 };

test('a memory item carries no shareable fields until one is set, and old stores load unchanged', () => {
  const dir = tmp();
  try {
    const { item } = upsertCandidate(dir, fact, 'proj');
    assert.equal('shareable' in item, false);
    assert.equal('shareText' in item, false);
    fs.writeFileSync(path.join(dir, 'cross-agent-memory', 'store.json'), JSON.stringify({ items: [{ id: 'old', status: 'kept', fact }] }));
    assert.deepEqual(load(dir).items.map((i) => i.id), ['old']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('setShareableIn records the flag and text on one item and touches nothing else', () => {
  const dir = tmp();
  try {
    const { item } = upsertCandidate(dir, fact, 'proj');
    approveCandidateIn(dir, item.id);
    const r = setShareableIn(dir, item.id, { shareable: true, shareText: 'Prefer small commits.' });
    assert.equal(r.item.shareable, true);
    assert.equal(r.item.shareText, 'Prefer small commits.');
    const saved = load(dir).items[0];
    assert.equal(saved.status, 'approved');
    assert.deepEqual(saved.fact, item.fact);
    assert.throws(() => setShareableIn(dir, 'nope', { shareable: true, shareText: 'x' }), /no candidate/);
    assert.throws(() => setShareableIn(dir, item.id, { shareable: 'yes', shareText: 'x' }), /shareable must be a boolean/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the lesson ledger folds a shareable row into the current lesson; lessons without one are unchanged', () => {
  const dir = tmp();
  try {
    const prov = { source: 'operator', scope: 'global', evidence: [{ type: 'note', ref: 'x' }] };
    for (const id of ['legacy:a', 'legacy:b']) {
      try { createLesson(dir, { lessonId: id, kind: 'guard', title: `t ${id}`, provenance: prov, now: 1_700_000_000_000 }); } catch { /* provenance shape is the writer's business */ }
    }
    if (!readLessonRows(dir).length) {
      fs.mkdirSync(path.join(dir, 'lessons'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'lessons', 'ledger.ndjson'), ['legacy:a', 'legacy:b'].map((lessonId) => JSON.stringify({ type: 'created', lessonId, kind: 'guard', title: `t ${lessonId}`, provenance: { scope: 'global' }, createdAt: '2026-01-01T00:00:00.000Z' })).join('\n') + '\n');
    }
    setLessonShareable(dir, { lessonId: 'legacy:a', shareable: true, shareText: 'Design before building.', now: 1_700_000_001_000 });
    const cur = lessonsCurrent(readLessonRows(dir));
    assert.equal(cur.get('legacy:a').shareable, true);
    assert.equal(cur.get('legacy:a').shareText, 'Design before building.');
    assert.equal('shareable' in cur.get('legacy:b'), false);
    assert.equal(cur.get('legacy:a').status, 'active');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
