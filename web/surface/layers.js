// web/surface/layers.js
// The Surface layers (D10, D17): each is a filter over the one globe, fed by a
// named route (R1: an unfed layer is not built). Tasks 11 and 12 add
// residency, nowhere-else, players, files, agents and cards.
import { bindItem } from '../shared/interactive-item.js';
import { linkFor } from '../shared/deep-link.js';
import { buildFileActions } from '../shared/file-actions.js';
import { ackedSet } from '../shared/alerts-data.js';
import { ringPlacement, ringRadiusForZoom, separatePoints, RESIDENCY_WORD, RESIDENCY_GLYPH } from './globe-core.js';
import { agentName } from './agent-name.js';
import { LOGOS, hasLogo } from './logos/index.js';
import { createDial, DIAL_OUTER } from './agent-dial.js';
import { orbitRadiusPx, orbitPoint, loopPhase, loopOrbits, loopLabel, pulsePlaces, pulseLabel } from './orbits.js';

export const LAYERS = [
  { id: 'graticule', key: 'G', label: 'Graticule', swatch: '#6f8fa1', source: 'drawn', build: () => ({ count: null, place() {} }) },
  { id: 'labels', key: 'L', label: 'Labels', swatch: '#dbeaf2', source: 'drawn', build: () => ({ count: null, place() {} }) },
];

// One fetch per feed, each result kept with its status so a layer can name
// the route that is dry. Tasks 11 and 12 add feeds.
export const FEEDS = {};

export async function loadSurfaceData() {
  const out = {};
  await Promise.all(Object.entries(FEEDS).map(async ([name, url]) => {
    try {
      const res = await fetch(url);
      out[name] = res.ok ? { ok: true, data: await res.json(), status: res.status, fetchedAt: Date.now() } : { ok: false, status: res.status, error: `GET ${url} returned ${res.status}` };
    } catch (e) { out[name] = { ok: false, status: 0, error: `GET ${url} failed: ${e.message}` }; }
  }));
  return out;
}

// Task 11: the residency layer (K5 git-remote feed), the nowhere-else region
// and the players (fixed third-party locations plus the operator's own,
// W3-private, local store).
const SVG_NS = 'http://www.w3.org/2000/svg';
export const svgEl = (tag, cls) => { const e = document.createElementNS(SVG_NS, tag); if (cls) e.setAttribute('class', cls); return e; };
// split out so an arc (no single point to translate,
// just a d path between two projected points) can share the same tabindex/
// display toggle a translated node gets, instead of being left focusable and
// invisible once its d goes empty.
const setVisible = (el, visible) => { if (visible) { el.removeAttribute('display'); el.setAttribute('tabindex', '0'); } else { el.setAttribute('display', 'none'); el.setAttribute('tabindex', '-1'); } };
// Link layers (a line or arc between two places) are off by default; selecting a
// place draws that place's own links whatever the toggles say (lens.js sets
// api.linkShown). A layer built without a lens (a test) draws everything.
export const linkOn = (api, layerId, places) => api.linkShown?.(layerId, places) ?? true;
export const place = (el, p) => { setVisible(el, !!p); if (p) el.setAttribute('transform', `translate(${p[0].toFixed(1)},${p[1].toFixed(1)})`); };
const STALE_MS = 2 * 15 * 60000; // two K5 ticks
const ageText = (ms) => (ms < 5400000 ? `${Math.round(ms / 60000)} min` : `${(ms / 3600000).toFixed(1)} h`);

export const SURFACE_ITEM_TYPES = {
  repo: 'the repository\'s residency facts and branches',
  arc: 'the repository\'s link to its remote host',
  region: 'the repositories that exist nowhere else',
  player: 'what that location holds, with its evidence class',
};

FEEDS.residency = '/api/residency';
FEEDS.config = '/api/config';
FEEDS.players = '/surface/players.json';
FEEDS.backlog = '/api/backlog?fields=id,title,state,origin,project';

export function hostOf(remote) {
  if (typeof remote !== 'string' || !remote) return null;
  const scp = remote.match(/^[^@/]+@([^:/]+):/);
  if (scp) return scp[1];
  try { return new URL(remote).hostname || null; } catch { return null; }
}

// the host as a label; a remote that is neither SCP-style
// nor a URL is named as unreadable (its raw text stays in the inspector's
// remote fact) instead of rendering the word "null".
export const hostLabel = (remote) => hostOf(remote) ?? 'remote unreadable';

function repoModel(row) {
  return {
    title: row.repo,
    word: `${RESIDENCY_GLYPH[row.residency] ?? ''} ${RESIDENCY_WORD[row.residency] ?? row.residency}`.trim(),
    facts: [
      ['path', row.path], ['remote', row.remote ?? 'none: exists nowhere else'], ['default branch', row.defaultBranch],
      ['ahead', row.ahead], ['behind', row.behind], ['uncommitted paths', row.dirty],
      ['unpushed branches', row.unpushedBranches?.join(', ') || 'none'], ['no upstream', row.noUpstreamBranches?.join(', ') || 'none'],
      ['last fetch', row.lastFetchTs ? new Date(row.lastFetchTs).toISOString() : 'never'],
      // the arc opener already showed an unknown
      // row's error; the repo inspector (the one most people open first) did
      // not.
      ...(row.error ? [['error', row.error]] : []),
    ],
    actions: [],
  };
}

// A logo plate is 30 px across, so neighbours fan out to this gap.
const PLAYER_GAP_PX = 44;
const LOGO_PX = 20;

