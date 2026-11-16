// web/shared/interactive-item.js
// The one primitive behind "clickable and linkable everywhere" (D17). Every
// datum that looks like data gets: a click handler that opens its detail,
// keyboard activation, an accessible name, and a stable deep link. Activation
// dispatches `mc-link` so the router records the link in history (reload,
// share, back all work); ctrl or cmd click opens the link in a new tab.
import { interactive } from './a11y.js';

export function bindItem(el, { type, id, link, open, label } = {}) {
  if (!type) throw new TypeError('bindItem: type is required');
  if (id === undefined || id === null || id === '') throw new TypeError(`bindItem(${type}): id is required`);
  if (typeof link !== 'string' || !link) throw new TypeError(`bindItem(${type}:${id}): link is required`);
  if (typeof open !== 'function') throw new TypeError(`bindItem(${type}:${id}): open handler is required`);
  el.dataset.itemType = type;
  el.dataset.itemId = String(id);
  el.dataset.link = link;
  const activate = (ev) => {
    if (ev && (ev.ctrlKey || ev.metaKey)) { window.open(link, '_blank'); return; }
    window.dispatchEvent(new CustomEvent('mc-link', { detail: { link } }));
    // this item's open() is about to show its detail somewhere
    // on the page, so it is now "the selection" - every other bound item on
    // the page stops being one. A ctrl/cmd-click (new tab, handled above)
    // never reaches here, since nothing on THIS page is changing.
    markSelected(el);
    open(ev);
  };
  const tag = String(el.tagName || '').toLowerCase();
  if (tag === 'button' || tag === 'a') {
    el.addEventListener('click', activate);
    if (label) el.setAttribute('aria-label', label);
  } else if (tag === 'li') {
    // role=button on an <li> breaks its list (a list owns
    // only listitems). The li stays a listitem and the item's identity
    // (data-*, aria-current); its content moves into an inner native
    // button that takes focus, the name and Enter/Space, and whose click
    // bubbles to the li's handler.
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'item-btn';
    for (const c of [...el.childNodes]) btn.appendChild(c);
    if (label) btn.setAttribute('aria-label', label);
    el.appendChild(btn);
    el.addEventListener('click', activate);
  } else {
    interactive(el, activate, label);
  }
  // an item bound while it is the selection (a
  // list re-rendered under an open detail: a loop list on a loop tick,
  // Work's board on a backlog event) is born marked.
  if (selected && selected.type === type && selected.id === String(id)) setMark(el, true);
  return el;
}

// The current selection by identity, not by element, so a re-render keeps it.
let selected = null;

// a bound <li> keeps its mark on the li (the item)
// and mirrors it onto its inner .item-btn, the element keyboard focus and
// a screen reader actually sit on.
function setMark(node, on) {
  const targets = [node];
  for (const c of node.children ?? []) if (c.classList?.contains('item-btn')) targets.push(c);
  for (const t of targets) { if (on) t.setAttribute('aria-current', 'true'); else t.removeAttribute('aria-current'); }
}

export function collectItems(root) {
  const out = [];
  const walk = (n) => {
    if (n && n.dataset && n.dataset.itemType) out.push(n);
    for (const c of n?.childNodes ?? []) walk(c);
  };
  walk(root);
  return out;
}

// a selected row/card/node carried no aria-current/aria-selected
// (an ARIA role=button alone, which bindItem gives every non-button/anchor
// item via a11y.js's interactive(), says nothing about selection), so a
// screen reader had no way to tell which item's detail pane or drawer was
// open. One bound item is ever "the selection" at a time across the whole
// page (one lens is mounted into #lens-root at once, D1), so this clears
// every other item's mark before setting the new one - or just clears
// everyone when called with a falsy element, for a lens or drawer that
// closes its detail without opening a different item in its place.
export function markSelected(el) {
  selected = el ? { type: el.dataset.itemType, id: el.dataset.itemId } : null;
  for (const node of collectItems(document.body)) {
    if (node !== el) setMark(node, false);
  }
  if (el) setMark(el, true);
}

// Reopen a deep link's selection: find the rendered item and activate it the
// way a click would. A selection that no longer exists calls onMissing, so
// the lens can say "not found" instead of showing nothing.
export function openSelection(root, sel, { onMissing } = {}) {
  if (!sel) return false;
  const el = collectItems(root).find((e) => e.dataset.itemType === sel.type && e.dataset.itemId === String(sel.id));
  if (!el) { onMissing?.(sel); return false; }
  el.scrollIntoView?.({ block: 'center' });
  el.click();
  return true;
}
