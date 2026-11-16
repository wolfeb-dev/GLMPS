// server/test/stage-board-reserve.test.js
// The stage board reserves its space before any state lands, so the Fleet dock
// on Surface does not shift as live rows arrive. These
// were part of the Now lens tests before Now was retired (glmps-2-0-63).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installMiniDom } from './fixtures/mini-dom.js';

// Event-loop turns, not a clock: enough for the board's mocked polls to answer.
const drain = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// the Fleet band's "Recently ended" card had no reserved space,
// so it grew from near-zero (an empty .sb-ended-strip at first paint,
// web/overview/stage-board.js's renderStageBoard) to its full content height
// once updateStageBoard populated the strip from live state - a measured
// 0.16 CLS, with #band-record (which has nothing to do with this card's own
// content) also registering as shifted, since it sits right below Fleet in
// page order and got pushed down. This repo has no layout-engine test
// harness (shell-topbar-responsive.test.js), so the reserved size itself is
// pinned by source assertion; the DOM check below confirms the card (and
// its empty strip) exist at first paint, before any state has arrived,
// which is the exact moment the old code had nothing reserved yet.
// Card glmps-2-0-137 phase 2 (story 12) retired the "Recently ended" card:
// ended sessions live on Work > History only. The B1 shift is gone with it,
// so this pins that nothing replaces the card at first paint or in the CSS.
test('the Fleet board has no "Recently ended" card at first paint, so it cannot shift in (B1)', async () => {
  const css = fs.readFileSync(path.join(ROOT, 'web', 'overview', 'stage-board.css'), 'utf8');
  assert.doesNotMatch(css, /\.sb-endedcard|\.sb-ended-strip/, 'no ended-card rules remain');

  const dom = installMiniDom({ pathname: '/surface' });
  // renderStageBoard starts its own 30s vitals poller immediately
  // (startVitalsPoller -> pollVitals, fire-and-forget); mock fetch so that
  // poll settles instead of hitting the real network after this test ends.
  globalThis.fetch = async () => Response.json({});
  try {
    const sb = await import('../../web/overview/stage-board.js');
    const host = document.createElement('div');
    document.body.appendChild(host);
    sb.renderStageBoard(host, {}); // first paint only - no updateStageBoard call yet
    assert.equal(host.querySelector('.sb-endedcard'), null, 'no ended-session card');
    assert.equal(host.querySelector('.sb-ended-strip'), null, 'no ended strip');
    await drain(); // let the fire-and-forget poll settle
    sb.unmountStageBoard();
  } finally {
    delete globalThis.fetch;
    dom.restore();
  }
});

// the B1 fix (before the ended card was retired) only reserved the
// ended-session card's space. The session-row body (.sb-body) still grew unbounded as live rows
// arrived - each .sb-row has its own min-height of 100px, and .sb-body
// started a completely empty div with no height of its own (the fleet band
// body has no ancestor that bounds its height, unlike the 1.x full-screen
// view this module was first built for) - so a fresh browser pass measured
// Fleet growing 395 -> 450px even after the ended card's own growth was
// already closed. .sb-body gets the exact fix the ended card already
// proved out: min-height == max-height, so its box is the same size from
// the empty first paint through any number of rows, with its own
// overflow:auto absorbing anything past that.
test('the Fleet board reserves the session-row body\'s space too, not just the ended card (Task 15 round 2)', async () => {
  const css = fs.readFileSync(path.join(ROOT, 'web', 'overview', 'stage-board.css'), 'utf8');
  const rule = css.match(/#view-stageboard \.sb-body \{[^}]*\}/);
  assert.ok(rule, '#view-stageboard .sb-body rule found');
  const minH = rule[0].match(/min-height:\s*(\d+)px/);
  const maxH = rule[0].match(/max-height:\s*(\d+)px/);
  assert.ok(minH && maxH, 'both min-height and max-height are set in px');
  assert.equal(minH[1], maxH[1], 'min-height must reserve the same space the body can ever grow to (max-height)');

  const dom = installMiniDom({ pathname: '/surface' });
  globalThis.fetch = async () => Response.json({});
  try {
    const sb = await import('../../web/overview/stage-board.js');
    const host = document.createElement('div');
    document.body.appendChild(host);
    sb.renderStageBoard(host, {}); // first paint only - no updateStageBoard call yet
    const body = host.querySelector('.sb-body');
    assert.ok(body, 'the session-row body exists at first paint, before any state has arrived');
    assert.equal(body.children.length, 0, 'it starts empty - no rows rendered yet');
    await drain(); // let the fire-and-forget poll settle
    sb.unmountStageBoard();
  } finally {
    delete globalThis.fetch;
    dom.restore();
  }
});
