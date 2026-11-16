// web/surface/agent-dial.js
// The marks that ride on an agent in the Agents layer: a 60-tick dial of its
// last minute (newest at the top, older ticks counter-clockwise), the steady
// amber ring that means it needs you, the ping rings an event sends out, and
// the Wall mode reticle. Pure SVG building; the heartbeat model supplies what
// the ticks say and the live-motion controller decides when to paint.
import { DIAL_TICKS } from './heartbeat.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const svgEl = (tag, cls) => { const e = document.createElementNS(SVG_NS, tag); if (cls) e.setAttribute('class', cls); return e; };
const set = (e, attrs) => { for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v)); return e; };

export const R0 = 20;
export const R1 = 23;
export const R1_LIT = 27;
export const RING_R = 31;
export const PING_FROM = 21;
export const PING_TO = 40;
// Dial radius in px at scale 1, the label sits below it.
export const DIAL_OUTER = PING_TO;

const f = (n) => n.toFixed(2);
export function tickGeometry(i) {
  const a = (-90 - (i * 360) / DIAL_TICKS) * (Math.PI / 180);
  const c = Math.cos(a), s = Math.sin(a);
  return { x1: R0 * c, y1: R0 * s, x2: R1 * c, y2: R1 * s, x3: R1_LIT * c, y3: R1_LIT * s };
}

export function createDial() {
  const el = svgEl('g', 'dial');
  el.setAttribute('aria-hidden', 'true');
  const ring = set(svgEl('circle', 'dial-ring'), { r: RING_R, display: 'none' });
  el.appendChild(ring);
  const ticks = [];
  for (let i = 0; i < DIAL_TICKS; i++) {
    const g = tickGeometry(i);
    const line = set(svgEl('line', 'dial-tick tk-rest'), { x1: f(g.x1), y1: f(g.y1), x2: f(g.x2), y2: f(g.y2) });
    el.appendChild(line);
    ticks.push({ line, g, cls: 'tk-rest', lit: false });
  }
  const pings = svgEl('g', 'dial-pings');
  el.appendChild(pings);
  const reticle = set(svgEl('g', 'dial-reticle'), { display: 'none' });
  const arm = 7, r = PING_TO - 4;
  for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    reticle.appendChild(set(svgEl('path'), { d: `M${sx * r},${sy * (r - arm)}V${sy * r}H${sx * (r - arm)}` }));
  }
  el.appendChild(reticle);

  let sig = '';
  return {
    el,
    // Paint the ticks for one status. Waiting turns the whole dial amber, idle
    // dims what is lit; an empty second is a faint neutral tick.
    paint(tones, status) {
      const next = `${status}|${tones.join(',')}`;
      if (next === sig) return;
      sig = next;
      ring.setAttribute('display', status === 'waiting' ? 'inline' : 'none');
      for (let i = 0; i < DIAL_TICKS; i++) {
        const tone = tones[i];
        const lit = tone != null;
        const cls = status === 'waiting' ? (lit ? 'tk-warn' : 'tk-warnrest') : lit ? (status === 'idle' ? 'tk-idle' : `tk-${tone}`) : 'tk-rest';
        const t = ticks[i];
        if (t.cls !== cls) { t.cls = cls; t.line.setAttribute('class', `dial-tick ${cls}`); }
        if (t.lit !== lit) { t.lit = lit; t.line.setAttribute('x2', f(lit ? t.g.x3 : t.g.x2)); t.line.setAttribute('y2', f(lit ? t.g.y3 : t.g.y2)); }
      }
    },
    addPing(tone) {
      const c = set(svgEl('circle', `dial-ping ping-${tone}`), { r: PING_FROM, 'aria-hidden': 'true' });
      pings.appendChild(c);
      return c;
    },
    setReticle(on) { reticle.setAttribute('display', on ? 'inline' : 'none'); },
    setScale(s) { el.setAttribute('transform', `scale(${s.toFixed(3)})`); },
    ringShown: () => ring.getAttribute('display') === 'inline',
  };
}
