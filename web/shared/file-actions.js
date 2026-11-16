// web/shared/file-actions.js
// Any file, anywhere: the 1.x diff popup, the 1.x pop-out editor (with its
// diff mode) and "Open in IDE" (POST /api/open-in-editor). Carried over, not
// rebuilt (D17): this only routes to showDiffPopup, openEditor, openInEditor.
import { showDiffPopup } from './diff-popup.js';
import { openInEditor } from './api.js';

let editorMod = null;
const toast = (msg) => window.dispatchEvent(new CustomEvent('mc-toast', { detail: String(msg) }));
const basename = (p) => String(p ?? '').split(/[/\\]/).pop();

export async function openFileEditor(path, { diff } = {}) {
  editorMod ??= await import('./editor.js');
  editorMod.openEditor(path, { onClose: () => {}, diff: diff ?? undefined });
}

export async function openFileInIde(path) {
  try {
    const r = await openInEditor(path);
    if (!r.status || r.status >= 400) {
      const error = r.body?.error ?? `Open in IDE failed (${r.status})`;
      toast(error);
      return { ok: false, error };
    }
    return { ok: true };
  } catch (e) {
    toast(`Open in IDE failed: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

export function openFileDiff(anchor, { path, change, label } = {}) {
  return showDiffPopup(anchor, { change, label: label ?? basename(path), path, onOpenFile: (p, c) => openFileEditor(p, { diff: c }) });
}

export function buildFileActions(path, { getChange } = {}) {
  const row = document.createElement('div');
  row.className = 'file-actions';
  const mk = (text, title, fn) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'fa-btn'; b.textContent = text; b.title = title;
    b.addEventListener('click', fn);
    row.appendChild(b);
    return b;
  };
  // ok:false means loadChange already toasted the specific error (a
  // rejected getChange) - the caller must not also toast the generic
  // "No diff for this file" on top of it.
  const loadChange = async () => {
    if (!getChange) return { ok: true, change: null };
    try { return { ok: true, change: await getChange() }; }
    catch (e) { toast(`Could not load the diff: ${e.message}`); return { ok: false, change: null }; }
  };
  const diffBtn = mk('Diff', 'Show the diff for this file', async () => {
    const { ok, change } = await loadChange();
    if (!ok) return;
    if (!change) { toast('No diff for this file'); return; }
    openFileDiff(diffBtn, { path, change });
  });
  mk('Edit', 'Open in the pop-out editor', async () => {
    const { change } = await loadChange();
    await openFileEditor(path, { diff: change ?? undefined });
  });
  mk('Open in IDE', 'Open in your IDE', () => openFileInIde(path));
  return row;
}
