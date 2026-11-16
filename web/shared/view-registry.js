// web/shared/view-registry.js
//
// Registry seam for web/app.js's view dispatch, mirroring
// server/lib/observability/route-registry.js. Views self-register a pillar
// label/suffix + a dynamic-import loader, instead of being hardcoded into the
// PILLARS object and the if-chain in enterView(). Pure: no DOM access, and
// app.js still owns mounting. Zero Node-specific imports, so this module is
// importable both in the browser and under node:test.

const views = new Map();

export function registerView(name, { label, suffix, load, styles } = {}) {
  if (!name || typeof load !== 'function') {
    throw new TypeError('registerView requires a name and a load() function');
  }
  views.set(name, { name, label: label ?? null, suffix: suffix ?? null, load, styles: Array.isArray(styles) ? styles : [] });
}

export function getView(name) { return views.get(name) ?? null; }
export function listViews() { return [...views.values()]; }
export function clearViews() { views.clear(); }

// Per-view stylesheets: each href is appended once, kept for the life of the
// page (a cached lens must not lose its styles), and the promise settles when
// the sheet has loaded so a mount can wait for it and never paint unstyled.
// A failed sheet resolves too: a missing stylesheet must not block the lens.
const sheets = new Map();
export function loadStyles(hrefs, doc = typeof document === 'undefined' ? null : document) {
  if (!doc || !hrefs?.length) return Promise.resolve();
  return Promise.all(hrefs.map((href) => {
    let p = sheets.get(href);
    if (!p) {
      p = new Promise((resolve) => {
        const link = doc.createElement('link');
        link.rel = 'stylesheet'; link.href = href;
        link.addEventListener('load', () => resolve());
        link.addEventListener('error', () => { console.error('stylesheet failed to load', href); resolve(); });
        doc.head.appendChild(link);
      });
      sheets.set(href, p);
    }
    return p;
  })).then(() => {});
}
export function resetStyles() { sheets.clear(); }
