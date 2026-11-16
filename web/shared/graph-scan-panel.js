// web/shared/graph-scan-panel.js
// The secondary graph scan dialog (card glmps-2-0-101), opened from the
// settings gear. Lists every root the app knows with its scope and the
// classifier's reason, switches the machine scan on or off, and opts machine
// candidates in one repo at a time. The pure functions at the top decide every
// piece of text and are tested without a DOM. textContent only; no innerHTML.
import { getGraphMachine, setGraphMachine, buildMachineGraph } from './api.js';
import { clear } from './dom-util.js';

const SCOPE_ORDER = { ship: 0, machine: 1, excluded: 2 };

/** Ship first, then machine candidates, then excluded; by path within each. */
export function sortRoots(roots = []) {
  return [...roots].sort((a, b) => (SCOPE_ORDER[a.scope] ?? 3) - (SCOPE_ORDER[b.scope] ?? 3)
    || String(a.root).localeCompare(String(b.root)));
}

export function scopePill(row, enabled) {
  if (row.scope === 'ship') return { label: 'Ship', tone: 'success' };
  if (row.scope === 'machine') {
    if (row.optedIn) return { label: 'Opted in', tone: 'success' };
    return { label: enabled ? 'Not opted in' : 'Candidate', tone: 'neutral' };
  }
  return { label: 'Excluded', tone: 'neutral' };
}

export function scanSummary(view) {
  const roots = view?.roots ?? [];
  const cands = roots.filter((r) => r.scope === 'machine');
  const opted = cands.filter((r) => r.optedIn).length;
  const state = view?.enabled ? 'scan on' : 'scan off';
  return `${cands.length} ${cands.length === 1 ? 'candidate' : 'candidates'} \u00B7 ${opted} opted in \u00B7 ${state}`;
}

