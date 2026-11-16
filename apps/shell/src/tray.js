// apps/shell/src/tray.js
// The notification-area icon and menu. Labels and order come from
// trayMenuModel (pure, tested); this file maps ids to handlers.
import { Tray, Menu } from 'electron';
import path from 'node:path';
import { trayMenuModel } from './lib/status-format.js';

export function createTray({ assetsDir, handlers, toggles }) {
  const icon = (name) => path.join(assetsDir, `${name}.ico`);
  let view = { menuStatus: 'Checking the kernel', tooltip: 'GLMPS 2.0: checking the kernel', trayIcon: 'tray-down' };
  const tray = new Tray(icon(view.trayIcon));
  const build = () => tray.setContextMenu(Menu.buildFromTemplate(
    trayMenuModel(view, toggles()).map((item) => (item.type === 'separator' ? item : { ...item, click: handlers[item.id] })),
  ));
  tray.setToolTip(view.tooltip);
  tray.on('click', handlers.show);
  build();
  return {
    update(next) {
      if (next.trayIcon !== view.trayIcon) tray.setImage(icon(next.trayIcon));
      view = next;
      tray.setToolTip(next.tooltip);
      build();
    },
    refresh: build,
    destroy: () => tray.destroy(),
  };
}
