// UI round 3 (glmps-2-0-63) R3-3: the camera presets live in the Layers panel
// (Fly to), above the data layers. The floating preset bar is gone. The View
// section (Normal, Heat, Drift, Focus) that sat above Fly to was retired by
// glmps-2-0-106.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installMiniDom } from './fixtures/mini-dom.js';
import { mountSurface } from './fixtures/surface-fixtures.js';

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const run = async (search, fn) => {
  const dom = installMiniDom({ pathname: '/surface', search });
  let handle;
  try {
    const m = await mountSurface(search);
    handle = m.handle;
    await tick();
    await fn(m);
  } finally { handle?.unmount(); delete globalThis.fetch; delete window.d3; dom.restore(); }
};

test('R3-3: Fly to is the first section of the Layers panel, and there is no View section', async () => {
  await run('', ({ root }) => {
    const dock = root.querySelector('#dock-layers');
    const groups = dock.querySelectorAll('.layer-group');
    assert.deepEqual(groups.slice(0, 2).map((g) => g.querySelector('h3').textContent), ['Fly to', 'Data']);
    assert.equal(groups[0].getAttribute('role'), 'group');
    assert.equal(groups[0].getAttribute('aria-labelledby'), groups[0].querySelector('h3').id);
    assert.equal(root.querySelectorAll('.surface-styles').length, 0);
    assert.equal(root.querySelectorAll('.style-btn').length, 0);
  });
});

test('R3-3: the floating preset bar is gone from the stage', async () => {
  await run('', ({ root }) => {
    const stage = root.querySelector('.surface-stage');
    const dock = root.querySelector('#dock-layers');
    assert.equal(stage.querySelectorAll('.surface-presets').length, 1, 'exactly one .surface-presets');
    assert.equal(dock.querySelectorAll('.surface-presets').length, 1, 'and it is inside the Layers panel');
  });
});

test('R3-3: Fly to lists the nine presets and a click flies and presses the button', async () => {
  await run('', async ({ root }) => {
    const fly = root.querySelector('.surface-presets');
    const names = fly.querySelectorAll('button').map((b) => b.textContent);
    assert.deepEqual(names, ['Players', 'Local store', 'File tree', 'Agents', 'Kanban', 'Loops', 'Alerts', 'GitHub', 'Global']);
    const global = fly.querySelectorAll('button').find((b) => b.textContent === 'Global');
    global.click();
    await tick(1600);
    assert.equal(global.getAttribute('aria-pressed'), 'true');
  });
});
