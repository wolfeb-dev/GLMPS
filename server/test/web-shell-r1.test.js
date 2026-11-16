// server/test/web-shell-r1.test.js
// Round 2 fidelity, R1 AC-1: the flat 52 px top bar, a 2 px blue underline on
// the current lens, one status cluster, a #topbar-slot for a lens to fill, and
// the links on a bottom bar at 560 px and below. Source assertions, like
// shell-topbar-responsive.test.js (this repo has no layout engine in tests).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installMiniDom } from './fixtures/mini-dom.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const css = read('web/styles.css');
const rule = (sel, src = css) => {
  const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return src.match(new RegExp(`(?:^|\\n)${esc} \\{[^{}]*\\}`))?.[0] ?? '';
};

test('AC-1 (amended by glmps-2-0-137): the shell search, then an empty #topbar-slot, sit between the nav and the status cluster', () => {
  const html = read('web/index.html');
  assert.match(html, /<\/nav>\s*<div id="topbar-search"><\/div>\s*<div id="topbar-slot"><\/div>\s*<div id="topbar-tools">/);
});

test('AC-1: #topbar is the flat bar, 52 px, full width, ground token, bottom border, no margin or radius', () => {
  const r = rule('#topbar');
  assert.ok(r, '#topbar rule found');
  assert.match(r, /height: 52px/);
  assert.match(r, /background: var\(--bar\)/);
  assert.match(r, /border-bottom: 1px solid var\(--border\)/);
  assert.doesNotMatch(r, /border-radius|margin:|backdrop-filter/, 'the floating pill is gone (a backdrop-filter would also trap the fixed bottom nav)');
});

const tokenCss = read('web/shared/tokens.css');

test('AC-1: --bar is a role defined for dark and both light sets', () => {
  assert.match(tokenCss, /--bar:\s+#08141f;/);
  assert.equal([...tokenCss.matchAll(/--bar:/g)].length, 3, 'dark, light override and OS light');
});

test('AC-1: the current lens carries a 2 px underline in the interactive blue, not teal', () => {
  const r = rule('.lens-link.active');
  assert.match(r, /box-shadow: inset 0 -2px 0 var\(--info\)/);
  assert.doesNotMatch(r, /--primary|rgba\(15, 164, 175/, 'teal selection is retired');
});

test('AC-1: at 560 px and below the links sit in a bottom bar and the top bar is at most 56 px', () => {
  const m = css.match(/@media \(max-width: 560px\) \{\n  \/\* Narrow screens[\s\S]*?\n\}\n/);
  assert.ok(m, 'the shared narrow-screen block is found');
  const block = m[0];
  assert.match(block, /#topbar nav \{[^}]*position: fixed[^}]*bottom: 0/);
  const bar = block.match(/#topbar \{[^}]*\}/)?.[0] ?? '';
  const h = Number(bar.match(/height: (\d+)px/)?.[1]);
  assert.ok(h > 0 && h <= 56, `top bar height ${h}`);
  assert.match(block, /\.lens-link \{[^}]*min-height: 44px/);
});

test('AC-1 (amended by glmps-2-0-106): the status cluster shows live and usage, with no critical pill; the lens slot stays', () => {
  const js = read('web/app.js');
  assert.doesNotMatch(js, /stat-crit/);
  assert.match(js, /getSlot: \(\) => document\.getElementById\('topbar-slot'\)/);
});

test('AC-1: no raw hex outside token definitions was added to the shell sheets', async () => {
  const { compare, scan, loadBaseline } = await import('../../scripts/css-hex-gate.mjs');
  assert.deepEqual(compare(scan(), loadBaseline()), []);
});

