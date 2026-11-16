// web/shared/lens-router.js
// The shell's navigation (moved out of web/app.js so it can be tested
// without booting the whole page): one lens mounted into #lens-root at a
// time and history kept in step with the screen. The wiki is the Knowledge
// lens's Wiki tab (card glmps-2-0-137), not a page of its own.
//
// Ownership: each navigation is a generation.
// The generation that last reset #lens-root OWNS it, and every mount (the
// four pillars, the session page) receives a ctx whose
// isCurrent() answers "do I still own the root". A mount overtaken while it
// waited on the network keeps running to completion, so it must check
// isCurrent() before any write to the root or to document-wide state (the
// selection mark, a drawer or popup on document.body, a root class), and
// its eventual unmount runs with isCurrent() false, so it releases only
// what it alone created. A normal unmount (the operator leaves) runs while
// the leaving mount still owns the root.
import { linkFor, parseLink, DEFAULT_LENS } from './deep-link.js';
import { markSelected } from './interactive-item.js';

// how long a mount may wait on the network before the page
// says so. The mount keeps going in the background and is adopted if it
// lands while it is still the current navigation.
export const MOUNT_TIMEOUT_MS = 15000;
const DEFAULT_LABEL = DEFAULT_LENS.charAt(0).toUpperCase() + DEFAULT_LENS.slice(1);

// Settings a lens reads from the query string itself, which linkFor does not
// model. The canonical rewrite at boot dropped them before the lens mounted,
// so a shared tracking link opened plain (glmps-2-0-63).
const LENS_OWNED = ['track', 'asof'];
export function keepLensParams(link, pathname, search) {
  const [path, qs = ''] = link.split('?');
  if (path !== pathname) return link;
  const from = new URLSearchParams(search);
  const q = new URLSearchParams(qs);
  for (const k of LENS_OWNED) if (from.has(k) && !q.has(k)) q.set(k, from.get(k));
  const out = q.toString();
  return out ? `${path}?${out}` : path;
}

