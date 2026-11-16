// web/surface/study-panels.js
// The mockup's panels on live feeds: Repository inspector, Location
// drill-down, File tree, Agents and Kanban. Each row is a bindItem with a deep
// link; each panel says by name which feed is dry instead of going blank.
import { bindItem } from '../shared/interactive-item.js';
import { linkFor } from '../shared/deep-link.js';
import { RESIDENCY_WORD, summarizeResidency } from './globe-core.js';
import { IN_FLIGHT } from './layers.js';
import { fmt, stackFor } from './ledger.js';
import { renderInspector } from './panels.js';
import { basename, since } from './format.js';
import { agentName } from './agent-name.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const note = (body, cls, text) => body.appendChild(el('p', cls, text));

// Re-renders a panel as its feed lands or changes, until the panel is closed.
function live(api, panelId, store, render) {
  const unsub = store.subscribe(() => { if (api.destroyed || !api.panels.has(panelId)) { unsub(); return; } render(); });
  return unsub;
}

const PIN_TONE = { synced: 'sync', ahead: 'drift', behind: 'drift', diverged: 'drift', dirty: 'drift', 'nowhere-else': 'nowhere', unknown: 'unknown' };

function pin() {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 12 12'); svg.setAttribute('class', 'pin'); svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(SVG_NS, 'path');
  p.setAttribute('d', 'M6 1a3.5 3.5 0 0 0-3.5 3.5C2.5 7.5 6 11 6 11s3.5-3.5 3.5-6.5A3.5 3.5 0 0 0 6 1z');
  p.setAttribute('fill', 'currentColor'); svg.appendChild(p);
  return svg;
}

export function renderRepositories(body, api) {
  body.textContent = '';
  const feed = api.data.residency;
  if (!feed?.ok) { note(body, 'band-error', `Residency feed not available: ${feed?.error ?? 'no data'}.`); return; }
  const rows = feed.data.rows ?? [];
  const s = summarizeResidency(rows);
  const sum = el('div', 'rsum');
  for (const [k, v, tone] of [['repositories', s.repos], ['with a remote', s.withRemote], ['nowhere else', s.nowhereElse, 'rust'], ['uncommitted', s.dirty, 'amber']]) {
    const c = el('div'); c.appendChild(el('b', tone ?? '', String(v))); c.appendChild(document.createTextNode(k)); sum.appendChild(c);
  }
  body.appendChild(sum);
  if (!rows.length) { note(body, 'band-empty', 'No repository is registered yet.'); return; }
  note(body, 'panel-note', 'Every repository on this disk against its remote.');
  const list = el('div', 'rlist');
  for (const r of rows) {
    const tone = PIN_TONE[r.residency] ?? 'unknown';
    const row = el('div', `rrow ${tone}`);
    row.appendChild(pin());
    const main = el('div', 'main'); main.appendChild(el('span', 'id', r.repo)); main.appendChild(el('span', 'st', RESIDENCY_WORD[r.residency] ?? r.residency));
    row.appendChild(main);
    row.appendChild(el('span', 'n', `${r.ahead ?? 0} ahead  ${r.behind ?? 0} behind  ${r.dirty ?? 0} dirty`));
    bindItem(row, { type: 'repo', id: r.repo, link: api.link({ type: 'repo', id: r.repo }), open: () => api.open({ type: 'repo', id: r.repo }), label: `${r.repo}: ${RESIDENCY_WORD[r.residency] ?? r.residency}, ${r.ahead ?? 0} ahead, ${r.behind ?? 0} behind, ${r.dirty ?? 0} uncommitted` });
    list.appendChild(row);
  }
  body.appendChild(list);
}

// What one player holds, by data type, from the ledger's copies.
export function renderLocation(body, api, player, model) {
  const store = api.ledgerStore;
  const draw = () => {
    body.textContent = '';
    const head = el('div'); body.appendChild(head); renderInspector(head, model);
    body.appendChild(el('h3', 'sub-h', 'Held here, by data type'));
    const { status, types, error } = store.get();
    if (status === 'error') { note(body, 'band-error', `Data ledger not available: ${error}`); return; }
    if (status !== 'ok') { note(body, 'band-empty', 'Measuring what this player holds.'); return; }
    const segs = stackFor(types, player.id);
    if (!segs.length) { note(body, 'band-empty', 'No data type is recorded as held here.'); return; }
    for (const seg of segs) {
      const t = types.find((x) => x.id === seg.type);
      const row = el('div', 'lrow');
      const sw = el('span', 'sw'); sw.style.background = seg.color; sw.setAttribute('aria-hidden', 'true');
      row.append(sw, el('span', 'nm', seg.label), el('span', 'loc', fmt(seg.count)), el('span', 'chips', player.id === 'local' && (t?.onlyHere ?? 0) > 0 ? `${fmt(t.onlyHere)} only here` : ''));
      bindItem(row, { type: 'datatype', id: seg.type, link: api.link({ type: 'datatype', id: seg.type }), open: () => api.open({ type: 'datatype', id: seg.type }), label: `${seg.label}: ${fmt(seg.count)} at ${player.name}` });
      body.appendChild(row);
    }
  };
  draw();
  return live(api, 'location', store, draw);
}

const FILE_WORD = { uncommitted: 'uncommitted', untracked: 'untracked', ahead: 'ahead', behind: 'behind', clean: 'in sync' };

