// Tests for SCUT presence (server/lib/scut/presence.js): the  -> ok/x reaction
// lifecycle on the mention message. Fake web injected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makePresence } from '../lib/scut/presence.js';

function fakeWeb() {
  const added = [];
  const removed = [];
  return {
    added, removed,
    reactionsAdd: async (p) => { added.push(p); return { ok: true }; },
    reactionsRemove: async (p) => { removed.push(p); return { ok: true }; },
  };
}
const CTX = { channel: 'C1', ts: '100.1' };

test('receipt adds the eyes reaction to the mention message', async () => {
  const web = fakeWeb();
  await makePresence(web).receipt(CTX);
  assert.deepEqual(web.added, [{ channel: 'C1', timestamp: '100.1', name: 'eyes' }]);
});

test('done removes eyes and adds the check', async () => {
  const web = fakeWeb();
  await makePresence(web).done(CTX);
  assert.deepEqual(web.removed, [{ channel: 'C1', timestamp: '100.1', name: 'eyes' }]);
  assert.equal(web.added[0].name, 'white_check_mark');
});

test('failed removes eyes and adds the x', async () => {
  const web = fakeWeb();
  await makePresence(web).failed(CTX);
  assert.equal(web.removed[0].name, 'eyes');
  assert.equal(web.added[0].name, 'x');
});

test('presence is best-effort: a throwing web never propagates', async () => {
  const web = {
    reactionsAdd: async () => { throw new Error('already_reacted'); },
    reactionsRemove: async () => { throw new Error('no_reaction'); },
  };
  const p = makePresence(web);
  await p.receipt(CTX); // must not throw
  await p.done(CTX);
  await p.failed(CTX);
  assert.ok(true);
});

test('custom emoji set is honored', async () => {
  const web = fakeWeb();
  await makePresence(web, { emoji: { receipt: 'hourglass', done: 'tada', failed: 'boom' } }).receipt(CTX);
  assert.equal(web.added[0].name, 'hourglass');
});
