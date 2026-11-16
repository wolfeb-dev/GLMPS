// apps/shell/src/preload/setup.cjs
// Sandboxed preload for the setup wizard window. CommonJS because a sandboxed
// preload gets only a limited require. Exposes a fixed API only; every message
// is checked against this window's own webContents in setup-window.js.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('glmpsSetup', {
  getState: () => ipcRenderer.invoke('setup:get-state'),
  onState: (cb) => { ipcRenderer.on('setup:state', (_e, state) => cb(state)); },
  run: (stepId, actionId, input) => ipcRenderer.invoke('setup:run', String(stepId), String(actionId), input && typeof input === 'object' ? { ...input } : {}),
  pickFolder: () => ipcRenderer.invoke('setup:pick-folder'),
  openLink: (key) => ipcRenderer.invoke('setup:open-link', String(key)),
  finish: (opts) => ipcRenderer.invoke('setup:finish', { launchAtLogin: !opts || opts.launchAtLogin !== false }),
  close: () => ipcRenderer.invoke('setup:close'),
});
