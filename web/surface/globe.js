// web/surface/globe.js
// The Surface globe (D11, D17): an orthographic d3 projection drawn in two
// planes, a canvas for the sphere, graticule and coastlines, and an SVG for
// every mark (so every mark is a focusable, clickable element with a deep
// link). Drag rotates, wheel zooms, fly-to answers a click. It renders on
// demand; the only timers are a fly-to tween and the optional auto-rotate,
// both stopped by destroy().
import { clampZoom, normLon, clampLat, isVisible, lerpCamera, easeCubicInOut, dragCamera, topoFeature, resolveLabelOverlaps } from './globe-core.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

// one screen-space label-collision pass, after every
// layer has placed its marks. A fixed priority (the local residency ring
// beats players beats the nowhere-else region - reviewer-specified) and an
// approximate per-character box (real text measurement needs a live layout
// engine mini-dom does not have, and an estimate is enough to decide "these
// two overlap"). Only .lbl elements are ever hidden here - never the mark,
// its glyph, or its tabindex/aria-label - so the accessible name and every
// click/keyboard target survive regardless of what the pass decides.
const LABEL_LAYER_PRIORITY = { players: 0, residency: 1, nowhere: 2, agents: 3, cards: 4, loops: 5, files: 6 };
const LABEL_OFFSETS = [
  { cls: 'res-node', dx: 8, dy: 3 },
  { cls: 'player', dx: 30, dy: -9 },
];
const LABEL_CHAR_PX = 6.5; // Fira Code, --fs-micro (11px): approximate advance width
// 11px font metrics alone (~12px line box) undercounted: .lbl also carries a
// 3px paint-order:stroke halo (surface.css) around the glyphs, which real
// getBoundingClientRect includes - confirmed live (a real overlap between
// two surviving labels, ~2px, was missed at 12px and caught once this
// accounted for the halo).
const LABEL_LINE_PX = 16;

const PAINT = {
  ocean: [[0, '#1f5a9c'], [0.45, '#0f3a6e'], [0.85, '#082044'], [1, '#040f24']],
  land: [[0, '#2f4f68'], [1, '#1a2c40']],
  coast: 'rgba(140,190,230,0.42)', grid: 'rgba(120,180,220,0.11)', limb: 'rgba(140,205,255,0.55)',
};

// A context that cannot make gradients (a headless test canvas) paints the
// flat fallback instead of throwing.
function paint(gradient, stops, fallback) {
  if (!gradient || typeof gradient.addColorStop !== 'function') return fallback;
  for (const [at, color] of stops) gradient.addColorStop(at, color);
  return gradient;
}

// Fixed seed: the same sky on every mount, so a screenshot compares cleanly.
function makeStars(w, h, dpr) {
  const c = document.createElement('canvas');
  c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
  const g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  let seed = 11;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const count = Math.min(320, Math.round((w * h) / 4000));
  for (let i = 0; i < count; i++) {
    const x = rnd() * w, y = rnd() * h, r = rnd() < 0.15 ? 1.3 : 0.7, a = 0.25 + rnd() * 0.6;
    g.fillStyle = `rgba(200,225,255,${a.toFixed(2)})`;
    g.beginPath(); g.arc(x, y, r, 0, 7); g.fill();
  }
  return c;
}

// Shared glow and platform fills the marks reference by id (layers.js).
function buildDefs() {
  const defs = document.createElementNS(SVG_NS, 'defs');
  const radial = (id, stops) => {
    const g = document.createElementNS(SVG_NS, 'radialGradient'); g.setAttribute('id', id);
    for (const [o, color, op] of stops) { const st = document.createElementNS(SVG_NS, 'stop'); st.setAttribute('offset', String(o)); st.setAttribute('stop-color', color); st.setAttribute('stop-opacity', String(op)); g.appendChild(st); }
    defs.appendChild(g);
  };
  radial('sf-glow-blue', [[0, '#7ec3ff', 0.9], [0.45, '#3d8bff', 0.4], [1, '#3d8bff', 0]]);
  radial('sf-glow-cyan', [[0, '#a9c9ff', 0.8], [0.5, '#3d8bff', 0.3], [1, '#3d8bff', 0]]);
  const plat = document.createElementNS(SVG_NS, 'linearGradient'); plat.setAttribute('id', 'sf-plat'); plat.setAttribute('x1', '0'); plat.setAttribute('y1', '0'); plat.setAttribute('x2', '0'); plat.setAttribute('y2', '1');
  for (const [o, color] of [[0, '#2a5a8a'], [1, '#0c2038']]) { const st = document.createElementNS(SVG_NS, 'stop'); st.setAttribute('offset', String(o)); st.setAttribute('stop-color', color); plat.appendChild(st); }
  defs.appendChild(plat);
  return defs;
}

