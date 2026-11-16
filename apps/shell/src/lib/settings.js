// %APPDATA%\GLMPS2\shell.json: the shell's only persistent state of its own.
import fs from 'node:fs';
import path from 'node:path';

// kernelCheckout/kernelNode/kernelAssetsDir: the in-app kernel on a machine
// with no service (card glmps-2-0-runtime-12), copied from the retired
// service's WinSW XML by scripts/service/move-kernel-to-app.mjs.
export const DEFAULT_SETTINGS = Object.freeze({
  version: 2, splitRatio: 0.62, bounds: null, maximized: false, slackVisible: true,
  swapped: false, closeToTray: true, launchAtLogin: true, kernelUrl: null, stateDir: null, worktreesDir: null,
  kernelCheckout: null, kernelNode: null, kernelAssetsDir: null, kernelEnv: Object.freeze({}),
  setupWizardDismissed: false, setupCompleted: false,
});

export function settingsFile(userDataDir) { return path.join(userDataDir, 'shell.json'); }

function normBounds(b) {
  if (!b || typeof b !== 'object') return null;
  const { x, y, width, height } = b;
  if (![x, y, width, height].every(Number.isInteger) || width < 200 || height < 200) return null;
  return { x, y, width, height };
}

// Extra kernel environment variables. Only GLMPS_* names, so a settings file
// cannot set NODE_OPTIONS, PATH and the like.
function normKernelEnv(v) {
  const out = {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
  for (const [k, val] of Object.entries(v)) {
    if (/^GLMPS_[A-Z0-9_]+$/.test(k) && typeof val === 'string' && val.trim()) out[k] = val.trim();
  }
  return out;
}

export function normalizeSettings(raw) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const bool = (k) => (typeof r[k] === 'boolean' ? r[k] : DEFAULT_SETTINGS[k]);
  const str = (k) => (typeof r[k] === 'string' && r[k].trim() ? r[k].trim() : null);
  const ratio = Number.isFinite(r.splitRatio) ? Math.min(0.9, Math.max(0.1, r.splitRatio)) : DEFAULT_SETTINGS.splitRatio;
  // Version 1 wrote every key, so its launchAtLogin:false was the old default
  // written back, never a choice anyone can tell apart: it becomes on.
  const launchAtLogin = r.version === 2 ? bool('launchAtLogin') : r.launchAtLogin === true || DEFAULT_SETTINGS.launchAtLogin;
  return {
    version: 2, splitRatio: ratio, bounds: normBounds(r.bounds), maximized: bool('maximized'),
    slackVisible: bool('slackVisible'), swapped: bool('swapped'), closeToTray: bool('closeToTray'),
    launchAtLogin, kernelUrl: str('kernelUrl'), stateDir: str('stateDir'), worktreesDir: str('worktreesDir'),
    kernelCheckout: str('kernelCheckout'), kernelNode: str('kernelNode'), kernelAssetsDir: str('kernelAssetsDir'),
    kernelEnv: normKernelEnv(r.kernelEnv), setupWizardDismissed: bool('setupWizardDismissed'),
    setupCompleted: bool('setupCompleted'),
  };
}

export function loadSettings({ file, fsImpl = fs, now = Date.now }) {
  let text;
  try { text = fsImpl.readFileSync(file, 'utf8'); }
  catch (e) {
    if (e.code === 'ENOENT') return { settings: normalizeSettings({}), warning: null };
    return { settings: normalizeSettings({}), warning: { kind: 'unreadable', file, error: e.message } };
  }
  try { return { settings: normalizeSettings(JSON.parse(text)), warning: null }; }
  catch (e) {
    const backup = `${file}.bad-${now()}`;
    try { fsImpl.renameSync(file, backup); }
    catch (re) {
      return { settings: normalizeSettings({}), warning: { kind: 'corrupt', file, backup: null, error: `${e.message}; backup failed: ${re.message}` } };
    }
    return { settings: normalizeSettings({}), warning: { kind: 'corrupt', file, backup, error: e.message } };
  }
}

export function saveSettings({ file, settings, fsImpl = fs }) {
  fsImpl.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fsImpl.writeFileSync(tmp, JSON.stringify(normalizeSettings(settings), null, 2) + '\n');
  fsImpl.renameSync(tmp, file);
}

export function createSettingsWriter({ file, initial, onError, fsImpl = fs, delayMs = 500,
  setTimer = setTimeout, clearTimer = clearTimeout }) {
  if (typeof onError !== 'function') throw new TypeError('onError is required');
  let current = normalizeSettings(initial);
  let timer = null;
  function flush() {
    clearTimer(timer);
    timer = null;
    try { saveSettings({ file, settings: current, fsImpl }); return true; }
    catch (e) { onError(e); return false; }
  }
  return {
    current: () => ({ ...current }),
    update(patch) {
      current = normalizeSettings({ ...current, ...patch });
      clearTimer(timer);
      timer = setTimer(flush, delayMs);
      return { ...current };
    },
    flush,
  };
}

export function boundsVisible(bounds, workAreas, { minVisibleW = 100, minVisibleH = 50 } = {}) {
  if (!bounds) return false;
  return workAreas.some((a) => {
    const w = Math.min(bounds.x + bounds.width, a.x + a.width) - Math.max(bounds.x, a.x);
    const h = Math.min(bounds.y + bounds.height, a.y + a.height) - Math.max(bounds.y, a.y);
    return w >= minVisibleW && h >= minVisibleH;
  });
}
