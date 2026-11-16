// server/test/web-shell-p3.test.js
// P3 (card glmps-2-0-53): Surface tokens, Fleet pin, one status cluster,
// count badges, no tools strip / aurora. Source-text assertions, the same
// pattern as shell-topbar-responsive.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// A Windows checkout (core.autocrlf) has CRLF; the block matches below assume LF.
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
// the dark token set is shared by :root and the subtrees that stay dark in light mode.
const rootBlock = (css) => css.match(/:root,\n\.surface-root[^{]*\{[\s\S]*?\n\}/)[0];
const tokenOf = (block, name) => block.match(new RegExp(`${name}:\s*([^;]+);`))?.[1].trim();

test('AC-1: :root carries the Surface palette with four distinct status colours', () => {
  const root = rootBlock(read('web/shared/tokens.css'));
  assert.equal(tokenOf(root, '--bg'), '#05070c');
  assert.equal(tokenOf(root, '--fg'), '#dbeaf2');
  assert.match(tokenOf(root, '--card'), /^rgba\(8, 20, 32, 0\.82\)/);
  assert.match(tokenOf(root, '--border'), /^rgba\(94, 168, 214, 0\.34\)/);
  assert.equal(tokenOf(root, '--muted-fg'), '#8fb0c2');
  assert.equal(tokenOf(root, '--primary'), '#3d8bff');
  const status = ['--success', '--info', '--warning', '--destructive'].map((n) => tokenOf(root, n));
  assert.deepEqual(status.slice(0, 4), ['#3ddc84', '#3d8bff', '#f5a524', '#ff5b5b']);
  assert.equal(new Set(status).size, 4);
});

test('AC-2: #view-stageboard pins the old root values', () => {
  const css = read('web/overview/stage-board.css');
  const pin = css.match(/#view-stageboard \{[\s\S]*?\n\}/)[0];
  assert.ok(css.indexOf(pin) < 1200, 'the pin sits at the top of the file');
  // Round 3 (glmps-2-0-63): the teal entries were dropped so the board follows the blue palette.
  const old = { '--bg': '#0a0b0d', '--warning': '#e0a23a', '--destructive': '#964734' };
  for (const [k, v] of Object.entries(old)) assert.equal(tokenOf(pin, k), v, k);
  for (const k of ['--fg', '--card', '--border', '--success', '--primary']) assert.equal(tokenOf(pin, k), undefined, `${k} is inherited`);
});

test('AC-3/4: status cluster, labelled usage, count badges from backlog counts', () => {
  const js = read('web/app.js');
  assert.match(js, /5h \$\{fmt\(h5\)\} \/ 7d \$\{fmt\(d7\)\}/);
  assert.doesNotMatch(js, /severity === 'critical'/, 'the bell carries the critical count (Q1 AC-4)');
  assert.match(js, /mc-alerts-refresh/);
  assert.doesNotMatch(js, /usage-nav-badge/);
  assert.doesNotMatch(js, /nav-item-dot/);
  assert.match(js, /getBacklogCounts\(\)/);
  assert.doesNotMatch(js, /fetch\('\/api\/backlog'\)/);
  assert.match(js, /\(c\.queued \?\? 0\) \+ \(c\.held \?\? 0\)/);
});

test('AC-5: the launcher is not awaited before the first state render', () => {
  const js = read('web/app.js');
  assert.doesNotMatch(js, /await mountLauncher/);
  assert.match(js, /mountLauncher\(launcherSlot\)\.catch/);
});

test('AC-6: no tools strip, no aurora, dock is in flow', () => {
  const html = read('web/index.html');
  const css = read('web/styles.css');
  const js = read('web/app.js');
  assert.doesNotMatch(html, /tools-strip|aurora/);
  assert.doesNotMatch(css, /tools-strip|aurora/);
  assert.doesNotMatch(js, /renderToolsStrip|tools-strip/);
  assert.doesNotMatch(css.match(/\.dock-root \{[^}]*\}/)[0], /position: fixed/);
});
