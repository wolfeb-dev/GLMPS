// apps/shell/src/preload/splitter.cjs
// Sandboxed preload. CommonJS because a sandboxed preload gets only a limited
// require (electron-44.4.5/tutorial/sandbox.md). Exposes a fixed API only.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('glmpsSplitter', {
  start: () => ipcRenderer.send('splitter:start'),
  move: (screenX) => ipcRenderer.send('splitter:move', Number(screenX)),
  end: (screenX) => ipcRenderer.send('splitter:end', Number(screenX)),
  nudge: (dir) => ipcRenderer.send('splitter:nudge', dir === 'left' ? 'left' : 'right'),
  edge: (which) => ipcRenderer.send('splitter:edge', which === 'home' ? 'home' : 'end'),
  reset: () => ipcRenderer.send('splitter:reset'),
  onRatio: (cb) => ipcRenderer.on('splitter:ratio', (_e, pct, label) => cb(Number(pct), String(label ?? ''))),
  onMode: (cb) => ipcRenderer.on('splitter:mode', (_e, mode) => cb({ overlay: Boolean(mode && mode.overlay) })),
});
