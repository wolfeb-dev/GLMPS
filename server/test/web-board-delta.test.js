// Card glmps-2-0-runtime-65: the board applies 'backlog' events as card deltas.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBoardDelta } from '../../web/orchestration/board-delta.js';

function rig() {
  const log = { full: 0, ids: [], paints: [] };
  const cards = new Map([['a', { id: 'a', n: 1 }], ['b', { id: 'b', n: 1 }]]);
  const d = createBoardDelta({
    waitMs: 0,
    fetchFull: async () => { log.full++; return { items: [...cards.values()], version: log.version ?? 5, epoch: log.epoch ?? 'e' }; },
    fetchIds: async (ids) => {
      log.ids.push(ids);
      return { items: ids.filter((i) => cards.has(i)).map((i) => cards.get(i)), removed: ids.filter((i) => !cards.has(i)) };
    },
    paint: (items) => log.paints.push(items.map((i) => `${i.id}:${i.n}`).join(',')),
  });
  return { d, log, cards };
}

test('a named change fetches only those cards and merges them', async () => {
  const { d, log, cards } = rig();
  d.seed({ items: [...cards.values()], version: 5, epoch: 'e' });
  cards.set('b', { id: 'b', n: 2 });
  d.onEvent({ type: 'backlog', epoch: 'e', version: 6, prev: 5, ids: ['b'] });
  await d.flush();
  assert.equal(log.full, 0);
  assert.deepEqual(log.ids, [['b']]);
  assert.deepEqual(log.paints, ['a:1,b:2']);
});

test('events in one window share a single card fetch; a removed card leaves the list', async () => {
  const { d, log, cards } = rig();
  d.seed({ items: [...cards.values()], version: 5, epoch: 'e' });
  cards.delete('a');
  d.onEvent({ type: 'backlog', epoch: 'e', version: 6, prev: 5, ids: ['a'] });
  d.onEvent({ type: 'backlog', epoch: 'e', version: 7, prev: 6, ids: ['b'] });
  await d.flush();
  assert.equal(log.ids.length, 1);
  assert.deepEqual([...log.ids[0]].sort(), ['a', 'b']);
  assert.deepEqual(log.paints, ['b:1']);
});

test('an unnamed change or a missed event falls back to one full fetch', async () => {
  const a = rig();
  a.d.seed({ items: [...a.cards.values()], version: 5, epoch: 'e' });
  a.d.onEvent({ type: 'backlog', epoch: 'e', version: 6, prev: 5, ids: null });
  await a.d.flush();
  assert.equal(a.log.full, 1);

  const b = rig();
  b.d.seed({ items: [...b.cards.values()], version: 5, epoch: 'e' });
  b.d.onEvent({ type: 'backlog', epoch: 'e', version: 9, prev: 8, ids: ['a'] });
  await b.d.flush();
  assert.equal(b.log.full, 1);

  const c = rig();
  c.d.onEvent({ type: 'backlog', epoch: 'e', version: 6, prev: 5, ids: ['a'] });
  await c.d.flush();
  assert.equal(c.log.full, 1);
});

test('a ledger-only event repaints without fetching any board data; an already-seen change is skipped', async () => {
  const { d, log, cards } = rig();
  d.seed({ items: [...cards.values()], version: 5, epoch: 'e' });
  d.onEvent({ type: 'backlog', epoch: 'e', version: 5, prev: 5, ids: [] });
  await d.flush();
  assert.equal(log.full + log.ids.length, 0);
  assert.equal(log.paints.length, 1);
  d.onEvent({ type: 'backlog', epoch: 'e', version: 4, prev: 3, ids: ['a'] });
  await d.flush();
  assert.equal(log.paints.length, 1);
});

test('a server restart (new epoch, version back at 2) refetches instead of being skipped as old', async () => {
  const { d, log, cards } = rig();
  log.epoch = 'boot-2'; log.version = 2;
  d.seed({ items: [...cards.values()], version: 50, epoch: 'boot-1' });
  cards.set('b', { id: 'b', n: 9 });
  d.onEvent({ type: 'backlog', epoch: 'boot-2', version: 2, prev: 1, ids: ['b'] });
  await d.flush();
  assert.equal(log.full, 1);
  assert.equal(log.paints.at(-1), 'a:1,b:9');
  d.onEvent({ type: 'backlog', epoch: 'boot-2', version: 3, prev: 2, ids: ['a'] });
  await d.flush();
  assert.equal(log.full, 1);
  assert.equal(log.ids.length, 1);
});
