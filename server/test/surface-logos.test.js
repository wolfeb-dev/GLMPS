// Modules under test: web/surface/logos/index.js and the players layer in web/surface/layers.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { installMiniDom } from './fixtures/mini-dom.js';
import { mountSurface } from './fixtures/surface-fixtures.js';
import { LOGOS, hasLogo } from '../../web/surface/logos/index.js';

test('every place has a glyph, and each brand path is the pinned simple-icons drawing', () => {
  for (const id of ['local', 'github', 'slack', 'anthropic', 'gcp']) assert.equal(hasLogo(id), true, id);
  assert.equal(hasLogo('openai'), false);
  const prov = fs.readFileSync(new URL('../../web/surface/logos/PROVENANCE.txt', import.meta.url), 'utf8');
  assert.match(prov, /simple-icons[\s\S]*15\.22\.0/);
  assert.match(prov, /CC0-1\.0/);
  // GitHub's mark starts with the octocat circle path the package ships.
  assert.match(LOGOS.github.d, /^M12 \.297c-6\.63/);
});

test('a place is drawn as its logo, named by aria-label and title, with no text label', async () => {
  const dom = installMiniDom({ pathname: '/surface' });
  try {
    const { root, handle } = await mountSurface('');
    const marks = root.querySelectorAll('.player');
    assert.equal(marks.length, 5);
    for (const m of marks) {
      const id = m.dataset.itemId;
      assert.ok(m.querySelector('.logo-glyph'), `${id} has a logo glyph`);
      assert.equal(m.querySelector('.lbl'), null, `${id} has no text label for the collision pass to hide`);
      assert.match(m.getAttribute('aria-label'), /evidence/, `${id} keeps its accessible name`);
      assert.ok(m.querySelector('title')?.textContent.length > 3, `${id} keeps a hover title`);
    }
    const name = (id) => marks.find((m) => m.dataset.itemId === id).getAttribute('aria-label');
    assert.match(name('github'), /^GitHub/);
    assert.match(name('slack'), /^Slack/);
    assert.match(name('anthropic'), /^Anthropic/);
    assert.match(name('gcp'), /^Gemini and Antigravity/);
    assert.match(name('local'), /^Local store/);
    handle.unmount();
  } finally { delete globalThis.fetch; delete window.d3; dom.restore(); }
});

test('the three Virginia places do not overlap at the default camera', async () => {
  const dom = installMiniDom({ pathname: '/surface' });
  try {
    const { root, handle } = await mountSurface('');
    const at = (id) => {
      const m = root.querySelectorAll('.player').find((x) => x.dataset.itemId === id);
      const t = (m.getAttribute('transform') ?? '').match(/translate\(([-\d.]+),([-\d.]+)\)/);
      return t ? [Number(t[1]), Number(t[2])] : null;
    };
    const pts = ['github', 'slack', 'anthropic'].map(at).filter(Boolean);
    assert.ok(pts.length >= 2, 'at least two of the three are on the near side to compare');
    for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) assert.ok(Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1]) >= 30, 'plates are 30 px across');
    handle.unmount();
  } finally { delete globalThis.fetch; delete window.d3; dom.restore(); }
});
