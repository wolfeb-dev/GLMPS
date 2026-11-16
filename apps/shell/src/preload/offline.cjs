// apps/shell/src/preload/offline.cjs
// Sandboxed preload for the offline page. CommonJS because a sandboxed
// preload gets only a limited require (electron-44.4.5/tutorial/sandbox.md).
// Exposes a fixed API only; every message it sends is checked against this
// view's own webContents on the main-process side (shell-window.js).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('glmpsOffline', {
  onState: (cb) => ipcRenderer.on('offline:state', (_e, view) => cb(view)),
  retry: () => ipcRenderer.send('offline:retry'),
  openLogs: () => ipcRenderer.send('offline:open-logs'),
});
