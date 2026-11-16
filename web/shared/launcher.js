// web/shared/launcher.js
// Topbar "New terminal" launcher: pick an AI CLI + folder and open it in a
// native terminal. Mirrors the resume-menu pattern; all data goes through
// textContent / element APIs (no innerHTML).
import { getConfig, launchTerminal, getCoverage } from './api.js';
import { cwdLastSeg } from './dom-util.js';

const LS_CLI = 'mc.term.cli';
const LS_FOLDER = 'mc.term.folder';
const LS_ISOLATE = 'mc-term-isolate';

// pulled out of doLaunch's closure so it is testable
// without a DOM harness; also drops the stale "queued - Antigravity" copy
// and the em-dash.
// Fix round 1, m6: a service-mode kernel answers launched: 'queued' instead
// of opening anything - named here rather than claiming "Terminal opened".
export function launchToast(status, body) {
  if (status !== 200) return body?.error ? String(body.error) : 'Launch failed: check the folder';
  if (body?.launched === 'queued') return body.client ? `Queued: ${body.clientName || body.client} will open it` : 'Queued: the desktop shell will open it';
  return body?.launched === 'antigravity' ? 'Opened in Antigravity' : 'Terminal opened';
}

// The server names the roots it would accept; an older server that does not
// say leaves every root listed (fail open, the 403 text still explains).
export function launchableFolders(config) {
  const roots = Array.isArray(config?.projectRoots) ? config.projectRoots : [];
  return Array.isArray(config?.launchableRoots) ? roots.filter((r) => config.launchableRoots.includes(r)) : roots;
}

// Tools the server tracks that have no capture adapter yet. Sorted by how
// widely used they are so the dot's label names the one that matters most.
export function uncapturedTools(coverage) {
  const tools = Array.isArray(coverage?.tools) ? coverage.tools : [];
  return tools.filter((t) => !t.hasAdapter).sort((a, b) => (b.popularityWeight ?? 0) - (a.popularityWeight ?? 0));
}

export function captureWarnLabel(missing) {
  const names = missing.slice(0, 3).map((t) => t.displayName || t.id).join(', ');
  const more = missing.length > 3 ? ` and ${missing.length - 3} more` : '';
  return `${missing.length} ${missing.length === 1 ? 'tool has' : 'tools have'} no capture hook: ${names}${more}. Open Settings, Clients and capture`;
}

function cliIcon(icon) {
  const span = document.createElement('span');
  span.className = 'term-cli-ic';
  const safe = String(icon ?? 'terminal').replace(/[^a-z0-9_-]/gi, '');
  const url = `url("icons/${safe || 'terminal'}.svg")`;
  span.style.webkitMaskImage = url;
  span.style.maskImage = url;
  return span;
}

