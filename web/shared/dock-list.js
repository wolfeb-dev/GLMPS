// web/shared/dock-list.js
// Pop-over docks mounted on every page, outside #lens-root so they survive a
// lens change. web/shared/dock.js mountDocks() loads each entry and calls
// mount(rootEl) -> { unmount() } with #huddle-dock. The huddle (H1,
// docs/superpowers/plans/2026-09-10-huddle-spike-1-text-huddle.md) is the first.
export const DOCKS = [
  { id: 'huddle', load: () => import('../huddle/dock.js') },
];
