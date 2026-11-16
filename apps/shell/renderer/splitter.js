const bar = document.getElementById('bar');
const readout = document.getElementById('readout');
const api = window.glmpsSplitter;
let dragging = false;
let pendingX = 0;
let raf = 0;
let overlay = false;

api.onRatio((pct, label) => {
  bar.setAttribute('aria-valuenow', String(pct));
  bar.setAttribute('aria-valuetext', `Dashboard ${pct} percent, Slack ${100 - pct} percent`);
  bar.title = `${label} (drag to resize, double-click resets)`;
  readout.textContent = label;
});
api.onMode((mode) => { overlay = mode.overlay; });

bar.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  dragging = true;
  bar.setPointerCapture(e.pointerId);
  bar.classList.add('dragging');
  if (overlay) document.body.classList.add('overlay');
  api.start();
});
bar.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  pendingX = e.screenX;
  if (overlay) {
    const s = document.body.style;
    s.setProperty('--ghost-x', `${e.clientX}px`);
    document.body.classList.add('moved');
    document.body.classList.toggle('flip', e.clientX > window.innerWidth / 2);
  }
  if (!raf) raf = requestAnimationFrame(() => { raf = 0; api.move(pendingX); });
});
function finish(e) {
  if (!dragging) return;
  dragging = false;
  bar.classList.remove('dragging');
  document.body.classList.remove('overlay', 'moved', 'flip');
  api.end(e.screenX);
}
bar.addEventListener('pointerup', finish);
bar.addEventListener('pointercancel', finish);
// The main process re-lays the view out when a drag starts; if that costs the
// capture while the button is still down, take it back instead of ending the drag.
bar.addEventListener('lostpointercapture', (e) => {
  if (dragging && (e.buttons & 1)) {
    try { bar.setPointerCapture(e.pointerId); } catch { /* pointer already gone: pointerup ends the drag */ }
    return;
  }
  finish(e);
});
bar.addEventListener('dblclick', () => api.reset());
bar.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowLeft') { e.preventDefault(); api.nudge('left'); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); api.nudge('right'); }
  else if (e.key === 'Home') { e.preventDefault(); api.edge('home'); }
  else if (e.key === 'End') { e.preventDefault(); api.edge('end'); }
  else if (e.key === 'Enter') { e.preventDefault(); api.reset(); }
});
