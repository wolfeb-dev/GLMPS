// web/shared/dock.js
export async function mountDocks(root, docks, { toast } = {}) {
  const handles = [];
  if (!root) return handles;
  for (const d of docks) {
    try {
      const mod = await d.load();
      handles.push(await mod.mount(root));
    } catch (e) {
      console.error(`dock ${d.id} failed to mount`, e);
      toast?.(`The ${d.id} dock failed to load: ${e.message}`);
    }
  }
  return handles;
}
