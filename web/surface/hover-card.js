// web/surface/hover-card.js
// The hover card: one tooltip element that answers pointerover and focus on any
// [data-item-type] inside the lens. It shows within the same event, from data
// the lens already loaded: it never touches the network. A pointer press (the
// start of a drag), a wheel turn or Escape hides it.
import { hostLabel } from './layers.js';
import { RESIDENCY_WORD, RESIDENCY_GLYPH } from './globe-core.js';
import { DATA_TYPES, fmt } from './ledger.js';
import { basename, bytes, normPath, since, stamp } from './format.js';
import { agentName } from './agent-name.js';

const CARD_ID = 'surface-hovercard';
const GAP = 14;
const MARGIN = 8;
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

export function createHoverCard(root, { modelFor }) {
  const card = el('div', 'surface-hovercard');
  card.id = CARD_ID; card.setAttribute('role', 'tooltip'); card.hidden = true;
  const title = el('p', 'hc-title'); const word = el('p', 'hc-word'); const facts = el('dl', 'hc-facts'); const hint = el('p', 'hc-hint');
  card.append(title, word, facts, hint);
  root.appendChild(card);

  let current = null;
  let model = null;
  let down = false;
  const listeners = [];
  const on = (target, type, fn, opts) => { target.addEventListener(type, fn, opts); listeners.push([target, type, fn, opts]); };

  function place(point) {
    const vw = window.innerWidth || 1200, vh = window.innerHeight || 800;
    const r = card.getBoundingClientRect();
    const w = r.width || 240, h = r.height || 120;
    let x, y;
    if (point) { x = point.x + GAP; y = point.y + GAP; }
    else { const a = current.getBoundingClientRect(); x = a.right + GAP / 2; y = a.top; }
    if (x + w > vw - MARGIN) x = (point ? point.x - GAP : x) - w;
    if (y + h > vh - MARGIN) y = (point ? point.y - GAP : y) - h;
    x = Math.max(MARGIN, Math.min(x, vw - w - MARGIN));
    // The app topbar stacks above the lens, so the card never rises past the lens's own top.
    const floor = Math.max(MARGIN, (root.getBoundingClientRect?.().top ?? 0) + MARGIN);
    y = Math.max(floor, Math.min(y, vh - h - MARGIN));
    card.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }

  function hide() {
    if (current) current.removeAttribute('aria-describedby');
    current = null; model = null;
    card.hidden = true;
  }

  function show(target, point = null) {
    if (!target || target === current) { if (target && point) place(point); return; }
    const m = modelFor(target.dataset.itemType, target.dataset.itemId, target);
    if (!m) { hide(); return; }
    if (current) current.removeAttribute('aria-describedby');
    current = target; model = m;
    title.textContent = m.title;
    word.textContent = m.word ?? ''; word.hidden = !m.word;
    facts.textContent = '';
    for (const [k, v] of m.facts ?? []) { facts.appendChild(el('dt', null, k)); facts.appendChild(el('dd', null, v == null ? 'none' : String(v))); }
    facts.hidden = !(m.facts?.length);
    hint.textContent = m.hint ?? ''; hint.hidden = !m.hint;
    card.hidden = false;
    target.setAttribute('aria-describedby', CARD_ID);
    place(point);
  }

  const itemOf = (e) => (e.target?.closest ? e.target.closest('[data-item-type]') : null);
  on(root, 'pointerover', (e) => { if (down) return; const it = itemOf(e); if (it) show(it, { x: e.clientX ?? 0, y: e.clientY ?? 0 }); });
  on(root, 'pointermove', (e) => {
    if (!current || down) return;
    if (!root.contains(current)) { hide(); return; }
    place({ x: e.clientX ?? 0, y: e.clientY ?? 0 });
  });
  on(root, 'pointerout', (e) => { if (current && !current.contains(e.relatedTarget)) hide(); });
  on(root, 'focusin', (e) => { const it = itemOf(e); if (it) show(it); });
  on(root, 'focusout', () => hide());
  on(root, 'pointerdown', () => { down = true; hide(); });
  on(root, 'wheel', () => hide(), { passive: true });
  const release = () => { down = false; };
  on(window, 'pointerup', release);
  on(window, 'pointercancel', release);
  on(window, 'keydown', (e) => { if (e.key === 'Escape') hide(); });

  return {
    show, hide, el: card,
    isShown: () => !card.hidden,
    // The absolute path of the file the card is about, while it is shown.
    fileTarget: () => (model?.file && !card.hidden ? model.file : null),
    // The bound item the card is about, for keys that act on it (T tracks an agent).
    itemTarget: () => (current && !card.hidden ? { type: current.dataset.itemType, id: current.dataset.itemId } : null),
    destroy() {
      for (const [t, type, fn, opts] of listeners) t.removeEventListener(type, fn, opts);
      listeners.length = 0;
      hide(); card.remove();
    },
  };
}