// The platform a player sits on: a rack for the local store, a shield with a
// branch glyph for GitHub, a hexagonal deck for the cloud hosts.
function platformShape(p) {
  const g = svgEl('g', 'pl-shape');
  const add = (tag, attrs, cls) => { const e = svgEl(tag, cls); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v)); g.appendChild(e); return e; };
  if (hasLogo(p.id)) {
    // The company logo on a round plate. The name is the mark's aria-label and
    // title, not text drawn on the globe.
    const logo = LOGOS[p.id];
    add('circle', { r: 15 }, 'logo-plate');
    const [bx, by, bw] = logo.box.split(' ').map(Number);
    const k = LOGO_PX / bw;
    const glyph = svgEl('g', `logo-glyph logo-${logo.kind}`);
    glyph.setAttribute('transform', `translate(${(-LOGO_PX / 2 - bx * k).toFixed(2)},${(-LOGO_PX / 2 - by * k).toFixed(2)}) scale(${k.toFixed(4)})`);
    const path = svgEl('path'); path.setAttribute('d', logo.d);
    if (logo.kind === 'stroke') path.setAttribute('stroke-width', String(logo.sw));
    glyph.appendChild(path); g.appendChild(glyph);
  } else if (p.id === 'local') {
    add('rect', { x: -18, y: -14, width: 36, height: 28, rx: 3 }, 'rack-body');
    for (let i = 0; i < 3; i++) { add('rect', { x: -14, y: -11 + i * 8, width: 28, height: 5, rx: 1 }, 'rack-slot'); add('circle', { cx: 11, cy: -8.5 + i * 8, r: 1.2 }, i === 1 ? 'rack-led warn' : 'rack-led'); }
  } else if (p.id === 'github') {
    add('path', { d: 'M0,-19 L16,-13 L16,1.5 Q16,14 0,20 Q-16,14 -16,1.5 L-16,-13 Z' }, 'shield');
    add('circle', { cx: -5, cy: -7, r: 2.4 }, 'glyph'); add('circle', { cx: -5, cy: 7, r: 2.4 }, 'glyph'); add('circle', { cx: 5.5, cy: -2, r: 2.4 }, 'glyph');
    add('path', { d: 'M-5,-4.6 V4.6 M5.5,0.4 C5.5,5 -5,2 -5,4.6' }, 'glyph');
  } else {
    add('path', { d: 'M0,-14 L24,-7 L24,7 L0,14 L-24,7 L-24,-7 Z' }, 'plat');
    add('path', { d: 'M0,-9 L16,-4.5 L16,4.5 L0,9 L-16,4.5 L-16,-4.5 Z' }, 'plat-inner');
  }
  return g;
}

// The callout beside a platform: where it is, its name, and the evidence
// class of the placement as a badge (vendor, operator, illustrative).
function calloutFor(p) {
  const g = svgEl('g', 'lbl callout');
  const text = (cls, x, y, str) => { const t = svgEl('text', cls); t.setAttribute('x', String(x)); t.setAttribute('y', String(y)); t.textContent = str; g.appendChild(t); return t; };
  text('prov', 30, -6, p.where);
  text('nm', 30, 9, p.name);
  const w = p.evidence.length * 6.6 + 10;
  const bg = svgEl('rect', `ev-bg ev-bg-${p.evidence}`); bg.setAttribute('x', '30'); bg.setAttribute('y', '14'); bg.setAttribute('width', w.toFixed(1)); bg.setAttribute('height', '16'); bg.setAttribute('rx', '2'); g.appendChild(bg);
  text(`ev ev-${p.evidence}`, 35, 26, p.evidence);
  g.setAttribute('data-box-w', String(Math.ceil(Math.max(p.where.length, p.name.length * 1.1, p.evidence.length + 2) * 6.6)));
  g.setAttribute('data-box-h', '52');
  return g;
}

