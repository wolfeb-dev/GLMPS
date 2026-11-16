// server/test/shell-topbar-responsive.test.js
// #topbar overflowed the viewport horizontally below
// ~860px of content width (brand + nav + live stats + the three launcher
// widgets never wrapped), and .surface-root guessed the bar's height with a
// viewport-relative calc() that was also wrong. Fix round 2 folds in the
// same-shaped bug in web/overview/dashboard.css's .dash-roster-rail, and a
// small #topstats spacing gap. This repo has no real getComputedStyle/
// layout-engine test pattern (mini-dom.js is a lightweight DOM shim for d3,
// not a CSS engine); the closest existing pattern is shell-four-lenses.
// test.js's plain-text/regex assertions against the raw source, which this
// file follows. Real pixel verification for this fix lives in the task
// report (isolated server + headless Chrome Beta at 360/544/768/900/1280px,
// five routes each, plus a ground-truth check of the one route where
// .dash-roster-rail actually renders).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

test('index.html declares a viewport meta tag and wraps #topstats in #topbar-tools', () => {
  const html = read('web/index.html');
  assert.match(html, /<meta name="viewport" content="width=device-width/,
    'without this, real phones lay out at a virtual ~980px viewport regardless of the device width, and no narrow-screen CSS below 560px ever fires');
  assert.match(html, /<div id="topbar-tools">\s*<span id="topstats">/,
    '#topstats must sit inside #topbar-tools so it wraps and collapses together with the launcher widgets as one unit');
});

test('app.js mounts the launcher widgets onto #topbar-tools, not #topbar directly', () => {
  const js = read('web/app.js');
  assert.match(js, /getElementById\('topbar-tools'\)/);
  assert.match(js, /mountLauncher\(launcherSlot\)/);
  assert.match(js, /topbarTools\.appendChild\(launcherSlot\)/, 'the launcher mounts inside a slot in #topbar-tools');
  assert.match(js, /mountSettings\(topbarTools\)/);
  assert.doesNotMatch(js, /mountAlerts/, 'the top-bar bell is gone: alerts live in the Surface Alerts dock (glmps-2-0-106)');
});

