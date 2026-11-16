import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clampZoom, normLon, clampLat, angularDistance, isVisible, lerpCamera, easeCubicInOut, dragCamera,
  ringPlacement, ringRadiusForZoom, summarizeResidency, RESIDENCY_WORD, topoFeature, ZOOM_MIN, ZOOM_MAX,
  contrastRatio, resolveLabelOverlaps,
} from '../../web/surface/globe-core.js';
import { loadVendorD3 } from './fixtures/mini-dom.js';

const VA = [-78.4, 37.0];

test('zoom, longitude and latitude are clamped and wrapped', () => {
  assert.equal(clampZoom(0.1), ZOOM_MIN);
  assert.equal(clampZoom(1e6), ZOOM_MAX);
  assert.equal(clampZoom(NaN), 1);
  assert.equal(normLon(190), -170);
  assert.equal(normLon(-190), 170);
  assert.equal(clampLat(95), 89);
});

test('visibility is the near hemisphere', () => {
  assert.ok(isVisible(VA, VA));
  assert.ok(!isVisible(VA, [VA[0] + 180, -VA[1]]));
  assert.ok(Math.abs(angularDistance([0, 0], [90, 0]) - Math.PI / 2) < 1e-9);
});

test('a camera tween takes the short way across the date line', () => {
  const mid = lerpCamera({ lon: 170, lat: 0, k: 1 }, { lon: -170, lat: 0, k: 4 }, 0.5);
  assert.ok(Math.abs(Math.abs(mid.lon) - 180) < 1e-9);
  assert.ok(Math.abs(mid.k - 2) < 1e-9);
  assert.equal(easeCubicInOut(0), 0);
  assert.equal(easeCubicInOut(1), 1);
});

test('dragging right turns the globe east-to-west (centre longitude decreases)', () => {
  const c = dragCamera({ lon: 0, lat: 0, k: 1 }, 100, 0, 300);
  assert.ok(c.lon < 0);
  assert.ok(dragCamera({ lon: 0, lat: 0, k: 1 }, 0, 100, 300).lat > 0);
});

test('ring placement spreads n points within the radius', () => {
  const pts = Array.from({ length: 6 }, (_, i) => ringPlacement([-117, 33], 6, i, 1));
  assert.equal(new Set(pts.map((p) => p.join())).size, 6);
  for (const p of pts) assert.ok(angularDistance(p, [-117, 33]) * 180 / Math.PI < 1.5);
  assert.deepEqual(ringPlacement([-117, 33], 1, 0, 1), [-117, 33]);
});

test('residency summary counts from the raw fields; every state has a word', () => {
  const rows = [
    { repo: 'a', remote: 'git@github.com:x/a.git', ahead: 14, behind: 0, dirty: 0, unpushedBranches: ['f'], noUpstreamBranches: [], residency: 'ahead' },
    { repo: 'b', remote: 'https://github.com/x/b', ahead: 0, behind: 3, dirty: 27, unpushedBranches: [], noUpstreamBranches: ['g', 'h'], residency: 'dirty' },
    { repo: 'c', remote: null, ahead: 0, behind: 0, dirty: 0, unpushedBranches: [], noUpstreamBranches: [], residency: 'nowhere-else' },
  ];
  assert.deepEqual(summarizeResidency(rows), { repos: 3, unreadable: 0, withRemote: 2, nowhereElse: 1, ahead: 1, behind: 1, dirty: 1, unpushedBranches: 1, noUpstreamBranches: 2 });
  for (const s of ['synced', 'ahead', 'behind', 'diverged', 'dirty', 'nowhere-else', 'unknown']) assert.equal(typeof RESIDENCY_WORD[s], 'string');
});

// a row the git check itself could not read is neither
// with-remote nor nowhere-else - summarizeResidency itself buckets it as
// unreadable.
test('residency summary buckets an unknown row as unreadable, not with-remote or nowhere-else', () => {
  const rows = [
    { repo: 'a', remote: 'git@github.com:x/a.git', ahead: 0, behind: 0, dirty: 0, unpushedBranches: [], noUpstreamBranches: [], residency: 'synced' },
    { repo: 'flaky', remote: 'git@github.com:x/flaky.git', ahead: 0, behind: 0, dirty: 0, unpushedBranches: [], noUpstreamBranches: [], residency: 'unknown' },
    { repo: 'flaky-no-remote', remote: null, ahead: 0, behind: 0, dirty: 0, unpushedBranches: [], noUpstreamBranches: [], residency: 'unknown' },
  ];
  assert.deepEqual(summarizeResidency(rows), { repos: 3, unreadable: 2, withRemote: 1, nowhereElse: 0, ahead: 0, behind: 0, dirty: 0, unpushedBranches: 0, noUpstreamBranches: 0 });
});

