// web/surface/drawer.js
// Surface's right-side context drawer (card glmps-2-0-137 phase 2, story 13):
// one view at a time. Three views are tabs (Alerts, Repo inspector, Policy
// bounds); an item's detail (the inspector, a file tree, the agents list)
// shows in the same body with no tab selected. Opening a view replaces what
// the drawer shows; nothing is ever closed behind the operator's back, since
// there is only ever one thing open. The API matches the panel stack it
// replaces: open(id, title, render), close(id), has(id), ids().
import { createTabs } from '../shared/tabs.js';
import { clear } from '../shared/dom-util.js';
import { bandError } from '../shared/bands.js';

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

export function createDrawer(host, { tabs, onTab = () => {}, onOpen, onClose, label = 'Context drawer' } = {}) {
  const tabIds = new Set(tabs.map((t) => t.id));
  const section = el('section', 'surface-panel surface-drawer');
  section.setAttribute('aria-label', label);
  section.hidden = true;
  host.appendChild(section);
  const strip = createTabs(section, tabs, { label: 'Context views', idPrefix: 'sd', className: 'drawer-tabs', onSelect: (id) => onTab(id) });
  const head = el('div', 'surface-drawer-head');
  const x = el('button', 'panel-close'); x.type = 'button'; x.setAttribute('aria-label', 'Close the drawer');
  section.insertBefore(head, strip.el);
  head.append(strip.el, x);
  const title = el('h2', 'surface-panel-title surface-drawer-title');
  const detail = el('div', 'surface-drawer-detail');
  section.append(title, detail);

  let current = null;
  let currentBody = null;
  // The section carries the id of the view it shows (panel-<id>), the address
  // every Surface panel had before the drawer, so links and tests that look a
  // view up by id still find it; the view it replaces is emptied.
  const leave = () => { if (currentBody) clear(currentBody); currentBody = null; section.removeAttribute('id'); };
  function close(id) {
    if (current == null || (id != null && id !== current)) return;
    const was = current;
    current = null;
    leave();
    section.hidden = true;
    strip.none();
    onClose?.(was);
  }
  x.addEventListener('click', () => close());

  return {
    el: section,
    open(id, text, render) {
      const opening = current == null;
      if (current != null && current !== id) { const was = current; current = null; leave(); onClose?.(was); }
      current = id;
      section.id = `panel-${id}`;
      section.hidden = false;
      x.setAttribute('aria-label', `Close ${text}`);
      let body;
      if (tabIds.has(id)) {
        strip.show(id);
        title.hidden = true; detail.hidden = true;
        body = strip.panel(id);
      } else {
        strip.none();
        title.hidden = false; title.textContent = text;
        detail.hidden = false;
        body = detail;
      }
      clear(body);
      currentBody = body;
      // a render may be async; a rejection or a throw lands in the drawer's
      // error state instead of a blank body.
      const failed = (e) => { if (body.isConnected !== false) bandError(body, `The ${text} view`, e); };
      try { const out = render?.(body); if (out && typeof out.then === 'function') out.catch(failed); }
      catch (e) { failed(e); }
      if (opening) onOpen?.(id);
      return body;
    },
    close,
    has: (id) => current === id,
    ids: () => (current == null ? [] : [current]),
  };
}
