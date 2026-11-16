// The in-app kernel (glmps-2-0-59, amends D26). On a machine where the GLMPS2
// service is not installed, the packaged shell runs the kernel as its own
// child, so the installer works anywhere. Where the service exists it always
// wins and this module never spawns anything.
//
// Two sources: the kernel bundled in resources/kernel, or (card
// glmps-2-0-runtime-12) a source checkout named in settings, which is what
// the operator's PC runs so a deploy stays "fast-forward, then restart".
//
// The only other file besides service-control.js allowed near the kernel's
// process: it starts node on the kernel's server entry and taskkill for that
// child's own tree, nothing else.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// The kernel's supervised-restart exit code (server/lib/kernel/service-mode.js).
const RESTART_EXIT_CODE = 75;
const NO_SERVICE = new Set(['not-installed', 'sc-missing']);
// The retired service's WinSW <onfailure> delays and <resetfailure>, so a
// crashed kernel comes back here exactly as it did under the service.
export const CRASH_RESPAWN_DELAYS_MS = Object.freeze([5000, 30000, 120000]);
const CRASH_RESET_MS = 3_600_000;
export const KERNEL_LOG_MAX_BYTES = 10 * 1024 * 1024;
const RESTART_WAIT_MS = 10_000;

// Not checked for existence (card glmps-2-0-214): a packaged install whose
// kernel files are gone still gets a host, so start() reports embedded-missing
// instead of the shell asking for a service install it has no source for.
export function bundledKernel({ isPackaged, platform, isLoopback, resourcesPath }) {
  if (!isPackaged || platform !== 'win32' || !isLoopback || !resourcesPath) return null;
  return path.join(resourcesPath, 'kernel');
}

export function checkoutKernel({ isPackaged, platform, isLoopback, settings = {} }) {
  if (!isPackaged || platform !== 'win32' || !isLoopback) return null;
  const { kernelCheckout, kernelNode, kernelAssetsDir, kernelEnv } = settings;
  if (!kernelCheckout || !kernelNode || !path.isAbsolute(kernelCheckout) || !path.isAbsolute(kernelNode)) return null;
  if (!fs.existsSync(kernelNode) || !fs.existsSync(path.join(kernelCheckout, 'server', 'server.js'))) return null;
  return { kernelDir: kernelCheckout, nodePath: kernelNode, extraEnv: { ...(kernelAssetsDir ? { GLMPS_ASSETS_DIR: kernelAssetsDir } : {}), ...kernelEnv } };
}

function seedConfig({ kernelDir, configFile, port }) {
  if (fs.existsSync(configFile)) return;
  const example = JSON.parse(fs.readFileSync(path.join(kernelDir, 'config.example.json'), 'utf8'));
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(configFile, JSON.stringify({ ...example, port }, null, 2) + '\n', { flag: 'wx' });
}

function rollLog(file) {
  try {
    if (fs.statSync(file).size > KERNEL_LOG_MAX_BYTES) fs.renameSync(file, `${file}.1`);
  } catch { /* no log yet, or locked: append to it as before */ }
}

const defaultKill = (pid) => {
  spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {});
};

// nodePath: the configured node in checkout mode, else the bundled one.
// configFile null (checkout mode): the kernel reads its own default config,
// the one the service read, and nothing is seeded.
// profileFile: the wizard's glmps.profile.json, kept in the user data dir so a
// reinstall never loses it; the kernel is told where it is once it exists.
export function createKernelHost({ kernelDir, nodePath: nodeOverride = null, stateDir, configFile, profileFile = null, extraEnv = {}, logsDir, port, env = process.env,
  spawnImpl = spawn, killImpl = defaultKill, log = () => {},
  setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now }) {
  const nodePath = nodeOverride ?? path.join(kernelDir, 'node.exe');
  const entry = path.join(kernelDir, 'server', 'server.js');
  let child = null;
  let stopping = false;
  let owned = false;
  let respawnTimer = null;
  let crashes = 0;
  let startedTs = 0;

  function launch() {
    const { GLMPS_SERVICE, GLMPS_CONFIG_FILE, ...rest } = env;
    const childEnv = {
      ...rest, ...extraEnv, GLMPS_SUPERVISED: '1', GLMPS_STATE_DIR: stateDir,
      ...(configFile ? { GLMPS_CONFIG_FILE: configFile } : {}),
      ...(profileFile && fs.existsSync(profileFile) ? { GLMPS_PROFILE: profileFile } : {}),
    };
    fs.mkdirSync(logsDir, { recursive: true });
    const logFile = path.join(logsDir, 'kernel.log');
    rollLog(logFile);
    const fd = fs.openSync(logFile, 'a');
    let c;
    try {
      c = spawnImpl(nodePath, [entry], { cwd: kernelDir, env: childEnv, windowsHide: true, stdio: ['ignore', fd, fd] });
    } finally {
      fs.closeSync(fd);
    }
    child = c;
    startedTs = now();
    c.on('error', (e) => {
      log('error', 'in-app kernel failed to start', { error: e.message });
      if (child === c) child = null;
    });
    c.on('exit', (code, signal) => {
      if (child !== c) return;
      child = null;
      log(code === RESTART_EXIT_CODE ? 'info' : 'warn', 'in-app kernel exited', { code, signal });
      if (stopping) return;
      if (code === RESTART_EXIT_CODE) { start(); return; }
      if (now() - startedTs >= CRASH_RESET_MS) crashes = 0;
      const delayMs = CRASH_RESPAWN_DELAYS_MS[Math.min(crashes, CRASH_RESPAWN_DELAYS_MS.length - 1)];
      crashes += 1;
      log('warn', 'in-app kernel respawn scheduled', { delayMs, crashes });
      respawnTimer = setTimer(() => { respawnTimer = null; start(); }, delayMs);
    });
  }

  function start() {
    if (child) return { ok: true, code: null, reason: 'embedded-running' };
    if (!fs.existsSync(nodePath) || !fs.existsSync(entry)) return { ok: false, code: null, reason: 'embedded-missing' };
    clearTimer(respawnTimer);
    respawnTimer = null;
    stopping = false;
    try {
      if (configFile) seedConfig({ kernelDir, configFile, port });
      launch();
    } catch (e) {
      log('error', 'in-app kernel could not be started', { error: e.message });
      child = null;
      return { ok: false, code: null, reason: 'embedded-spawn-failed' };
    }
    owned = true;
    return { ok: true, code: null, reason: 'embedded-started' };
  }

  function stop() {
    stopping = true;
    owned = false;
    clearTimer(respawnTimer);
    respawnTimer = null;
    if (child?.pid) killImpl(child.pid);
    child = null;
  }

  // The old kernel holds the port until it is gone, so the new one starts on
  // its exit; a kernel that never reports one is not waited for forever.
  function restart() {
    const old = child;
    stop();
    if (!old) return Promise.resolve(start());
    return new Promise((resolve) => {
      let done = false;
      let timer = null;
      const go = () => {
        if (done) return;
        done = true;
        clearTimer(timer);
        resolve(start());
      };
      old.once?.('exit', go);
      timer = setTimer(go, RESTART_WAIT_MS);
    });
  }

  return {
    start,
    stop,
    restart,
    running: () => child !== null,
    // True from the first start until stop, through a crash and its pending
    // respawn: what the tray and the close notice describe.
    owned: () => owned,
  };
}

export function createKernelStarter({ startService, host }) {
  return async () => {
    const r = await startService();
    return host && NO_SERVICE.has(r.reason) ? host.start() : r;
  };
}
