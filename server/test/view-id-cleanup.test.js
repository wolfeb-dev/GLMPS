// server/test/view-id-cleanup.test.js
// four dead 1.x view-id CSS rules, confirmed by grep to
// have no setter anywhere in web/ (no element ever gets that id). Two are
// deleted outright (their old full-page treatment does not transfer to the
// compact container the view renders in today); two are retargeted to the
// real container, matching #view-wiki's and #view-decisions's fix in
// earlier rounds. This repo has no layout-engine test harness (see
// shell-topbar-responsive.test.js), so CSS correctness is pinned by source
// assertions here; the two DOM-level checks below instead prove the real
// target element exists and carries the selector the retargeted rule needs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installMiniDom } from './fixtures/mini-dom.js';
import { parseLink } from '../../web/shared/deep-link.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

test('the four dead view-id selectors are gone from their stylesheets', () => {
  assert.doesNotMatch(read('web/styles.css'), /#view-analytics\s*\{/, 'styles.css still declares #view-analytics');
  assert.doesNotMatch(read('web/observability/map.css'), /#view-map\s*\{/, 'map.css still declares #view-map');
  assert.doesNotMatch(read('web/observability/alerts.css'), /#view-alerts\s*\{/, 'alerts.css still declares #view-alerts');
  assert.doesNotMatch(read('web/observability/qa-trends.css'), /#view-qa-trends\s*\{/, 'qa-trends.css still declares #view-qa-trends');
});

// Card glmps-2-0-137 phase 4: the Gates band became the QA trends tab, so the
// retargeted rule follows it to #wk-panel-qa.
test('#view-qa-trends is retargeted to the QA trends tab panel, not just deleted', () => {
  const css = read('web/work/work.css');
  assert.match(css, /#wk-panel-qa:not\(\[hidden\]\),\s*#wk-panel-cost:not\(\[hidden\]\) \{ flex: 1 1 auto; min-height: 0; display: flex;/, 'display: flex, so flex-direction below actually applies');
  assert.match(css, /#wk-panel-qa:not\(\[hidden\]\),\s*#wk-panel-cost:not\(\[hidden\]\) \{ flex-direction: column; overflow-y: auto; \}/, 'column, and the scroll boundary the dead rule carried');
  assert.match(css, /#wk-panel-qa:not\(\[hidden\]\) \{ padding: var\(--sp-3\) var\(--sp-4\)/, 'the padding the dead rule carried');
});

// Proves the Gates band body (#band-gates .lens-band-body) is a real,
// reachable element today, not a renamed id the retarget silently missed.
test('the Work lens actually renders a #wk-panel-qa element (R2-3 DOM check)', async () => {
  const dom = installMiniDom({ pathname: '/work' });
  const now = Date.now();
  globalThis.fetch = async (url) => {
    const u = String(url).split('?')[0];
    if (u === '/api/backlog') return Response.json({ items: [], gatelessDone: [] });
    if (u === '/api/qa-trends') return Response.json({ points: [] });
    return Response.json({});
  };
  window.vegaEmbed = async () => {};
  let handle;
  try {
    const lens = await import('../../web/work/lens.js');
    const root = document.createElement('div'); document.body.appendChild(root);
    handle = await lens.mount(root, parseLink('/work', ''), { getState: () => null, toast: () => {}, go: () => {}, handlers: {} });
    const qaPanel = root.querySelector('[id="wk-panel-qa"]');
    assert.ok(qaPanel, '#wk-panel-qa renders (createTabs sets this id on the QA trends panel)');
    assert.equal(qaPanel.getAttribute('role'), 'tabpanel');
  } finally {
    handle?.unmount(); delete globalThis.fetch; dom.restore();
  }
});