export function mergedLine(view, now = Date.now()) {
  const m = view?.manifest;
  if (!m?.builtAt) return 'No merged machine graph yet.';
  const n = Array.isArray(m.roots) ? m.roots.length : 0;
  const ago = Math.max(0, now - Date.parse(m.builtAt));
  const when = ago < 60_000 ? 'just now' : ago < 3_600_000 ? `${Math.floor(ago / 60_000)}m ago`
    : ago < 86_400_000 ? `${Math.floor(ago / 3_600_000)}h ago` : `${Math.floor(ago / 86_400_000)}d ago`;
  return `Merged machine graph: ${n} ${n === 1 ? 'repo' : 'repos'}, ${Number(m.nodes ?? 0).toLocaleString('en-US')} nodes, built ${when}.`;
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
function button(label, cls, onClick) {
  const b = el('button', cls, label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}
const toast = (detail) => window.dispatchEvent(new CustomEvent('mc-toast', { detail }));

export function openGraphScanPanel() {
  const dlg = el('dialog', 'cp-dialog gs-dialog');
  dlg.setAttribute('aria-labelledby', 'gs-title');

  const head = el('div', 'cp-head');
  const title = el('h2', 'cp-title', 'Secondary graph scan');
  title.id = 'gs-title';
  const summary = el('span', 'cp-summary');
  const toggleBtn = button('\u2026', 'cp-btn cp-btn-primary', () => toggleScan());
  toggleBtn.disabled = true;
  const closeBtn = button('\u00D7', 'cp-close', () => dlg.close());
  closeBtn.setAttribute('aria-label', 'Close');
  head.append(title, summary, toggleBtn, closeBtn);

  const intro = el('p', 'gs-intro', 'The ship graph (this app and its corpus) is always indexed. The machine scan indexes only the repos ticked below, into its own graph.');
  const merged = el('div', 'gs-merged');
  const mergedText = el('span', 'cp-muted');
  const buildBtn = button('Build merged graph', 'cp-btn', () => buildNow());
  merged.append(mergedText, buildBtn);
  const notice = el('div', 'cp-err');
  notice.setAttribute('aria-live', 'polite');
  const body = el('div', 'cp-body');
  dlg.append(head, intro, merged, notice, body);
  dlg.addEventListener('close', () => dlg.remove());

  let view = null;

  function render() {
    summary.textContent = scanSummary(view);
    toggleBtn.disabled = false;
    toggleBtn.textContent = view.enabled ? 'Turn scan off' : 'Turn scan on';
    toggleBtn.setAttribute('aria-pressed', String(!!view.enabled));
    mergedText.textContent = view.actorEnabled ? mergedLine(view) : `${mergedLine(view)} Automatic merging is off on this instance.`;
    buildBtn.disabled = !view.enabled || !view.roots.some((r) => r.optedIn);
    clear(body);
    const sorted = sortRoots(view.roots);
    const active = sorted.filter((r) => r.scope !== 'excluded');
    const excluded = sorted.filter((r) => r.scope === 'excluded');
    body.appendChild(table(active, true));
    if (excluded.length) {
      const det = el('details', 'gs-excluded');
      det.appendChild(el('summary', 'gs-excluded-sum', `Excluded (${excluded.length})`));
      det.appendChild(table(excluded, false));
      body.appendChild(det);
    }
  }

  function table(rows, withInclude) {
    const t = el('table', 'cp-table gs-table');
    const thead = el('thead');
    const hr = el('tr');
    for (const h of [withInclude ? 'Index' : null, 'Repo', 'Scope', 'Reason'].filter(Boolean)) {
      const th = el('th', null, h); th.scope = 'col'; hr.appendChild(th);
    }
    thead.appendChild(hr);
    const tbody = el('tbody');
    for (const r of rows) {
      const tr = el('tr', r.scope === 'excluded' ? 'gs-row-muted' : null);
      if (withInclude) {
        const td = el('td', 'gs-inc');
        const cb = el('input');
        cb.type = 'checkbox';
        cb.checked = r.scope === 'ship' || !!r.optedIn;
        cb.disabled = r.scope !== 'machine';
        cb.setAttribute('aria-label', r.scope === 'ship' ? `${r.root} is always indexed` : `Index ${r.root}`);
        if (r.scope === 'machine') cb.addEventListener('change', () => optIn(r.root, cb.checked, cb));
        td.appendChild(cb);
        tr.appendChild(td);
      }
      const name = el('td', 'gs-root', r.root);
      const pill = scopePill(r, view.enabled);
      const st = el('td');
      st.appendChild(el('span', `cp-status cp-tone-${pill.tone}`, pill.label));
      tr.append(name, st, el('td', 'gs-reason', r.reason));
      tbody.appendChild(tr);
    }
    t.append(thead, tbody);
    return t;
  }

  async function apply(promise, ok) {
    notice.textContent = '';
    try {
      const { status, body: b } = await promise;
      if (status !== 200) { notice.textContent = b?.error || `Server answered ${status}.`; return false; }
      view = b;
      render();
      if (ok) toast(ok);
      return true;
    } catch (e) {
      notice.textContent = `Could not reach the server: ${e?.message || e}`;
      return false;
    }
  }

  async function load() {
    summary.textContent = 'Classifying roots\u2026';
    await apply(getGraphMachine());
  }

  async function toggleScan() {
    toggleBtn.disabled = true;
    const on = !view.enabled;
    if (!(await apply(setGraphMachine({ enabled: on }), on ? 'Machine scan on' : 'Machine scan off'))) toggleBtn.disabled = false;
  }

  async function optIn(root, on, cb) {
    cb.disabled = true;
    if (!(await apply(setGraphMachine({ root, optIn: on }), `${root}: ${on ? 'opted in' : 'opted out'}`))) {
      cb.checked = !on;
      cb.disabled = false;
    }
  }

  async function buildNow() {
    buildBtn.disabled = true;
    buildBtn.textContent = 'Building\u2026';
    notice.textContent = '';
    try {
      const { status, body: b } = await buildMachineGraph();
      if (status !== 200) notice.textContent = b?.error || `Server answered ${status}.`;
      else toast(b.built ? 'Merged machine graph built' : `Not built: ${b.reason}`);
    } catch (e) { notice.textContent = `Could not reach the server: ${e?.message || e}`; }
    buildBtn.textContent = 'Build merged graph';
    await load();
  }

  document.body.appendChild(dlg);
  dlg.showModal();
  load();
  return dlg;
}
