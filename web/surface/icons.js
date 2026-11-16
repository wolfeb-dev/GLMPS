// web/surface/icons.js
// The rail's line icons: static path data on an 18px grid, built with
// createElementNS so no markup string ever reaches the DOM.
const SVG_NS = 'http://www.w3.org/2000/svg';

const PATHS = {
  layers: ['M9 2.5 16 6l-7 3.5L2 6z', 'm2 9.5 7 3.5 7-3.5', 'm2 13 7 3.5 7-3.5'],
  ledger: ['M3.5 3h11a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z', 'M2.5 7h13M2.5 11h13M7 7v8'],
  repos: ['M5 6v6', 'M13 9c0 3-8 1-8 5'],
  files: ['M3 3h5l1.5 1.5H15v10H3z', 'M3 8h12'],
  agents: ['M9 2l2 4.5 4.8.4-3.6 3.2 1.1 4.7L9 12.4 4.7 14.8l1.1-4.7L2.2 6.9 7 6.5z'],
  kanban: ['M3 3h3v12H3z', 'M7.5 3h3v8h-3z', 'M12 3h3v10h-3z'],
  edits: ['M3 15l.8-3.4L12 3.4a1.4 1.4 0 0 1 2 0l.6.6a1.4 1.4 0 0 1 0 2L6.4 14.2z', 'M10.5 5l2.5 2.5'],
  declared: ['M4 2.5h7l3 3v10H4z', 'M11 2.5v3h3', 'M6.5 9h5M6.5 12h5'],
  decisions: ['M9 2.5v5', 'M9 7.5 4.5 12M9 7.5 13.5 12', 'M3 12h3v3H3zM12 12h3v3h-3z'],
  graph: ['M5.5 5.5 9 9M12.5 5.5 9 9M9 9v4'],
  alerts: ['M4.5 7.5a4.5 4.5 0 0 1 9 0c0 4.5 2 6 2 6h-13s2-1.5 2-6', 'M7.7 15.5a1.5 1.5 0 0 0 2.6 0'],
  reset: ['M9 3a6 6 0 1 0 0 12A6 6 0 0 0 9 3z', 'M9 6.5v5M6.5 9h5'],
};
const CIRCLES = {
  repos: [[5, 4, 2], [5, 14, 2], [13, 7, 2]],
  graph: [[5, 4.5, 1.8], [13, 4.5, 1.8], [9, 9, 1.8], [9, 14, 1.8]],
};

export function icon(name) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 18 18');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.4');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of PATHS[name] ?? []) { const p = document.createElementNS(SVG_NS, 'path'); p.setAttribute('d', d); svg.appendChild(p); }
  for (const [cx, cy, r] of CIRCLES[name] ?? []) {
    const c = document.createElementNS(SVG_NS, 'circle');
    c.setAttribute('cx', String(cx)); c.setAttribute('cy', String(cy)); c.setAttribute('r', String(r));
    svg.appendChild(c);
  }
  return svg;
}
