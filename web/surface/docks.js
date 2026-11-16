// web/surface/docks.js
// The floating glass panels that sit over the globe by default (HUD, Layers,
// Data ledger, Recent edits). They are not part of the three-panel stack in
// panels.js: that stack is for detail the operator opens on purpose, these are
// the standing instruments, each toggled from the rail.
import { icon } from './icons.js';

export function createDock(parent, { id, title, iconName, sub = null, foot = null, foldable = false, open = true, onChange = () => {} }) {
  const el = document.createElement('section');
  el.className = 'surface-panel surface-dock'; el.id = `dock-${id}`;
  el.setAttribute('aria-label', title);
  const head = document.createElement('div'); head.className = 'surface-panel-head';
  if (iconName) { const i = icon(iconName); i.setAttribute('class', 'panel-icon'); head.appendChild(i); }
  const h = document.createElement('h2'); h.className = 'surface-panel-title'; h.textContent = title; head.appendChild(h);
  let fold = null;
  if (foldable) {
    fold = document.createElement('button'); fold.type = 'button'; fold.className = 'panel-fold';
    fold.setAttribute('aria-label', `Fold ${title}`); fold.setAttribute('aria-expanded', 'true');
    head.appendChild(fold);
  }
  const x = document.createElement('button'); x.type = 'button'; x.className = 'panel-close'; x.setAttribute('aria-label', `Close ${title}`);
  head.appendChild(x);
  el.appendChild(head);
  const subEl = document.createElement('p'); subEl.className = 'dock-sub'; if (sub) subEl.textContent = sub; else subEl.hidden = true;
  el.appendChild(subEl);
  const body = document.createElement('div'); body.className = 'surface-panel-body'; el.appendChild(body);
  const footEl = document.createElement('p'); footEl.className = 'panel-foot'; if (foot) footEl.textContent = foot; else footEl.hidden = true;
  el.appendChild(footEl);
  parent.appendChild(el);

  let isOpen = open;
  el.hidden = !isOpen;
  const api = {
    el, body, subEl, footEl, id,
    isOpen: () => isOpen,
    open() { if (isOpen) return; isOpen = true; el.hidden = false; onChange(true); },
    close() { if (!isOpen) return; isOpen = false; el.hidden = true; onChange(false); },
    toggle() { if (isOpen) api.close(); else api.open(); },
    folded: () => el.classList.contains('is-folded'),
    fold(on) {
      el.classList.toggle('is-folded', on);
      fold?.setAttribute('aria-expanded', on ? 'false' : 'true');
    },
  };
  x.addEventListener('click', () => api.close());
  fold?.addEventListener('click', () => api.fold(!api.folded()));
  return api;
}
