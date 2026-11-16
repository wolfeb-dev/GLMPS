// UI round 3 (glmps-2-0-63) R3-5: the shell is blue, not teal. Source-text
// assertions over the token blocks and the Fleet board, Now and Surface styles.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const CSS = read('web/shared/tokens.css');

const tokens = (block, name) => [...block.matchAll(new RegExp(`${name}:\\s*([^;]+);`, 'g'))].map((m) => m[1].trim());
const darkBlock = CSS.match(/:root,\n\.surface-root[^{]*\{[\s\S]*?\n\}/)[0];
const lightBlock = CSS.match(/:root\[data-theme="light"\] \{[\s\S]*?\n\}/)[0];
const osLightBlock = CSS.match(/@media \(prefers-color-scheme: light\) \{\n  :root:not\(\[data-theme="dark"\]\) \{[\s\S]*?\n  \}/)[0];

const lum = (hex) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const ratio = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };

test('R3-5: dark --primary is #3d8bff and --teal follows it', () => {
  assert.deepEqual(tokens(darkBlock, '--primary'), ['#3d8bff']);
  assert.deepEqual(tokens(darkBlock, '--teal'), ['#3d8bff']);
  assert.deepEqual(tokens(darkBlock, '--primary-rgb'), ['61, 139, 255']);
});

test('R3-5: light --primary is #1d58c9 in the attribute block and the OS block', () => {
  for (const block of [lightBlock, osLightBlock]) {
    assert.deepEqual(tokens(block, '--primary'), ['#1d58c9']);
    assert.deepEqual(tokens(block, '--teal'), ['#1d58c9']);
    assert.deepEqual(tokens(block, '--primary-rgb'), ['29, 88, 201']);
  }
});

test('R3-5: text on the primary fill keeps AA contrast in both themes', () => {
  assert.ok(ratio('#3d8bff', tokens(darkBlock, '--on-primary')[0]) >= 4.5, 'dark');
  assert.ok(ratio('#1d58c9', tokens(lightBlock, '--on-primary')[0]) >= 4.5, 'light');
});

test('R3-5: no teal literal or teal wash remains on the Fleet board, Work or Surface', () => {
  const TEAL = /0fa4af|0a6f78|15, ?164, ?175|10, ?111, ?120|rgba\(2, ?73, ?80/i;
  for (const f of ['web/overview/stage-board.css', 'web/surface/surface.css', 'web/work/work.css', 'web/orchestration/board.css', 'web/surface/globe.js', 'web/surface/layers.js']) {
    assert.doesNotMatch(read(f), TEAL, f);
  }
  const pin = read('web/overview/stage-board.css').match(/#view-stageboard \{[\s\S]*?\n\}/)[0];
  for (const name of ['--card', '--muted', '--border', '--primary', '--success', '--info', '--teal']) assert.equal(tokens(pin, name).length, 0, `${name} is no longer pinned to teal`);
});
