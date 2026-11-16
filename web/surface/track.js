// web/surface/track.js
// Tracking one agent: the camera locks on its mark, its recent files are drawn
// as a numbered trail (1 is the oldest of the last twelve), and the board's
// pieces appear around the globe: a breadcrumb header with Stop tracking, a
// telemetry card at the top right, the In view list at the top left (the marks
// inside the current frame, throttled so a drag never pays for it) and a pin
// box at the bottom left. An agent is named by its card, never by a summary.
import { bindItem } from '../shared/interactive-item.js';
import { workspaceSummary } from '../overview/workspace-view.js';
import { ringPlacement, ringRadiusForZoom } from './globe-core.js';
import { mergeEdits } from './timeline.js';
import { normPath, since, basename } from './format.js';
import { agentName } from './agent-name.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const svgEl = (tag, cls) => { const e = document.createElementNS(SVG_NS, tag); if (cls) e.setAttribute('class', cls); return e; };
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

export const TRAIL_LIMIT = 12;
export const INVIEW_LIMIT = 30;
export const INVIEW_MS = 250;
const MARK_TYPES_SKIPPED = new Set(['layer', 'panel', 'stat']);
const TYPE_WORD = { repo: 'repo', agent: 'agent', player: 'player', 'card-stack': 'card stack', folder: 'folder', file: 'file', region: 'region', loop: 'loop', 'alert-pulse': 'alert', arc: 'link' };
const words = (s) => String(s ?? '').replace(/_/g, ' ');
// An absolute path is shown as its last two segments; the card is narrow and
// the full path is in the row's tooltip.
const shortPath = (p) => { const n = normPath(p); return /^([a-zA-Z]:)?\//.test(n) ? n.split('/').filter(Boolean).slice(-2).join('/') : n; };

export function duration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return 'unknown';
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min`;
  return `${(m / 60).toFixed(1)} h`;
}

export const crumbsFor = ({ place, repo, name }) => ['Surface', place, ...(repo ? [repo] : []), `tracking ${name}`];

// The card's latest gate verdict, or why there is none yet.
export function nextGateWord({ card, events = [], now = Date.now(), cardState = null }) {
  if (!card) return 'no card, so no gate';
  const last = events.filter((e) => e.kind === 'gate' && e.cardId === card.id).sort((a, b) => b.ts - a.ts)[0];
  if (last) return `${words(last.state)}, ${since(last.ts, now)}`;
  return cardState ? `not reached, card is ${words(cardState)}` : 'no gate verdict seen';
}

export function pinLine({ repo, row }) {
  if (!repo) return 'Pin on this agent';
  if (!row) return `Pin on ${repo}`;
  if (row.dirty > 0) return `Pin on ${repo}: ${row.dirty} ${row.dirty === 1 ? 'file differs' : 'files differ'} from remote`;
  if (row.ahead > 0 || row.behind > 0) return `Pin on ${repo}: ahead ${row.ahead ?? 0}, behind ${row.behind ?? 0}`;
  return `Pin on ${repo}: in sync with its remote`;
}

// path -> { repo, rel } over the residency rows, longest root first.
export function makeResolver(getRows) {
  return (abs) => {
    const p = normPath(abs).toLowerCase();
    const hit = getRows().map((r) => ({ r, root: normPath(r.path).toLowerCase().replace(/\/+$/, '') }))
      .filter((x) => p.startsWith(`${x.root}/`)).sort((a, b) => b.root.length - a.root.length)[0];
    return hit ? { repo: hit.r.repo, rel: normPath(abs).slice(hit.root.length + 1) } : null;
  };
}

// The marks inside the frame, nearest the centre first.
export function marksInFrame(svg, w, h) {
  const out = [];
  for (const node of svg.querySelectorAll('[data-item-type]')) {
    const type = node.dataset.itemType;
    if (MARK_TYPES_SKIPPED.has(type) || node.getAttribute('display') === 'none') continue;
    const layer = node.closest('[data-layer]');
    if (layer && (layer.getAttribute('display') === 'none' || layer.getAttribute('data-layer') === 'trail')) continue;
    const m = (node.getAttribute('transform') ?? '').match(/translate\(([-\d.]+),([-\d.]+)\)/);
    if (!m) continue;
    const x = parseFloat(m[1]), y = parseFloat(m[2]);
    if (x < 0 || y < 0 || x > w || y > h) continue;
    out.push({ type, id: node.dataset.itemId, label: node.getAttribute('aria-label') ?? node.dataset.itemId, d: Math.hypot(x - w / 2, y - h / 2) });
  }
  return out.sort((a, b) => a.d - b.d);
}

// The three pieces of tracking chrome that are not the telemetry card. They
// exist from mount, hidden, so the lens can move the view-style bar and the
// heat legend into them while an agent is tracked.
export function createTrackUi(stage) {
  const bar = el('div', 'surface-trackbar'); bar.hidden = true;
  const nav = el('nav'); nav.setAttribute('aria-label', 'Tracking breadcrumb');
  const crumbs = el('ol', 'crumbs'); nav.appendChild(crumbs);
  const stop = el('button', 'trk-stop', 'Stop tracking'); stop.type = 'button';
  const right = el('div', 'trackbar-right');
  bar.append(nav, stop, right);

  const inview = el('section', 'surface-inview'); inview.hidden = true; inview.setAttribute('aria-labelledby', 'inview-h');
  const inviewH = el('h2', 'inview-h', 'In view'); inviewH.id = 'inview-h';
  const inviewList = el('ul', 'trk-inview');
  inview.append(inviewH, inviewList);

  const pinbox = el('section', 'surface-pinbox'); pinbox.hidden = true; pinbox.setAttribute('aria-label', 'Pin to card');
  const pinLineEl = el('p', 'pin-line');
  const pinHelp = el('p', 'pin-help', 'A pin becomes a card on Work with this view linked.');
  const pinBtn = el('button', 'pin-file', 'File as card'); pinBtn.type = 'button';
  pinbox.append(pinLineEl, pinHelp, pinBtn);

  stage.append(bar, inview, pinbox);
  return { bar, crumbs, stop, right, inview, inviewH, inviewList, pinbox, pinLineEl, pinBtn, destroy() { bar.remove(); inview.remove(); pinbox.remove(); } };
}

export function createTracker({ api, stage, dock, timeline, edits, resolve, getState, onChange, ui, onPin }) {
  const group = api.globe.layerGroup('trail');
  let id = null;
  let trail = [];
  let trailSig = '';
  let pts = [];
  let line = null;
  let flying = false;
  let viewTimer = null;
  let viewSig = '';
  const refs = {};
  const sessionRows = () => mergeEdits({ edits: edits.get().edits, events: timeline.get().events, asOf: timeline.asOf(), resolve }).filter((e) => e.sessionId === id);
  ui.stop.addEventListener('click', () => api.stopTrack());
  ui.pinBtn.addEventListener('click', () => { if (id) onPin?.(id); });

  function buildTrail() {
    const mine = sessionRows();
    trail = mine.slice(0, TRAIL_LIMIT).reverse();
    const sig = trail.map((e) => `${e.path}@${e.ts}`).join('|');
    return { mine, changed: sig !== trailSig, sig };
  }

  function drawTrail() {
    group.textContent = '';
    pts = []; line = null;
    if (!id) return;
    line = svgEl('path', 'trail-line'); group.appendChild(line);
    trail.forEach((e, i) => {
      const g = svgEl('g', `trail-pt${e.repo ? '' : ' trail-pt-loose'}`);
      g.appendChild(svgEl('circle', 'trail-dot')).setAttribute('r', '9');
      const t = svgEl('text', 'trail-n'); t.textContent = String(i + 1); g.appendChild(t);
      const name = e.rel ?? basename(e.path);
      const tip = svgEl('title'); tip.textContent = `${i + 1}. ${name}`; g.appendChild(tip);
      if (e.repo) {
        const fid = `${e.repo}/${e.rel}`;
        bindItem(g, { type: 'file', id: fid, link: api.link({ type: 'file', id: fid }), open: () => api.open({ type: 'file', id: fid }), label: `Trail step ${i + 1}: ${name}` });
      } else g.setAttribute('aria-hidden', 'true');
      group.appendChild(g);
      pts.push({ e, g });
    });
  }

  function place(project, cam) {
    if (!id) return;
    const perRepo = new Map(); const loose = [];
    pts.forEach((p) => { if (p.e.repo) { if (!perRepo.has(p.e.repo)) perRepo.set(p.e.repo, []); perRepo.get(p.e.repo).push(p); } else loose.push(p); });
    const put = (p, ll) => { const s = ll ? project(ll) : null; p.xy = s; if (s) { p.g.removeAttribute('display'); p.g.setAttribute('transform', `translate(${s[0].toFixed(1)},${s[1].toFixed(1)})`); } else p.g.setAttribute('display', 'none'); };
    for (const [repo, list] of perRepo) {
      const centre = api.repoPos?.(repo) ?? api.localPos();
      list.forEach((p, i) => put(p, ringPlacement(centre, list.length, i, ringRadiusForZoom(0.9, cam.k))));
    }
    loose.forEach((p, i) => put(p, ringPlacement(api.localPos(), loose.length, i, ringRadiusForZoom(1.8, cam.k))));
    const head = api.agentPos?.(id, cam.k);
    const headXY = head ? project(head) : null;
    const seq = [...pts.map((p) => p.xy), headXY].filter(Boolean);
    line?.setAttribute('d', seq.length > 1 ? `M${seq.map((s) => `${s[0].toFixed(1)},${s[1].toFixed(1)}`).join('L')}` : '');
  }
  api.globe.layerGroup('trail', place);

  // The telemetry card: card and title, then what the agent is doing, then the trail.
  function buildCard() {
    dock.body.textContent = '';
    refs.headBox = el('div', 'trk-headbox');
    refs.id = el('span', 'trk-id');
    refs.title = el('div', 'trk-title');
    refs.headBox.append(refs.id, refs.title);
    refs.facts = el('dl', 'insp-facts trk-facts');
    refs.trailH = el('h3', 'sub-h', 'Trail');
    refs.trail = el('ol', 'trk-trail');
    refs.empty = el('p', 'band-empty trk-empty');
    const acts = el('div', 'trk-acts');
    const centre = el('button', 'fa-btn', 'Re-centre'); centre.type = 'button'; centre.addEventListener('click', () => relock(true));
    acts.appendChild(centre);
    dock.body.append(refs.headBox, refs.facts, refs.trailH, refs.trail, refs.empty, acts);
  }

  const stageWord = () => `${refs.stageName}, ${duration((timeline.asOf() ?? Date.now()) - refs.stageTs)} here`;

  function renderFacts() {
    if (!id) return;
    const st = getState?.() ?? null;
    const sess = (st?.sessions ?? []).find((s) => s.id === id);
    const row = (st?.board?.rows ?? []).find((r) => r.id === id);
    const w = (api.data.workspace?.ok ? api.data.workspace.data.sessions ?? [] : []).find((x) => x.sessionId === id);
    const sum = w ? workspaceSummary(w) : null;
    const last = sessionRows()[0];
    const card = sess?.card?.id ? sess.card : null;
    const name = agentName(st, id);
    refs.id.textContent = name;
    refs.title.textContent = card?.title ?? (card ? '' : 'No card on this session');
    refs.title.title = refs.title.textContent;
    const tool = row?.tool ?? last?.tool ?? sess?.tool ?? null;
    const model = sess?.status?.model?.displayName ?? null;
    const cost = sess?.status?.cost?.totalUsd;
    const more = (sum?.paths.length ?? 0) - 3;
    const cardState = card ? (api.data.backlog?.ok ? api.data.backlog.data.items ?? [] : []).find((c) => c.id === card.id)?.state ?? null : null;
    refs.stageName = row?.stageName ?? null;
    refs.stageTs = row?.enteredTs ?? null;
    const facts = [
      ['stage', row ? (refs.stageTs ? stageWord() : row.stageName) : 'not on the board'],
      ['tool', tool ? [tool, model].filter(Boolean).join(', ') : 'not captured'],
      ['declared', sum?.goal || w?.declared?.goal || 'none declared'],
      ['observed', sum?.paths.length ? `${sum.paths.slice(0, 3).map(shortPath).join(', ')}${more > 0 ? ` and ${more} more` : ''}` : 'nothing observed yet'],
      ['drift', sum?.drift ?? 'not measured'],
      ['spend', typeof cost === 'number' ? `$${cost.toFixed(2)}` : 'not recorded'],
      ['next gate', nextGateWord({ card, events: timeline.get().events, now: timeline.asOf() ?? Date.now(), cardState })],
    ];
    refs.facts.textContent = '';
    for (const [k, v] of facts) {
      refs.facts.appendChild(el('dt', null, k));
      const dd = el('dd', k === 'drift' && sum ? `trk-drift trk-drift-${sum.drift}` : null, String(v));
      dd.title = String(v);
      if (k === 'stage' && refs.stageTs) refs.stage = dd; else if (k === 'stage') refs.stage = null;
      refs.facts.appendChild(dd);
    }
    renderChrome(st, name);
  }

  // Breadcrumb and pin box: where the agent is, in which repository.
  function renderChrome(st, name) {
    const repoName = api.agentList?.().find((a) => a.id === id)?.repo ?? null;
    const place = api.players?.find((p) => p.id === 'local')?.name ?? 'Local store';
    ui.crumbs.textContent = '';
    for (const c of crumbsFor({ place, repo: repoName, name })) ui.crumbs.appendChild(el('li', 'crumb', c));
    ui.crumbs.lastChild?.setAttribute('aria-current', 'page');
    const rows = api.data.residency?.ok ? api.data.residency.data.rows ?? [] : [];
    ui.pinLineEl.textContent = pinLine({ repo: repoName, row: rows.find((r) => r.repo === repoName) ?? null });
  }

  function renderTrail() {
    refs.trail.textContent = '';
    refs.empty.hidden = trail.length > 0;
    refs.empty.textContent = trail.length ? '' : (edits.get().status === 'error' ? `Recent edits not available: ${edits.get().error}` : 'No file edits seen for this agent at this time.');
    trail.forEach((e, i) => {
      const li = el('li', 'trk-step'); const row = el('div', 'trk-row'); li.appendChild(row);
      const name = e.rel ?? basename(e.path);
      row.appendChild(el('span', 'trk-n', String(i + 1)));
      row.appendChild(el('span', 'trk-file', name));
      row.appendChild(el('span', 'trk-meta', `${e.add != null ? `+${e.add} -${e.del ?? 0}  ` : ''}${since(e.ts)}`));
      if (e.repo) { const fid = `${e.repo}/${e.rel}`; bindItem(li, { type: 'file', id: fid, link: api.link({ type: 'file', id: fid }), open: () => api.open({ type: 'file', id: fid }), label: `Trail step ${i + 1}: ${name}` }); }
      refs.trail.appendChild(li);
    });
  }

  function updateInView() {
    viewTimer = null;
    if (!id) return;
    const r = stage.getBoundingClientRect();
    const list = marksInFrame(api.globe.svg, r.width, r.height);
    const sig = list.map((m) => `${m.type}:${m.id}`).join('|');
    if (sig === viewSig) return;
    viewSig = sig;
    ui.inviewH.textContent = `In view (${list.length})`;
    ui.inviewList.textContent = '';
    if (!list.length) ui.inviewList.appendChild(el('li', 'band-empty', 'Nothing is marked inside this frame.'));
    for (const m of list.slice(0, INVIEW_LIMIT)) {
      const li = el('li', 'trk-vrow'); const row = el('div', 'trk-row'); li.appendChild(row);
      row.appendChild(el('span', `trk-dot trk-dot-${m.type}`));
      row.appendChild(el('span', 'trk-vl', m.label));
      row.appendChild(el('span', 'trk-vt', TYPE_WORD[m.type] ?? m.type));
      bindItem(li, { type: m.type, id: m.id, link: api.link({ type: m.type, id: m.id }), open: () => api.open({ type: m.type, id: m.id }), label: m.label });
      ui.inviewList.appendChild(li);
    }
    if (list.length > INVIEW_LIMIT) ui.inviewList.appendChild(el('li', 'band-empty', `${list.length - INVIEW_LIMIT} more in view, zoom in to narrow it.`));
  }
  // Called from every globe render; the work happens at most once per window.
  function scheduleInView() { if (id && !viewTimer) viewTimer = setTimeout(updateInView, INVIEW_MS); }

  function relock(force = false) {
    if (!id) return;
    const c = api.globe.getCamera();
    const p = api.agentPos?.(id, c.k);
    if (!p) return;
    if (!force && Math.abs(c.lon - p[0]) < 0.01 && Math.abs(c.lat - p[1]) < 0.01) return;
    api.globe.setCamera({ lon: p[0], lat: p[1], k: c.k }, { silent: true });
  }

  function refresh() {
    if (!id) return;
    const t = buildTrail();
    if (t.changed) { trailSig = t.sig; drawTrail(); renderTrail(); }
    renderFacts();
    api.globe.render();
  }

  const show = (on) => { ui.bar.hidden = !on; ui.inview.hidden = !on; ui.pinbox.hidden = !on; };

  const tracker = {
    active: () => id,
    isFlying: () => flying,
    async start(next) {
      const p = api.agentPos?.(next, 1);
      if (!p) { api.inspect({ title: 'Cannot track', empty: 'That agent is not in the live sessions feed, so it has no mark to follow.' }); return false; }
      if (id && id !== next) tracker.stop(false);
      id = next; trailSig = ''; viewSig = '';
      api.showLayer?.('agents');
      buildCard();
      refresh();
      show(true);
      dock.open();
      onChange?.();
      const k = Math.max(api.globe.getCamera().k, 5);
      const to = api.agentPos(next, k);
      flying = true;
      try { await api.globe.flyTo({ lon: to[0], lat: to[1], k }); } finally { flying = false; }
      if (id !== next) return true;
      scheduleInView();
      return true;
    },
    stop(notify = true) {
      if (!id) return;
      id = null; trail = []; trailSig = ''; viewSig = '';
      clearTimeout(viewTimer); viewTimer = null;
      group.textContent = ''; pts = []; line = null;
      show(false);
      dock.close();
      api.globe.render();
      if (notify) onChange?.();
    },
    refresh,
    relock,
    scheduleInView,
    onState() { if (id) renderFacts(); },
    // Cheap per-tick text: time in stage keeps counting between state pushes.
    tick() { if (id && refs.stage && refs.stageTs) refs.stage.textContent = stageWord(); },
    destroy() { clearTimeout(viewTimer); viewTimer = null; id = null; },
  };
  return tracker;
}
