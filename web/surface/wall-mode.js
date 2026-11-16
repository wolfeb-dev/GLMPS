// web/surface/wall-mode.js
// Wall mode: the Director tours the camera over the sessions on the ring, using
// Track mode for the lock, with a reticle on the focus and a one-line heads-up.
// Off by default and remembered per browser; a moving camera fights a screen
// you are also clicking on. It owns no timer: the lens's existing readout tick
// calls tick(), and director.js decides when to move on.
import { directorStep, initialDirector } from './director.js';

export const WALL_KEY = 'mc.surface.wall';
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

export function readWall(storage = globalThis.localStorage) {
  try { return storage?.getItem(WALL_KEY) === 'on'; } catch { return false; }
}
function writeWall(on, storage = globalThis.localStorage) {
  try { storage?.setItem(WALL_KEY, on ? 'on' : 'off'); } catch { /* private mode: the choice lasts this visit */ }
}

export function createWallMode({ api, motion, tracker, home, reduced = false, now = Date.now, storage }) {
  const btn = el('button', 'wall-btn', 'Wall mode'); btn.type = 'button';
  btn.setAttribute('aria-pressed', 'false');
  btn.title = 'The camera tours the busiest sessions, waiting on you first. Click a session in the Sessions panel to hold it.';
  const headsUp = el('div', 'surface-headsup'); headsUp.hidden = true;
  let on = false; let director = initialDirector(); let lockId = null; let focusId = null; let switching = false; let gone = false;

  const reticle = (id, shown) => api.agents?.get(id)?.dial.setReticle(shown);
  const paintHeads = () => {
    const text = focusId ? motion.headsUp(focusId) : 'Wall mode: waiting for a session';
    if (headsUp.textContent !== text) headsUp.textContent = text;
  };
  const paintLock = () => { btn.dataset.locked = lockId ? 'true' : 'false'; };

  async function focus(id) {
    if (focusId) reticle(focusId, false);
    focusId = id;
    if (id) reticle(id, true);
    paintHeads();
    if (!id) return;
    // Track mode does the camera work: fly, lock, and snap back after a drag.
    switching = true;
    try { await tracker.start(id); } finally { switching = false; }
  }

  function tick() {
    if (!on || gone) return;
    const next = directorStep(director, motion.directorInputs(), { now: now(), lockId, reduced });
    director = next;
    if (next.changed) focus(next.id); else paintHeads();
  }

  async function set(value, { save = true } = {}) {
    if (value === on || gone) return;
    on = value;
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    headsUp.hidden = !on;
    if (save) writeWall(on, storage);
    if (on) { director = initialDirector(); tick(); return; }
    if (focusId) reticle(focusId, false);
    const was = focusId;
    focusId = null; lockId = null; director = initialDirector(); paintLock();
    // Esc and the Stop button already ended tracking; only stop what Wall mode started.
    if (was && tracker.active() === was) tracker.stop();
    await api.globe.flyTo(home());
  }

  btn.addEventListener('click', () => set(!on));
  return {
    btn, headsUp,
    isOn: () => on,
    lockedId: () => lockId,
    set, tick,
    // A Sessions panel row: with Wall mode on it locks (or releases) that session and
    // returns true; with it off the caller opens the session instead.
    pick(id) {
      if (!on) return false;
      lockId = lockId === id ? null : id;
      paintLock();
      tick();
      return true;
    },
    // Tracking ended on its own (Esc, Stop tracking) while the Director was on: take that as "stop touring".
    onTrackChange() { if (on && !switching && !tracker.active()) set(false); },
    destroy() { gone = true; if (focusId) reticle(focusId, false); focusId = null; btn.remove(); headsUp.remove(); },
  };
}