// The shared placement of the local store and remote hosts is computed once
// per mount from the feeds (players and config), set on api.local and
// api.remotePos by the players layer, which is built first.
const playersLayer = {
  id: 'players', key: 'P', label: 'Players', swatch: '#7ec3ff', source: 'web/surface/players.json and config surface.localGeo, else the OS timezone',
  build(api, group) {
    const decl = api.data.players?.ok ? api.data.players.data.players : [];
    const geo = api.data.config?.ok ? api.data.config.data.surface?.localGeo ?? null : null;
    const local = decl.find((p) => p.id === 'local');
    const players = decl.map((p) => (p.id === 'local'
      ? { ...p, lon: geo?.lon ?? -98.5, lat: geo?.lat ?? 39.8, where: geo ? `${geo.city} (${geo.precision}, ${geo.source === 'timezone' ? 'from OS timezone' : geo.source})` : 'location not set (config.json surface.localGeo)' }
      : { ...p, where: p.provider }));
    api.local = [players.find((p) => p.id === 'local')?.lon ?? -98.5, players.find((p) => p.id === 'local')?.lat ?? 39.8];
    const byHost = new Map(players.filter((p) => p.remoteHost).map((p) => [p.remoteHost, p]));
    const extra = new Map();
    api.remotePos = (remote) => {
      const host = hostOf(remote);
      if (!host) return null;
      const p = byHost.get(host);
      if (p) return [p.lon, p.lat];
      if (!extra.has(host)) extra.set(host, [-74 + extra.size * 2, 41]);
      return extra.get(host);
    };
    const tools = api.ctx.getState()?.tools ?? [];
    const rows = api.data.residency?.ok ? api.data.residency.data.rows : [];
    const cards = api.data.backlog?.ok ? api.data.backlog.data.items ?? [] : [];
    const holdCount = (h) => {
      if (h === 'repos') return rows.length;
      if (h === 'repos-remote') return rows.filter((r) => r.remote).length;
      if (h === 'cards') return cards.length;
      if (h === 'cards:slack') return cards.filter((c) => c.origin?.via === 'slack').length;
      if (h.startsWith('sessions:')) { const t = tools.find((x) => x.id === h.slice(9)); return t ? t.sessionsFound ?? 0 : 'not captured'; }
      return 'live';
    };
    api.holdCount = holdCount;
    api.players = players;
    const marks = players.map((p) => {
      const g = svgEl('g', `player player-${p.id} ev-${p.evidence}`);
      const leader = svgEl('line', 'pl-leader'); const truept = svgEl('circle', 'pl-true'); truept.setAttribute('r', '2.5');
      g.appendChild(leader); g.appendChild(truept);
      const glow = svgEl('circle', 'pl-glow'); glow.setAttribute('r', '34'); glow.setAttribute('fill', p.id === 'local' ? 'url(#sf-glow-cyan)' : 'url(#sf-glow-blue)'); g.appendChild(glow);
      const ring = svgEl('circle', 'pl-ring'); ring.setAttribute('r', '23'); g.appendChild(ring);
      g.appendChild(platformShape(p));
      const stack = svgEl('g', 'stack'); g.appendChild(stack);
      if (!hasLogo(p.id)) g.appendChild(calloutFor(p));
      // A remote place states how many items it holds instead of drawing lines to them.
      const linked = p.id === 'local' ? 0 : (p.holds ?? []).reduce((n, h) => { const c = holdCount(h); return n + (typeof c === 'number' ? c : 0); }, 0);
      if (linked > 0) {
        const chip = svgEl('g', 'pl-count'); chip.setAttribute('transform', 'translate(14,-24)');
        const bg = svgEl('rect', 'pl-count-bg'); const w = Math.max(18, String(linked).length * 7 + 10);
        bg.setAttribute('x', '0'); bg.setAttribute('y', '-9'); bg.setAttribute('width', String(w)); bg.setAttribute('height', '18'); bg.setAttribute('rx', '9');
        const tx = svgEl('text', 'pl-count-text'); tx.setAttribute('x', String(w / 2)); tx.setAttribute('y', '4'); tx.textContent = String(linked);
        chip.append(bg, tx); g.appendChild(chip);
      }
      const name = `${p.name}, ${p.where}, evidence ${p.evidence}${linked > 0 ? `, ${linked} linked items` : ''}`;
      bindItem(g, { type: 'player', id: p.id, link: api.link({ type: 'player', id: p.id }), open: () => api.open({ type: 'player', id: p.id }), label: name });
      if (hasLogo(p.id)) { const tip = svgEl('title'); tip.textContent = `${p.name}: ${p.where} (evidence ${p.evidence})`; g.insertBefore(tip, g.firstChild); }
      group.appendChild(g);
      return { p, g, stack, leader, truept };
    });
    api.playerMarks = marks;
    // Where a platform is drawn right now (fanned apart from its true point),
    // so the orbit and pulse layers sit on the platform, not beside it.
    api.playerScreen = (id) => marks.find((m) => m.p.id === id)?.screen ?? null;
    api.registerOpener('player', (id) => {
      const m = marks.find((x) => x.p.id === id);
      if (!m) return false;
      const model = { title: m.p.name, word: `${m.p.where}, evidence ${m.p.evidence}`, facts: [['note', m.p.note ?? (local === m.p ? 'This workstation' : '')], ...m.p.holds.map((h) => [h, holdCount(h)])] };
      if (api.location) api.location(m.p, model); else api.inspect(model);
      api.flyTo([m.p.lon, m.p.lat], 4);
      return true;
    });
    return {
      count: players.length,
      place(project) {
        // Marks that would sit on top of each other at this zoom are fanned
        // apart on screen, each keeping a leader to its true point.
        const live = marks.map((m) => ({ m, at: project([m.p.lon, m.p.lat]) })).filter((x) => x.at);
        const spread = separatePoints(live.map((x) => ({ x: x.at[0], y: x.at[1] })), PLAYER_GAP_PX);
        for (const m of marks) { place(m.g, null); m.screen = null; }
        live.forEach(({ m, at }, i) => {
          place(m.g, [spread[i].x, spread[i].y]);
          m.screen = [spread[i].x, spread[i].y];
          const dx = at[0] - spread[i].x, dy = at[1] - spread[i].y, moved = Math.hypot(dx, dy) > 4;
          m.leader.setAttribute('x2', dx.toFixed(1)); m.leader.setAttribute('y2', dy.toFixed(1));
          m.leader.setAttribute('display', moved ? 'inline' : 'none'); m.truept.setAttribute('display', moved ? 'inline' : 'none');
          m.truept.setAttribute('cx', dx.toFixed(1)); m.truept.setAttribute('cy', dy.toFixed(1));
        });
      },
    };
  },
};

// The projected points along the great circle from a to b; null where the
// point is on the far side. arcPath draws them, the live arcs ride them.
export function arcPoints(d3, a, b, project) {
  const interp = d3.geoInterpolate(a, b);
  const pts = [];
  for (let i = 0; i <= 24; i++) pts.push(project(interp(i / 24)));
  return pts;
}

export function arcPath(d3, a, b, project) {
  let d = ''; let pen = false;
  for (const p of arcPoints(d3, a, b, project)) {
    if (!p) { pen = false; continue; }
    d += `${pen ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`;
    pen = true;
  }
  return d;
}

const residencyLayer = {
  id: 'residency', key: 'R', label: 'Residency', swatch: '#3ddc84', source: 'GET /api/residency (K5 git-remote feed)',
  build(api, group) {
    const feed = api.data.residency;
    if (!feed?.ok) { api.empty(`Residency feed not available: ${feed?.error ?? 'GET /api/residency returned no data'}. The git-remote feed ships with phase K5.`); return { count: 0, place() {} }; }
    // ts == null used to compute an age since the epoch
    // (a bogus "53 years old" message) instead of naming the real problem.
    if (feed.data.ts == null) api.empty('The residency feed has no timestamp; its loop may be failing (see Loops).');
    else { const age = Date.now() - feed.data.ts; if (age > STALE_MS) api.empty(`The residency feed ${ageText(age)} old; its loop may be failing (see Loops).`); }
    const rows = (feed.data.rows ?? []).filter((r) => r.remote);
    const marks = rows.map((row, i) => {
      const node = svgEl('g', `res-node res-${row.residency}`);
      const c = svgEl('circle'); c.setAttribute('r', '5'); node.appendChild(c);
      const glyph = svgEl('text', 'res-glyph'); glyph.textContent = RESIDENCY_GLYPH[row.residency] ?? '?'; node.appendChild(glyph);
      const lbl = svgEl('text', 'lbl'); lbl.textContent = `${row.repo} ${RESIDENCY_WORD[row.residency] ?? row.residency}`; node.appendChild(lbl);
      bindItem(node, { type: 'repo', id: row.repo, link: api.link({ type: 'repo', id: row.repo }), open: () => api.open({ type: 'repo', id: row.repo }), label: `${row.repo}: ${RESIDENCY_WORD[row.residency] ?? row.residency}` });
      group.appendChild(node);
      // was 6 / cam.k (zoom-invariant screen size,
      // reviewer-measured to never spread same-ring labels apart at any
      // zoom); ringRadiusForZoom keeps k=1 identical but lets zoom help.
      api.repoLocators.set(row.repo, (k) => ringPlacement(api.localPos(), rows.length, i, ringRadiusForZoom(6, k)));
      return { row, node };
    });
    api.registerOpener('repo', (id) => { const m = marks.find((x) => x.row.repo === id); if (!m) return false; api.inspect(api.decorateRepo?.(repoModel(m.row), m.row) ?? repoModel(m.row)); const pos = api.repoPos(id); if (pos) api.flyTo(pos, 10); return true; });
    return {
      count: rows.length,
      place(project) { for (const m of marks) place(m.node, project(api.repoPos(m.row.repo))); },
    };
  },
};

