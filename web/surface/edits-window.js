// web/surface/edits-window.js
// The recent-edits window: every file a running or idle session has just
// written, newest first, with the diff one click away and the pop-out editor
// and the IDE one more. The list comes from the shared edits store (refreshed
// every few seconds); the diff for a repository file is read from git, for any
// other file from the change the session's own event carried.
import { bindItem } from '../shared/interactive-item.js';
import { renderDiff } from '../shared/diff-view.js';
import { basename, since } from './format.js';
import { agentName } from './agent-name.js';

export const EDITS_ITEM_TYPES = { edit: 'a file a session is editing or has just edited, with its diff' };
export const editId = (e) => `${e.sessionId}|${e.path}`;

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const toast = (msg) => window.dispatchEvent(new CustomEvent('mc-toast', { detail: String(msg) }));
const CACHE_MAX = 200;

export function createEditsWindow(dock, { api, store, actions }) {
  const cache = new Map();
  let selected = null;
  let lastSig = null;
  const list = el('div', 'elist');
  const pane = el('div', 'epane'); pane.hidden = true;
  dock.body.append(list, pane);
  dock.subEl.hidden = true;

  const ordered = () => [...store.get().edits].sort((a, b) => b.ts - a.ts);
  const find = (id) => store.get().edits.find((e) => editId(e) === id) ?? null;

  function loadDiff(e) {
    const key = `${editId(e)}|${e.ts}`;
    const hit = cache.get(key);
    if (hit) return hit.promise;
    const entry = { done: false, change: null, error: null, source: null };
    entry.promise = (async () => {
      if (e.repo && e.rel) {
        try {
          const res = await fetch(`/api/surface/file-diff?repo=${encodeURIComponent(e.repo)}&path=${encodeURIComponent(e.rel)}`);
          const body = await res.json();
          if (!res.ok) throw new Error(body.error ?? `GET /api/surface/file-diff returned ${res.status}`);
          if (body.change) { entry.change = body.change; entry.source = 'git'; }
        } catch (err) { entry.error = err.message; }
      }
      if (!entry.change && e.change) { entry.change = e.change; entry.source = 'session'; }
      entry.done = true;
      return entry;
    })();
    cache.set(key, entry);
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    return entry.promise;
  }
  const cachedFor = (e) => cache.get(`${editId(e)}|${e.ts}`) ?? null;

  function drawPane() {
    pane.textContent = '';
    const e = selected ? find(selected) : null;
    pane.hidden = !e;
    if (!e) return;
    const head = el('div', 'epane-head');
    head.appendChild(el('span', 'epath', e.path));
    pane.appendChild(head);
    const body = el('div', 'ediff'); pane.appendChild(body);
    const entry = cachedFor(e);
    if (!entry?.done) { body.appendChild(el('p', 'band-empty', 'Loading the diff.')); return; }
    if (entry.error) body.appendChild(el('p', 'band-error', `Could not load the diff: ${entry.error}`));
    if (entry.change) {
      body.appendChild(el('p', 'epane-src', entry.source === 'git' ? 'Changed since the last commit, from git.' : 'Captured from the session\'s own edit.'));
      body.appendChild(renderDiff(entry.change));
    } else if (!entry.error) body.appendChild(el('p', 'band-empty', 'No diff captured for this file'));
  }

  function select(id) {
    const e = find(id);
    if (!e) return false;
    selected = id;
    for (const r of list.querySelectorAll('.erow')) r.classList.toggle('sel', r.dataset.id === id);
    drawPane();
    loadDiff(e).then(() => { if (!api.destroyed && selected === id) drawPane(); });
    return true;
  }

  const sigOf = (edits) => edits.map((e) => `${editId(e)}|${e.ts}|${e.state}|${e.size == null && e.mtimeMs == null ? 'gone' : 'here'}`).join('\n');

  function drawList() {
    list.textContent = '';
    const { status, error, edits } = store.get();
    if (status === 'error') { list.appendChild(el('p', 'band-error', `Recent edits not available: ${error}`)); pane.hidden = true; return; }
    if (status === 'loading') { for (let i = 0; i < 3; i++) list.appendChild(el('div', 'erow skel')); return; }
    if (!edits.length) { list.appendChild(el('p', 'band-empty', 'No running or idle session has written a file recently.')); pane.hidden = true; return; }
    for (const e of ordered()) {
      const id = editId(e);
      const gone = e.size == null && e.mtimeMs == null;
      const row = el('div', `erow${id === selected ? ' sel' : ''}`); row.dataset.id = id;
      const main = el('div', 'erow-main');
      const dot = el('span', `dot ${e.state}`); dot.title = e.state === 'working' ? 'The session is working' : 'The session is idle';
      const line1 = el('span', 'l1');
      line1.appendChild(el('span', 'name', basename(e.path)));
      line1.appendChild(el('span', 'ed add', `+${e.add ?? '?'}`));
      line1.appendChild(el('span', 'ed del', `-${e.del ?? '?'}`));
      const age = el('span', 'age', since(e.ts)); age.dataset.ts = String(e.ts);
      line1.appendChild(age);
      const line2 = el('span', 'l2');
      if (gone) line2.appendChild(el('span', 'lchip gap', 'deleted'));
      line2.appendChild(document.createTextNode(`${e.repo ?? 'outside a repository'}  ${agentName(api.ctx?.getState?.(), e.sessionId)}`));
      const text = el('span', 'etext'); text.append(line1, line2);
      main.append(dot, text);
      bindItem(main, { type: 'edit', id, link: api.link({ type: 'edit', id }), open: () => api.open({ type: 'edit', id }), label: `${basename(e.path)}, ${e.state === 'working' ? 'being edited' : 'edited'} by ${agentName(api.ctx?.getState?.(), e.sessionId)}, ${e.repo ?? 'outside a repository'}` });
      const acts = el('span', 'erow-actions');
      const edit = el('button', 'fa-btn', 'Edit'); edit.type = 'button'; edit.title = 'Open in the pop-out editor, with this diff';
      edit.addEventListener('click', async () => {
        try { const entry = await loadDiff(e); if (!api.destroyed) await actions.openFileEditor(e.path, { diff: entry.change ?? undefined }); }
        catch (err) { toast(`Could not open the editor: ${err.message}`); }
      });
      const ide = el('button', 'fa-btn', 'Open in IDE'); ide.type = 'button'; ide.title = 'Open in your IDE';
      ide.addEventListener('click', () => actions.openFileInIde(e.path));
      acts.append(edit, ide);
      row.append(main, acts);
      list.appendChild(row);
    }
    if (selected && !find(selected)) selected = null;
    drawPane();
  }

  function refresh() {
    const sig = `${store.get().status}|${sigOf(store.get().edits)}`;
    if (sig !== lastSig) { lastSig = sig; drawList(); return; }
    // Same rows: only the ages move, so keyboard focus is never torn away.
    for (const a of list.querySelectorAll('.age')) a.textContent = since(Number(a.dataset.ts));
  }

  api.registerOpener('edit', (id) => { if (!find(id)) return false; dock.open(); return select(id); });
  refresh();
  return { unsubscribe: store.subscribe(() => { if (!api.destroyed) refresh(); }), select };
}
