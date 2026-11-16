// Packaged builds load icons from real files in resources/ (copied by
// extraResources): the window icon handle is created from a file path, and a
// path inside app.asar is not a file the OS can open.
export function iconDir({ isPackaged, resourcesPath, assetsDir }) {
  return isPackaged && resourcesPath ? resourcesPath : assetsDir;
}