export function renderFileTree(body, api, pick) {
  body.textContent = '';
  const feed = api.data.residency;
  if (!feed?.ok) { note(body, 'band-error', `Residency feed not available: ${feed?.error ?? 'no data'}.`); return; }
  const rows = feed.data.rows ?? [];
  if (!rows.length) { note(body, 'band-empty', 'No repository is registered yet.'); return; }
  if (!rows.some((r) => r.repo === pick.repo)) pick.repo = (rows.find((r) => r.dirty > 0) ?? rows[0]).repo;
  const sel = el('select', 'tree-pick'); sel.setAttribute('aria-label', 'Repository');
  for (const r of rows) { const o = el('option', null, r.repo); o.value = r.repo; if (r.repo === pick.repo) o.selected = true; sel.appendChild(o); }
  body.appendChild(sel);
  const out = el('div', 'tree-out'); body.appendChild(out);
  sel.addEventListener('change', () => { pick.repo = sel.value; fill(); });
  async function fill() {
    const repo = pick.repo;
    out.textContent = '';
    note(out, 'band-empty', 'Reading the file tree.');
    let entry;
    try { entry = await api.loadTree(repo); } catch (e) {
      if (api.destroyed || pick.repo !== repo) return;
      out.textContent = ''; note(out, 'band-error', `The file tree failed to load: ${e.message}`); return;
    }
    if (api.destroyed || pick.repo !== repo) return;
    const tree = entry.tree;
    out.textContent = '';
    const total = tree.folders.reduce((a, f) => a + f.count, 0);
    const sum = el('div', 'rsum');
    for (const [k, v, tone] of [['files', total], ['folders', tree.folders.length], ['differ', tree.files.length, tree.files.length ? 'amber' : '']]) { const c = el('div'); c.appendChild(el('b', tone, String(v))); c.appendChild(document.createTextNode(k)); sum.appendChild(c); }
    out.appendChild(sum);
    const gl = el('button', 'fa-btn', 'Show on the globe'); gl.type = 'button'; gl.addEventListener('click', () => api.showTree(repo));
    out.appendChild(gl);
    out.appendChild(el('h3', 'sub-h', 'Folders'));
    for (const f of tree.folders) {
      const id = `${repo}/${f.dir}`;
      const row = el('div', `frow${f.drifted ? ' drift' : ''}`);
      row.append(el('span', 'p', f.dir === '.' ? '(root)' : f.dir), el('span', 'n', String(f.count)), el('span', 'd', f.drifted ? `${f.drifted} differ` : ''));
      bindItem(row, { type: 'folder', id, link: api.link({ type: 'folder', id }), open: () => api.open({ type: 'folder', id }), label: `Folder ${f.dir}: ${f.count} files, ${f.drifted} differ from the remote` });
      out.appendChild(row);
    }
    out.appendChild(el('h3', 'sub-h', 'Files that differ'));
    if (!tree.files.length) note(out, 'band-empty', 'Every file matches the remote.');
    for (const f of tree.files.slice(0, 200)) {
      const id = `${repo}/${f.path}`;
      const row = el('div', `frow file ${f.status}`);
      row.append(el('span', 'p', f.path), el('span', 'st', FILE_WORD[f.status] ?? f.status));
      bindItem(row, { type: 'file', id, link: api.link({ type: 'file', id }), open: () => api.open({ type: 'file', id }), label: `${f.path}: ${FILE_WORD[f.status] ?? f.status}` });
      out.appendChild(row);
    }
    if (tree.files.length > 200 || tree.truncated) note(out, 'band-empty', 'The list is capped; the repository has more.');
  }
  fill();
}

export function renderAgents(body, api) {
  const draw = () => {
    body.textContent = '';
    const live_ = api.data.live;
    if (!live_?.ok) { note(body, 'band-error', `Agents not available: ${live_?.error ?? 'no data'}.`); return; }
    const sessions = live_.data.sessions ?? [];
    if (!sessions.length) { note(body, 'band-empty', 'No session is running or idle right now.'); return; }
    const ws = new Map((api.data.workspace?.ok ? api.data.workspace.data.sessions : []).map((w) => [w.sessionId, w]));
    const edits = api.edits.get();
    for (const s of sessions) {
      const w = ws.get(s.id);
      const repo = api.repoFor?.(s.cwd);
      const row = el('div', 'arow live');
      row.appendChild(el('span', 't', agentName(api.ctx.getState?.(), s.id)));
      row.appendChild(el('span', 'ago', s.lastTs ? since(s.lastTs) : 'no activity'));
      const d = el('div', 'd');
      d.appendChild(document.createTextNode(repo ? 'in ' : 'outside every registered repository'));
      if (repo) d.appendChild(el('b', null, repo.repo));
      row.appendChild(d);
      const chips = el('div', 'chips');
      const mine = api.edits.forSession(s.id);
      if (edits.status === 'error') chips.appendChild(el('span', 'lchip gap', 'edits not available'));
      else if (edits.status !== 'ok') chips.appendChild(el('span', 'lchip skel', 'reading edits'));
      else if (!mine.length) chips.appendChild(el('span', 'lchip gap', 'no edits seen'));
      for (const e of mine.slice(0, 6)) chips.appendChild(el('span', 'lchip ok', `${basename(e.path)} +${e.add ?? '?'} -${e.del ?? '?'}`));
      if (mine.length > 6) chips.appendChild(el('span', 'lchip', `${mine.length - 6} more`));
      row.appendChild(chips);
      bindItem(row, { type: 'agent', id: s.id, link: api.link({ type: 'agent', id: s.id }), open: () => api.open({ type: 'agent', id: s.id }), label: `Agent ${agentName(api.ctx.getState?.(), s.id)}${repo ? ` in ${repo.repo}` : ', not a project'}` });
      body.appendChild(row);
    }
  };
  draw();
  return live(api, 'agents', api.edits, draw);
}

