// server/test/fixtures/mini-dom.js
// A zero-dependency DOM for web tests (this repo has no jsdom; see
// server/test/web-loop-view-smoke.test.js). It implements only what the lens
// modules touch, records every event listener so tests can assert a click
// handler exists and that unmount removed it, and THROWS on any non-empty
// innerHTML assignment (a live XSS-discipline trap).
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

class Listeners {
  constructor() { this.map = new Map(); }
  add(type, fn) { if (!this.map.has(type)) this.map.set(type, new Set()); this.map.get(type).add(fn); }
  remove(type, fn) { this.map.get(type)?.delete(fn); }
  count(type) { return type ? (this.map.get(type)?.size ?? 0) : [...this.map.values()].reduce((a, s) => a + s.size, 0); }
  fire(type, ev) { for (const fn of [...(this.map.get(type) ?? [])]) fn.call(ev.currentTarget, ev); }
}

export class MiniEvent {
  constructor(type, init = {}) { Object.assign(this, init); this.type = type; this.defaultPrevented = false; }
  preventDefault() { this.defaultPrevented = true; }
  stopPropagation() { this._stopped = true; }
}
export class MiniCustomEvent extends MiniEvent { constructor(type, init = {}) { super(type, init); this.detail = init.detail; } }

class MiniNode {
  constructor(doc) { this.ownerDocument = doc; this.childNodes = []; this.parentNode = null; this._l = new Listeners(); }
  get children() { return this.childNodes.filter((c) => c.nodeType === 1); }
  get firstChild() { return this.childNodes[0] ?? null; }
  appendChild(c) {
    if (c.nodeType === 11) { for (const k of [...c.childNodes]) this.appendChild(k); return c; }
    c.parentNode?.removeChild(c); c.parentNode = this; this.childNodes.push(c); return c;
  }
  append(...cs) { for (const c of cs) this.appendChild(typeof c === 'string' ? this.ownerDocument.createTextNode(c) : c); }
  insertBefore(c, ref) {
    if (!ref) return this.appendChild(c);
    c.parentNode?.removeChild(c); c.parentNode = this; this.childNodes.splice(this.childNodes.indexOf(ref), 0, c); return c;
  }
  removeChild(c) { const i = this.childNodes.indexOf(c); if (i >= 0) this.childNodes.splice(i, 1); c.parentNode = null; return c; }
  replaceChildren(...cs) { for (const c of [...this.childNodes]) this.removeChild(c); this.append(...cs); }
  remove() { this.parentNode?.removeChild(this); }
  contains(n) { for (let x = n; x; x = x.parentNode) if (x === this) return true; return false; }
  get textContent() { return this.nodeType === 3 ? this._text : this.childNodes.map((c) => c.textContent).join(''); }
  set textContent(v) { this.childNodes = []; const s = v == null ? '' : String(v); if (s) this.appendChild(this.ownerDocument.createTextNode(s)); }
  addEventListener(t, fn) { this._l.add(t, fn); }
  removeEventListener(t, fn) { this._l.remove(t, fn); }
  listenerCount(t) { return this._l.count(t); }
  dispatchEvent(ev) {
    ev.target ??= this;
    for (let n = this; n; n = n.parentNode) { ev.currentTarget = n; n._l.fire(ev.type, ev); if (ev._stopped || ev.bubbles === false) break; }
    return !ev.defaultPrevented;
  }
}

class MiniText extends MiniNode { constructor(doc, s) { super(doc); this.nodeType = 3; this._text = String(s); } }
class MiniFragment extends MiniNode { constructor(doc) { super(doc); this.nodeType = 11; } }

