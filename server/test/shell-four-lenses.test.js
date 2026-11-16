// server/test/shell-four-lenses.test.js
// The record of the shell's navigation decisions. D1 (five lens links) and D3
// (one plain Wiki page link after them) were revisited by card glmps-2-0-137
// (spec docs/specs/2026-11-02-hci-ia-redesign.md): four pillars, Surface,
// Work, Evolution (URL /learning, so links keep working) and Knowledge, which
// is now a lens rather than a page link. Loops and Personality became
// Evolution tabs and are no longer lenses. D2 stands: no Governance entry.
// Search is shell-owned (mounted once, in the topbar, for every pillar) and
// Ctrl+K focuses it. The dock mount point exists; every lens module satisfies
// the mount contract and imports without a DOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const PILLARS = [['surface', 'surface', 'Surface'], ['work', 'work', 'Work'], ['learning', 'learning', 'Evolution'], ['knowledge', 'knowledge', 'Knowledge']];

test('index.html has exactly the four pillar links, in order, with their labels', () => {
  const html = read('web/index.html');
  const links = [...html.matchAll(/<a class="lens-link"[^>]*href="\/([a-z]+)"[^>]*data-lens="([a-z]+)">([A-Za-z]+)<\/a>/g)].map((m) => [m[1], m[2], m[3]]);
  assert.deepEqual(links, PILLARS);
  assert.equal([...html.matchAll(/class="lens-link"/g)].length, 4, 'no other nav entry');
  assert.doesNotMatch(html, /data-lens="(now|loops|personality)"|href="\/(now|loops|personality)"|data-page="wiki"|href="\/wiki\/"/);
  assert.doesNotMatch(html, /nav-pillar|data-view=|Governance/);
  assert.match(html, /<nav aria-label="Pillars">/);
  assert.match(html, /<div id="topbar-search"[^>]*><\/div>/, 'the shell search slot');
  assert.match(html, /<div id="lens-root"/);
  assert.match(html, /<div id="huddle-dock"/);
  // the lens sheets are registered in app.js, not linked here (web-shell-q1.test.js).
});

test('app.js routes through deep-link.js, registers the four pillars and the session page, and owns search', () => {
  const js = read('web/app.js');
  assert.doesNotMatch(js, /\bPILLARS\b|VIEW_REDIRECTS|function pathFor|function parseRoute/);
  assert.match(js, /from '\.\/shared\/deep-link\.js'/);
  for (const lens of ['surface', 'work', 'learning', 'knowledge']) assert.match(js, new RegExp(`registerView\\('${lens}'`));
  for (const gone of ['now', 'loops', 'personality', 'wiki']) assert.doesNotMatch(js, new RegExp(`registerView\\('${gone}'`));
  assert.match(js, /registerView\('learning', \{ label: 'Evolution'/);
  assert.match(js, /registerView\('session'/);
  assert.match(js, /mountDocks\(document\.getElementById\('huddle-dock'\)/);
  assert.match(js, /addEventListener\('mc-link'/);
  assert.match(js, /resolveTarget\(/);
  assert.match(js, /createShellSearch\(document\.getElementById\('topbar-search'\)/);
});

test('every lens module imports without a DOM and exports the mount contract', async () => {
  for (const lens of ['surface', 'work', 'learning', 'knowledge']) {
    const mod = await import(pathToFileURL(path.join(ROOT, 'web', lens, 'lens.js')).href);
    assert.equal(typeof mod.mount, 'function', `${lens}.mount`);
    assert.equal(typeof mod.ITEM_TYPES, 'object', `${lens}.ITEM_TYPES`);
  }
  const session = await import(pathToFileURL(path.join(ROOT, 'web', 'shared', 'session-page.js')).href);
  assert.equal(typeof session.mount, 'function');
});

test('the dock list is the only file phase C edits to add the huddle', async () => {
  const { DOCKS } = await import(pathToFileURL(path.join(ROOT, 'web', 'shared', 'dock-list.js')).href);
  assert.ok(Array.isArray(DOCKS));
  for (const d of DOCKS) { assert.equal(typeof d.id, 'string'); assert.equal(typeof d.load, 'function'); }
});

// Work is a tab list now (card glmps-2-0-137 phase 4, story 29), so it has no
// bands to count; its four tabs are pinned here and in web-work-tabs.test.js.
test('R2: Learning declares at most three bands; Work declares its four tabs', () => {
  assert.match(read('web/work/lens.js'), /\{ id: 'board', label: 'Board' \},\s*\{ id: 'history', label: 'History' \},\s*\{ id: 'qa', label: 'QA trends' \},\s*\{ id: 'cost', label: 'Cost' \}/);
  for (const lens of ['learning']) {
    const src = read(`web/${lens}/lens.js`);
    const m = src.match(/buildBands\(root, \[([\s\S]*?)\]\)/);
    assert.ok(m, `${lens} builds its bands with buildBands`);
    assert.ok((m[1].match(/id: '/g) ?? []).length <= 3, `${lens} has more than three bands`);
  }
});
