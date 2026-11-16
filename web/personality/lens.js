// web/personality/lens.js
// Personality: every file that steers how the agents think, in the order they
// read it. Five groups as bands with an icon and a colored edge, a strip of the
// five icons under the filters, summary cards that expand to an outline and the
// full text, and collections as one card with a table. Read-only; the open
// button hands a path to the editor through POST /api/open-in-editor.
// Everything file-derived reaches the DOM through textContent.
import { getPersonality, openInEditor } from '../shared/api.js';
import { clear } from '../shared/dom-util.js';
import { linkFor, resolveTarget } from '../shared/deep-link.js';
import { formatTime } from '../shared/time-format.js';
import { DEFAULT_FILTERS, filterGroups, fmtSize, relTime } from './model.js';

export const ITEM_TYPES = Object.freeze({});

const FILTER_KEY = 'glmps.personality.filters';
const SVG_NS = 'http://www.w3.org/2000/svg';
const AI_LABEL = { claude: 'Claude', gemini: 'Gemini' };
const AI_OPTIONS = [['all', 'All'], ['claude', 'Claude'], ['gemini', 'Gemini']];
const SHAPE_OPTIONS = [['all', 'All'], ['personality', 'Personality'], ['guardrail', 'Guardrail'], ['memory', 'Memory'], ['routing', 'Routing']];