// The arcs from each repository to the host of its remote. They were part of
// the Residency layer until round 3 of glmps-2-0-63: lines to Slack, AWS and
// GitHub cluttered the globe, so they are their own layer, off by default.
const remoteLinksLayer = {
  id: 'remote-links', key: 'X', label: 'Remote links', swatch: '#3ddc84', link: true, source: 'GET /api/residency (repositories with a remote, drawn to the host of the remote)',
  build(api, group) {
    const feed = api.data.residency;
    if (!feed?.ok) return { count: 0, place() {} };
    const rows = (feed.data.rows ?? []).filter((r) => r.remote);
    const hostPlayer = (row) => (api.players ?? []).find((p) => p.remoteHost && p.remoteHost === hostOf(row.remote))?.id ?? null;
    const marks = rows.map((row, i) => {
      const arc = svgEl('path', `res-arc res-${row.residency}`);
      bindItem(arc, { type: 'arc', id: row.repo, link: api.link({ type: 'arc', id: row.repo }), open: () => api.open({ type: 'arc', id: row.repo }), label: `${row.repo} to ${hostLabel(row.remote)}` });
      group.appendChild(arc);
      return { row, arc, i, places: ['local', hostPlayer(row)].filter(Boolean) };
    });
    api.registerOpener('arc', (id) => { const m = marks.find((x) => x.row.repo === id); if (!m) return false; api.inspect({ title: `${m.row.repo} to ${hostLabel(m.row.remote)}`, word: RESIDENCY_WORD[m.row.residency], facts: [['remote', m.row.remote], ['ahead', m.row.ahead], ['behind', m.row.behind], ...(m.row.error ? [['error', m.row.error]] : [])] }); return true; });
    return {
      count: rows.length,
      touches: (placeId) => marks.some((m) => m.places.includes(placeId)),
      place(project, cam) {
        // The same ring the Residency layer places the repositories on.
        const r = ringRadiusForZoom(6, cam.k);
        for (const m of marks) {
          const pos = ringPlacement(api.localPos(), marks.length, m.i, r);
          const remote = api.remotePos(m.row.remote);
          const p1 = project(pos), p2 = remote ? project(remote) : null;
          // an arc kept tabindex 0 forever (bindItem
          // sets it once, at creation) even once its own repository or its
          // remote's host went off-hemisphere (or the host was unparseable),
          // leaving an invisible mark in the tab order with nothing to open.
          const visible = !!p1 && !!p2 && linkOn(api, 'remote-links', m.places);
          m.arc.setAttribute('d', visible ? arcPath(api.d3, pos, remote, project) : '');
          setVisible(m.arc, visible);
        }
      },
    };
  },
};

const nowhereLayer = {
  id: 'nowhere', key: 'N', label: 'Nowhere else', swatch: '#c96b52', source: 'GET /api/residency rows with no remote',
  build(api, group) {
    const feed = api.data.residency;
    if (!feed?.ok) return { count: 0, place() {} };
    const rows = (feed.data.rows ?? []).filter((r) => !r.remote);
    const region = svgEl('g', 'nowhere-region');
    const ring = svgEl('circle', 'nowhere-ring'); ring.setAttribute('r', '22'); region.appendChild(ring);
    const title = svgEl('text', 'lbl nowhere-title'); title.textContent = `nowhere else: ${rows.length}`; region.appendChild(title);
    bindItem(region, { type: 'region', id: 'nowhere-else', link: api.link({ type: 'region', id: 'nowhere-else' }), open: () => api.open({ type: 'region', id: 'nowhere-else' }), label: `${rows.length} repositories exist nowhere else` });
    group.appendChild(region);
    const marks = rows.map((row, i) => {
      // this layer draws every row with no remote,
      // which used to always mean "confirmed nowhere-else" - but a row the
      // git check could not read (residency 'unknown') can also have no
      // remote, and hardcoding the nowhere-else glyph/word/class showed it
      // as a confirmed state it is not. Keyed by row.residency instead,
      // exactly like residencyLayer's own nodes above.
      const node = svgEl('g', `res-node res-${row.residency}`);
      const c = svgEl('circle'); c.setAttribute('r', '5'); node.appendChild(c);
      const glyph = svgEl('text', 'res-glyph'); glyph.textContent = RESIDENCY_GLYPH[row.residency] ?? '?'; node.appendChild(glyph);
      const lbl = svgEl('text', 'lbl'); lbl.textContent = `${row.repo} ${RESIDENCY_WORD[row.residency] ?? row.residency}`; node.appendChild(lbl);
      bindItem(node, { type: 'repo', id: row.repo, link: api.link({ type: 'repo', id: row.repo }), open: () => api.open({ type: 'repo', id: row.repo }), label: `${row.repo}: ${RESIDENCY_WORD[row.residency] ?? row.residency}` });
      group.appendChild(node);
      // same zoom-invariant-radius bug as the residency ring, same fix.
      api.repoLocators.set(row.repo, (k) => ringPlacement(regionCenter(k), rows.length, i, ringRadiusForZoom(1.5, k)));
      return { row, node };
    });
    // The region sits south-west of the local store, closer as the camera zooms in.
    const regionCenter = (k) => { const [lon, lat] = api.localPos(); return [lon - 3 / k, lat - 3 / k]; };
    api.registerOpener('region', (id) => {
      if (id !== 'nowhere-else') return false;
      api.inspect({ title: 'Nowhere else', word: `${rows.length} repositories have no remote and exist only on this disk`, rows: rows.map((r) => ({ type: 'repo', id: r.repo, text: r.repo, link: api.link({ type: 'repo', id: r.repo }), open: () => api.open({ type: 'repo', id: r.repo }) })) });
      return true;
    });
    api.registerOpener('repo', (id) => { const m = marks.find((x) => x.row.repo === id); if (!m) return false; api.inspect(api.decorateRepo?.(repoModel(m.row), m.row) ?? repoModel(m.row)); const pos = api.repoPos(id); if (pos) api.flyTo(pos, 10); return true; });
    return {
      count: rows.length,
      place(project, cam) {
        place(region, project(regionCenter(cam.k)));
        for (const m of marks) place(m.node, project(api.repoPos(m.row.repo)));
      },
    };
  },
};

