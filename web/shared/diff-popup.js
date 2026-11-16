// web/shared/diff-popup.js
// The 1.x diff popup (was private to web/observability/detail.js), shared so
// any file on any page opens the same popup (D17). XSS-safe: renderDiff and
// setText only.
import { renderDiff } from './diff-view.js';
import { setText, clear } from './dom-util.js';

let _diffPopup = null;
// The one Escape listener showDiffPopup ever has live at a time: the popup is a shared singleton reused by every lens's file-actions
// row, so closeDiffPopup is the single place that owns and removes it -
// on every close path (click-away, the toggle, the edit pencil, or Escape
// itself) - and showDiffPopup never adds a second one on top of a live one.
let _escHandler = null;

export function getDiffPopup() {
  if (!_diffPopup || !_diffPopup.parentNode) {
    _diffPopup = document.createElement('div');
    _diffPopup.className = 'diff-popup';
    _diffPopup.setAttribute('role', 'dialog');
    _diffPopup.setAttribute('aria-label', 'Diff');
    document.body.appendChild(_diffPopup);
  }
  return _diffPopup;
}

export function closeDiffPopup() {
  // Task 13 carry 2: used to only hide the popup, leaving _diffPopup pointing
  // at a stale element (a different test file's document, once that
  // document is gone) - the next getDiffPopup() would reuse it instead of
  // creating a fresh one bound to whatever document is current now. Fully
  // resetting module state here means diff-popup tests never depend on
  // execution order.
  if (_diffPopup) { _diffPopup.style.display = 'none'; clear(_diffPopup); _diffPopup.remove?.(); }
  _diffPopup = null;
  if (_escHandler) { window.removeEventListener('keydown', _escHandler); _escHandler = null; }
}

// Moved verbatim from detail.js:100-123.
export function positionDiffPopup(popup, btn) {
  const r = btn.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const popW = Math.min(520, vw - 16);
  const popH = 320;
  let top = r.bottom + 4;
  let left = r.right - popW;
  if (left < 8) left = 8;
  if (left + popW > vw - 8) left = vw - popW - 8;
  if (top + popH > vh - 8) top = r.top - popH - 4;
  if (top < 8) top = 8;
  popup.style.top = top + 'px';
  popup.style.left = left + 'px';
  popup.style.maxWidth = popW + 'px';
  popup.style.display = 'block';
}

// Moved verbatim from detail.js:125-153; the edit button now calls
// closeDiffPopup() (detail.js's own hideDiffPopup also resets its toggle).
export function fillDiffPopup(popup, change, labelBasename, handlers, filePath) {
  clear(popup);
  if (labelBasename || filePath) {
    const hdr = document.createElement('div');
    hdr.className = 'diff-popup-header';
    const nameSpan = document.createElement('span');
    setText(nameSpan, labelBasename ?? '');
    hdr.appendChild(nameSpan);
    if (filePath && handlers?.onOpenFile) {
      const editBtn = document.createElement('button');
      editBtn.className = 'diff-edit';
      editBtn.title = 'Open in editor';
      setText(editBtn, '\u270E');
      editBtn.addEventListener('click', () => {
        handlers.onOpenFile(filePath, change);
        closeDiffPopup();
      });
      hdr.appendChild(editBtn);
    }
    popup.appendChild(hdr);
  }
  popup.appendChild(renderDiff(change));
}

export function showDiffPopup(anchor, { change, label, path, onOpenFile } = {}) {
  const popup = getDiffPopup();
  fillDiffPopup(popup, change, label ?? null, onOpenFile ? { onOpenFile } : null, path ?? null);
  positionDiffPopup(popup, anchor);
  if (!_escHandler) {
    _escHandler = (e) => { if (e.key === 'Escape') closeDiffPopup(); };
    window.addEventListener('keydown', _escHandler);
  }
  return popup;
}
