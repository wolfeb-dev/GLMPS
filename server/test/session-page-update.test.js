// server/test/session-page-update.test.js
// the session page's onEvent filtered on the mount-time
// route.sessionId, so after update() moved it to another session the live
// feed froze (B's events were dropped, A's still forwarded).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installMiniDom } from './fixtures/mini-dom.js';

test('W-I2: after update() from session A to B, B\'s events reach the page and A\'s do not', async () => {
  const dom = installMiniDom({ pathname: '/session/A' });
  let handle;
  try {
    globalThis.fetch = async () => Response.json({ events: [], contextNow: [] });
    const page = await import('../../web/shared/session-page.js');
    const root = document.createElement('div'); document.body.appendChild(root);
    const ctx = { getState: () => ({ sessions: [] }), handlers: { onOpenFile() {}, onCopy() {}, onOpenMap() {} } };
    handle = await page.mount(root, { lens: 'session', sessionId: 'A' }, ctx);
    await handle.update({ lens: 'session', sessionId: 'B' });
    const seen = [];
    const onEv = (e) => seen.push(e.detail.sessionId);
    window.addEventListener('mc-events', onEv);
    handle.onEvent({ type: 'events', sessionId: 'B' });
    handle.onEvent({ type: 'events', sessionId: 'A' });
    window.removeEventListener('mc-events', onEv);
    assert.deepEqual(seen, ['B']);
  } finally { handle?.unmount(); delete globalThis.fetch; dom.restore(); }
});