test('#topbar is one fixed row that cannot overflow: the nav shrinks and scrolls inside it', () => {
  const css = read('web/styles.css').replace(/\r\n/g, '\n');
  const topbarRule = css.match(/#topbar \{[\s\S]*?\n\}/);
  assert.ok(topbarRule, '#topbar rule found');
  assert.doesNotMatch(topbarRule[0], /flex-wrap: wrap/, 'round 2: the flat bar is a single 52 px row, not a wrapping pill');
  assert.match(css, /#topbar nav \{[^}]*min-width: 0; overflow-x: auto/, 'the nav is what gives way when the bar is full');
  assert.match(css, /#topbar-tools \{[^}]*margin-left: auto/,
    'the live-stats + launcher-widget cluster moves as one right-aligned unit');
});

test('the narrow-screen block gives every topbar control (nav links, stat link, and the two launcher widgets) a 44px touch target', () => {
  const css = read('web/styles.css');
  // a lazy [\s\S]*? here can run straight past this media
  // block's own closing brace and match an unrelated min-height: 44px far
  // later in the file (styles.css has several, for other components) -
  // that false-matched even the pre-fix 10dbb89 file and a version of this
  // block with #topstats a's/.lens-link's floors stripped out. Bound the
  // block to its own single level of nested rules first (no [\s\S], and no
  // rule inside this block nests further), the same technique the
  // .surface-root/.dash-roster-rail tests below use, then isolate each
  // selector's own rule inside that bounded text before asserting on it.
  const block = css.match(/@media \(max-width: 560px\) \{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/);
  assert.ok(block, 'the shared #topbar narrow-screen media block is found');
  const statsRule = block[0].match(/#topstats a \{[^{}]*\}/);
  const lensRule = block[0].match(/\.lens-link \{[^{}]*\}/);
  assert.ok(statsRule, '#topstats a has its own rule inside the narrow-screen block');
  assert.match(statsRule[0], /min-height: 44px/, '#topstats a gets a 44px floor');
  assert.ok(lensRule, '.lens-link has its own rule inside the narrow-screen block');
  assert.match(lensRule[0], /min-height: 44px/, '.lens-link gets a 44px floor');
  for (const selector of ['.term-launch-btn', '.set-btn']) {
    const escaped = selector.replace(/[.]/g, '\\.');
    const baseIdx = css.indexOf(`${selector} {`);
    const overrideRe = new RegExp(`@media \\(max-width: 560px\\) \\{ ${escaped} \\{[^}]*?(?:min-height|height): 44px`);
    const overrideMatch = css.match(overrideRe);
    assert.ok(baseIdx >= 0, `${selector}'s base rule found`);
    assert.ok(overrideMatch, `${selector} gets a 44px override in the narrow-screen block`);
    // Same-specificity CSS cascade ties resolve by source order, so the
    // override must sit textually after the base rule it changes, or it loses.
    assert.ok(overrideMatch.index > baseIdx, `${selector}'s 44px override must come after its base rule`);
  }
});

test('.surface-root sizes from the flex-column shell, not a viewport-relative guess at the topbar height', () => {
  const css = read('web/surface/surface.css');
  // Isolate the single-line rule itself (not the prose comment above it, which
  // quotes the old calc(100vh - 56px) value as the thing being fixed).
  const rule = css.match(/\n\.surface-root \{[^\n{}]*\}/);
  assert.ok(rule, '.surface-root rule found');
  assert.doesNotMatch(rule[0], /calc\(/,
    'regression guard: this was the exact bug (calc(100vh - 56px) undershooting the ~74px bar, worse once it wraps)');
  assert.match(rule[0], /height: 100%/);
});

test('fix round 2: .dash-roster-rail sizes from its flex parent too, not a viewport-relative guess', () => {
  // Task 14 moved .dash-roster-rail out of the retired dashboard.css into
  // web/shared/roster.css (dashboard.js's only two surviving callers, the
  // Work kanban rail and the Surface graph panel rail, share it from there).
  const css = read('web/shared/roster.css');
  // Isolate the rule itself, not the prose comment above it (which quotes the
  // old calc(100vh - 52px) value as the thing being fixed - same trap as the
  // surface.css test above).
  const rule = css.match(/\.dash-roster-rail \{[^{}]*\}/);
  assert.ok(rule, '.dash-roster-rail rule found');
  assert.doesNotMatch(rule[0], /calc\(/,
    'regression guard: this was the same shape of bug as surface.css (calc(100vh - 52px))');
  assert.match(rule[0], /height: 100%/);
});

test('fix round 2: #topstats gives its three stat links a token-based gap', () => {
  const css = read('web/styles.css');
  const rule = css.match(/#topstats \{[^{}]*\}/);
  assert.ok(rule, '#topstats rule found');
  assert.match(rule[0], /gap: var\(--sp-\d\)/, 'the gap must come from the spacing scale, not a raw px value');
});

test('the pop-out editor pane stacks above the topbar', () => {
  const css = read('web/styles.css');
  const zOf = (sel) => {
    const block = css.match(new RegExp(`${sel}\\s*\\{[^}]*\\}`))?.[0] ?? '';
    return Number(block.match(/z-index:\s*(\d+)/)?.[1] ?? NaN);
  };
  const topbar = zOf('#topbar');
  const editor = zOf('#editor-pane');
  assert.ok(Number.isFinite(topbar) && Number.isFinite(editor), 'both rules declare a z-index');
  assert.ok(editor > topbar, `#editor-pane z-index ${editor} must exceed #topbar ${topbar}, or the bar covers the editor's header and Close button`);
});