// Where a layout engine exists (getBBox is an SVG method no headless DOM has),
// the real label box decides; the per-character estimate below is only the
// fallback, because it missed real overlaps such as a repository label sitting
// on a platform callout.
export function declutterLabels(svg) {
  const boxes = [];
  const els = new Map();
  // Reset them all before measuring any, so the browser lays out once, not once per label.
  const all = [...svg.querySelectorAll('.lbl')];
  for (const lbl of all) lbl.removeAttribute('display'); // a label that no longer overlaps must reappear
  for (const lbl of all) {
    const mark = lbl.parentNode;
    if (!mark || mark.getAttribute('display') === 'none') continue; // off-hemisphere: already fully hidden
    const layerG = mark.closest?.('[data-layer]');
    const priority = LABEL_LAYER_PRIORITY[layerG?.getAttribute('data-layer')] ?? 9;
    if (typeof lbl.getBBox === 'function') {
      const r = lbl.getBoundingClientRect();
      if (!(r.width > 0)) continue;
      const rid = `${mark.dataset?.itemType ?? '?'}:${mark.dataset?.itemId ?? boxes.length}`;
      boxes.push({ id: rid, priority, x: r.left, y: r.top, width: r.width, height: r.height });
      els.set(rid, lbl);
      continue;
    }
    const transform = mark.getAttribute('transform') || '';
    const m = transform.match(/translate\(([-\d.]+),([-\d.]+)\)/);
    if (!m) continue;
    const tx = parseFloat(m[1]), ty = parseFloat(m[2]);
    const off = LABEL_OFFSETS.find((o) => mark.classList?.contains(o.cls)) ?? { dx: 0, dy: 0 };
    const text = lbl.textContent ?? '';
    // A multi-line callout states its own box (data-box-w/-h); a one-line
    // label is estimated from its text.
    const width = Number(lbl.getAttribute('data-box-w')) || Math.max(4, text.length * LABEL_CHAR_PX);
    const height = Number(lbl.getAttribute('data-box-h')) || LABEL_LINE_PX;
    const id = `${mark.dataset?.itemType ?? '?'}:${mark.dataset?.itemId ?? `${tx},${ty}`}`;
    boxes.push({ id, priority, x: tx + off.dx, y: ty + off.dy - LABEL_LINE_PX / 2, width, height });
    els.set(id, lbl);
  }
  for (const id of resolveLabelOverlaps(boxes)) els.get(id)?.setAttribute('display', 'none');
}