LAYERS.unshift(playersLayer, remoteLinksLayer, residencyLayer, nowhereLayer);

// Task 12: the file tree, agents and cards layers, and the file actions
// (diff popup, pop-out editor, open-in-IDE) end to end, carried over from
// 1.x (web/shared/file-actions.js), not rebuilt.
Object.assign(SURFACE_ITEM_TYPES, {
  folder: 'the folder\'s drifted files',
  file: 'the file\'s diff, editor and IDE actions',
  agent: 'the live session\'s declared goal and observed work',
  'card-stack': 'the cards in flight at that location',
  card: 'the card on Work',
});
FEEDS.live = '/api/sessions/live';
FEEDS.workspace = '/api/workspace';

const FILE_WORD = { uncommitted: 'uncommitted', untracked: 'untracked', ahead: 'ahead of the remote', behind: 'behind the remote', clean: 'in sync' };

const filesLayer = {
  id: 'files', key: 'F', label: 'File tree', swatch: '#3d8bff', source: 'GET /api/surface/tree',
  build(api, group) {
    const trees = new Map(); // repo -> { tree, marks }
    const repoRow = (repo) => (api.data.residency?.ok ? api.data.residency.data.rows : []).find((r) => r.repo === repo);
    const absOf = (row, rel) => `${String(row.path).replace(/[\\/]+$/, '')}/${rel}`;
    async function loadTree(repo) {
      if (trees.has(repo)) return trees.get(repo);
      const res = await fetch(`/api/surface/tree?repo=${encodeURIComponent(repo)}`);
      if (!res.ok) { const b = await res.json().catch(() => ({})); throw new Error(b.error ?? `GET /api/surface/tree returned ${res.status}`); }
      const tree = await res.json();
      // The fetch above can still be in flight when the lens unmounts (a
      // click fires showTree, then the test/operator navigates away before
      // it resolves) - building marks and rendering into a destroyed globe
      // would touch document/DOM APIs a torn-down page no longer has.
      if (api.destroyed) return { tree, marks: [] };
      const marks = tree.folders.map((f, i) => {
        const g = svgEl('g', `folder${f.drifted ? ' drifted' : ''}`);
        const sq = svgEl('rect', 'folder-sq'); const s = Math.max(6, Math.min(18, Math.sqrt(f.count) * 2));
        sq.setAttribute('x', String(-s / 2)); sq.setAttribute('y', String(-s / 2)); sq.setAttribute('width', String(s)); sq.setAttribute('height', String(s));
        g.appendChild(sq);
        const lbl = svgEl('text', 'lbl'); lbl.textContent = `${f.dir} ${f.count}${f.drifted ? `, ${f.drifted} differ` : ''}`; g.appendChild(lbl);
        const id = `${repo}/${f.dir}`;
        bindItem(g, { type: 'folder', id, link: api.link({ type: 'folder', id }), open: () => api.open({ type: 'folder', id }), label: `Folder ${f.dir}: ${f.count} files, ${f.drifted} differ from the remote` });
        group.appendChild(g);
        return { f, g, i };
      });
      const entry = { tree, marks };
      trees.set(repo, entry);
      api.globe.render();
      return entry;
    }
    // this used to report nothing on failure, and the
    // folder opener's .then() re-opened the folder unconditionally - a
    // repo whose tree never loads retried forever, at fetch speed, from a
    // deep link. showTree now reports whether it actually succeeded, so a
    // caller can tell a genuine failure from success and stop.
    api.loadTree = loadTree;
    api.trees = trees;
    api.showTree = async (repo) => {
      try {
        await loadTree(repo);
        if (api.destroyed) return true;
        // The files layer starts off by default (a drill-down detail layer,
        // not a primary status one) - "Show file tree" is an explicit ask
        // to see it, so it turns itself on rather than building marks
        // nobody can see until they separately find the rail checkbox.
        api.showLayer?.('files');
        if (!api.globe.getCamera || api.globe.getCamera().k < 8) await api.flyTo(api.repoPos?.(repo) ?? api.localPos(), 12);
        return true;
      } catch (e) {
        if (!api.destroyed) api.inspect({ title: repo, empty: `The file tree failed to load: ${e.message}` });
        return false;
      }
    };
    api.decorateRepo = (model, row) => {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'fa-btn'; b.textContent = 'Show file tree';
      b.addEventListener('click', () => api.showTree(row.repo));
      model.actions = [...(model.actions ?? []), b];
      return model;
    };
    const splitId = (id) => { const i = id.indexOf('/'); return i < 0 ? [id, ''] : [id.slice(0, i), id.slice(i + 1)]; };
    function openFile(repo, rel) {
      const row = repoRow(repo);
      if (!row) return false;
      const entry = trees.get(repo);
      const status = entry?.tree.files.find((f) => f.path === rel)?.status ?? 'clean';
      const abs = absOf(row, rel);
      const getChange = async () => {
        const res = await fetch(`/api/surface/file-diff?repo=${encodeURIComponent(repo)}&path=${encodeURIComponent(rel)}`);
        const body = await res.json();
        if (!res.ok) throw new Error(body.error ?? `GET /api/surface/file-diff returned ${res.status}`);
        // buildFileActions (1.x, carried over) is not
        // aware of the surface lens's own lifecycle - a diff resolving
        // after unmount used to still open the shared singleton popup,
        // anchored to a now-detached button, over whatever page the
        // operator had moved on to. Throwing here (the surface-owned
        // wrapper around the shared 1.x action) is the seam: it routes
        // through buildFileActions's own existing failure path instead of
        // ever handing back a change to open a popup with.
        if (api.destroyed) throw new Error('the view has since closed');
        return body.change;
      };
      api.inspect({ title: rel, word: FILE_WORD[status] ?? status, facts: [['repository', repo], ['path', abs], ['compared with', entry?.tree.base ?? '@{u}']], actions: [buildFileActions(abs, { getChange })] });
      return true;
    }
    api.registerOpener('folder', (id) => {
      const [repo, dir] = splitId(id);
      const entry = trees.get(repo);
      if (!entry) {
        // no automatic retry - a failure already showed
        // its own named error inside showTree's catch; re-opening the
        // folder here on failure is exactly what re-entered this same
        // !entry branch forever.
        api.showTree(repo).then((ok) => { if (ok && !api.destroyed) api.open({ type: 'folder', id }); });
        return true;
      }
      const files = entry.tree.files.filter((f) => (dir === '.' ? !f.path.includes('/') : f.path.startsWith(dir + '/')));
      const folder = entry.tree.folders.find((f) => f.dir === dir);
      if (!folder) return false;
      api.inspect({
        title: `${repo}/${dir}`, word: `${folder.count} files, ${folder.drifted} differ from the remote`,
        rows: files.map((f) => ({ type: 'file', id: `${repo}/${f.path}`, text: `${f.path}  ${FILE_WORD[f.status] ?? f.status}`, link: api.link({ type: 'file', id: `${repo}/${f.path}` }), open: () => api.open({ type: 'file', id: `${repo}/${f.path}` }) })),
        empty: files.length ? null : 'Every file in this folder matches the remote.',
      });
      return true;
    });
    api.registerOpener('file', (id) => { const [repo, rel] = splitId(id); return rel ? openFile(repo, rel) : false; });
    return {
      count: null,
      place(project, cam) {
        for (const [repo, entry] of trees) {
          const center = api.repoPos?.(repo);
          if (!center) continue;
          // Fix round 1/2 (D-surface Task 11) applied here too: a plain
          // radiusDeg/cam.k ring never visually separates its own members as
          // the operator zooms in (it cancels the projection's own zoom
          // scaling exactly) - ringRadiusForZoom keeps the same k=1 look but
          // lets zooming into a repo's folders actually spread them apart.
          for (const m of entry.marks) place(m.g, project(ringPlacement(center, entry.marks.length, m.i, ringRadiusForZoom(1.2, cam.k))));
        }
      },
    };
  },
};

