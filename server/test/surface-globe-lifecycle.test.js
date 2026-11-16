// server/test/surface-globe-lifecycle.test.js
// The globe renders through real d3 7.9.0 (the vendored file), projects the
// centre to the middle of the host, hides the far side, and destroy() leaves
// nothing behind: no timer, no window or host listener, no ResizeObserver.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installMiniDom, loadVendorD3 } from './fixtures/mini-dom.js';

test('createGlobe projects, flies, and cleans up', async () => {
  const dom = installMiniDom({ pathname: '/surface' });
  try {
    const d3 = loadVendorD3();
    const { createGlobe } = await import('../../web/surface/globe.js');
    const host = document.createElement('div'); document.body.appendChild(host);
    const baseWin = window.listenerCount();
    const cams = [];
    const g = createGlobe(host, { d3, topology: null, camera: { lon: -78.4, lat: 37, k: 1 }, onCamera: (c) => cams.push(c) });
    const placed = [];
    g.layerGroup('probe', (project) => placed.push(project([-78.4, 37])));
    g.render();
    const [x, y] = placed.at(-1);
    assert.ok(Math.abs(x - 50) < 1e-6 && Math.abs(y - 10) < 1e-6, `centre projects to the host centre, got ${x},${y}`);
    assert.equal(g.project([101.6, -37]), null, 'the antipode is hidden');
    await g.flyTo({ lon: 0, lat: 0, k: 2 }, 30);
    assert.equal(g.activeTimers(), 0);
    assert.deepEqual(cams.at(-1), { lon: 0, lat: 0, k: 2 });
    g.setAutoRotate(true);
    assert.equal(g.activeTimers(), 1);
    g.destroy();
    assert.equal(g.activeTimers(), 0);
    assert.equal(host.childNodes.length, 0);
    assert.equal(window.listenerCount(), baseWin);
    assert.equal(window._ro ?? 0, 0);
  } finally { dom.restore(); }
});

test('destroy() during an in-flight flyTo resolves the pending promise instead of hanging', async () => {
  const dom = installMiniDom();
  try {
    const d3 = loadVendorD3();
    const { createGlobe } = await import('../../web/surface/globe.js');
    const host = document.createElement('div'); document.body.appendChild(host);
    const g = createGlobe(host, { d3, topology: null, camera: { lon: 0, lat: 0, k: 1 } });
    const flying = g.flyTo({ lon: 60, lat: 30, k: 2 }, 5000); // long enough to still be mid-flight
    assert.equal(g.activeTimers(), 1, 'the fly tween is running');
    g.destroy(); // interrupts mid-flight via stopFly()
    const TIMEOUT = Symbol('timeout');
    const winner = await Promise.race([
      flying.then(() => 'resolved'),
      new Promise((resolve) => setTimeout(() => resolve(TIMEOUT), 500)),
    ]);
    assert.equal(winner, 'resolved', 'an in-flight flyTo must resolve on destroy(), not hang its caller');
  } finally { dom.restore(); }
});

test('reduced motion: flyTo is instant', async () => {
  const dom = installMiniDom();
  try {
    const d3 = loadVendorD3();
    const { createGlobe } = await import('../../web/surface/globe.js');
    const host = document.createElement('div'); document.body.appendChild(host);
    const g = createGlobe(host, { d3, topology: null, reducedMotion: true });
    await g.flyTo({ lon: 10, lat: 10, k: 3 }, 900);
    assert.deepEqual(g.getCamera(), { lon: 10, lat: 10, k: 3 });
    assert.equal(g.activeTimers(), 0);
    g.destroy();
  } finally { dom.restore(); }
});