export function createLensRouter({ getRoot, getSlot, loadView, loadStyles, ctx, markNav, toast, mountTimeoutMs = MOUNT_TIMEOUT_MS }) {
  let current = { lens: null, handle: null, route: null, gen: 0 };
  let queue = Promise.resolve();
  let gen = 0;
  let owner = 0;
  // Resolved by the NEXT enter(): a navigation still waiting on its mount
  // stops holding the queue the moment a newer one arrives.
  let next = deferred();
  let mountingGen = 0;

  const scopedCtx = (my) => ({ ...ctx, isCurrent: () => owner === my });

  const unmountCurrent = () => {
    if (!current.handle) return;
    try { current.handle.unmount(); } catch (e) { console.error(`unmounting ${current.lens} failed`, e); toast(`Leaving ${current.lens} failed: ${e.message}`); }
  };

  // The swap: the leaving mount unmounts while it still owns the root, then
  // this generation takes it. Task 16, W-I1: no class a previous lens added
  // survives; R3: no selection a previous lens marked survives either.
  function takeRoot(my, page, route) {
    unmountCurrent();
    owner = my;
    current = { lens: page, handle: null, route, gen: my };
    markSelected(null);
    // The top bar slot belongs to the lens on screen: a lens fills it at mount,
    // so the next lens must not inherit it.
    getSlot?.()?.replaceChildren();
    const root = getRoot();
    root.replaceChildren(); root.className = ''; root.dataset.lens = page;
    return root;
  }

  // Start a mount and wait for it, bounded (W-M4, R2): a newer navigation
  // releases the queue at once, and after the timeout a notice says so. A
  // mount that lands after it was overtaken is unmounted, never adopted.
  // Returns true when the mount is still running (so isMounting() stays
  // true until it settles, R4).
  async function mountPage(my, superseded, page, root, start) {
    const stillMine = () => owner === my && current.gen === my;
    let slowNote = null;
    let settled = false;
    const mounted = Promise.resolve().then(() => start(scopedCtx(my))).then(
      (handle) => {
        if (!stillMine()) {
          try { handle?.unmount(); } catch (e) { console.error(`unmounting a superseded ${page} mount failed`, e); }
          return;
        }
        slowNote?.remove();
        current.handle = handle;
        const s = ctx.getState();
        if (s) handle.onState(s);
      },
      (e) => {
        if (!stillMine()) return;
        console.error(`the ${page} page failed to mount`, e);
        slowNote?.remove();
        const p = document.createElement('p');
        p.className = 'lens-error';
        p.textContent = `The ${page} page failed to load: ${e.message}`;
        root.appendChild(p);
      },
    ).finally(() => { settled = true; if (mountingGen === my) mountingGen = 0; });
    await boundWait(mounted, superseded, () => {
      if (!stillMine()) return;
      console.error(`the ${page} page is still mounting after ${mountTimeoutMs} ms`);
      slowNote = document.createElement('p');
      slowNote.className = 'lens-error';
      slowNote.setAttribute('role', 'status');
      slowNote.textContent = `The ${page} page is taking too long to load: the server has not answered in ${Math.round(mountTimeoutMs / 1000)} s. It will appear if it arrives; any other page can be opened meanwhile.`;
      root.appendChild(slowNote);
    });
    return !settled;
  }

  async function doEnter(route, { push = false } = {}, my, superseded) {
    // A navigation overtaken before it even started is dropped: only the
    // newest of a burst of clicks mounts.
    if (my !== gen) return false;
    if (route.unknown) toast(`No page called "${route.unknown}". Showing ${DEFAULT_LABEL}.`);
    const link = keepLensParams(linkFor(route), location.pathname, location.search);
    const here = location.pathname + location.search;
    if (here !== link) (push ? history.pushState : history.replaceState).call(history, {}, '', link);
    if (current.lens === route.lens && current.handle) {
      current.route = route;
      markNav(route.lens);
      // a failed update is a named failure, as it was before the router
      // moved out of app.js, not a silent 'done'.
      const handle = current.handle;
      const updated = Promise.resolve().then(() => handle.update(route)).catch((e) => {
        console.error('navigation failed', e);
        toast(`Navigation failed: ${e.message}`);
      });
      await boundWait(updated, superseded, () => {});
      return false;
    }
    const root = takeRoot(my, route.lens, route);
    markNav(route.lens);
    return mountPage(my, superseded, route.lens, root, async (lensCtx) => {
      // The sheets load beside the module and both settle before mount, so a
      // lens never paints unstyled; they stay for the life of the page.
      const [mod] = await Promise.all([loadView(route.lens), loadStyles?.(route.lens)]);
      // the first import of a lens module is a network
      // fetch; a navigation overtaken meanwhile must not mount into the
      // newer page's root. An inert handle is all there is to unmount.
      if (!lensCtx.isCurrent()) return INERT_HANDLE;
      return mod.mount(root, route, lensCtx);
    });
  }

  // Wait for p, but no longer than the mount timeout, and not at all once a
  // newer navigation has arrived.
  async function boundWait(p, superseded, onTimeout) {
    let timer = null;
    const timedOut = new Promise((r) => { timer = setTimeout(() => r('timeout'), mountTimeoutMs); });
    try {
      const why = await Promise.race([p.then(() => 'done', () => 'done'), superseded.then(() => 'superseded'), timedOut]);
      if (why === 'timeout') onTimeout();
    } finally { clearTimeout(timer); }
  }

  // Serialised so a fast double-click never mounts two lenses into one root;
  // a newer navigation releases the queue (see `next`) instead of waiting
  // behind a mount that is still on the network.
  function enter(route, opts = {}) {
    const my = ++gen;
    next.resolve();
    next = deferred();
    const superseded = next.promise;
    queue = queue
      .then(async () => {
        mountingGen = my;
        let stillMounting = false;
        try { stillMounting = await doEnter(route, opts, my, superseded); }
        finally { if (!stillMounting && mountingGen === my) mountingGen = 0; }
      })
      .catch((e) => { console.error('navigation failed', e); toast(`Navigation failed: ${e.message}`); });
    return queue;
  }

  // the topbar link of the lens already on screen keeps the
  // current URL (Surface's layers and camera, a selection) instead of
  // pushing the bare lens route over it.
  function goLens(lens) {
    if (current.lens === lens && current.handle) return Promise.resolve();
    return enter(parseLink(`/${lens}`, ''), { push: true });
  }

  return {
    enter,
    goLens,
    get current() { return current; },
    isMounting: () => mountingGen !== 0,
    setRoute(route) { current.route = route; },
  };
}

const INERT_HANDLE = Object.freeze({ update() {}, onState() {}, onEvent() {}, unmount() {} });

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}