const agentsLayer = {
  id: 'agents', key: 'A', label: 'Agents', swatch: '#3ddc84', source: 'GET /api/sessions/live with GET /api/workspace',
  build(api, group) {
    const live = api.data.live;
    if (!live?.ok) { api.empty(`Agents not available: ${live?.error ?? 'no data'}.`); return { count: 0, place() {} }; }
    const ws = new Map((api.data.workspace?.ok ? api.data.workspace.data.sessions : []).map((w) => [w.sessionId, w]));
    const rows = api.data.residency?.ok ? api.data.residency.data.rows : [];
    const norm = (p) => String(p ?? '').replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
    // a bare startsWith cross-matched sibling directories
    // that merely share a name prefix (glmps / glmps-
    // assets, or a -wt- worktree) - boundary-safe shape from
    // server/lib/zones.js:43 (a path is "under" a root only at a real path
    // segment boundary, or is the root itself).
    const repoFor = (cwd) => {
      const c = norm(cwd);
      return rows.filter((r) => { const rp = norm(r.path); return c === rp || c.startsWith(rp + '/'); })
        .sort((a, b) => norm(b.path).length - norm(a.path).length)[0] ?? null;
    };
    api.repoFor = repoFor;
    const marks = [];
    const addMark = (s) => {
      const repo = repoFor(s.cwd);
      const vec = svgEl('path', 'agent-vec');
      const g = svgEl('g', 'agent');
      g.dataset.state = 'active';
      const dial = createDial(); g.appendChild(dial.el);
      const dot = svgEl('circle', 'agent-dot'); dot.setAttribute('r', '4'); g.appendChild(dot);
      const short = agentName(api.ctx.getState?.(), s.id);
      const name = `${short}${repo ? ` in ${repo.repo}` : ', not a project'}`;
      const lbl = svgEl('text', 'lbl'); lbl.textContent = name; g.appendChild(lbl);
      bindItem(g, { type: 'agent', id: s.id, link: api.link({ type: 'agent', id: s.id }), open: () => api.open({ type: 'agent', id: s.id }), label: `Agent ${name}` });
      group.appendChild(vec); group.appendChild(g);
      const m = { s, repo, g, vec, dial, lbl, short, name, i: marks.length };
      marks.push(m);
      return m;
    };
    for (const s of live.data.sessions ?? []) addMark(s);
    // The ring widens with the sessions on it so their dials do not stack.
    const ringDeg = () => Math.min(12, 5 + Math.max(0, marks.length - 1));
    const posOf = (m, k) => ringPlacement(api.localPos(), marks.length, m.i, ringRadiusForZoom(ringDeg(), k));
    // The live-motion controller's way in: the marks, and a way to add sessions that joined after mount.
    api.agents = {
      get: (id) => marks.find((x) => x.s.id === id) ?? null,
      list: () => marks,
      add(sessions) {
        const known = new Set(marks.map((x) => x.s.id));
        const fresh = sessions.filter((x) => x?.id && !known.has(x.id));
        for (const x of fresh) addMark(x);
        if (fresh.length) api.globe.render();
        return fresh;
      },
    };
    // Where an agent's mark sits at a zoom, so tracking can centre on it
    // before the next render has placed it.
    api.agentPos = (id, k) => { const m = marks.find((x) => x.s.id === id); return m ? posOf(m, k) : null; };
    api.agentList = () => marks.map((m) => ({ id: m.s.id, repo: m.repo?.repo ?? null, title: agentName(api.ctx.getState?.(), m.s.id), summary: ws.get(m.s.id)?.title ?? null, lastTs: m.s.lastTs ?? null }));
    api.registerOpener('agent', (id) => {
      const m = marks.find((x) => x.s.id === id);
      if (!m) return false;
      const w = ws.get(id);
      const open = document.createElement('a'); open.className = 'fa-btn'; open.textContent = 'Open session page';
      open.href = linkFor({ lens: 'session', sessionId: id });
      open.addEventListener('click', (e) => { if (e.ctrlKey || e.metaKey) return; e.preventDefault(); api.ctx.go(open.href); });
      const track = document.createElement('button'); track.type = 'button'; track.className = 'fa-btn';
      const labelTrack = () => { track.textContent = api.trackedId?.() === id ? 'Stop tracking' : 'Track'; };
      labelTrack();
      track.addEventListener('click', () => { api.toggleTrack?.(id); labelTrack(); });
      api.inspect({ title: agentName(api.ctx.getState?.(), id), word: m.repo ? `working in ${m.repo.repo}` : 'working outside every registered repository',
        facts: [['session', id], ['working directory', m.s.cwd ?? 'not captured'], ['last activity', m.s.lastTs ? new Date(m.s.lastTs).toISOString() : 'never'], ['declared goal', w?.declared?.goal ?? 'none declared'], ['divergence', w?.divergence?.level ?? w?.divergence ?? 'none']],
        actions: [track, open] });
      return true;
    });
    return {
      get count() { return marks.length; },
      place(project, cam) {
        // Dials shrink to fit the room between neighbours on the ring.
        const centre = marks.length > 1 ? project(api.localPos()) : null;
        const first = centre ? project(posOf(marks[0], cam.k)) : null;
        const chord = centre && first ? 2 * Math.hypot(first[0] - centre[0], first[1] - centre[1]) * Math.sin(Math.PI / marks.length) : null;
        const scale = chord == null ? 1 : Math.max(0.3, Math.min(1, chord / (2 * DIAL_OUTER)));
        for (const m of marks) {
          const pos = posOf(m, cam.k);
          const p = project(pos); place(m.g, p);
          m.dial.setScale(scale);
          m.lbl.setAttribute('y', (DIAL_OUTER * scale + 12).toFixed(1));
          // Only to a marker that is drawn: otherwise the line ends in empty space.
          const target = m.repo && linkOn(api, m.repo.remote ? 'residency' : 'nowhere', []) ? api.repoPos?.(m.repo.repo) : null;
          const t = target ? project(target) : null;
          m.vec.setAttribute('d', p && t ? `M${p[0].toFixed(1)},${p[1].toFixed(1)}L${t[0].toFixed(1)},${t[1].toFixed(1)}` : '');
        }
      },
    };
  },
};

