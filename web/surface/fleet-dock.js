// web/surface/fleet-dock.js
// The Fleet stage board in a collapsible dock under the globe. The board is a
// module-level singleton (one container, one poller), so only the mount that
// last started it may stop it, and the router unmounts the leaving lens before
// the next one mounts.
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const PREF = 'surface.fleet';
// the board's height is the operator's to set. Stored per viewer; every
// storage call is guarded, so a blocked store only costs the memory.
const HEIGHT_KEY = 'mc.surface.fleet-height';
const DEFAULT_H = 222;
const MIN_H = 120;
const MAX_FRACTION = 0.7;
const STEP = 24;

let mountSeq = 0;
let boardOwner = 0;

export function createFleetDock(host, { handlers, getState, isCurrent = () => true, phone = false }) {
  const me = ++mountSeq;
  const dock = el('section', 'surface-fleet'); dock.setAttribute('aria-label', 'Fleet');
  const sep = el('div', 'fleet-sep');
  sep.setAttribute('role', 'separator'); sep.setAttribute('aria-orientation', 'horizontal'); sep.tabIndex = 0;
  sep.setAttribute('aria-label', 'Resize the Fleet board');
  sep.title = 'Drag, or use the arrow keys, to resize. Double-click resets.';
  const head = el('div', 'fleet-head');
  const toggle = el('button', 'fleet-toggle'); toggle.type = 'button'; toggle.setAttribute('aria-controls', 'view-stageboard');
  const caret = el('span', 'fleet-caret'); caret.setAttribute('aria-hidden', 'true');
  toggle.append(caret, el('span', 'fleet-title', 'Fleet board'));
  const note = el('span', 'fleet-note', 'Sessions by loop stage');
  head.append(toggle, note);
  // stage-board.css is scoped under #view-stageboard.
  const body = el('div', 'fleet-body'); body.id = 'view-stageboard';
  dock.append(sep, head, body);
  host.appendChild(dock);

  let sb = null; let mounted = false; let gone = false; let pending = Promise.resolve();
  let open;
  try { const saved = localStorage.getItem(PREF); open = saved == null ? !phone : saved === 'open'; } catch { open = !phone; }

  const lensHeight = () => host.clientHeight || window.innerHeight || 900;
  const maxHeight = () => Math.max(MIN_H, Math.round(lensHeight() * MAX_FRACTION));
  const clamp = (h) => Math.min(maxHeight(), Math.max(MIN_H, Math.round(h)));
  let height = DEFAULT_H;
  let chosen = false;
  try { const saved = localStorage.getItem(HEIGHT_KEY); if (saved != null && saved !== '' && Number.isFinite(Number(saved))) { height = Number(saved); chosen = true; } } catch { /* blocked: the default */ }
  function paintHeight() {
    height = clamp(height);
    sep.setAttribute('aria-valuemin', String(MIN_H)); sep.setAttribute('aria-valuemax', String(maxHeight())); sep.setAttribute('aria-valuenow', String(height));
    if (chosen) dock.style.setProperty('--fleet-h', `${height}px`); else dock.style.removeProperty('--fleet-h');
  }
  function setHeight(h, { save = true } = {}) {
    height = clamp(h); chosen = true; paintHeight();
    if (save) try { localStorage.setItem(HEIGHT_KEY, String(height)); } catch { /* private mode */ }
  }
  function resetHeight() {
    height = DEFAULT_H; chosen = false; paintHeight();
    try { localStorage.removeItem(HEIGHT_KEY); } catch { /* private mode */ }
  }
  let drag = null;
  sep.addEventListener('pointerdown', (e) => {
    if (e.button != null && e.button !== 0) return;
    drag = { y: e.clientY, h: height, id: e.pointerId };
    sep.setPointerCapture?.(e.pointerId);
    dock.classList.add('is-resizing');
    e.preventDefault?.();
  });
  sep.addEventListener('pointermove', (e) => { if (drag) setHeight(drag.h + (drag.y - e.clientY), { save: false }); });
  const endDrag = (e) => {
    if (!drag) return;
    sep.releasePointerCapture?.(drag.id);
    drag = null; dock.classList.remove('is-resizing');
    setHeight(height);
  };
  sep.addEventListener('pointerup', endDrag);
  sep.addEventListener('pointercancel', endDrag);
  sep.addEventListener('dblclick', resetHeight);
  sep.addEventListener('keydown', (e) => {
    const next = e.key === 'ArrowUp' ? height + STEP : e.key === 'ArrowDown' ? height - STEP : e.key === 'Home' ? MIN_H : e.key === 'End' ? maxHeight() : null;
    if (next == null) return;
    e.preventDefault();
    setHeight(next);
  });
  // A smaller window lowers the ceiling; keep the board inside it.
  const onResize = () => paintHeight();
  window.addEventListener('resize', onResize);
  paintHeight();

  async function mountBoard() {
    if (mounted || gone || !isCurrent()) return;
    mounted = true;
    try {
      sb ??= await import('../overview/stage-board.js');
      if (gone || !isCurrent() || !open) { mounted = false; return; }
      boardOwner = me;
      sb.renderStageBoard(body, handlers);
      const s = getState?.();
      if (s) sb.updateStageBoard(s, handlers);
      // The board starts its own fetches; let them land before the lens reports
      // itself mounted, so a quick unmount never leaves a callback for a torn-down page.
      await new Promise((r) => setTimeout(r, 0));
    } catch (e) {
      mounted = false;
      body.textContent = '';
      body.appendChild(el('p', 'band-error', `The Fleet board failed to load: ${e.message}`));
    }
  }
  function unmountBoard() {
    if (!mounted) return;
    mounted = false;
    if (sb && boardOwner === me) { sb.unmountStageBoard(); boardOwner = 0; }
    body.textContent = '';
  }
  function paint() {
    dock.classList.toggle('is-open', open);
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    body.hidden = !open;
    sep.hidden = !open;
    if (open) pending = mountBoard(); else unmountBoard();
  }
  const setOpen = (v) => { open = v; try { localStorage.setItem(PREF, open ? 'open' : 'closed'); } catch { /* private mode */ } paint(); };
  toggle.addEventListener('click', () => setOpen(!open));
  paint();
  return {
    el: dock, isOpen: () => open, ready: () => pending,
    // A deep link to the fleet opens the board if the operator had folded it.
    open() { if (!open) setOpen(true); dock.scrollIntoView?.({ block: 'nearest' }); },
    onState(s) { if (mounted && sb && boardOwner === me) sb.updateStageBoard(s, handlers); },
    destroy() { gone = true; window.removeEventListener('resize', onResize); unmountBoard(); dock.remove(); },
  };
}