const ICONS = {
  machine: [['rect', { x: 3, y: 4, width: 18, height: 12, rx: 2 }], ['path', { d: 'M8 20h8M12 16v4' }]],
  project: [['path', { d: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z' }]],
  agents: [['circle', { cx: 9, cy: 8, r: 3 }], ['path', { d: 'M3 20a6 6 0 0 1 12 0' }], ['circle', { cx: 17, cy: 9, r: 2.5 }], ['path', { d: 'M16 14.3A5 5 0 0 1 21 19' }]],
  runtime: [['path', { d: 'M8 7l-5 5 5 5M16 7l5 5-5 5' }]],
  memory: [['path', { d: 'M6 3h12v18l-6-4-6 4z' }]],
};
const SHORT = { machine: 'Machine', project: 'Project', agents: 'Agents', runtime: 'Runtime', memory: 'Memory' };

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function icon(group) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  for (const [tag, attrs] of ICONS[group] ?? []) {
    const n = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
    svg.appendChild(n);
  }
  return svg;
}

function loadFilters() {
  try {
    const f = JSON.parse(localStorage.getItem(FILTER_KEY) || '{}');
    const ai = AI_OPTIONS.some(([v]) => v === f.ai) ? f.ai : 'all';
    const shape = SHAPE_OPTIONS.some(([v]) => v === f.shape) ? f.shape : 'all';
    return { ...DEFAULT_FILTERS, ai, shape };
  } catch { return { ...DEFAULT_FILTERS }; }
}
function saveFilters(f) {
  try { localStorage.setItem(FILTER_KEY, JSON.stringify({ ai: f.ai, shape: f.shape })); } catch { /* private mode: the filters simply do not persist */ }
}

function segment(label, labelId, options, current, onPick) {
  const wrap = el('div', 'pers-field');
  const l = el('span', 'pers-label', label);
  l.id = labelId;
  const seg = el('div', 'pers-seg');
  seg.setAttribute('role', 'group');
  seg.setAttribute('aria-labelledby', labelId);
  const buttons = options.map(([value, text]) => {
    const b = el('button', null, text);
    b.type = 'button';
    b.dataset.v = value;
    b.setAttribute('aria-pressed', String(value === current));
    b.addEventListener('click', () => { onPick(value); set(value); });
    seg.appendChild(b);
    return b;
  });
  function set(value) { for (const b of buttons) b.setAttribute('aria-pressed', String(b.dataset.v === value)); }
  wrap.append(l, seg);
  return { node: wrap, set };
}

function tag(text, cls) { return el('span', `pers-tag${cls ? ` ${cls}` : ''}`, text); }

function openButton(label, target, ctx, small) {
  const b = el('button', `pers-btn${small ? ' sm' : ''}`, label);
  b.type = 'button';
  b.addEventListener('click', async () => {
    if (target.openView) { ctx.go?.(resolveTarget({ view: target.openView })); return; }
    b.disabled = true;
    try {
      const r = await openInEditor(target.openPath, target.openKind === 'dir' ? 'dir' : undefined);
      if (r.status === 200) ctx.toast?.(r.body?.queued ? 'Sent to the desktop app to open.' : 'Opening in the editor.');
      else ctx.toast?.(`Could not open it: ${r.body?.error ?? r.status}`);
    } catch (e) { ctx.toast?.(`Could not open it: ${e.message}`); } finally { b.disabled = false; }
  });
  return b;
}

function rowsTable(card, ctx) {
  const table = el('table', 'pers-table');
  const cap = el('caption', 'pers-sr', `${card.name}: ${card.count ?? card.rows.length} items`);
  const head = el('thead');
  const hr = el('tr');
  for (const h of ['Name', 'What', 'Source']) hr.appendChild(el('th', null, h));
  const actTh = el('th', 'act'); actTh.appendChild(el('span', 'pers-sr', 'Open')); hr.appendChild(actTh);
  head.appendChild(hr);
  const body = el('tbody');
  for (const r of card.rows) {
    const tr = el('tr', r.withheld ? 'withheld' : '');
    tr.appendChild(el('td', 'mono', r.name));
    if (r.withheld) {
      const td = el('td', 'pers-muted', 'Credential file, listed by name only and never read');
      td.colSpan = 2;
      tr.appendChild(td);
      tr.appendChild(el('td', 'act'));
    } else {
      const what = r.count != null ? `${r.count} skills` : (r.personality ? `${r.description} (${r.personality})` : r.description);
      tr.appendChild(el('td', null, what || '-'));
      const src = el('td', 'mono pers-source', r.link && r.realPath ? r.realPath : (r.source ?? ''));
      src.title = r.path ?? '';
      tr.appendChild(src);
      const act = el('td', 'act');
      if (r.overridden) act.appendChild(tag('overridden'));
      if (r.openPath) act.appendChild(openButton(r.openKind === 'dir' ? 'Open folder' : 'Open', r, ctx, true));
      tr.appendChild(act);
    }
    body.appendChild(tr);
  }
  table.append(cap, head, body);
  return table;
}

function fileBody(card, ctx) {
  const body = el('div', 'pers-body');
  const side = el('dl', 'pers-side');
  const add = (k, v, mono) => { side.appendChild(el('dt', null, k)); side.appendChild(el('dd', mono ? 'mono' : '', v)); };
  if (card.path) add('Read from', card.path, true);
  if (card.realPath) add('Real file', card.realPath, true);
  if (card.note) add('Note', card.note);
  const loops = card.usedBy ?? [];
  const graphs = card.usedByGraphs ?? [];
  if (loops.length || graphs.length) {
    side.appendChild(el('dt', null, 'Used by'));
    const dd = el('dd');
    loops.forEach((name, i) => {
      if (i) dd.appendChild(document.createTextNode(', '));
      const href = linkFor({ lens: 'loops', sel: { type: 'loop', id: name } });
      const a = el('a', 'pers-loop-link', name);
      a.href = href;
      a.addEventListener('click', (e) => {
        if (e.ctrlKey || e.metaKey || e.shiftKey || e.button === 1) return;
        e.preventDefault();
        ctx.go?.(href);
      });
      dd.appendChild(a);
    });
    if (graphs.length) dd.appendChild(document.createTextNode(`${loops.length ? ', ' : ''}${graphs.join(', ')}`));
    side.appendChild(dd);
  }
  if (card.count != null && !card.rows) add('Facts', String(card.count));
  const act = el('dd');
  if (card.openView) act.appendChild(openButton('Open in Memory view', card, ctx));
  else if (card.openPath) act.appendChild(openButton('Open in editor', card, ctx));
  side.appendChild(act);
  body.appendChild(side);
  const main = el('div', 'pers-main');
  if (card.outline?.length) {
    const ol = el('ol', 'pers-outline');
    ol.setAttribute('aria-label', 'Outline');
    for (const o of card.outline) {
      const li = el('li', null, o.text);
      li.style.setProperty('--lvl', String(Math.max(0, (o.level ?? 1) - 1)));
      if (o.generated) li.appendChild(tag('GLMPS', 'gen'));
      ol.appendChild(li);
    }
    main.appendChild(ol);
  }
  if (card.text) {
    const pre = el('pre', 'pers-excerpt mono', card.text);
    pre.tabIndex = 0;
    pre.setAttribute('aria-label', `${card.name} text`);
    main.appendChild(pre);
    if (card.truncated) main.appendChild(el('p', 'pers-muted', 'Shown truncated; open the file for the rest.'));
  }
  body.appendChild(main);
  return body;
}

function collectionBody(card, ctx) {
  const body = el('div', 'pers-body one');
  const main = el('div', 'pers-main');
  if (card.rows.length) main.appendChild(rowsTable(card, ctx));
  else main.appendChild(el('p', 'pers-muted', 'Nothing here yet.'));
  const actions = el('div', 'pers-actions');
  if (card.openPath && card.openKind === 'dir') actions.appendChild(openButton('Open folder', card, ctx, true));
  if (card.path) { const c = el('span', 'pers-muted mono', card.path); actions.appendChild(c); }
  if (card.note) actions.appendChild(el('span', 'pers-muted', card.note));
  main.appendChild(actions);
  body.appendChild(main);
  return body;
}

function buildCard(card, ctx, now) {
  const d = el('details', `pers-card${card.rows ? ' wide' : ''}`);
  d.dataset.id = card.id;
  const sum = el('summary');
  const title = el('span', 'pers-title', card.rows ? `${card.name} (${card.count})` : card.name);
  const meta = card.rows
    ? [card.mtime ? relTime(card.mtime, now) : null].filter(Boolean).join(', ')
    : [fmtSize(card.size), relTime(card.mtime, now)].filter((x) => x !== '-').join(', ');
  const metaEl = el('span', 'pers-meta', meta || '-');
  if (card.mtime) metaEl.title = formatTime(card.mtime);
  const what = el('span', 'pers-what', card.controls);
  const tags = el('span', 'pers-tags');
  for (const ai of card.readBy ?? []) tags.appendChild(tag(AI_LABEL[ai] ?? ai, 'ai'));
  if (card.usedBy?.length) tags.appendChild(tag(`used by ${card.usedBy.length} ${card.usedBy.length === 1 ? 'loop' : 'loops'}`, 'used'));
  if (card.badges?.link) tags.appendChild(tag('link', 'link'));
  if (card.badges?.generated) tags.appendChild(tag('generated', 'gen'));
  if (card.badges?.overridden) tags.appendChild(tag('overridden'));
  sum.append(title, metaEl, what, tags);
  d.appendChild(sum);
  d.appendChild(card.rows ? collectionBody(card, ctx) : fileBody(card, ctx));
  return d;
}

export async function mount(root, route, ctx) {
  const owns = () => ctx.isCurrent?.() !== false;
  const wrap = el('div', 'pers');
  root.appendChild(wrap);

  const head = el('header', 'pers-head');
  head.append(el('h2', null, 'Personality'), el('span', 'pers-muted', 'Every file that steers how your agents think, in the order they read it'));
  wrap.appendChild(head);
  const content = el('div', 'pers-content');
  content.appendChild(el('p', 'pers-muted', 'Loading...'));
  wrap.appendChild(content);

  let data;
  try { data = await getPersonality(); } catch (e) {
    if (!owns()) return inert();
    clear(content);
    const p = el('p', 'lens-error', `Could not load the personality files: ${e.message}`);
    p.setAttribute('role', 'alert');
    content.appendChild(p);
    return inert();
  }
  if (!owns()) return inert();
  clear(content);

  const filters = { ...loadFilters(), q: '' };
  const now = Date.now();
  const all = data.groups.flatMap((g) => g.cards);

  const stats = el('section', 'pers-stats');
  stats.setAttribute('aria-label', 'Totals');
  const stat = (n, label) => { const s = el('div', 'pers-stat'); s.append(el('b', null, String(n)), el('span', null, label)); stats.appendChild(s); };
  stat(all.length, 'cards in five groups');
  stat(all.reduce((n, c) => n + (c.rows ? c.rows.length : 0), 0), 'items in collections');
  stat(all.filter((c) => c.badges?.generated).length, 'partly written by GLMPS');
  stat(all.reduce((n, c) => n + (c.rows ? c.rows.filter((r) => r.withheld).length : 0), 0), 'credential files withheld');

  const bar = el('div', 'pers-bar');
  const search = el('div', 'pers-filters');
  search.setAttribute('role', 'search');
  const aiSeg = segment('AI', 'pers-ai-l', AI_OPTIONS, filters.ai, (v) => { filters.ai = v; saveFilters(filters); apply(); });
  const shapeSeg = segment('Shapes', 'pers-sh-l', SHAPE_OPTIONS, filters.shape, (v) => { filters.shape = v; saveFilters(filters); apply(); });
  const input = el('input', 'pers-search');
  input.type = 'search';
  input.placeholder = 'Search names and contents';
  input.setAttribute('aria-label', 'Search names and contents');
  input.addEventListener('input', () => { filters.q = input.value; apply(); });
  const countEl = el('span', 'pers-count');
  countEl.setAttribute('role', 'status');
  search.append(aiSeg.node, shapeSeg.node, input, countEl);

  // Outside the search landmark: the strip navigates, it does not filter.
  const strip = el('nav', 'pers-strip');
  strip.setAttribute('aria-label', 'Groups, broadest first');
  const stripBtns = new Map();
  const sections = new Map();
  const cardEls = new Map();

  const list = el('div', 'pers-groups');
  for (const g of data.groups) {
    const sec = el('section', `pers-group g-${g.id}`);
    sec.id = `pg-${g.id}`;
    sec.setAttribute('aria-labelledby', `pg-${g.id}-h`);
    const gh = el('div', 'pers-group-head');
    const gi = el('span', 'gi'); gi.appendChild(icon(g.id));
    const h2 = el('h3');
    h2.id = `pg-${g.id}-h`;
    h2.tabIndex = -1;
    h2.append(g.name, el('span', 'n', g.sub));
    gh.append(gi, h2, el('span', 'order', g.order));
    const cards = el('div', 'pers-cards');
    for (const c of g.cards) { const node = buildCard(c, ctx, now); cardEls.set(c.id, node); cards.appendChild(node); }
    sec.append(gh, cards);
    sections.set(g.id, sec);
    list.appendChild(sec);

    const b = el('button', `g-${g.id}`);
    b.type = 'button';
    const bi = el('span', 'gi'); bi.appendChild(icon(g.id));
    b.append(bi, SHORT[g.id] ?? g.name);
    b.setAttribute('aria-label', `${g.name}, ${g.cards.length} cards`);
    b.addEventListener('click', () => {
      if (b.getAttribute('aria-disabled') === 'true') return;
      sec.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
      h2.focus({ preventScroll: true });
    });
    stripBtns.set(g.id, b);
    strip.appendChild(b);
  }
  bar.append(search, strip);

  const none = el('p', 'pers-muted pers-none', 'No files match these filters. ');
  none.hidden = true;
  const clearBtn = el('button', 'pers-btn', 'Clear filters');
  clearBtn.type = 'button';
  clearBtn.addEventListener('click', () => {
    filters.ai = 'all'; filters.shape = 'all'; filters.q = ''; input.value = '';
    aiSeg.set('all'); shapeSeg.set('all'); saveFilters(filters); apply();
  });
  none.appendChild(clearBtn);

  content.append(stats, bar, list, none);

  function apply() {
    const result = filterGroups(data, filters);
    let shown = 0;
    for (const g of result) {
      const keep = new Set(g.cards.map((c) => c.id));
      for (const c of data.groups.find((x) => x.id === g.id).cards) cardEls.get(c.id).hidden = !keep.has(c.id);
      shown += g.cards.length;
      sections.get(g.id).hidden = g.empty;
      const b = stripBtns.get(g.id);
      if (g.empty) b.setAttribute('aria-disabled', 'true'); else b.removeAttribute('aria-disabled');
      b.classList.toggle('off', g.empty);
      b.setAttribute('aria-label', `${data.groups.find((x) => x.id === g.id).name}, ${g.cards.length} cards`);
    }
    none.hidden = shown > 0;
    countEl.textContent = `${shown} of ${all.length} cards`;
  }
  apply();

  // A link from the Loops lens names a card: open it and bring it into view.
  function openSelected(r) {
    if (r?.sel?.type !== 'card') return;
    const node = cardEls.get(r.sel.id);
    if (!node) return;
    node.hidden = false;
    node.open = true;
    node.setAttribute('open', '');
    node.scrollIntoView?.({ block: 'center' });
  }
  openSelected(route);

  return { ...inert(), update(r) { openSelected(r); }, unmount() { wrap.remove(); } };
}

function inert() { return { update() {}, onState() {}, onEvent() {}, unmount() {} }; }
