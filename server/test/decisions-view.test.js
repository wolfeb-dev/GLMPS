// server/test/decisions-view.test.js
// the whole-row bindItem (dl-entry--open)
// and the pre-existing "Show more" button (is-open) were two independently
// toggled classes, and the button's click bubbled into the row's own click
// handler - one click on "Show more" flipped both, leaving the button's own
// label/aria-expanded out of sync with the only class the CSS actually reads
// (dl-entry--open; the #view-decisions-scoped is-open rules are dead - that
// scope is unreachable now renderDecisions is also embedded in the Surface
// panel). Adapted from the reviewer's reproduction (decisions-desync.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installMiniDom } from './fixtures/mini-dom.js';

test('a decision row click and the Show more button drive one state, never desync', async () => {
  const dom = installMiniDom();
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({
      json: async () => ({
        entries: [{ repo: 'glmps', commit: 'abc1234def', what: 'x', why: 'y'.repeat(200), ts: 1 }],
        repos: ['glmps'],
      }),
    });
    const { renderDecisions } = await import('../../web/observability/decisions.js');
    const container = document.createElement('div');
    document.body.appendChild(container);
    await renderDecisions(container);
    await new Promise((r) => setTimeout(r, 10));
    const row = container.querySelector('.dl-entry');
    assert.ok(row, 'a decision row rendered');
    const btn = row.querySelector('.dl-more');
    assert.ok(btn, 'the Show more button rendered (why > 140 chars)');
    const head = row.querySelector('.dl-entry-head');
    assert.ok(head, 'the entry head rendered');

    // Baseline: collapsed.
    assert.equal(row.classList.contains('dl-entry--open'), false);
    assert.equal(btn.textContent, 'Show more');
    assert.equal(btn.getAttribute('aria-expanded'), 'false');

    // Step 1: click somewhere on the row OTHER than the button (the head).
    // This is bindItem's own row-level activation.
    head.click();
    assert.equal(row.classList.contains('dl-entry--open'), true, 'row click opens dl-entry--open (drives the actual CSS clamp in the Surface panel)');
    assert.equal(btn.textContent, 'Show less', 'the button label follows the same state a row click set, not just its own clicks');
    assert.equal(btn.getAttribute('aria-expanded'), 'true');

    // Step 2: click the Show more(/Less) button itself. One click, one
    // toggle - the button's own handler must not let the click also bubble
    // into the row's separate toggle.
    btn.click();
    assert.equal(row.classList.contains('dl-entry--open'), false, 'the button click toggles the same state back off');
    assert.equal(btn.textContent, 'Show more', 'label matches the now-collapsed state');
    assert.equal(btn.getAttribute('aria-expanded'), 'false');

    // Step 3: click the button again - back to expanded, still in sync.
    btn.click();
    assert.equal(row.classList.contains('dl-entry--open'), true);
    assert.equal(btn.textContent, 'Show less');
    assert.equal(btn.getAttribute('aria-expanded'), 'true');

    // is-open must be gone entirely - one state, not two.
    assert.equal(row.classList.contains('is-open'), false, 'is-open is retired; dl-entry--open is the only toggle now');
  } finally { globalThis.fetch = realFetch; dom.restore(); }
});