// the reviewer measured that radiusDeg/cam.k (the
// round-1 shape) cancels the projection's own R*cam.k scaling exactly, so
// same-ring pairwise screen distance never changes with zoom
// (verify-ring-zoom2.mjs: ~52-54px from k=1 to k=40). ringRadiusForZoom's
// slower-than-1/k falloff must let that distance grow with zoom instead.
test('ringRadiusForZoom: same-ring screen spacing grows at least 2x from k=1 to k=10 (real d3 projection)', () => {
  const d3 = loadVendorD3();
  const localPos = [-117.2, 32.7];
  const R = 300, w = 800, h = 600, n = 3;
  const project = (cam) => {
    const projection = d3.geoOrthographic().clipAngle(90).precision(0.5);
    projection.rotate([-cam.lon, -cam.lat]).scale(R * cam.k).translate([w / 2, h / 2]);
    return (lonlat) => projection(lonlat);
  };
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const screenPairDist = (k) => {
    const r = ringRadiusForZoom(6, k);
    const pts = [0, 1, 2].map((i) => ringPlacement(localPos, n, i, r));
    const proj = project({ lon: -98.5, lat: 32, k });
    const screen = pts.map(proj);
    return dist(screen[0], screen[1]);
  };
  const d1 = screenPairDist(1);
  const d10 = screenPairDist(10);
  assert.ok(d10 >= d1 * 2, `expected d(k=10)=${d10.toFixed(1)} >= 2 * d(k=1)=${d1.toFixed(1)}`);
  // Monotone: k=40 keeps growing past k=10, it does not fall back.
  assert.ok(screenPairDist(40) >= d10);
  // The default-camera look at k=1 is unchanged: ringRadiusForZoom(base, 1) === base.
  assert.equal(ringRadiusForZoom(6, 1), 6);
});

test('contrastRatio: the res-unknown fix (fill and glyph both var(--fg) on var(--bg)) clears the text floor', () => {
  // web/styles.css: --fg: #afdde5 -> [175,221,229]; --bg: #0a0b0d -> [10,11,13].
  assert.ok(contrastRatio([175, 221, 229], [10, 11, 13]) >= 4.5, 'AA text contrast (4.5:1) for the "?" glyph on the fill');
  assert.equal(contrastRatio([1, 2, 3], [1, 2, 3]), 1, 'identical colours have no contrast');
  assert.equal(contrastRatio([0, 0, 0], [255, 255, 255]), contrastRatio([255, 255, 255], [0, 0, 0]), 'order does not matter');
});

test('resolveLabelOverlaps: the highest-priority (lowest number) box at each overlap wins; disjoint boxes all survive', () => {
  const a = { id: 'a', priority: 0, x: 0, y: 0, width: 10, height: 10 };
  const b = { id: 'b', priority: 1, x: 5, y: 5, width: 10, height: 10 }; // overlaps a
  const c = { id: 'c', priority: 2, x: 100, y: 100, width: 10, height: 10 }; // disjoint
  assert.deepEqual(resolveLabelOverlaps([a, b, c]), new Set(['b']));
  // Priority order in the input must not matter, only the priority field.
  assert.deepEqual(resolveLabelOverlaps([b, a, c]), new Set(['b']));
  // A box exactly touching another's edge does not count as overlapping.
  const d = { id: 'd', priority: 5, x: 10, y: 0, width: 10, height: 10 };
  assert.deepEqual(resolveLabelOverlaps([a, d]), new Set());
});

test('topoFeature decodes a quantized TopoJSON object', () => {
  const topo = {
    type: 'Topology', transform: { scale: [1, 1], translate: [0, 0] },
    arcs: [[[0, 0], [10, 0], [0, 10], [-10, 0], [0, -10]]],
    objects: { countries: { type: 'GeometryCollection', geometries: [{ type: 'Polygon', arcs: [[0]] }] } },
  };
  assert.deepEqual(topoFeature(topo, 'countries'), { type: 'MultiPolygon', coordinates: [[[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]]] });
});

test('separatePoints fans coincident points apart to the minimum gap and leaves distant ones alone', async () => {
  const { separatePoints } = await import('../../web/surface/globe-core.js');
  const out = separatePoints([{ x: 100, y: 100 }, { x: 100, y: 100 }, { x: 400, y: 400 }], 58);
  assert.ok(Math.hypot(out[0].x - out[1].x, out[0].y - out[1].y) >= 57.9, 'coincident points split');
  assert.deepEqual(out[2], { x: 400, y: 400 });
  assert.deepEqual(separatePoints([{ x: 100, y: 100 }, { x: 100, y: 100 }], 58), separatePoints([{ x: 100, y: 100 }, { x: 100, y: 100 }], 58), 'deterministic');
});
