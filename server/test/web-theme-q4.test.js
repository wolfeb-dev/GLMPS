// light theme tokens (AC-1), touch targets (AC-3), session ledger (AC-4).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { readTheme, saveTheme, applyTheme, THEME_KEY } from '../../web/shared/settings.js';

// A Windows checkout (core.autocrlf) has CRLF; the selector matches below assume LF.
const css = fs.readFileSync(new URL('../../web/styles.css', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const tokenCss = fs.readFileSync(new URL('../../web/shared/tokens.css', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const workCss = fs.readFileSync(new URL('../../web/work/work.css', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

function tokens(block) {
  const out = {};
  for (const m of block.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}
function blockAfter(selectorStart) {
  const i = tokenCss.indexOf(selectorStart);
  assert.ok(i >= 0, `missing ${selectorStart}`);
  const open = tokenCss.indexOf('{', i);
  let depth = 0, j = open;
  for (; j < tokenCss.length; j++) {
    if (tokenCss[j] === '{') depth++;
    else if (tokenCss[j] === '}' && --depth === 0) break;
  }
  return tokenCss.slice(open + 1, j);
}

const dark = tokens(blockAfter(':root,\n.surface-root'));
const light = tokens(blockAfter('\n:root[data-theme="light"] {'));
const mediaLight = tokens(blockAfter(':root:not([data-theme="dark"])'));

const parse = (v) => {
  let m = /^#([0-9a-f]{6})$/i.exec(v);
  if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)).concat(1);
  m = /^rgba?\(([^)]+)\)$/.exec(v);
  if (m) { const p = m[1].split(',').map(Number); return [p[0], p[1], p[2], p[3] ?? 1]; }
  throw new Error('unparsable ' + v);
};
const over = (fg, bg) => [0, 1, 2].map((i) => fg[i] * fg[3] + bg[i] * (1 - fg[3]));
const lum = ([r, g, b]) => [r, g, b].reduce((a, c, i) => {
  c /= 255; c = c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  return a + c * [0.2126, 0.7152, 0.0722][i];
}, 0);
const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

function pairs(t) {
  const bg = parse(t['--bg']);
  const card = over(parse(t['--card']), bg).concat(1);
  const raise = parse(t['--raise-2']);
  const c = (k) => parse(t[k]);
  const text = ['--fg', '--muted-fg', '--primary', '--success', '--warning', '--destructive', '--info', '--danger-ink', '--link-hover', '--ok-hover', '--warn-ink'];
  const rows = [];
  for (const k of text) {
    rows.push([`${k} on --bg`, c(k), bg, 4.5]);
    rows.push([`${k} on --card`, c(k), card, 4.5]);
  }
  rows.push(['--muted-fg on --raise-2', c('--muted-fg'), raise, 4.5]);
  rows.push(['--on-primary on --primary', c('--on-primary'), c('--primary'), 4.5]);
  rows.push(['--on-warning on --warning', c('--on-warning'), c('--warning'), 4.5]);
  rows.push(['--on-danger on --destructive', c('--on-danger'), c('--destructive'), 4.5]);
  rows.push(['--bg on --destructive-strong', bg, c('--destructive-strong'), 4.5]);
  rows.push(['--bg on --warning (nav badge)', bg, c('--warning'), 4.5]);
  rows.push(['--edge-ui on --bg', c('--edge-ui'), bg, 3]);
  rows.push(['--edge-ui on --card', c('--edge-ui'), card, 3]);
  rows.push(['--primary (focus ring) on --bg', c('--primary'), bg, 3]);
  return rows;
}

for (const [name, t] of [['dark', dark], ['light', light]]) {
  test(`AC-1 ${name} theme: text >= 4.5:1, control edges and focus ring >= 3:1`, (ctx) => {
    for (const [label, fg, bg, min] of pairs(t)) {
      const r = ratio(fg, bg);
      ctx.diagnostic(`${name} ${label}: ${r.toFixed(2)}`);
      assert.ok(r >= min, `${name} ${label} is ${r.toFixed(2)}, needs ${min}`);
    }
  });
}

test('AC-1 light values cover exactly the roles dark defines, and the OS media block matches the override', () => {
  const roles = (o) => Object.keys(o).filter((k) => !/^--(panel|panel-2|text|gold|green|amber|red|blue|purple)$/.test(k)).sort();
  assert.deepEqual(roles(light), roles(dark));
  assert.deepEqual(mediaLight, light);
  assert.match(tokenCss, /@media \(prefers-color-scheme: light\) \{\s*:root:not\(\[data-theme="dark"\]\)/);
});

test('AC-1 Surface and the Fleet board re-declare the dark set', () => {
  const sel = tokenCss.slice(tokenCss.indexOf(':root,\n.surface-root'), tokenCss.indexOf('{', tokenCss.indexOf(':root,\n.surface-root')));
  for (const s of ['.surface-root', '#lens-root[data-lens="surface"]', '#view-stageboard']) assert.ok(sel.includes(s), s);
  assert.equal(dark['--panel'], 'var(--card)', 'aliases are restated so the subtree resolves them dark');
});

test('AC-1 theme helpers: persisted, guarded, applied to the root element', () => {
  const store = {};
  const ls = { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = v; }, removeItem: (k) => { delete store[k]; } };
  assert.equal(readTheme(ls), 'system');
  assert.equal(saveTheme('light', ls), 'light');
  assert.equal(store[THEME_KEY], 'light');
  assert.equal(readTheme(ls), 'light');
  assert.equal(saveTheme('bogus', ls), 'system');
  assert.equal(THEME_KEY in store, false);
  const throwing = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } };
  assert.equal(readTheme(throwing), 'system');
  assert.equal(saveTheme('dark', throwing), 'dark');
  const root = { dataset: {} };
  applyTheme('dark', root); assert.equal(root.dataset.theme, 'dark');
  applyTheme('light', root); assert.equal(root.dataset.theme, 'light');
  applyTheme('system', root); assert.equal(root.dataset.theme, undefined);
});

test('AC-3 phone touch targets are 44 px: chips, action buttons, top bar', () => {
  const phone = workCss.slice(workCss.lastIndexOf('@media (max-width: 560px)'));
  assert.match(phone, /max-width: 560px/);
  assert.match(phone, /\.work-chip \{[^}]*min-height: 44px/);
  // The recently ended band and its buttons are retired (card glmps-2-0-137
  // phase 4); the two runner switches take their place in the board bar.
  assert.match(phone, /\.board-runner \.backlog-pause, \.board-runner \.backlog-runner \{ height: 44px; \}/);
  assert.match(css, /@media \(max-width: 560px\) \{ \.set-btn \{ width: 44px; height: 44px; \} \}/);
  assert.match(css, /@media \(max-width: 560px\) \{ \.term-launch-btn \{ min-height: 44px; min-width: 44px/);
  assert.match(css, /\.lens-link \{ min-height: 44px/);
});

test('AC-4 the session page ledger is scoped to the session lens and keeps the diff toggle', () => {
  assert.match(css, /#lens-root\[data-lens="session"\] \.event-row \{[^}]*border-bottom/);
  assert.match(css, /#lens-root\[data-lens="session"\] \.event-time,[^{]*\.event-edits[^{]*\{[^}]*Fira Code/);
  assert.match(css, /#lens-root\[data-lens="session"\] \.chip \{[^}]*border-radius: 2px/);
  const detail = fs.readFileSync(new URL('../../web/observability/detail.js', import.meta.url), 'utf8');
  assert.match(detail, /toggle\.className = 'diff-toggle'/);
});
