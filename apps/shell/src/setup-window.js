// apps/shell/src/setup-window.js
// The graphical setup wizard window. One at a time (opening again focuses it),
// sandboxed, served from the local scheme on the shell's local partition. Every
// IPC message is accepted only from this window's own webContents. The logic
// lives in lib/setup/* (pure, tested); this file is the electron wiring.
import { BrowserWindow, dialog, ipcMain, session } from 'electron';
import path from 'node:path';
import { PARTITIONS, PRELOAD_DIR, ASSETS_DIR, installLocalPages } from './shell-window.js';
import { localPageUrl } from './lib/local-pages.js';
import { createSetupService } from './lib/setup/assemble.js';

const CHANNELS = ['setup:get-state', 'setup:run', 'setup:pick-folder', 'setup:open-link', 'setup:finish', 'setup:close'];

export function createSetupWindow({ kernel, userData, profileFile, stateDirOverride, kernelStateDir, restartKernel, onFinish, onDismissed, openExternal, log, iconFile = path.join(ASSETS_DIR, 'icon.ico') }) {
  let win = null;
  let finished = false;
  let service = null;

  function open() {
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      return;
    }
    installLocalPages();
    finished = false;
    service = createSetupService({
      kernel, userData, profileFile, stateDirOverride, kernelStateDir, restartKernel, openExternal, log,
      finish: async (choice) => { finished = true; await onFinish(choice); },
    });
    const w = new BrowserWindow({
      width: 940, height: 700, minWidth: 720, minHeight: 560, show: false, backgroundColor: '#0a0b0d',
      title: 'GLMPS 2.0 setup', icon: iconFile, autoHideMenuBar: true,
      webPreferences: {
        contextIsolation: true, nodeIntegration: false, sandbox: true,
        session: session.fromPartition(PARTITIONS.local), preload: path.join(PRELOAD_DIR, 'setup.cjs'),
      },
    });
    win = w;
    w.setMenu(null);
    const wc = w.webContents;
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.on('will-navigate', (event) => event.preventDefault());
    w.once('ready-to-show', () => w.show());

    const mine = (event) => event.sender === wc;
    const handlers = {
      'setup:get-state': (event) => (mine(event) ? service.getState() : null),
      'setup:run': (event, stepId, actionId, input) => (mine(event) ? service.run(stepId, actionId, input) : { ok: false, message: '' }),
      'setup:pick-folder': async (event) => {
        if (!mine(event)) return null;
        const r = await dialog.showOpenDialog(w, { title: 'Choose the folder that holds your projects', properties: ['openDirectory'] });
        return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
      },
      'setup:open-link': (event, key) => (mine(event) ? service.openLink(key) : { ok: false }),
      'setup:finish': async (event, opts) => {
        if (!mine(event)) return { ok: false };
        const r = await service.finish(opts);
        if (!w.isDestroyed()) w.close();
        return r;
      },
      'setup:close': (event) => { if (mine(event) && !w.isDestroyed()) w.close(); },
    };
    for (const channel of CHANNELS) ipcMain.handle(channel, handlers[channel]);
    const unsubscribe = service.onState((state) => { if (!wc.isDestroyed()) wc.send('setup:state', state); });

    w.on('closed', () => {
      unsubscribe();
      for (const channel of CHANNELS) ipcMain.removeHandler(channel);
      if (win === w) win = null;
      if (!finished) onDismissed();
    });
    w.loadURL(localPageUrl('setup.html')).catch((e) => log('error', 'setup window did not load', { error: e.message }));
  }

  return { open, isOpen: () => Boolean(win && !win.isDestroyed()) };
}
