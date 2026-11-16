// UI round 3 (glmps-2-0-63) R3-2: the Fleet board tiles keep their value and delta but
// no longer draw a spark. Card glmps-2-0-137 phase 2 retired the Pulse panel
// that drew them, and the Active tile with it (the live count is the topbar's),
// so the delta is pinned on the Uncommitted tile.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installMiniDom } from './fixtures/mini-dom.js';
import { waitFor } from './helpers/wait-for.js';

const HOUR = 60 * 60_000;
const NOW = Date.now();
const points = [
  { ts: NOW - HOUR - 30_000, active: 1, uncommitted: 2, budgetPct: 40, queued: 3 },
  { ts: NOW - 30 * 60_000, active: 2, uncommitted: 2, budgetPct: 45, queued: 3 },
  { ts: NOW, active: 4, uncommitted: 5, budgetPct: 52, queued: 3 },
];
const routes = {
  '/api/vitals-trends?window=2h': { points },
  '/api/qa-trends': { points: [{ source: 'ci', conclusion: 'success', testCount: 120, fail: 0 }, { source: 'ci', conclusion: 'success', testCount: 130, fail: 0 }] },
  '/api/budget': { usage: { fiveHour: { usedPercent: 52, resetsAt: NOW + HOUR } }, meta: {} },
  '/api/alerts': { alerts: [] },
  '/api/backlog?counts=1': { counts: { queued: 3 } },
};

test('R3-2: the Fleet board tiles show a delta chip and draw no spark', async () => {
  const dom = installMiniDom({ pathname: '/surface' });
  globalThis.fetch = async (url) => (routes[String(url)] ? Response.json(routes[String(url)]) : Response.json({}));
  let sb;
  try {
    sb = await import('../../web/overview/stage-board.js');
    const host = document.createElement('div');
    document.body.appendChild(host);
    sb.renderStageBoard(host, {});
    assert.equal(host.querySelector('#sb-vtile-active'), null, 'no Active tile');
    const chip = host.querySelector('#sb-vtile-uncommitted').querySelector('.sb-vt-delta');
    await waitFor(() => !chip.classList.contains('sb-vt-delta--empty'), { message: 'the Uncommitted delta chip' });
    assert.ok(!chip.classList.contains('sb-vt-delta--empty'), 'the Uncommitted tile shows its delta');
    assert.equal(chip.querySelector('.sb-vt-delta-num').textContent, '+3');
    assert.equal(host.querySelector('.sb-vitals').querySelectorAll('svg').length, 0, 'no tile holds a spark');
    assert.equal(host.querySelectorAll('.sb-vt-aside').length, 0, 'and no spark slot is reserved');
  } finally {
    sb?.unmountStageBoard();
    delete globalThis.fetch;
    dom.restore();
  }
});
