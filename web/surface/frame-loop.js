// web/surface/frame-loop.js
// The Surface's one requestAnimationFrame loop. It asks for a frame only
// after wake(), keeps asking only while step() reports something still moving,
// and neither runs nor starts while the tab is hidden.
export function createFrameLoop({ step, raf = (fn) => requestAnimationFrame(fn), caf = (id) => cancelAnimationFrame(id), doc = document }) {
  let id = 0; let gone = false; let wanted = false;
  const hidden = () => doc.hidden === true;
  const frame = (t) => {
    id = 0;
    if (gone || hidden()) return;
    wanted = step(t) === true;
    if (wanted) id = raf(frame);
  };
  const start = () => { if (!id && !gone && !hidden()) id = raf(frame); };
  const onVisibility = () => {
    if (hidden()) { if (id) { caf(id); id = 0; } } else if (wanted) start();
  };
  doc.addEventListener('visibilitychange', onVisibility);
  return {
    wake() { wanted = true; start(); },
    active: () => id !== 0,
    destroy() { gone = true; if (id) { caf(id); id = 0; } doc.removeEventListener('visibilitychange', onVisibility); },
  };
}
