// web/shared/load-script.js
// Load a vendored classic (UMD) script once. d3 is loaded this way by Surface
// only, so no other page pays its bytes (D21).
const pending = new Map();
export function loadScript(src) {
  if (!pending.has(src)) {
    pending.set(src, new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.addEventListener('load', () => resolve());
      s.addEventListener('error', () => { pending.delete(src); reject(new Error(`could not load ${src}`)); });
      document.head.appendChild(s);
    }));
  }
  return pending.get(src);
}
