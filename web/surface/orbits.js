// web/surface/orbits.js
// Pure geometry and classification for the Loops and Alert pulses layers (no
// DOM, no d3), so the maths is testable without a globe. layers.js draws it.

// Inside the local platform's own ring (30 px) and its callout, then one ring
// per loop. Radii grow with sqrt(zoom) like ringRadiusForZoom's marks, so the
// orbits open up as the operator zooms in rather than staying a fixed blob.
export const ORBIT_BASE_PX = 46;
export const ORBIT_STEP_PX = 7;

export const orbitRadiusPx = (index, k) => (ORBIT_BASE_PX + index * ORBIT_STEP_PX) * Math.sqrt(Math.max(1e-9, k));

const clamp01 = (x) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);

// Same rule the retired Now lens used for its loop rows, so a dot and the loop record never disagree:
// 3 or more failures in a row is critical, 1 or 2 is a warning, otherwise a
// loop older than its SLA is stale.
export function loopState(loop) {
  const n = loop?.consecutiveFailures ?? 0;
  const stale = loop?.sla?.maxAgeMs != null && loop.ageS * 1000 > loop.sla.maxAgeMs;
  const severity = n >= 3 ? 'critical' : n >= 1 ? 'warn' : stale ? 'stale' : 'ok';
  const word = n >= 1 ? `failing ${n} in a row` : stale ? 'stale' : 'ok';
  return { severity, word };
}

// How far round its orbit the loop's dot sits, 0 (just ran, top) to 1 (due).
// A timed loop sweeps its interval, read from nextRunTs when the server states
// it and from lastRunTs otherwise; an external or event loop has no interval,
// so its age is read against its SLA instead. All three move with `now`, so a
// re-render between feed refreshes advances the dot.
export function loopPhase(loop, now) {
  const every = loop?.trigger?.everyMs;
  if (every > 0) {
    if (Number.isFinite(loop.nextRunTs)) return clamp01(1 - (loop.nextRunTs - now) / every);
    if (Number.isFinite(loop.lastRunTs)) return clamp01((now - loop.lastRunTs) / every);
  }
  const max = loop?.sla?.maxAgeMs;
  const age = Number.isFinite(loop?.lastRunTs) ? now - loop.lastRunTs : loop?.ageS * 1000;
  return max > 0 ? clamp01(age / max) : 0;
}

// Clockwise from twelve o'clock, in screen coordinates (y grows downward).
export function orbitPoint(radius, phase) {
  const a = -Math.PI / 2 + 2 * Math.PI * clamp01(phase);
  return [radius * Math.cos(a), radius * Math.sin(a)];
}

// One entry per loop, named order so a ring keeps its index across refreshes.
export function loopOrbits(snapshot, now) {
  return Object.entries(snapshot ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, loop], index) => ({ name, index, phase: loopPhase(loop, now), ...loopState(loop), loop }));
}

export const loopLabel = (o) => `Loop ${o.name}: ${o.word}`;

// Where an alert source is felt: the workstation's kernel and git state sit at
// the local store, the capture channel at Slack. Other sources are not drawn.
export const PULSE_PLACE = Object.freeze({
  'kernel-health': 'local', injection: 'local', poison: 'local', integrity: 'local', 'unmerged-branch': 'local',
  'capture-health': 'slack',
});

// Active alerts folded by place: how many, the worst severity and the title
// that earned it (first of that severity in feed order). `acked` is the same
// operator-side set the bell uses; the feed's own flag counts too.
export function pulsePlaces(alerts, acked = new Set()) {
  const places = new Map();
  let unplaced = 0;
  for (const a of alerts ?? []) {
    if (a.acknowledged || acked.has(a.id)) continue;
    const place = PULSE_PLACE[a.source];
    if (!place) { unplaced++; continue; }
    const critical = a.severity === 'critical';
    const cur = places.get(place);
    if (!cur) places.set(place, { place, count: 1, severity: critical ? 'critical' : 'warn', title: a.title });
    else {
      cur.count++;
      if (critical && cur.severity !== 'critical') { cur.severity = 'critical'; cur.title = a.title; }
    }
  }
  const count = [...places.values()].reduce((n, p) => n + p.count, 0);
  return { places, count, unplaced };
}

export const pulseLabel = (p, where) => `${p.count} active ${p.count === 1 ? 'alert' : 'alerts'} at ${where}, worst ${p.severity}: ${p.title}`;