export const IN_FLIGHT = new Set(['queued', 'held', 'in_progress', 'in_review']);
const cardsLayer = {
  id: 'cards', key: 'K', label: 'Cards', swatch: '#f5a524', source: 'GET /api/backlog',
  build(api, group) {
    const feed = api.data.backlog;
    if (!feed?.ok) { api.empty(`Cards not available: ${feed?.error ?? 'no data'}.`); return { count: 0, place() {} }; }
    const all = feed.data.items ?? [];
    // At Latest a card is in flight by its live state; scrubbed back, by the
    // state its last timeline event at or before that time gave it.
    const inFlight = () => all.map((c) => ({ c, state: api.timeline?.cardState(c) ?? (api.timeline?.asOf() == null ? c.state : null) }))
      .filter((x) => x.state && IN_FLIGHT.has(x.state)).map((x) => x.c);
    let cards = inFlight();
    const stacks = [
      { id: 'local', label: 'at the local store', list: [], pos: () => api.localPos(), pick: (c) => c.origin?.via !== 'slack' },
      { id: 'slack', label: 'born in Slack', list: [], pos: () => { const p = (api.data.players?.ok ? api.data.players.data.players : []).find((x) => x.id === 'slack'); return p ? [p.lon, p.lat] : null; }, pick: (c) => c.origin?.via === 'slack' },
    ];
    const marks = stacks.map((s) => {
      const g = svgEl('g', 'card-stack');
      const chips = svgEl('g', 'card-chips'); g.appendChild(chips);
      const lbl = svgEl('text', 'lbl'); g.appendChild(lbl);
      const fill = () => {
        s.list = cards.filter(s.pick);
        chips.textContent = '';
        for (let k = 0; k < Math.min(5, s.list.length); k++) { const r = svgEl('rect', 'card-chip'); r.setAttribute('x', '-7'); r.setAttribute('y', String(-4 - k * 3)); r.setAttribute('width', '14'); r.setAttribute('height', '4'); chips.appendChild(r); }
        lbl.textContent = `${s.list.length} cards ${s.label}`;
        g.setAttribute('aria-label', lbl.textContent);
      };
      fill();
      bindItem(g, { type: 'card-stack', id: s.id, link: api.link({ type: 'card-stack', id: s.id }), open: () => api.open({ type: 'card-stack', id: s.id }), label: lbl.textContent });
      group.appendChild(g);
      return { s, g, fill };
    });
    api.cardStackOf = (card) => (card.origin?.via === 'slack' ? 'slack' : 'local');
    api.stackPos = (id) => marks.find((m) => m.s.id === id)?.s.pos() ?? null;
    api.registerOpener('card-stack', (id) => {
      const m = marks.find((x) => x.s.id === id);
      if (!m) return false;
      api.inspect({ title: `${m.s.list.length} cards ${m.s.label}`, rows: m.s.list.map((c) => {
        const link = linkFor({ lens: 'work', band: 'board', sel: { type: 'card', id: c.id } });
        return { type: 'card', id: c.id, text: `${c.id}  ${c.state}  ${c.title}`, link, open: () => api.ctx.go(link) };
      }), empty: m.s.list.length ? null : 'No cards in flight here.' });
      return true;
    });
    // same ringRadiusForZoom shape as every other offset
    // in this file, for consistency (each stack sits at its own distinct
    // anchor, so this was not the same bug C1's sibling fix addressed, but
    // the same zoom-invariant formula everywhere reads as one system).
    return {
      count: cards.length,
      refresh() { cards = inFlight(); for (const m of marks) m.fill(); api.globe.render(); },
      place(project, cam) { const off = ringRadiusForZoom(1.2, cam.k); for (const m of marks) { const pos = m.s.pos(); const p = pos ? project([pos[0] + off, pos[1] + off]) : null; place(m.g, p); } },
    };
  },
};

LAYERS.push(filesLayer, agentsLayer, cardsLayer);

// loops in orbit around the local store, and alert pulses at the places
// they are felt. Both read the kernel loop and alert feeds.
Object.assign(SURFACE_ITEM_TYPES, {
  loop: 'the loop\'s record in the inspector',
  'alert-pulse': 'the Alerts dock',
});
FEEDS.loops = '/api/loops';
FEEDS.alerts = '/api/alerts';

const ageOf = (ts) => { const s = Math.max(0, Math.round((Date.now() - ts) / 1000)); return s < 90 ? `${s} s` : ageText(s * 1000); };
const ATTENTION = linkFor({ lens: 'surface', panel: 'attention' });

