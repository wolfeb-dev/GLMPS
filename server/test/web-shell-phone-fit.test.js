import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (p) => fs.readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const phoneBlocks = (css) => [...css.matchAll(/@media \(max-width: 560px\) \{([\s\S]*?)\n\}|@media \(max-width: 560px\) \{([^\n]*)\}/g)].map((m) => m[1] ?? m[2]).join('\n');

// At 390 px the cluster (live, critical, New terminal, settings, bell) needed
// about 400 px and the Surface search spilled over it (glmps-2-0-63).
test('the top bar carries no critical chip and no bell on any width: alerts live in the Surface Alerts dock (glmps-2-0-106)', () => {
  assert.doesNotMatch(read('web/styles.css'), /stat-crit|\.alert-btn/);
  assert.doesNotMatch(read('web/app.js'), /stat-crit|mountAlerts/);
});

test('on a phone the terminal launcher is icon-only and keeps its name', () => {
  assert.match(phoneBlocks(read('web/styles.css')), /\.term-launch-label, \.term-launch-btn \.term-caret \{ display: none; \}/);
  const js = read('web/shared/launcher.js');
  assert.match(js, /btnLabel\.className = 'term-launch-label'/);
  assert.match(js, /btn\.setAttribute\('aria-label', 'New terminal'\)/);
});

test('a lens control in the top bar slot, and the shell search, shrink to the room left', () => {
  const css = read('web/styles.css');
  assert.match(css, /#topbar-slot > \* \{ flex: 1 1 auto; min-width: 0; \}/);
  assert.match(css, /#topbar-search \{ flex: 1 1 0; min-width: 0;/);
  assert.match(css, /#topbar-search > \* \{ flex: 1 1 auto; min-width: 0; \}/);
});

test('on a phone the shell search and pillar sub-tabs keep 44px targets', () => {
  assert.match(phoneBlocks(read('web/styles.css')), /\.shell-search \.surface-search-input, \.shell-search \.sr-opt, \.pillar-tabs-tab \{ min-height: 44px; \}/);
});

// The shell search's label is visually hidden on every pillar, so the class
// lives in the shell sheet, not only in Surface's (card glmps-2-0-137).
test('the visually-hidden class is defined in the shell sheet', () => {
  assert.match(read('web/styles.css'), /\n\.sr-only \{ position: absolute; width: 1px; height: 1px;/);
});