const FILE_WORD = { uncommitted: 'uncommitted', untracked: 'untracked', ahead: 'ahead of the remote', behind: 'behind the remote', clean: 'in sync' };

// Builds the synchronous model for every item type from data the lens holds.
export function buildModelFor({ api, layers, built, launchers, state, itemTypes }) {
  const residency = () => (api.data.residency?.ok ? api.data.residency.data.rows ?? [] : []);
  const rowOf = (repo) => residency().find((r) => r.repo === repo);
  const absOf = (row, rel) => `${String(row.path).replace(/[\\/]+$/, '')}/${rel}`;
  const split = (id) => { const i = id.indexOf('/'); return i < 0 ? [id, ''] : [id.slice(0, i), id.slice(i + 1)]; };
  const sessionTitle = (e) => agentName(api.ctx?.getState?.(), e.sessionId);
  const repoOfPath = (abs) => {
    const p = normPath(abs).toLowerCase().replace(/\/+$/, '');
    return residency().filter((r) => { const rp = normPath(r.path).toLowerCase().replace(/\/+$/, ''); return p === rp || p.startsWith(`${rp}/`); })
      .sort((a, b) => b.path.length - a.path.length)[0] ?? null;
  };

  // The facts every file shows, wherever the file is listed from.
  const fileModel = (abs, { repo, status, size, mtimeMs, title }) => {
    const last = api.edits.latestFor(abs);
    const lastBy = last ? `${sessionTitle(last)}, ${since(last.ts)}` : (api.edits.get().status === 'ok' ? 'no session edit in the recent window' : 'recent edits not loaded');
    return {
      title: title ?? basename(abs), word: FILE_WORD[status] ?? status ?? null,
      facts: [['path', abs], ['repository', repo ?? 'outside every repository'], ['status', FILE_WORD[status] ?? status ?? 'not compared'], ['size', size == null ? 'unknown' : bytes(size)], ['modified', mtimeMs == null ? 'unknown' : `${stamp(mtimeMs)}, ${since(mtimeMs)}`], ['last edited by', lastBy]],
      hint: 'E edits this file, I opens it in your IDE', file: abs,
    };
  };

  const ledgerType = (id) => api.ledgerStore.get().types.find((t) => t.id === id);

  const models = {
    layer: (id) => {
      const l = layers.find((x) => x.id === id);
      return l ? { title: l.label, word: `Source: ${l.source}`, facts: [['key', l.key], ['items', built.get(id)?.count ?? 'drawn'], ['shown', state.layers.has(id) ? 'yes' : 'no']] } : null;
    },
    repo: (id) => {
      const r = rowOf(id); if (!r) return null;
      return { title: r.repo, word: `${RESIDENCY_GLYPH[r.residency] ?? ''} ${RESIDENCY_WORD[r.residency] ?? r.residency}`.trim(), facts: [['path', r.path], ['remote', r.remote ? hostLabel(r.remote) : 'none, exists nowhere else'], ['ahead', r.ahead], ['behind', r.behind], ['uncommitted paths', r.dirty], ['unpushed branches', r.unpushedBranches?.length ?? 0]] };
    },
    arc: (id) => {
      const r = rowOf(id); if (!r) return null;
      return { title: `${r.repo} to ${hostLabel(r.remote)}`, word: RESIDENCY_WORD[r.residency] ?? r.residency, facts: [['remote', r.remote], ['ahead', r.ahead], ['behind', r.behind]] };
    },
    region: () => { const rows = residency().filter((r) => !r.remote); return { title: 'Nowhere else', word: `${rows.length} repositories have no remote`, facts: [['repositories', rows.slice(0, 6).map((r) => r.repo).join(', ') || 'none']] }; },
    player: (id) => {
      const p = api.players?.find((x) => x.id === id); if (!p) return null;
      return { title: p.name, word: `${p.where}, evidence ${p.evidence}`, facts: [...(p.note ? [['note', p.note]] : []), ...p.holds.map((h) => [h, api.holdCount?.(h)])] };
    },
    folder: (id) => {
      const [repo, dir] = split(id);
      const f = api.trees?.get(repo)?.tree.folders.find((x) => x.dir === dir);
      return { title: `${repo}/${dir}`, word: f ? `${f.count} files, ${f.drifted} differ from the remote` : null, facts: [['repository', repo], ['folder', dir]] };
    },
    file: (id) => {
      const [repo, rel] = split(id);
      const row = rowOf(repo); if (!row) return { title: rel || id, facts: [['repository', repo]] };
      const f = api.trees?.get(repo)?.tree.files.find((x) => x.path === rel);
      return fileModel(absOf(row, rel), { repo, status: f?.status ?? 'clean', size: f?.size, mtimeMs: f?.mtimeMs, title: rel });
    },
    agent: (id) => {
      const s = (api.data.live?.ok ? api.data.live.data.sessions ?? [] : []).find((x) => x.id === id);
      const w = (api.data.workspace?.ok ? api.data.workspace.data.sessions ?? [] : []).find((x) => x.sessionId === id);
      if (!s && !w) return null;
      const repo = s ? api.repoFor?.(s.cwd) : null;
      return { title: agentName(api.ctx?.getState?.(), id), word: repo ? `working in ${repo.repo}` : 'working outside every registered repository', facts: [['session', id], ['working directory', s?.cwd ?? 'not captured'], ['last activity', s?.lastTs ? since(s.lastTs) : 'never'], ['declared goal', w?.declared?.goal ?? 'none declared'], ['files edited', api.edits.forSession(id).length]], hint: 'T tracks this agent' };
    },
    'card-stack': (id) => {
      const items = (api.data.backlog?.ok ? api.data.backlog.data.items ?? [] : []).filter((c) => ['queued', 'held', 'in_progress', 'in_review'].includes(c.state));
      const list = items.filter((c) => (id === 'slack' ? c.origin?.via === 'slack' : c.origin?.via !== 'slack'));
      return { title: `${list.length} cards ${id === 'slack' ? 'born in Slack' : 'at the local store'}`, facts: [['in flight', list.slice(0, 5).map((c) => c.id).join(', ') || 'none']] };
    },
    card: (id) => {
      const c = (api.data.backlog?.ok ? api.data.backlog.data.items ?? [] : []).find((x) => x.id === id);
      return c ? { title: c.id, word: c.state, facts: [['title', c.title], ['origin', c.origin?.via ?? 'local']] } : { title: id, facts: [] };
    },
    'provider-arc': (id) => {
      const p = (api.data.usage?.ok ? api.data.usage.data.providers ?? [] : []).find((x) => x.id === id); if (!p) return null;
      return { title: `Usage to ${p.label ?? p.id}`, word: 'From the local store, last 7 days', facts: [['spend', p.spendUsd == null ? 'not recorded' : `$${p.spendUsd.toFixed(2)}`], ['tokens', fmt(p.tokens)], ['sessions', p.sessions ?? 0]] };
    },
    panel: (id) => {
      const l = launchers.find((x) => x.id === id);
      return { title: l?.label ?? id, word: l?.isOn() ? 'Open. Click to close it.' : 'Closed. Click to open it.' };
    },
    divergence: (id) => {
      const w = (api.data.workspace?.ok ? api.data.workspace.data.sessions ?? [] : []).find((x) => x.sessionId === id);
      return { title: w?.title ?? id, word: 'Declared goal against observed work', facts: [['declared goal', w?.declared?.goal ?? 'none declared'], ['divergence', w?.divergence?.level ?? w?.divergence ?? 'none']] };
    },
    datatype: (id) => {
      const dt = DATA_TYPES.find((d) => d.id === id); if (!dt) return null;
      const t = ledgerType(id);
      if (!t) return { title: dt.label, word: api.ledgerStore.get().status === 'error' ? 'Data ledger not available' : 'Measuring' };
      const name = (pid) => { const p = api.players?.find((x) => x.id === pid); return p?.short ?? p?.name ?? pid; };
      return { title: t.label ?? dt.label, word: `${fmt(t.count)} on this disk`, facts: [...(t.copies ?? []).map((c) => [name(c.player), c.count == null ? 'held, count not captured' : fmt(c.count)]), ['only on this disk', fmt(t.onlyHere)]] };
    },
    edit: (id, node) => {
      const e = api.edits.get().edits.find((x) => `${x.sessionId}|${x.path}` === id); if (!e) return null;
      const m = fileModel(e.path, { repo: e.repo, status: null, size: e.size, mtimeMs: e.mtimeMs, title: basename(e.path) });
      m.word = `${e.state === 'working' ? 'being edited' : 'edited'} by ${sessionTitle(e)}`;
      m.facts[2] = ['status', e.size == null && e.mtimeMs == null ? 'deleted' : 'on disk'];
      return m;
    },
    // Rows owned by a lazily loaded panel carry their own accessible name.
    decision: (id, node) => ({ title: node?.getAttribute('aria-label') || `Decision ${id}`, word: itemTypes.decision }),
    'policy-rule': (id, node) => ({ title: node?.getAttribute('aria-label') || `Policy rule ${id}`, word: itemTypes['policy-rule'] }),
    'graph-file': (id) => {
      const abs = String(id); const row = repoOfPath(abs);
      return fileModel(abs, { repo: row?.repo, status: null, size: api.edits.latestFor(abs)?.size, mtimeMs: api.edits.latestFor(abs)?.mtimeMs, title: basename(abs) });
    },
  };

  return (type, id, node) => {
    const f = models[type];
    const m = f ? f(id, node) : null;
    return m ?? { title: String(id), word: itemTypes[type] ?? null };
  };
}
