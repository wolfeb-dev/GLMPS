// apps/shell/test/layout.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeLayout, clampRatio, ratioFromPointer, nudgeRatio, edgeRatio, presetRatio, splitLabel,
  DEFAULT_RATIO, SPLITTER_PX, MIN_PANE_PX, NUDGE_STEP, SPLIT_PRESETS,
} from '../src/lib/layout.js';

test('the divider is 12 px wide', () => {
  assert.equal(SPLITTER_PX, 12);
});

test('default split at 1200x800 tiles the width exactly: 737 + 12 + 451', () => {
  const l = computeLayout({ width: 1200, height: 800, ratio: DEFAULT_RATIO });
  assert.deepEqual(l.dashboard, { x: 0, y: 0, width: 737, height: 800 });
  assert.deepEqual(l.splitter, { x: 737, y: 0, width: 12, height: 800 });
  assert.deepEqual(l.slack, { x: 749, y: 0, width: 451, height: 800 });
});

test('swapped puts Slack on the left with the same widths', () => {
  const l = computeLayout({ width: 1200, height: 800, ratio: DEFAULT_RATIO, swapped: true });
  assert.deepEqual(l.slack, { x: 0, y: 0, width: 451, height: 800 });
  assert.deepEqual(l.splitter, { x: 451, y: 0, width: 12, height: 800 });
  assert.deepEqual(l.dashboard, { x: 463, y: 0, width: 737, height: 800 });
});

test('a ratio that would squeeze Slack below 320 px is clamped', () => {
  const l = computeLayout({ width: 1200, height: 800, ratio: 0.95 });
  assert.equal(l.slack.width, MIN_PANE_PX);
  assert.equal(l.dashboard.width + SPLITTER_PX + l.slack.width, 1200);
});

test('a window too narrow for two minimum panes splits evenly', () => {
  assert.equal(clampRatio(0.8, 600), 0.5);
  const l = computeLayout({ width: 600, height: 400, ratio: 0.8 });
  assert.equal(l.dashboard.width, 294);
  assert.equal(l.slack.width, 294);
});

test('Slack hidden gives the dashboard the whole window and no splitter', () => {
  const l = computeLayout({ width: 1200, height: 800, ratio: 0.3, slackVisible: false });
  assert.deepEqual(l.dashboard, { x: 0, y: 0, width: 1200, height: 800 });
  assert.equal(l.slack, null);
  assert.equal(l.splitter, null);
});

test('non-finite ratio falls back to the default', () => {
  assert.equal(clampRatio(Number.NaN, 1200), DEFAULT_RATIO);
  assert.equal(clampRatio(undefined, 1200), DEFAULT_RATIO);
});

test('fractional window sizes still produce integer rectangles', () => {
  const l = computeLayout({ width: 1199.5, height: 800.4, ratio: 0.5 });
  for (const r of [l.dashboard, l.splitter, l.slack]) for (const v of Object.values(r)) assert.ok(Number.isInteger(v));
});

test('ratioFromPointer centres the splitter on the pointer, and mirrors when swapped', () => {
  const r = ratioFromPointer({ pointerX: 606, width: 1200 });
  assert.ok(Math.abs(r - 600 / 1188) < 1e-9);
  const s = ratioFromPointer({ pointerX: 606, width: 1200, swapped: true });
  assert.ok(Math.abs(s - (1 - 600 / 1188)) < 1e-9);
});

test('ratioFromPointer clamps a pointer dragged past the window edge', () => {
  const r = ratioFromPointer({ pointerX: -500, width: 1200 });
  assert.equal(r, clampRatio(0, 1200));
});

test('a 2413 px window with the saved 0.62 ratio is not an even split', () => {
  const l = computeLayout({ width: 2413, height: 1400, ratio: 0.62 });
  assert.equal(l.ratio, 0.62);
  assert.equal(l.dashboard.width, 1489);
  assert.equal(l.slack.width, 912);
});

test('nudgeRatio moves the divider 2% toward the arrow, mirrored when swapped', () => {
  assert.equal(NUDGE_STEP, 0.02);
  assert.ok(Math.abs(nudgeRatio({ ratio: 0.62, width: 1200, dir: 'left' }) - 0.60) < 1e-9);
  assert.ok(Math.abs(nudgeRatio({ ratio: 0.62, width: 1200, dir: 'right' }) - 0.64) < 1e-9);
  assert.ok(Math.abs(nudgeRatio({ ratio: 0.62, width: 1200, dir: 'left', swapped: true }) - 0.64) < 1e-9);
});

test('nudgeRatio stops at the clamp bound', () => {
  const lo = 320 / 1188;
  assert.equal(nudgeRatio({ ratio: lo + 0.001, width: 1200, dir: 'left' }), lo);
});

test('edgeRatio sends the divider to the clamp bounds; Home is the left edge', () => {
  const lo = 320 / 1188;
  assert.equal(edgeRatio({ edge: 'home', width: 1200 }), lo);
  assert.equal(edgeRatio({ edge: 'end', width: 1200 }), 1 - lo);
  assert.equal(edgeRatio({ edge: 'home', width: 1200, swapped: true }), 1 - lo);
  assert.equal(edgeRatio({ edge: 'end', width: 1200, swapped: true }), lo);
});

test('presets are 50, 62 and 75 percent for the dashboard, clamped to the window', () => {
  assert.deepEqual(Object.values(SPLIT_PRESETS), [0.5, 0.62, 0.75]);
  assert.equal(presetRatio('split-50', 1200), 0.5);
  assert.equal(presetRatio('split-62', 1200), 0.62);
  assert.equal(presetRatio('split-75', 1600), 0.75);
  assert.equal(presetRatio('split-75', 1200), 1 - 320 / 1188);
  assert.equal(presetRatio('nope', 1200), null);
});

test('splitLabel reads left / right as drawn, so a swapped layout flips it', () => {
  assert.equal(splitLabel({ ratio: 0.62 }), '62 / 38');
  assert.equal(splitLabel({ ratio: 0.62, swapped: true }), '38 / 62');
  assert.equal(splitLabel({ ratio: 0.5 }), '50 / 50');
});
