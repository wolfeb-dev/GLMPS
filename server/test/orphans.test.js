import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectOrphans, orphanPost, hostsReadyToClose, HOST_READY_TEXT } from '../lib/orchestration/orphans.js';

// glmps-2-0-171 D3 and D4: pure selectors for the host notice and the daily orphan post.
const NOW = Date.parse('2026-11-10T16:00:00.000Z');
const ago = (h) => new Date(NOW - h * 3600_000).toISOString();
const card = (id, extra = {}) => ({ id, title: `t ${id}`, state: 'held', updatedAt: ago(30), devLog: [], ...extra });
const pick = (items, extra = {}) => selectOrphans({ items, now: NOW, ...extra }).map((o) => o.id);

test('a held, idle or queued card with no open host, quiet 24h, is an orphan', () => {
  const items = [card('a-1'), card('a-2', { state: 'idle' }), card('a-3', { state: 'queued' }), card('a-4', { state: 'in_progress' }), card('a-5', { state: 'done' })];
  assert.deepEqual(pick(items).sort(), ['a-1', 'a-2', 'a-3']);
});

test('a card with an open host, a recent touch, a quarantine, a live session or an open park is not an orphan', () => {
  const items = [
    card('host-1', { state: 'in_progress', updatedAt: ago(1) }),
    card('kid-1', { parentId: 'host-1' }),
    card('fresh-1', { updatedAt: ago(23) }),
    card('q-1', { quarantined: true }),
    card('live-1'),
    card('park-1'),
    card('edge-1', { updatedAt: ago(24) }),
  ];
  assert.deepEqual(pick(items, { live: ['live-1'], parked: ['park-1'] }), ['edge-1']);
});

test('a card whose parent is closed or missing is an orphan', () => {
  const items = [card('p-1', { state: 'done' }), card('k-1', { parentId: 'p-1' }), card('k-2', { parentId: 'gone-9' })];
  assert.deepEqual(pick(items).sort(), ['k-1', 'k-2']);
});

test('an explicit headless card with no open host is listed whatever its age or state', () => {
  const items = [
    card('h-1', { mode: 'headless', state: 'in_progress', updatedAt: ago(0.1) }),
    card('h-2', { mode: 'headless', state: 'done' }),
    card('host-1', { state: 'in_progress', updatedAt: ago(1) }),
    card('h-3', { mode: 'headless', state: 'in_progress', updatedAt: ago(0.1), parentId: 'host-1' }),
  ];
  const out = selectOrphans({ items, now: NOW });
  assert.deepEqual(out.map((o) => o.id), ['h-1']);
  assert.equal(out[0].headless, true);
});

test('orphanPost lists id, title, state, the last devlog trimmed to 120 chars and the replies; caps at 20 with a count', () => {
  const long = 'x'.repeat(300);
  const items = Array.from({ length: 23 }, (_, n) => card(`c-${n + 1}`, { devLog: [{ text: 'first' }, { text: long }] }));
  const out = selectOrphans({ items, now: NOW });
  const text = orphanPost(out);
  const lines = text.split('\n');
  assert.match(lines[0], /23 cards/);
  const row = lines.find((l) => l.includes('c-1 '));
  assert.ok(row.includes('t c-1') && row.includes('held'));
  assert.ok(row.includes('x'.repeat(117) + '...') && !row.includes('x'.repeat(118)));
  assert.ok(row.includes('run c-1') && row.includes('drop c-1'));
  assert.equal(lines.filter((l) => /run c-\d+/.test(l)).length, 20);
  assert.match(text, /and 3 more/);
});

test('hostsReadyToClose: an open host whose children are all closed gets one notice per child set', () => {
  const items = [
    card('h-1', { state: 'in_progress' }),
    card('c-1', { parentId: 'h-1', state: 'done' }),
    card('c-2', { parentId: 'h-1', state: 'cancelled' }),
    card('h-2', { state: 'in_progress' }),
    card('d-1', { parentId: 'h-2', state: 'done' }),
    card('d-2', { parentId: 'h-2', state: 'held' }),
    card('h-3', { state: 'done' }),
    card('e-1', { parentId: 'h-3', state: 'done' }),
    card('h-4', { state: 'in_progress' }),
  ];
  const out = hostsReadyToClose(items);
  assert.deepEqual(out.map((o) => o.id), ['h-1']);
  assert.equal(out[0].text, `${HOST_READY_TEXT} (c-1, c-2)`);
  items[0].devLog = [{ text: out[0].text }];
  assert.deepEqual(hostsReadyToClose(items), []);
});
