// glmps-2-0-84 AC-2: right-hand panels never paint over each other. Since card
// glmps-2-0-137 phase 2 the panel stack is one context drawer that shows one
// view at a time, so nothing is evicted behind the operator's back. The column clips, each panel clips its own
// body, and panel chrome never shrinks, so a squeezed column takes height from
// bodies, not heads. Measured live in headless Chrome for the fix; this pins
// the rules that geometry depends on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installMiniDom } from './fixtures/mini-dom.js';

const CSS = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'surface', 'surface.css'), 'utf8').replace(/\r\n/g, '\n');

function rule(selector) {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = CSS.match(new RegExp(`(?:^|\\n|,\\s*)${esc}\\s*(?:,[^{]*)?\\{([^}]*)\\}`));
  return m ? m[1] : null;
}

test('AC-2: the panel column and each panel clip their own content', () => {
  assert.match(rule('.surface-side') ?? '', /overflow:\s*hidden/);
  assert.match(rule('.surface-side .surface-panel') ?? '', /overflow:\s*hidden/);
});

test('AC-2: panel heads and footers never shrink, so a squeezed column cannot cover them', () => {
  for (const sel of ['.surface-side .surface-panel-head', '.surface-side .dock-sub', '.surface-side .panel-foot']) {
    assert.match(rule(sel) ?? '', /flex:\s*none/, `${sel} keeps its height`);
  }
  assert.match(rule('.surface-side > .surface-panel.is-folded') ?? '', /flex:\s*none/, 'a folded dock keeps its header');
});

test('AC-2: the drawer keeps a minimum height instead of collapsing under the docks', () => {
  assert.match(rule('.surface-drawer') ?? '', /min-height:\s*min\(96px,\s*100%\)/);
});

test('the drawer shows one view at a time: opening another replaces it, one block in the column', async () => {
  const dom = installMiniDom();
  try {
    const { createDrawer } = await import('../../web/surface/drawer.js');
    const box = document.createElement('div');
    const closed = [];
    const d = createDrawer(box, { tabs: [{ id: 'attention', label: 'Alerts' }, { id: 'repos', label: 'Repo inspector' }, { id: 'declared', label: 'Policy bounds' }], onClose: (id) => closed.push(id) });
    for (const id of ['inspector', 'declared', 'repos', 'attention']) d.open(id, id, (b) => { b.appendChild(document.createTextNode(`body ${id}`)); });
    assert.deepEqual(d.ids(), ['attention']);
    assert.deepEqual(closed, ['inspector', 'declared', 'repos'], 'each view that was replaced is reported closed');
    assert.equal(box.querySelectorAll('.surface-drawer').length, 1);
    assert.doesNotMatch(d.el.textContent, /body repos/, 'a replaced view leaves no content behind');
    d.close();
    assert.equal(d.el.hidden, true);
    assert.deepEqual(d.ids(), []);
  } finally { dom.restore(); }
});