const loopsLayer = {
  id: 'loops', key: 'O', label: 'Loops', swatch: '#3fb6a0', link: true, source: 'GET /api/loops (kernel loop health)',
  build(api, group) {
    const feed = api.data.loops;
    if (!feed?.ok) { api.empty(`Loops not available: ${feed?.error ?? 'no data'}.`); return { count: 0, place() {} }; }
    const snapshot = feed.data && typeof feed.data === 'object' ? feed.data : {};
    const orbits = loopOrbits(snapshot, Date.now());
    if (!orbits.length) api.empty('The loops feed reported no loops.');
    const marks = orbits.map((o) => {
      const ring = svgEl('circle', `orbit-ring orbit-${o.severity}`);
      const dot = svgEl('g', `orbit-dot orbit-${o.severity}`);
      dot.appendChild(svgEl('circle', 'orbit-hit')).setAttribute('r', '11');
      dot.appendChild(svgEl('circle', 'orbit-core')).setAttribute('r', '4');
      const tip = svgEl('title'); tip.textContent = loopLabel(o); dot.appendChild(tip);
      if (o.severity !== 'ok') { const lbl = svgEl('text', 'lbl'); lbl.textContent = o.name; dot.appendChild(lbl); }
      bindItem(dot, { type: 'loop', id: o.name, link: api.link({ type: 'loop', id: o.name }), open: () => api.open({ type: 'loop', id: o.name }), label: loopLabel(o) });
      group.appendChild(ring); group.appendChild(dot);
      return { o, ring, dot };
    });
    const failing = orbits.filter((o) => o.severity === 'warn' || o.severity === 'critical').length;
    const stale = orbits.filter((o) => o.severity === 'stale').length;
    return {
      count: orbits.length,
      touches: (placeId) => placeId === 'local',
      facts: () => [['freshness', `snapshot ${ageOf(feed.fetchedAt)} old`], ['failing', failing], ['stale', stale], ['dot position', 'share of the loop\'s interval since its last run; top is just ran']],
      place(project, cam) {
        const c = linkOn(api, 'loops', ['local']) ? api.playerScreen?.('local') ?? project(api.localPos()) : null;
        const now = Date.now();
        for (const m of marks) {
          if (!c) { m.ring.setAttribute('display', 'none'); place(m.dot, null); continue; }
          const r = orbitRadiusPx(m.o.index, cam.k);
          m.ring.removeAttribute('display');
          m.ring.setAttribute('cx', c[0].toFixed(1)); m.ring.setAttribute('cy', c[1].toFixed(1)); m.ring.setAttribute('r', r.toFixed(1));
          const [dx, dy] = orbitPoint(r, loopPhase(m.o.loop, now));
          place(m.dot, [c[0] + dx, c[1] + dy]);
        }
      },
    };
  },
};

const PULSE_WHERE = { local: 'the local store', slack: 'Slack' };

const alertsLayer = {
  id: 'alerts', key: 'E', label: 'Alert pulses', swatch: '#ff5b5b', source: 'GET /api/alerts (active alerts, by where they are felt)',
  build(api, group) {
    const feed = api.data.alerts;
    if (!feed?.ok) { api.empty(`Alert pulses not available: ${feed?.error ?? 'no data'}.`); return { count: 0, place() {} }; }
    const liveAlerts = feed.data?.alerts ?? [];
    // At Latest every alert counts; scrubbed back, only those the timeline had
    // already seen at that time.
    const compute = () => pulsePlaces(liveAlerts.filter((a) => api.timeline?.alertShown(a) !== false), ackedSet());
    const sum = compute();
    const marks = [...sum.places.values()].map((p) => {
      const g = svgEl('g', `pulse pulse-${p.severity}`);
      const wave = svgEl('circle', 'pulse-wave'); wave.setAttribute('r', '38'); g.appendChild(wave);
      const core = svgEl('circle', 'pulse-core'); core.setAttribute('r', '38'); g.appendChild(core);
      const hit = svgEl('circle', 'pulse-hit'); hit.setAttribute('r', '38'); g.appendChild(hit);
      const badge = svgEl('g', 'pulse-badge'); badge.setAttribute('transform', 'translate(27,-27)');
      badge.appendChild(svgEl('circle')).setAttribute('r', '9');
      const n = svgEl('text'); n.textContent = String(p.count); badge.appendChild(n);
      g.appendChild(badge);
      const label = pulseLabel(p, PULSE_WHERE[p.place]);
      bindItem(g, { type: 'alert-pulse', id: p.place, link: ATTENTION, open: () => api.panelOpeners.attention(), label });
      group.appendChild(g);
      return { p, g, n };
    });
    return {
      count: sum.count,
      facts: () => [['freshness', `fetched ${ageOf(feed.fetchedAt)} ago`], ['not drawn here', sum.unplaced ? `${sum.unplaced} active alerts from other sources, see the Alerts dock` : 'none'], ['motion', 'the ring pulses; a static ring under reduced motion']],
      // The timeline moved: recount each place from the alerts seen by then.
      refresh() {
        const now = compute();
        for (const m of marks) {
          const p = now.places.get(m.p.place) ?? null;
          m.live = p;
          if (!p) continue;
          m.g.setAttribute('class', `pulse pulse-${p.severity}`);
          m.n.textContent = String(p.count);
          m.g.setAttribute('aria-label', pulseLabel(p, PULSE_WHERE[p.place]));
        }
        api.globe.render();
      },
      place() { for (const m of marks) place(m.g, m.live === null ? null : api.playerScreen?.(m.p.place) ?? null); },
    };
  },
};

LAYERS.push(loopsLayer, alertsLayer);

// The Layers panel's headings; a layer lands under the heading its id maps to.
export const LAYER_GROUPS = [
  { id: 'data', label: 'Data' }, { id: 'places', label: 'Places' }, { id: 'work', label: 'Work' }, { id: 'events', label: 'Events' }, { id: 'links', label: 'Links between places' }, { id: 'map', label: 'Map' },
];
const GROUP_OF = { players: 'places', residency: 'places', nowhere: 'places', files: 'work', agents: 'work', cards: 'work', loops: 'links', 'remote-links': 'links', alerts: 'events', graticule: 'map', labels: 'map' };
for (const l of LAYERS) l.group = GROUP_OF[l.id] ?? 'work';
