// web/shared/bands.js
// A lens page is at most three bands (R2), each a <section> with a heading.
// Deep links name a band (?band=fleet) and focusBand scrolls it into view.
export function buildBands(root, defs) {
  const map = new Map();
  for (const d of defs) {
    const sec = document.createElement('section');
    sec.className = `lens-band lens-band-${d.id}`;
    sec.id = `band-${d.id}`;
    const h = document.createElement('h2');
    h.className = 'lens-band-title';
    h.id = `band-${d.id}-title`;
    h.textContent = d.title;
    sec.setAttribute('aria-labelledby', h.id);
    sec.appendChild(h);
    const body = document.createElement('div');
    body.className = 'lens-band-body';
    sec.appendChild(body);
    root.appendChild(sec);
    map.set(d.id, body);
  }
  return map;
}

export function focusBand(id) {
  const sec = document.getElementById(`band-${id}`);
  if (!sec) return false;
  sec.scrollIntoView({ block: 'start' });
  return true;
}

// The visible failure for a band: names what failed and why, never blank.
export function bandError(body, what, err) {
  console.error(`${what} failed`, err);
  const p = document.createElement('p');
  p.className = 'band-error';
  p.setAttribute('role', 'status');
  p.textContent = `${what} failed to load: ${err?.message ?? err}`;
  body.appendChild(p);
  return p;
}

// An empty state names the dry pipe and what to do; it does not apologise.
export function emptyState(body, text) {
  const p = document.createElement('p');
  p.className = 'band-empty';
  p.textContent = text;
  body.appendChild(p);
  return p;
}
