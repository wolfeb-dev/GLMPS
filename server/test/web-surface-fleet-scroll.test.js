// glmps-2-0-127: scrolling the Fleet board must not paint rows over its frozen
// header, and the Surface dock must let every row be scrolled into view.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web');
const read = (p) => fs.readFileSync(path.join(WEB, p), 'utf8').replace(/\r\n/g, '\n');
const BOARD = read('overview/stage-board.css');
const SURFACE = read('surface/surface.css');

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function decl(css, sel, prop) {
  const out = [];
  for (const m of css.matchAll(new RegExp(`(?:^|[},\\n])\\s*${esc(sel)}\\s*\\{([^}]*)\\}`, 'g'))) {
    const d = m[1].match(new RegExp(`(?:^|[;\\s])${esc(prop)}:\\s*([^;]+);`));
    if (d) out.push(d[1].trim());
  }
  return out;
}
function frozenPane() {
  const i = BOARD.indexOf('@media (max-width: 1400px)');
  assert.ok(i >= 0, 'the frozen-pane breakpoint exists');
  return BOARD.slice(i, BOARD.indexOf('@media (max-width: 1000px)'));
}
const z = (css, sel) => Number(decl(css, sel, 'z-index').at(-1));

test('AC-1: the frozen header stacks above every row layer (stage dots, detail cards, session rail)', () => {
  const fp = frozenPane();
  const head = z(fp, '#view-stageboard .sb-head');
  const rail = z(fp, '#view-stageboard .sb-id');
  const rowLayers = [
    z(BOARD, '#view-stageboard .sb-col'),
    z(BOARD, '#view-stageboard .sb-col.sb-cur'),
    z(BOARD, '#view-stageboard .sb-cx'),
    z(BOARD, '#view-stageboard .sb-pop'),
  ];
  for (const n of [head, rail, ...rowLayers]) assert.ok(Number.isFinite(n), 'every layer declares a z-index');
  assert.ok(head > Math.max(...rowLayers, rail), `header z ${head} must exceed row layers ${rowLayers} and rail ${rail}`);
  assert.ok(rail > Math.max(...rowLayers), `session rail z ${rail} must exceed row layers ${rowLayers}`);
});

test('AC-3: the frozen header, corner and rail are fully opaque', () => {
  const fp = frozenPane();
  const bg = decl(fp, '#view-stageboard .sb-id', 'background').at(-1);
  assert.ok(bg, 'frozen panes declare a background');
  assert.doesNotMatch(bg, /rgba|\/\s*0?\.\d|transparent/, `background ${bg} must be opaque`);
});

test('AC-2: in the Surface dock the board container scrolls and the board fills it', () => {
  const dock = '.surface-fleet #view-stageboard';
  assert.ok(decl(SURFACE, dock, 'overflow').includes('auto'), 'the dock board container scrolls (the #view-stageboard overflow:hidden must not clip rows)');
  assert.ok(decl(SURFACE, dock, 'display').includes('flex'), 'the dock board container is a flex column so the grid fills it');
  assert.ok(decl(SURFACE, `${dock} .sb-grid`, 'grid-template-rows').some((v) => /minmax\(\d+px, 1fr\)/.test(v)), 'the board row fills the dock with a usable floor');
  assert.ok(decl(SURFACE, `${dock} .sb-body`, 'max-height').includes('none'), 'the session list is not pinned to 320 px inside the dock');
  assert.ok(decl(SURFACE, `${dock} .sb-body`, 'min-height').includes('0'), 'the session list can shrink to the dock');
});

// glmps-2-0-148: the detail card sat out of flow, so a two-line file name hung
// it into the next session's row. It is a grid item now and the row grows.
test('glmps-2-0-148: the session detail card is in flow, so its row grows to hold it', () => {
  assert.ok(decl(BOARD, '#view-stageboard .sb-track', 'display').includes('grid'), 'the track is a grid of dots then card');
  assert.ok(!decl(BOARD, '#view-stageboard .sb-pop', 'position').includes('absolute'), 'the card is not absolutely positioned');
  assert.ok(decl(BOARD, '#view-stageboard .sb-pop', 'grid-row').includes('2'), 'the card takes the second track row');
  assert.ok(decl(BOARD, '#view-stageboard .sb-col', 'grid-row').includes('1'), 'the stage dots stay on the first row');
  // A zero flex basis (flex: 1) let the session list squeeze each row to its
  // 100 px floor whatever it held, so the card still hung into the next row.
  const flex = decl(BOARD, '#view-stageboard .sb-row', 'flex');
  assert.ok(flex.length && flex.every((v) => /\bauto\b/.test(v) && !/^1$/.test(v)), `rows size from their content, got flex: ${flex}`);
});
