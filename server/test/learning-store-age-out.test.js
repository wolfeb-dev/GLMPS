// Card glmps-2-0-201: sightings, age-out and reopen-on-recurrence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { upsertGapInto, emptyState, ageOutPending, upsertProposal, applyAction } from '../lib/evaluation/learning-store.js';

const DAY = 86400000;
const gap = { code: 'sleep-poll', severity: 'warn', message: 'm' };
const ctx = (sid) => ({ project: 'D--repo-a', sessionId: sid });

test('upsertGapInto records one sighting per distinct session and a lastSeenTs', () => {
  let s = upsertGapInto(emptyState(), gap, ctx('s1')).state;
  s = upsertGapInto(s, gap, ctx('s1')).state;
  s = upsertGapInto(s, gap, ctx('s2')).state;
  const it = s.items[0];
  assert.deepEqual(it.sightings.map((x) => x.sid), ['s1', 's2']);
  assert.equal(typeof it.lastSeenTs, 'number');
});

test('an applied row keeps its status but still records sightings, so probation can measure it', () => {
  let s = upsertGapInto(emptyState(), gap, ctx('s1')).state;
  s = { ...s, items: s.items.map((i) => ({ ...i, status: 'applied' })) };
  const r = upsertGapInto(s, gap, ctx('s2'));
  assert.equal(r.item.status, 'applied');
  assert.equal(r.changed, true);
  assert.deepEqual(r.item.sightings.map((x) => x.sid), ['s1', 's2']);
});

test('ageOutPending discards a pending gap or GEPA row unseen for 30 days and leaves fresh ones', () => {
  let s = upsertGapInto(emptyState(), gap, ctx('s1')).state;
  s = upsertProposal(s, { title: 't', body: 'b', rule: '- r', sourceItemIds: ['x'], now: Date.now() }).state;
  s = upsertGapInto(s, { ...gap, code: 'reread-loop' }, ctx('s1')).state;
  const old = Date.now() - 31 * DAY;
  s = { ...s, items: s.items.map((i) => (i.code === 'reread-loop' ? i : { ...i, lastSeenTs: old, updatedTs: old })) };
  const r = ageOutPending(s, Date.now());
  assert.equal(r.aged.length, 2);
  const byCode = Object.fromEntries(r.state.items.map((i) => [i.code, i]));
  assert.equal(byCode['sleep-poll'].status, 'discarded');
  assert.equal(byCode['sleep-poll'].discardReason, 'aged-out');
  assert.equal(byCode['gepa-proposal'].status, 'discarded');
  assert.equal(byCode['reread-loop'].status, 'pending');
});

test('ageOutPending never touches an operator idea or a non-pending row', () => {
  const old = Date.now() - 90 * DAY;
  const s = { ...emptyState(), items: [
    { id: 'idea-1', source: 'idea', status: 'pending', updatedTs: old, createdTs: old },
    { id: 'g', source: 'gap', status: 'covered', updatedTs: old, createdTs: old },
  ] };
  assert.equal(ageOutPending(s, Date.now()).aged.length, 0);
});

test('a recurrence resets the clock: the row is not aged out', () => {
  let s = upsertGapInto(emptyState(), gap, ctx('s1')).state;
  const old = Date.now() - 31 * DAY;
  s = { ...s, items: s.items.map((i) => ({ ...i, lastSeenTs: old, updatedTs: old })) };
  s = upsertGapInto(s, gap, ctx('s2')).state;
  assert.equal(ageOutPending(s, Date.now()).aged.length, 0);
});

test('an aged-out gap row reopens as pending on recurrence; a manual discard stays discarded', () => {
  let s = upsertGapInto(emptyState(), gap, ctx('s1')).state;
  s = { ...s, items: s.items.map((i) => ({ ...i, status: 'discarded', discardReason: 'aged-out' })) };
  const r = upsertGapInto(s, gap, ctx('s2'));
  assert.equal(r.item.status, 'pending');
  assert.equal(r.item.discardReason, undefined);
  assert.equal(r.item.count, 1);

  let m = upsertGapInto(emptyState(), gap, ctx('s1')).state;
  m = applyAction(m, m.items[0].id, 'discard').state;
  assert.equal(upsertGapInto(m, gap, ctx('s2')).item.status, 'discarded');
});

test('an aged-out GEPA proposal reopens when GEPA proposes the same rule again', () => {
  let s = upsertProposal(emptyState(), { title: 't', body: 'b', rule: '- r', sourceItemIds: ['x'] }).state;
  s = { ...s, items: s.items.map((i) => ({ ...i, status: 'discarded', discardReason: 'aged-out' })) };
  const r = upsertProposal(s, { title: 't', body: 'b', rule: '- r', sourceItemIds: ['y'] });
  assert.equal(r.item.status, 'pending');
  assert.equal(r.item.discardReason, undefined);
});