export async function mountLauncher(topbar) {
  let config = { terminals: [], projectRoots: [] };
  try { config = await getConfig(); } catch { return; }
  const terminals = Array.isArray(config.terminals) ? config.terminals : [];
  if (terminals.length === 0) return;
  const roots = launchableFolders(config);

  // Selection state (restored from localStorage when still valid)
  let selectedCli = localStorage.getItem(LS_CLI);
  if (!terminals.some(t => t.label === selectedCli)) selectedCli = terminals[0].label;
  let selectedFolder = localStorage.getItem(LS_FOLDER) ?? '';
  if (selectedFolder && !roots.includes(selectedFolder)) selectedFolder = '';
  let isolate = localStorage.getItem(LS_ISOLATE) === '1'; // default off

  const wrap = document.createElement('div');
  wrap.className = 'term-launcher';

  const btn = document.createElement('button');
  btn.className = 'term-launch-btn';
  btn.type = 'button';
  btn.appendChild(cliIcon('terminal'));
  btn.setAttribute('aria-label', 'New terminal');
  const btnLabel = document.createElement('span');
  btnLabel.className = 'term-launch-label';
  btnLabel.textContent = 'New terminal';
  btn.appendChild(btnLabel);
  const caret = document.createElement('span');
  caret.className = 'term-caret';
  caret.textContent = '\u25BE';
  btn.appendChild(caret);
  wrap.appendChild(btn);

  // The warning dot is a sibling of the launch button (a button cannot nest in
  // one). It stays out of the way until the server says a tool is uncaptured.
  getCoverage().then((cov) => {
    const missing = uncapturedTools(cov);
    if (missing.length === 0) return;
    const dot = document.createElement('button');
    dot.type = 'button';
    dot.className = 'term-capture-warn';
    const label = captureWarnLabel(missing);
    dot.setAttribute('aria-label', label);
    dot.title = label;
    const mark = document.createElement('span');
    mark.className = 'term-capture-dot';
    dot.appendChild(mark);
    dot.addEventListener('click', () => window.dispatchEvent(new CustomEvent('mc-open-settings', { detail: { tab: 'clients' } })));
    wrap.insertBefore(dot, btn);
  }).catch(() => { /* no coverage answer: no dot rather than a false alarm */ });

  let menuEl = null;
  let onDocClick = null;
  let onKey = null;

  function closeMenu() {
    if (!menuEl) return;
    menuEl.remove();
    menuEl = null;
    if (onDocClick) { document.removeEventListener('click', onDocClick, true); onDocClick = null; }
    if (onKey) { document.removeEventListener('keydown', onKey); onKey = null; }
    btn.classList.remove('open');
  }

  function buildMenu() {
    menuEl = document.createElement('div');
    menuEl.className = 'term-menu';

    const cap = document.createElement('div');
    cap.className = 'term-menu-cap';
    cap.textContent = 'Launch in editor tab';
    menuEl.appendChild(cap);

    const list = document.createElement('div');
    list.className = 'term-cli-list';
    for (const t of terminals) {
      const row = document.createElement('div');
      row.className = 'term-cli-row' + (t.label === selectedCli ? ' sel' : '');
      row.appendChild(cliIcon(t.icon));
      const lab = document.createElement('span');
      lab.className = 'term-cli-label';
      lab.textContent = t.label;
      row.appendChild(lab);
      const check = document.createElement('span');
      check.className = 'term-cli-check';
      check.textContent = '\u2713';
      row.appendChild(check);
      row.addEventListener('click', (ev) => {
        ev.stopPropagation();
        selectedCli = t.label;
        for (const r of list.children) r.classList.toggle('sel', r === row);
      });
      list.appendChild(row);
    }
    menuEl.appendChild(list);

    if (roots.length > 0) {
      const fLabel = document.createElement('label');
      fLabel.className = 'term-folder-label';
      fLabel.textContent = 'Folder';
      menuEl.appendChild(fLabel);

      const sel = document.createElement('select');
      sel.className = 'term-folder';
      const none = document.createElement('option');
      none.value = '';
      none.textContent = '(no folder)';
      sel.appendChild(none);
      for (const root of roots) {
        const opt = document.createElement('option');
        opt.value = root;
        opt.textContent = cwdLastSeg(root);
        opt.title = root;
        sel.appendChild(opt);
      }
      sel.value = selectedFolder;
      sel.addEventListener('change', () => { selectedFolder = sel.value; });
      sel.addEventListener('click', (ev) => ev.stopPropagation());
      menuEl.appendChild(sel);
    }

    // Isolate toggle (glmps-71 A2): open in a private git worktree instead of
    // the shared checkout. Reuses the existing pol-toggle switch component
    // (web/styles.css) rather than introducing a new control.
    const isoRow = document.createElement('div');
    isoRow.className = 'term-isolate-row';
    const isoToggle = document.createElement('label');
    isoToggle.className = 'term-isolate pol-toggle';
    const isoInput = document.createElement('input');
    isoInput.type = 'checkbox';
    isoInput.className = 'pol-toggle-input';
    isoInput.checked = isolate;
    isoInput.setAttribute('aria-label', 'Isolate this session in a git worktree');
    const isoTrack = document.createElement('span');
    isoTrack.className = 'pol-toggle-track';
    const isoThumb = document.createElement('span');
    isoThumb.className = 'pol-toggle-thumb';
    isoTrack.appendChild(isoThumb);
    isoInput.addEventListener('change', () => {
      isolate = isoInput.checked;
      localStorage.setItem(LS_ISOLATE, isolate ? '1' : '0');
    });
    isoToggle.addEventListener('click', (ev) => ev.stopPropagation());
    isoToggle.appendChild(isoInput);
    isoToggle.appendChild(isoTrack);
    const isoLabel = document.createElement('span');
    isoLabel.className = 'term-isolate-label';
    isoLabel.textContent = 'Isolate (git worktree)';
    isoToggle.appendChild(isoLabel);
    isoRow.appendChild(isoToggle);
    menuEl.appendChild(isoRow);

    const launch = document.createElement('button');
    launch.className = 'term-launch';
    launch.type = 'button';
    launch.appendChild(cliIcon('terminal'));
    const lt = document.createElement('span');
    lt.textContent = 'Launch';
    launch.appendChild(lt);
    launch.addEventListener('click', (ev) => { ev.stopPropagation(); doLaunch(); });
    menuEl.appendChild(launch);

    wrap.appendChild(menuEl);
  }

  function openMenu(e) {
    e.stopPropagation();
    if (menuEl) { closeMenu(); return; }
    buildMenu();
    btn.classList.add('open');
    onDocClick = (ev) => { if (!wrap.contains(ev.target)) closeMenu(); };
    onKey = (ev) => { if (ev.key === 'Escape') closeMenu(); };
    document.addEventListener('click', onDocClick, true);
    document.addEventListener('keydown', onKey);
  }

  async function doLaunch() {
    const cli = selectedCli;
    const folder = selectedFolder || null;
    localStorage.setItem(LS_CLI, cli);
    localStorage.setItem(LS_FOLDER, selectedFolder || '');
    closeMenu();
    try {
      const { status, body } = await launchTerminal(cli, folder, isolate);
      window.dispatchEvent(new CustomEvent('mc-toast', { detail: launchToast(status, body) }));
    } catch {
      window.dispatchEvent(new CustomEvent('mc-toast', { detail: 'Launch failed' }));
    }
  }

  btn.addEventListener('click', openMenu);
  topbar.appendChild(wrap);
}
