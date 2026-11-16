// server/test/web-launcher-open-target.test.js
// Card glmps-2-0-runtime-90 put the "Open files in" picker in the New terminal
// menu. Phase 6 of the HCI/IA redesign moved it to Settings > General (see
// web-settings-modal.test.js), so the launcher must no longer carry it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installMiniDom } from './fixtures/mini-dom.js';

const CONFIG = { terminals: [{ label: 'Claude', icon: 'claude' }], projectRoots: [] };

test('the New terminal menu does not carry Open files in', async () => {
  const dom = installMiniDom({ pathname: '/' });
  const fetched = [];
  globalThis.fetch = async (url) => {
    const u = String(url).split('?')[0];
    fetched.push(u);
    if (u === '/api/config') return Response.json(CONFIG);
    return Response.json({});
  };
  try {
    const { mountLauncher } = await import('../../web/shared/launcher.js');
    const bar = document.createElement('div'); document.body.appendChild(bar);
    await mountLauncher(bar);
    bar.querySelector('.term-launch-btn').click();
    assert.equal(bar.querySelector('select[aria-label="Open files in"]'), null);
    assert.ok(!bar.textContent.includes('Open files in'));
    assert.ok(!fetched.includes('/api/runner'), 'the launcher no longer reads the runner config');
  } finally { delete globalThis.fetch; dom.restore(); }
});