export function createGlobe(host, { d3, topology, camera = { lon: -98.5, lat: 32, k: 1 }, reducedMotion = false, onCamera = () => {}, onRender = () => {} } = {}) {
  const canvas = document.createElement('canvas');
  canvas.className = 'globe-base';
  canvas.setAttribute('aria-hidden', 'true');
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'globe-marks');
  svg.appendChild(buildDefs());
  svg.setAttribute('role', 'group');
  svg.setAttribute('aria-label', 'Globe: drag to turn, scroll to zoom, arrow keys to pan');
  const bg = document.createElementNS(SVG_NS, 'rect');
  bg.setAttribute('class', 'globe-bg');
  svg.appendChild(bg);
  host.appendChild(canvas);
  host.appendChild(svg);
  if (!host.hasAttribute('tabindex')) host.tabIndex = 0;

  const ctx2d = canvas.getContext('2d');
  const projection = d3.geoOrthographic().clipAngle(90).precision(0.5);
  const path = d3.geoPath(projection, ctx2d);
  const land = topology ? topoFeature(topology, 'countries') : null;
  const graticule = d3.geoGraticule().step([15, 15])();
  let cam = { lon: normLon(camera.lon), lat: clampLat(camera.lat), k: clampZoom(camera.k) };
  let w = 1, h = 1, R = 1, lastMs = 0, showGrid = true, stars = null;
  const dpr = window.devicePixelRatio || 1;
  const groups = new Map();
  const placers = new Map();
  const timers = new Set();
  const listeners = [];
  const on = (target, type, fn, opts) => { target.addEventListener(type, fn, opts); listeners.push([target, type, fn, opts]); };

  function apply() { projection.rotate([-cam.lon, -cam.lat]).scale(R * cam.k).translate([w / 2, h / 2]); }
  function project(lonlat) {
    if (!isVisible(lonlat, [cam.lon, cam.lat])) return null;
    const p = projection(lonlat);
    return p && Number.isFinite(p[0]) && Number.isFinite(p[1]) ? p : null;
  }
  function drawBase() {
    ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx2d.clearRect(0, 0, w, h);
    if (stars) ctx2d.drawImage(stars, 0, 0, w, h);
    const s = R * cam.k, cx = w / 2, cy = h / 2;
    const sphere = () => { ctx2d.beginPath(); path({ type: 'Sphere' }); };
    ctx2d.fillStyle = paint(ctx2d.createRadialGradient(cx, cy, s * 0.965, cx, cy, s * 1.09), [[0, 'rgba(80,160,255,0)'], [0.35, 'rgba(80,160,255,0.42)'], [1, 'rgba(80,160,255,0)']], 'rgba(80,160,255,0.2)');
    ctx2d.beginPath(); ctx2d.arc(cx, cy, s * 1.09, 0, 7); ctx2d.fill();
    ctx2d.fillStyle = paint(ctx2d.createRadialGradient(cx - s * 0.35, cy - s * 0.4, s * 0.1, cx, cy, s * 1.05), PAINT.ocean, '#0f3a6e');
    sphere(); ctx2d.fill();
    if (land) {
      ctx2d.fillStyle = paint(ctx2d.createLinearGradient(0, cy - s, 0, cy + s), PAINT.land, '#2f4f68');
      ctx2d.beginPath(); path(land); ctx2d.fill();
      ctx2d.strokeStyle = PAINT.coast; ctx2d.lineWidth = 0.7; ctx2d.stroke();
    }
    if (showGrid) { ctx2d.beginPath(); path(graticule); ctx2d.strokeStyle = PAINT.grid; ctx2d.lineWidth = 0.6; ctx2d.stroke(); }
    sphere(); ctx2d.strokeStyle = PAINT.limb; ctx2d.lineWidth = 1; ctx2d.stroke();
    // Zoomed in, the water darkens so the marks carry the view.
    if (cam.k > 1.2) { ctx2d.fillStyle = `rgba(2,10,28,${Math.min(0.5, (cam.k - 1.2) * 0.14).toFixed(3)})`; sphere(); ctx2d.fill(); }
  }
  function render() {
    const t0 = performance.now();
    apply();
    drawBase();
    for (const [id, place] of placers) if (groups.get(id).getAttribute('display') !== 'none') place(project, cam, { w, h, R });
    declutterLabels(svg);
    lastMs = performance.now() - t0;
    onRender();
  }
  function resize() {
    const r = host.getBoundingClientRect();
    w = Math.max(1, r.width); h = Math.max(1, r.height); R = Math.min(w, h) * 0.45;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    canvas.style.width = `${w}px`; canvas.style.height = `${h}px`;
    stars = makeStars(w, h, dpr);
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`); svg.setAttribute('width', String(w)); svg.setAttribute('height', String(h));
    bg.setAttribute('width', String(w)); bg.setAttribute('height', String(h));
    render();
  }
  function layerGroup(id, place) {
    let g = groups.get(id);
    if (!g) { g = document.createElementNS(SVG_NS, 'g'); g.setAttribute('data-layer', id); svg.appendChild(g); groups.set(id, g); }
    if (place) placers.set(id, place);
    return g;
  }
  function setLayerVisible(id, visible) {
    if (id === 'graticule') showGrid = visible;
    const g = groups.get(id);
    if (g) { if (visible) g.removeAttribute('display'); else g.setAttribute('display', 'none'); }
    render();
  }
  function setCamera(c, { silent = false } = {}) {
    cam = { lon: normLon(c.lon), lat: clampLat(c.lat), k: clampZoom(c.k) };
    render();
    if (!silent) onCamera({ ...cam });
  }
  let fly = null;
  // Resolving here (not just stopping the timer) keeps an in-flight flyTo() from hanging its caller across an unmount or an interrupting drag/wheel/new flyTo.
  function stopFly() { if (fly) { fly.timer.stop(); timers.delete(fly.timer); fly.resolve(); fly = null; } }
  function flyTo(target, ms = 900) {
    stopFly();
    const to = { lon: normLon(target.lon), lat: clampLat(target.lat), k: clampZoom(target.k ?? cam.k) };
    if (reducedMotion || ms <= 0) { setCamera(to); return Promise.resolve(); }
    const from = { ...cam };
    return new Promise((resolve) => {
      const timer = d3.timer((elapsed) => {
        const t = Math.min(1, elapsed / ms);
        cam = lerpCamera(from, to, easeCubicInOut(t));
        render();
        if (t >= 1) { timer.stop(); timers.delete(timer); fly = null; cam = to; onCamera({ ...cam }); resolve(); }
      });
      timers.add(timer);
      fly = { timer, resolve };
    });
  }
  let spin = null;
  function setAutoRotate(enabled) {
    if (spin) { spin.stop(); timers.delete(spin); spin = null; }
    if (!enabled || reducedMotion) return;
    let last = null;
    spin = d3.timer((elapsed) => { if (last != null) { cam = { ...cam, lon: normLon(cam.lon + 0.004 * (elapsed - last)) }; render(); } last = elapsed; });
    timers.add(spin);
  }

  let drag = null;
  on(svg, 'pointerdown', (e) => {
    if (e.target !== svg && e.target !== bg) return;
    stopFly();
    drag = { x: e.clientX, y: e.clientY, cam: { ...cam } };
    svg.setPointerCapture?.(e.pointerId);
  });
  on(svg, 'pointermove', (e) => { if (!drag) return; cam = dragCamera(drag.cam, e.clientX - drag.x, e.clientY - drag.y, R); render(); });
  const endDrag = () => { if (drag) { drag = null; onCamera({ ...cam }); } };
  on(svg, 'pointerup', endDrag);
  on(svg, 'pointercancel', endDrag);
  on(svg, 'wheel', (e) => { e.preventDefault(); stopFly(); setCamera({ ...cam, k: cam.k * Math.exp(-e.deltaY * 0.0015) }); }, { passive: false });
  on(host, 'keydown', (e) => {
    const step = 5 / cam.k;
    const moves = { ArrowLeft: [-step, 0, 1], ArrowRight: [step, 0, 1], ArrowUp: [0, step, 1], ArrowDown: [0, -step, 1], '+': [0, 0, 1.25], '=': [0, 0, 1.25], '-': [0, 0, 0.8] };
    const m = moves[e.key];
    if (!m || e.target !== host) return;
    e.preventDefault();
    setCamera({ lon: cam.lon + m[0], lat: cam.lat + m[1], k: cam.k * m[2] });
  });
  const ro = new ResizeObserver(() => resize());
  ro.observe(host);
  resize();

  return {
    getCamera: () => ({ ...cam }), setCamera, flyTo, project, layerGroup, setLayerVisible, setAutoRotate, render, resize,
    frameMs: () => lastMs,
    activeTimers: () => timers.size,
    svg,
    destroy() {
      stopFly();
      setAutoRotate(false);
      for (const t of timers) t.stop();
      timers.clear();
      for (const [target, type, fn, opts] of listeners) target.removeEventListener(type, fn, opts);
      listeners.length = 0;
      ro.disconnect();
      canvas.remove();
      svg.remove();
      groups.clear(); placers.clear();
    },
  };
}
