// web/surface/globe-core.js
// The globe's pure maths (no DOM, no d3): camera clamps and tweens, the
// near-hemisphere test, marker placement around a player, the residency
// summary, and a TopoJSON decoder for the vendored coastlines.
export const ZOOM_MIN = 0.8;
export const ZOOM_MAX = 40;
const RAD = Math.PI / 180;

export const clampZoom = (k) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Number.isFinite(k) ? k : 1));
export const normLon = (lon) => ((((lon + 180) % 360) + 360) % 360) - 180;
export const clampLat = (lat) => Math.max(-89, Math.min(89, lat));

export function angularDistance([lon1, lat1], [lon2, lat2]) {
  const p1 = lat1 * RAD, p2 = lat2 * RAD, dl = (lon2 - lon1) * RAD;
  const a = Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * Math.asin(Math.min(1, Math.sqrt(a)));
}
export const isVisible = (pt, center) => angularDistance(pt, center) < Math.PI / 2 - 1e-6;

export function lerpCamera(a, b, t) {
  const dLon = normLon(b.lon - a.lon);
  return { lon: normLon(a.lon + dLon * t), lat: a.lat + (b.lat - a.lat) * t, k: a.k * Math.pow(b.k / a.k, t) };
}
export const easeCubicInOut = (t) => ((t *= 2) <= 1 ? t * t * t : (t -= 2) * t * t + 2) / 2;

export function dragCamera(cam, dx, dy, radiusPx) {
  const s = 180 / (Math.PI * Math.max(1, radiusPx * cam.k));
  return { lon: normLon(cam.lon - dx * s), lat: clampLat(cam.lat + dy * s), k: cam.k };
}

// Pushes screen points apart until none is closer than minDist (a few
// relaxation passes, deterministic). Two points on the same spot split along a
// fixed per-index angle so repeated renders agree.
export function separatePoints(points, minDist, passes = 8) {
  const out = points.map((p) => ({ x: p.x, y: p.y }));
  for (let pass = 0; pass < passes; pass++) {
    let moved = false;
    for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        let dx = out[j].x - out[i].x, dy = out[j].y - out[i].y;
        let d = Math.hypot(dx, dy);
        if (d >= minDist) continue;
        if (d < 1e-6) { const a = (i + 1) * 2.399963; dx = Math.cos(a); dy = Math.sin(a); d = 1; }
        const push = (minDist - d) / 2 / d;
        out[i].x -= dx * push; out[i].y -= dy * push;
        out[j].x += dx * push; out[j].y += dy * push;
        moved = true;
      }
    }
    if (!moved) break;
  }
  return out;
}

export function ringPlacement([lon, lat], n, i, radiusDeg) {
  if (n <= 1) return [lon, lat];
  const a = (2 * Math.PI * i) / n;
  return [normLon(lon + (radiusDeg * Math.cos(a)) / Math.max(0.2, Math.cos(lat * RAD))), clampLat(lat + radiusDeg * Math.sin(a))];
}

// a ring/region radius of baseDeg/cam.k keeps a
// CONSTANT screen size at every zoom - the orthographic projection scales by
// R*cam.k, so the 1/k in the radius cancels the k in the scale exactly
// (reviewer-measured with the real vendored d3: ~52-54px pairwise, k=1 to
// k=40, and after flyTo - unchanged at every zoom). That means a label the
// collision pass hides at k=1 can never come back by zooming in, which is
// the opposite of what a globe's zoom should do for a crowded cluster.
// baseDeg/sqrt(k) falls off slower than 1/k, so the screen distance instead
// grows with sqrt(k) (the k's do not fully cancel), while sqrt(1) = 1 keeps
// the k=1 (default camera) look byte-for-byte the same as before.
export function ringRadiusForZoom(baseDeg, k) {
  return baseDeg / Math.sqrt(Math.max(1e-9, k));
}

export const RESIDENCY_WORD = Object.freeze({
  synced: 'in sync', ahead: 'ahead of its remote', behind: 'behind its remote', diverged: 'diverged from its remote',
  dirty: 'uncommitted changes', 'nowhere-else': 'exists nowhere else', unknown: 'unreadable (see its error)',
});
export const RESIDENCY_GLYPH = Object.freeze({ synced: '\u2713', ahead: '\u2191', behind: '\u2193', diverged: '\u2195', dirty: '\u25CF', 'nowhere-else': '\u25CC', unknown: '?' });

export function summarizeResidency(rows = []) {
  // a row the git check itself could not read
  // (residency 'unknown') is neither with-remote nor nowhere-else - those
  // buckets describe a read we trust.
  const s = { repos: rows.length, unreadable: 0, withRemote: 0, nowhereElse: 0, ahead: 0, behind: 0, dirty: 0, unpushedBranches: 0, noUpstreamBranches: 0 };
  for (const r of rows) {
    if (r.residency === 'unknown') s.unreadable++;
    else if (r.remote) s.withRemote++;
    else s.nowhereElse++;
    if (r.ahead > 0) s.ahead++;
    if (r.behind > 0) s.behind++;
    if (r.dirty > 0) s.dirty++;
    s.unpushedBranches += r.unpushedBranches?.length ?? 0;
    s.noUpstreamBranches += r.noUpstreamBranches?.length ?? 0;
  }
  return s;
}

// WCAG relative luminance / contrast ratio, so a colour choice for a new
// status state is a checked fact, not a guess.
function srgbChannel(c) {
  const v = c / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}
export function relativeLuminance([r, g, b]) {
  return 0.2126 * srgbChannel(r) + 0.7152 * srgbChannel(g) + 0.0722 * srgbChannel(b);
}
export function contrastRatio(rgb1, rgb2) {
  const l1 = relativeLuminance(rgb1), l2 = relativeLuminance(rgb2);
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

// One screen-space label-collision pass: given every
// visible mark's approximate label box, keep the highest-priority label at
// each point of overlap (lower `priority` number wins) and report the rest
// to hide. Pure over the box list - the DOM measurement and priority lookup
// live in globe.js, which is the only place that knows about layers and
// marks; this function only ever sees plain boxes.
export function resolveLabelOverlaps(boxes) {
  const kept = [];
  const hidden = new Set();
  for (const b of [...boxes].sort((a, c) => a.priority - c.priority)) {
    const overlaps = kept.some((k) => b.x < k.x + k.width && k.x < b.x + b.width && b.y < k.y + k.height && k.y < b.y + b.height);
    if (overlaps) hidden.add(b.id); else kept.push(b);
  }
  return hidden;
}

export function topoFeature(topology, objectName) {
  const { scale: [sx, sy], translate: [tx, ty] } = topology.transform;
  const arcs = topology.arcs.map((arc) => { let x = 0, y = 0; return arc.map(([dx, dy]) => { x += dx; y += dy; return [x * sx + tx, y * sy + ty]; }); });
  const ring = (idxs) => {
    const pts = [];
    for (const i of idxs) { let a = arcs[i < 0 ? ~i : i]; if (i < 0) a = a.slice().reverse(); if (pts.length) pts.pop(); pts.push(...a); }
    return pts;
  };
  const polys = (g) => (g.type === 'Polygon' ? [g.arcs.map(ring)] : g.type === 'MultiPolygon' ? g.arcs.map((p) => p.map(ring)) : []);
  const obj = topology.objects[objectName];
  const geoms = obj.type === 'GeometryCollection' ? obj.geometries : [obj];
  return { type: 'MultiPolygon', coordinates: geoms.flatMap(polys) };
}
