// web/shared/deep-link.js
// One URL scheme for the four pillars (card glmps-2-0-137 revisits D1/D3:
// Surface, Work, Evolution at /learning, Knowledge) and the session page. Every
// clickable datum's deep link is built here, and every 1.x path and server
// alert target resolves here, so a bookmark, a reload or a Slack link reopens
// the same page, band, layer, camera and selection. Pure: no DOM, importable
// under node:test.

export const LENSES = Object.freeze(['surface', 'work', 'learning', 'knowledge']);

// Lenses folded into a pillar tab. Their old paths, links their own modules
// still build, and alert targets all land on the tab that hosts them now.
export const FOLDED_LENSES = Object.freeze({
  loops: { lens: 'learning', tab: 'loops' },
  personality: { lens: 'learning', tab: 'capabilities', seg: 'files' },
});
const WIKI_TAB = Object.freeze({ lens: 'knowledge', tab: 'wiki' });
// Surface side panels retired in card glmps-2-0-137 phase 2: each full-size
// view has its own tab now, so an old ?panel= link lands there (the selection
// rides along, so /surface?panel=graph&sel=session:x opens that session's map).
export const SURFACE_MOVED = Object.freeze({
  cost: { lens: 'work', tab: 'cost' },
  kanban: { lens: 'work', tab: 'board' },
  graph: { lens: 'knowledge', tab: 'architecture' },
  decisions: { lens: 'knowledge', tab: 'decisions' },
});
// GLMPS opens on Surface. Links and 1.x bookmarks that name the retired Now lens land on Surface (or Work, for the record).
export const DEFAULT_LENS = 'surface';

// 1.x view names (nav views, retired views, and alert target views) -> where
// their content lives now. 'wiki' leaves the dashboard for the D-W page (D3).
export const LEGACY_VIEWS = Object.freeze({
  dashboard: { lens: 'surface' },
  stageboard: { lens: 'surface', panel: 'fleet' },
  'stage-board': { lens: 'surface', panel: 'fleet' },
  sessions: { lens: 'surface', panel: 'fleet' },
  history: { lens: 'work', tab: 'history' },
  analytics: { lens: 'work', tab: 'cost' },
  alerts: { lens: 'surface', panel: 'attention' },
  map: { lens: 'knowledge', tab: 'architecture' },
  decisions: { lens: 'knowledge', tab: 'decisions' },
  policy: { lens: 'surface', panel: 'declared' },
  engagement: { lens: 'surface', panel: 'declared' },
  governance: { lens: 'surface', panel: 'declared' },
  'substrate-loop': { lens: 'learning', tab: 'ledger' },
  experiments: { lens: 'learning', tab: 'experiments' },
  improvements: { lens: 'learning', tab: 'experiments' },
  registry: { lens: 'learning', tab: 'capabilities' },
  guardrails: { lens: 'learning', tab: 'capabilities' },
  skills: { lens: 'learning', tab: 'capabilities' },
  measurables: { lens: 'learning', tab: 'capabilities' },
  research: { lens: 'learning', tab: 'capabilities' },
  memory: { lens: 'learning', tab: 'capabilities', seg: 'memory' },
  learning: { lens: 'learning', tab: 'capabilities' },
  kanban: { lens: 'work', band: 'board' },
  backlog: { lens: 'work', band: 'board' },
  'qa-trends': { lens: 'work', tab: 'qa' },
  wiki: WIKI_TAB, // the Knowledge Wiki tab (was D3's own /wiki/ page; F7: never location.assign, which would reload /wiki/ forever)
});

// A 1.x path segment or alert target id, typed by the view it came with.
export const LEGACY_ID_TYPE = Object.freeze({ kanban: 'card', backlog: 'card', map: 'session' });

function safeDecode(s) { try { return decodeURIComponent(s); } catch { return null; } }

export function parseSel(s) {
  if (typeof s !== 'string') return null;
  const i = s.indexOf(':');
  if (i <= 0 || i === s.length - 1) return null;
  return { type: s.slice(0, i), id: s.slice(i + 1) };
}

export function parseCam(s) {
  if (typeof s !== 'string' || !s) return null;
  const parts = s.split(',');
  if (parts.length !== 3) return null;
  const [lon, lat, k] = parts.map(Number);
  if (![lon, lat, k].every(Number.isFinite) || lat < -90 || lat > 90 || k <= 0) return null;
  // Only wrap out-of-range longitudes; an in-range value passes through
  // untouched so a round trip through formatCam/parseCam is exact (the wrap
  // formula's modulo arithmetic introduces floating-point drift).
  const wrapped = lon >= -180 && lon <= 180 ? lon : ((((lon + 180) % 360) + 360) % 360) - 180;
  return { lon: wrapped, lat, k };
}

export function formatCam({ lon, lat, k }) {
  return `${lon.toFixed(2)},${lat.toFixed(2)},${k.toFixed(2)}`;
}

