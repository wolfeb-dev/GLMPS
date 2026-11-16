// web/shared/session-page.js
// /session/<id>: the one detail surface every list on every lens opens.
export const ITEM_TYPES = Object.freeze({});
export async function mount(root, route, ctx) {
  // Task 16 fix rounds 2-3, R3: false once a newer page owns the root.
  const owns = () => ctx.isCurrent?.() !== false;
  const detailMod = await import('../observability/detail.js');
  // Overtaken while the module loaded: write nothing into the root (a newer
  // page owns it) and hand back an inert handle the router can unmount.
  if (!owns()) return { update() {}, onState() {}, onEvent() {}, unmount() {} };
  const container = document.createElement('section');
  container.className = 'session-page';
  root.appendChild(container);
  let cleanup = null;
  let disposed = false;
  let renderSeq = 0;
  // the session on screen, not the mount-time route's.
  let currentId = route.sessionId;
  // a render's cleanup releases the shared diff popup and
  // export menu only while this page still owns the root; otherwise only
  // its own listeners (a newer page may have the popup open).
  const release = (fn) => fn?.({ releaseShared: owns() && !disposed });
  const render = async (id) => {
    const mySeq = ++renderSeq;
    currentId = id;
    release(cleanup); cleanup = null;
    // each render paints into its own pass element, which
    // replaces the previous one now. renderDetail appends its header rows
    // and .session-bands after its fetch; an older pass landing late then
    // writes only into its own detached element, never the page on screen.
    // display: contents keeps the layout identical to painting the
    // container directly.
    const pass = document.createElement('div');
    pass.className = 'session-pass';
    pass.style.display = 'contents';
    container.replaceChildren(pass);
    const summary = (ctx.getState()?.sessions ?? []).find((s) => s.id === id) ?? null;
    const done = await detailMod.renderDetail(id, pass, {
      onOpenFile: ctx.handlers.onOpenFile, onCopy: ctx.handlers.onCopy,
      onOpenMap: ctx.handlers.onOpenMap, onBack: () => history.back(),
      backLabel: ctx.fromLensLabel?.() ?? null,
      getSummary: () => (ctx.getState()?.sessions ?? []).find((s) => s.id === id) ?? summary,
    }, summary);
    // A render that lands after the page was left, after it was overtaken,
    // or after a newer render started releases its own listeners at once
    // instead of setting a cleanup nobody will call.
    if (disposed || !owns() || mySeq !== renderSeq) { done?.({ releaseShared: false }); return; }
    cleanup = done;
  };
  await render(route.sessionId);
  return {
    async update(r) { await render(r.sessionId); },
    onState() {},
    onEvent(payload) {
      if (payload.type === 'events' && payload.sessionId === currentId) {
        window.dispatchEvent(new CustomEvent('mc-events', { detail: payload }));
      }
    },
    unmount() {
      release(cleanup);
      cleanup = null;
      disposed = true;
    },
  };
}
