// apps/shell/src/lib/app-identity.js
// Windows draws a running app's taskbar button from the Start Menu shortcut
// that carries its AUMID. A dev run (`electron .`) sharing the installed
// app's AUMID let a dev shortcut to node_modules electron.exe take over the
// installed app's taskbar icon (card glmps-2-0-131), so dev runs get their own.
export function appUserModelId({ appId, isPackaged }) {
  return isPackaged ? appId : `${appId}.dev`;
}