function route(r = {}) {
  return {
    lens: r.lens ?? null, sessionId: r.sessionId ?? null, band: r.band ?? null, panel: r.panel ?? null,
    seg: r.seg ?? null, tool: r.tool ?? null, preset: r.preset ?? null, layers: r.layers ?? null,
    cam: r.cam ?? null, sel: r.sel ?? null, external: r.external ?? null, legacy: r.legacy ?? null,
    unknown: r.unknown ?? null, page: r.page ?? null, tab: r.tab ?? null,
  };
}

function fromQuery(search) {
  let q;
  try { q = new URLSearchParams(search || ''); } catch { q = new URLSearchParams(); }
  const layers = q.get('layers');
  return {
    tab: q.get('tab'), band: q.get('band'), panel: q.get('panel'), seg: q.get('seg'), tool: q.get('tool'), preset: q.get('preset'),
    layers: layers ? layers.split(',').filter(Boolean) : null,
    cam: parseCam(q.get('cam')), sel: parseSel(q.get('sel')),
  };
}

// A /now link: the same query it always carried, read onto the lens that now
// shows that thing. The selection (an alert, a loop) rides along unchanged.
function fromNow(search) {
  const q = fromQuery(search);
  if (q.band === 'record' || q.tool) return { ...q, lens: 'work', band: 'record', panel: null };
  let panel = q.panel === 'cost' ? null : q.panel;
  if (q.band === 'fleet') panel = 'fleet';
  else if (q.band === 'state') panel = q.sel?.type === 'loop' ? 'loops' : 'attention';
  return { ...q, lens: 'surface', band: null, panel };
}

export function parseLink(pathname = '/', search = '') {
  const parts = String(pathname).replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
  const head = parts[0] ?? '';
  const id = parts[1] ? safeDecode(parts[1]) : null;
  if ((head === 'session' || head === 'sessions' || head === 'detail') && id) return route({ lens: 'session', sessionId: id });
  if (head === '') return route({ lens: DEFAULT_LENS, ...fromQuery(search) });
  if (LENSES.includes(head)) {
    const q = fromQuery(search);
    const moved = head === 'surface' ? SURFACE_MOVED[q.panel] : null;
    if (moved) return route({ sel: q.sel, ...moved, legacy: `surface-${q.panel}` });
    return route({ lens: head, ...q });
  }
  if (head === 'now') return route({ ...fromNow(search), legacy: 'now' });
  if (FOLDED_LENSES[head]) return route({ ...fromQuery(search), ...FOLDED_LENSES[head], legacy: head });
  const legacy = LEGACY_VIEWS[head];
  if (legacy) {
    if (legacy.external) return route({ external: legacy.external, legacy: head });
    const sel = id && LEGACY_ID_TYPE[head] ? { type: LEGACY_ID_TYPE[head], id } : null;
    return route({ ...legacy, sel, legacy: head });
  }
  return route({ lens: DEFAULT_LENS, unknown: head });
}

export function linkFor(r = {}) {
  if (r.external) return r.external;
  if (r.page === 'wiki') return linkFor(WIKI_TAB);
  if (FOLDED_LENSES[r.lens]) return linkFor({ ...r, ...FOLDED_LENSES[r.lens] });
  if (r.lens === 'session') return `/session/${encodeURIComponent(r.sessionId ?? '')}`;
  const lens = LENSES.includes(r.lens) ? r.lens : DEFAULT_LENS;
  const q = new URLSearchParams();
  if (r.tab) q.set('tab', r.tab);
  if (r.band) q.set('band', r.band);
  if (r.panel) q.set('panel', r.panel);
  if (r.seg) q.set('seg', r.seg);
  if (r.tool) q.set('tool', r.tool);
  if (r.preset) q.set('preset', r.preset);
  if (Array.isArray(r.layers) && r.layers.length) q.set('layers', r.layers.join(','));
  if (r.cam) q.set('cam', formatCam(r.cam));
  if (r.sel && r.sel.type && r.sel.id != null) q.set('sel', `${r.sel.type}:${r.sel.id}`);
  const s = q.toString();
  return `/${lens}${s ? '?' + s : ''}`;
}

// A server alert's `target` ({ view, id?, loop? }) -> the link that shows it.
export function resolveTarget(t = {}) {
  const view = t?.view;
  if (view === 'loops') return linkFor({ ...FOLDED_LENSES.loops, sel: t.loop ? { type: 'loop', id: t.loop } : null });
  if ((view === 'sessions' || view === 'detail') && t.id) return linkFor({ lens: 'session', sessionId: t.id });
  const legacy = LEGACY_VIEWS[view];
  if (!legacy) return linkFor({ lens: 'surface', panel: 'attention' });
  if (legacy.external) return legacy.external;
  const sel = t.id && LEGACY_ID_TYPE[view] ? { type: LEGACY_ID_TYPE[view], id: t.id } : null;
  return linkFor({ ...legacy, sel });
}
