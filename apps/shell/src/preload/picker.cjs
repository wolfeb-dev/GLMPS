// apps/shell/src/preload/picker.cjs
// Sandboxed preload for the screen-share picker. CommonJS because a sandboxed
// preload gets only a limited require (electron-44.4.5/tutorial/sandbox.md).
// Exposes a fixed API only; every message it sends is checked against this
// view's own webContents on the main-process side (shell-window.js).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('glmpsPicker', {
  onSources: (cb) => ipcRenderer.on('picker:sources', (_e, state) => cb(state)),
  // 'picker:clear' fires when the picker is hidden (a request settled, or the
  // slot was force-denied): the renderer drops its tile list so a stale tile
  // from an earlier request is never still sitting there to be clicked.
  onClear: (cb) => ipcRenderer.on('picker:clear', () => cb()),
  // requestId is the id the current sources arrived tagged with (PR #29
  // echoed back so main can ignore a delayed message that no
  // longer matches whatever request now owns the slot.
  choose: (sourceId, includeAudio, requestId) => ipcRenderer.send('picker:choose', String(sourceId), Boolean(includeAudio), Number(requestId)),
  cancel: (requestId) => ipcRenderer.send('picker:cancel', Number(requestId)),
});