function matches(el, sel) {
  if (sel.startsWith('#')) return el.id === sel.slice(1);
  if (sel.startsWith('.')) return el.classList.contains(sel.slice(1));
  const m = sel.match(/^([a-z0-9]*)\[([a-z-]+)(?:="([^"]*)")?\]$/i);
  if (m) {
    if (m[1] && el.tagName.toLowerCase() !== m[1].toLowerCase()) return false;
    const v = el.getAttribute(m[2]);
    return m[3] === undefined ? v != null : v === m[3];
  }
  return el.tagName.toLowerCase() === sel.toLowerCase();
}

class MiniElement extends MiniNode {
  constructor(doc, tag, ns = null) {
    super(doc); this.nodeType = 1; this.tagName = String(tag).toUpperCase(); this.namespaceURI = ns;
    this.attributes = new Map(); this.style = { setProperty(k, v) { this[k] = v; }, removeProperty(k) { delete this[k]; } };
    const self = this;
    this.dataset = new Proxy({}, {
      get: (_, k) => self.getAttribute('data-' + String(k).replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())) ?? undefined,
      set: (_, k, v) => { self.setAttribute('data-' + String(k).replace(/[A-Z]/g, (c) => '-' + c.toLowerCase()), String(v)); return true; },
      deleteProperty: (_, k) => { self.removeAttribute('data-' + String(k).replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())); return true; },
    });
    this.classList = {
      _s: () => new Set(String(self.getAttribute('class') ?? '').split(/\s+/).filter(Boolean)),
      _w: (s) => self.setAttribute('class', [...s].join(' ')),
      add: (...c) => { const s = self.classList._s(); c.forEach((x) => s.add(x)); self.classList._w(s); },
      remove: (...c) => { const s = self.classList._s(); c.forEach((x) => s.delete(x)); self.classList._w(s); },
      toggle: (c, force) => { const s = self.classList._s(); const on = force ?? !s.has(c); if (on) s.add(c); else s.delete(c); self.classList._w(s); return on; },
      contains: (c) => self.classList._s().has(c),
    };
    this.width = 300; this.height = 150; this.value = ''; this.disabled = false;
  }
  get id() { return this.getAttribute('id') ?? ''; } set id(v) { this.setAttribute('id', v); }
  get className() { return this.getAttribute('class') ?? ''; } set className(v) { this.setAttribute('class', v); }
  get tabIndex() { return Number(this.getAttribute('tabindex') ?? -1); } set tabIndex(v) { this.setAttribute('tabindex', String(v)); }
  get title() { return this.getAttribute('title') ?? ''; } set title(v) { this.setAttribute('title', v); }
  get href() { return this.getAttribute('href') ?? ''; } set href(v) { this.setAttribute('href', v); }
  get type() { return this.getAttribute('type') ?? ''; } set type(v) { this.setAttribute('type', v); }
  get hidden() { return this.hasAttribute('hidden'); } set hidden(v) { if (v) this.setAttribute('hidden', ''); else this.removeAttribute('hidden'); }
  // a <select>'s real .options is a live HTMLOptionsCollection
  // over its <option> children; aliasing to .children (already live, already an
  // array) gives callers the .length and index access they actually use
  // (web/orchestration/board.js's populateProjects) without a second data
  // structure to keep in sync. Real DOM leaves .options undefined on every
  // other element, so this only returns something for SELECT.
  get options() { return this.tagName === 'SELECT' ? this.children : undefined; }
  // HTMLSelectElement.remove(index) removes the option AT that index - a
  // different method from the generic Node/ChildNode.remove() (self-removal,
  // MiniNode's own remove() above) that every other element inherits. Only
  // a SELECT called WITH an index gets that override; a bare .remove() (no
  // index, or a non-SELECT element) still means self-removal.
  remove(index) {
    if (this.tagName === 'SELECT' && index !== undefined) {
      const opt = this.children[index];
      if (opt) this.removeChild(opt);
      return;
    }
    super.remove();
  }
  setAttribute(k, v) { this.attributes.set(k, String(v)); }
  getAttribute(k) { return this.attributes.has(k) ? this.attributes.get(k) : null; }
  hasAttribute(k) { return this.attributes.has(k); }
  removeAttribute(k) { this.attributes.delete(k); }
  set innerHTML(v) { if (v !== '') throw new Error(`innerHTML assigned data: ${String(v).slice(0, 60)}`); this.childNodes = []; }
  get innerHTML() { return ''; }
  click() { this.dispatchEvent(new MiniEvent('click', { bubbles: true, button: 0 })); }
  focus() { this.ownerDocument.activeElement = this; }
  blur() {}
  scrollIntoView() { this._scrolled = true; }
  getBoundingClientRect() { return { top: 0, left: 0, right: 100, bottom: 20, width: 100, height: 20 }; }
  querySelectorAll(sel) {
    const out = []; const walk = (n) => { for (const c of n.children) { if (matches(c, sel)) out.push(c); walk(c); } }; walk(this); return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; }
  closest(sel) { for (let n = this; n && n.nodeType === 1; n = n.parentNode) if (matches(n, sel)) return n; return null; }
  getContext() { // a canvas 2d context that accepts every call
    const calls = (this._calls ??= []);
    const gradient = () => { calls.push(['gradient', 0]); return { addColorStop() {} }; };
    return new Proxy({}, { get: (t, k) => (k in t ? t[k] : (k === 'createRadialGradient' || k === 'createLinearGradient') ? gradient : (...a) => { calls.push([k, a.length]); }), set: (t, k, v) => { t[k] = v; return true; } });
  }
}

