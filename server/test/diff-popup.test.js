// server/test/diff-popup.test.js
// showDiffPopup used to add a fresh window
// keydown listener on every open, only removed by an actual Escape press.
// The diff popup is a shared singleton reused by every lens's file-actions
// row, so repeated opens closed some other way (click-away, the toggle, the
// edit pencil) stacked listeners indefinitely. closeDiffPopup now owns the
// one module-level Escape handler and removes it on every close path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installMiniDom, MiniEvent } from './fixtures/mini-dom.js';

test('showDiffPopup never stacks more than one window keydown listener', async () => {
  const dom = installMiniDom();
  try {
    const { showDiffPopup, closeDiffPopup } = await import('../../web/shared/diff-popup.js');
    const anchor = document.createElement('button');
    document.body.appendChild(anchor);
    const change = { old: null, new: { text: 'x', truncated: false } };

    // Open/close 5 times via closeDiffPopup (the click-away / toggle / edit-
    // pencil path) - never via an actual Escape keypress.
    for (let i = 0; i < 5; i++) {
      showDiffPopup(anchor, { change });
      closeDiffPopup();
    }
    assert.equal(window.listenerCount('keydown'), 0, 'closeDiffPopup must remove the Escape listener on every close');

    // Re-opening without closing first must never stack a second listener.
    showDiffPopup(anchor, { change });
    showDiffPopup(anchor, { change });
    assert.ok(window.listenerCount('keydown') <= 1, `expected at most 1 keydown listener, got ${window.listenerCount('keydown')}`);

    // Escape itself is also a close path and must remove its own listener.
    window.dispatchEvent(new MiniEvent('keydown', { key: 'Escape' }));
    assert.equal(window.listenerCount('keydown'), 0, 'an Escape close must also remove the listener');
  } finally { dom.restore(); }
});