export function installMiniDom({ pathname = '/surface', search = '' } = {}) {
  const saved = {};
  const doc = new MiniNode(null); doc.ownerDocument = doc; doc.nodeType = 9;
  doc.createElement = (t) => new MiniElement(doc, t);
  doc.createElementNS = (ns, t) => new MiniElement(doc, t, ns);
  doc.createTextNode = (s) => new MiniText(doc, s);
  doc.createDocumentFragment = () => new MiniFragment(doc);
  doc.documentElement = doc.createElement('html'); doc.appendChild(doc.documentElement);
  doc.head = doc.createElement('head'); doc.body = doc.createElement('body');
  doc.documentElement.appendChild(doc.head); doc.documentElement.appendChild(doc.body);
  doc.getElementById = (id) => doc.documentElement.querySelector('#' + id);
  doc.querySelectorAll = (s) => doc.documentElement.querySelectorAll(s);
  doc.querySelector = (s) => doc.documentElement.querySelector(s);
  doc.activeElement = null; doc.hidden = false;
  const win = new MiniNode(doc);
  win.opened = []; win.innerWidth = 1400; win.innerHeight = 900; win.devicePixelRatio = 1;
  win.location = { pathname, search, origin: 'http://127.0.0.1:8123', assign(u) { win.assigned = u; }, replace(u) { win.assigned = u; }, reload() { win.reloaded = true; } };
  win.history = { entries: [], pushState(s, _t, u) { this.entries.push(['push', u]); const x = new URL(u, win.location.origin); win.location.pathname = x.pathname; win.location.search = x.search; }, replaceState(s, _t, u) { this.entries.push(['replace', u]); const x = new URL(u, win.location.origin); win.location.pathname = x.pathname; win.location.search = x.search; }, back() {} };
  win.open = (u, target) => { win.opened.push([u, target]); return null; };
  win.matchMedia = (q) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} });
  win.getComputedStyle = () => ({ getPropertyValue: () => '' });
  win.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);
  win.cancelAnimationFrame = (h) => clearTimeout(h);
  win.document = doc;
  const store = new Map();
  const globals = {
    document: doc, window: win, location: win.location, history: win.history,
    CustomEvent: MiniCustomEvent, Event: MiniEvent, KeyboardEvent: MiniEvent, PointerEvent: MiniEvent, MouseEvent: MiniEvent, WheelEvent: MiniEvent,
    localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
    confirm: () => true, alert: () => {},
    requestAnimationFrame: win.requestAnimationFrame, cancelAnimationFrame: win.cancelAnimationFrame,
    matchMedia: win.matchMedia, getComputedStyle: win.getComputedStyle,
    ResizeObserver: class { constructor(cb) { this.cb = cb; win._ro = (win._ro ?? 0) + 1; } observe() {} unobserve() {} disconnect() { win._ro -= 1; } },
    navigator: { clipboard: { writeText: async () => {} }, userAgent: 'mini-dom' },
  };
  for (const [k, v] of Object.entries(globals)) { saved[k] = Object.getOwnPropertyDescriptor(globalThis, k); Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true }); }
  return {
    document: doc, window: win,
    restore() { for (const [k, d] of Object.entries(saved)) { if (d) Object.defineProperty(globalThis, k, d); else delete globalThis[k]; } },
  };
}

// window.listenerCount() only ever
// covered listeners added directly on window - a leak on a mark or panel
// row (any other node in the tree) was invisible to it. Walks the current
// global document's whole tree plus window itself, summing every node's own
// listenerCount().
export function countAllListeners() {
  let total = window.listenerCount();
  const walk = (n) => {
    total += typeof n.listenerCount === 'function' ? n.listenerCount() : 0;
    for (const c of n.childNodes ?? []) walk(c);
  };
  walk(document);
  return total;
}

// d3 7.9.0 is a UMD bundle: run it in a fresh context with no module/define
// so it assigns itself to that context's globalThis.d3.
export function loadVendorD3() {
  const src = fs.readFileSync(path.join(ROOT, 'web', 'vendor', 'd3.min.js'), 'utf8');
  const ctx = { setTimeout, clearTimeout, setInterval, clearInterval, performance, Date, Math };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  if (!ctx.d3 || typeof ctx.d3.geoOrthographic !== 'function') throw new Error('d3.min.js did not define d3.geoOrthographic');
  return ctx.d3;
}
