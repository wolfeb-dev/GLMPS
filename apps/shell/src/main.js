// apps/shell/src/main.js
// GLMPS desktop shell entry (D26). A thin client: it reads the kernel's HTTP
// surface and never owns the kernel process - except on a machine with no
// GLMPS2 service, where a packaged build runs the kernel itself: the source
// checkout named in settings (card glmps-2-0-runtime-12, the operator's PC),
// else its bundled kernel (glmps-2-0-59).
import { app, Menu, Notification, session, shell, screen } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { settingsFile, loadSettings, createSettingsWriter, boundsVisible } from './lib/settings.js';
import { createShellLog } from './lib/shell-log.js';
import { refusedDebugSwitch } from './lib/debug-switches.js';
import { resolveKernelUrl, resolveLogsDir, resolveServiceName, resolveStateDir, resolveWorktreesDir, shouldRunLaunches } from './lib/endpoints.js';
import { iconDir } from './lib/icon-paths.js';
import { SLACK_HOME } from './lib/navigation.js';
import { checkHealth, identifyPortHolder, tcpAccepts } from './lib/health-client.js';
import { startService } from './lib/service-control.js';
import { bundledKernel, checkoutKernel, createKernelHost, createKernelStarter } from './lib/kernel-host.js';
import { createSupervisor } from './lib/supervisor.js';
import { createLaunchRunner } from './lib/launch-runner.js';
import { createAgyRunner } from './lib/agy-runner.js';
import { createGitopsRunner } from './lib/gitops-runner.js';
import { createEditorRunner } from './lib/editor-runner.js';
import { closeNotice, hungNotice, offlineView, statusView } from './lib/status-format.js';
import { shouldReconcileLoginItem } from './lib/login-item.js';
import { createLocalSession, installLocalSession } from './lib/local-session.js';
import { createShellWindow, installPermissionPolicy, registerLocalScheme, ASSETS_DIR, PARTITIONS } from './shell-window.js';
import { createTray } from './tray.js';
import { createSmokeProbe } from './smoke-probe.js';
import { shouldOpenSetup } from './lib/first-run.js';
import { createSetupWindow } from './setup-window.js';
import { appUserModelId } from './lib/app-identity.js';

export const APP_ID = 'dev.glmps.shell2';
const DEV = !app.isPackaged;
const SMOKE_FILE = DEV ? process.env.GLMPS_SHELL_SMOKE || null : null;
const START_HIDDEN = process.argv.includes('--hidden');

// Identity and storage are fixed before 'ready' (app.md: setAppUserModelId, setPath).
// GLMPS 2.0 identity (separated build): userData lives under %APPDATA%\GLMPS2,
// never the production shell's %APPDATA%\GLMPS.
app.setAppUserModelId(appUserModelId({ appId: APP_ID, isPackaged: app.isPackaged }));
const userData = DEV && process.env.GLMPS_SHELL_USERDATA
  ? process.env.GLMPS_SHELL_USERDATA
  : path.join(app.getPath('appData'), 'GLMPS2');
fs.mkdirSync(userData, { recursive: true });
app.setPath('userData', userData);
registerLocalScheme();
// a packaged build started with a remote-debugging switch exits
// before 'ready' (before any session or window exists), with a named line in
// the shell log and on stderr.
const refusedSwitch = refusedDebugSwitch({ isDev: DEV, argv: process.argv, hasSwitch: (n) => app.commandLine.hasSwitch(n) });
if (refusedSwitch) {
  const msg = `refusing to start: --${refusedSwitch} is not allowed in a packaged build`;
  try { createShellLog({ dir: path.join(userData, 'logs') })('error', msg, { argv: process.argv.slice(1) }); } catch { /* stderr below still names it */ }
  process.stderr.write(`GLMPS 2.0 shell: ${msg}\n`);
  app.exit(1);
}
const debugPort = Number(process.env.GLMPS_SHELL_DEBUG_PORT);
if (DEV && Number.isInteger(debugPort) && debugPort > 1024 && debugPort < 65536) {
  app.commandLine.appendSwitch('remote-debugging-port', String(debugPort));
}

if (refusedSwitch) {
  // app.exit(1) above is already under way; nothing else may start.
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let shellWin = null;
  app.on('second-instance', () => {
    if (!shellWin) return;
    shellWin.showWindow();
  });

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    const log = createShellLog({ dir: path.join(userData, 'logs') });
    const notify = (title, body, level = 'warn') => {
      log(level, title, { body });
      if (Notification.isSupported()) new Notification({ title, body }).show();
    };
    const file = settingsFile(userData);
    const { settings, warning } = loadSettings({ file });
    if (warning) {
      notify('GLMPS 2.0 shell settings were reset', warning.backup
        ? `The settings file could not be read, so defaults are in use. The old file is at ${warning.backup}.`
        : `The settings file could not be read (${warning.error}), so defaults are in use.`);
    }
    if (settings.bounds && !boundsVisible(settings.bounds, screen.getAllDisplays().map((d) => d.workArea))) settings.bounds = null;
    const writer = createSettingsWriter({ file, initial: settings, onError: (e) => notify('GLMPS 2.0 shell could not save its settings', e.message) });
    const kernel = resolveKernelUrl({ env: process.env, settings });
    if (kernel.warning) notify('GLMPS 2.0 shell is using the default kernel URL', kernel.warning);
    const serviceName = resolveServiceName({ env: process.env, isPackaged: app.isPackaged });
    const logsDir = resolveLogsDir({ env: process.env, settings, homedir: os.homedir() });
    const checkout = checkoutKernel({ isPackaged: app.isPackaged, platform: process.platform, isLoopback: kernel.isLoopback, settings });
    if (settings.kernelCheckout && !checkout) log('warn', 'kernelCheckout is set but not usable; using the bundled kernel if there is one', { kernelCheckout: settings.kernelCheckout, kernelNode: settings.kernelNode });
    const kernelDir = checkout?.kernelDir ?? bundledKernel({ isPackaged: app.isPackaged, platform: process.platform, isLoopback: kernel.isLoopback, resourcesPath: process.resourcesPath });
    const kernelStateDir = resolveStateDir({ env: process.env, settings, homedir: os.homedir() });
    const kernelHost = kernelDir
      ? createKernelHost({
          kernelDir, logsDir, port: Number(new URL(kernel.url).port) || 80,
          profileFile: path.join(userData, 'glmps.profile.json'),
          stateDir: kernelStateDir,
          // A checkout reads the config the service read. The bundled kernel's
          // lives outside the install dir, so a reinstall never wipes it.
          ...(checkout
            ? { nodePath: checkout.nodePath, configFile: null, extraEnv: checkout.extraEnv }
            : { configFile: path.join(userData, 'kernel', 'config.json') }),
          log,
        })
      : null;
    const kernelOwned = () => kernelHost?.owned() ?? false;
    const openLogs = () => shell.openPath(logsDir).then((err) => { if (err) notify('Could not open the logs folder', `${logsDir}: ${err}`); });
    installPermissionPolicy({ log, dashboardOrigin: kernel.origin });
    const smoke = SMOKE_FILE ? createSmokeProbe({ file: SMOKE_FILE }) : null;
    const openExternal = smoke ? smoke.openExternal : (url) => shell.openExternal(url);
    // Dev/smoke-only override so a fix-round-2 regression check (a flapping
    // kernel must never leave a stale dashboard-load timer to misreport
    // load-failed:timeout over the true down state) does not need to wait out
    // the real 20 s in every smoke run. Never read when packaged.
    const dashboardLoadTimeoutOverride = DEV ? Number(process.env.GLMPS_SHELL_DASHBOARD_LOAD_TIMEOUT_MS) : NaN;
    // Same dev/smoke-only rule for the supervisor's down threshold, so the
    // smoke's flap checks see a down kernel inside their 5 s waits.
    const supervisorOverrides = {};
    for (const [key, name] of [['failThreshold', 'GLMPS_SHELL_SUPERVISOR_FAIL_THRESHOLD'], ['noAnswerMs', 'GLMPS_SHELL_SUPERVISOR_NO_ANSWER_MS']]) {
      const v = DEV && process.env[name] !== undefined && process.env[name] !== '' ? Number(process.env[name]) : NaN;
      if (Number.isFinite(v) && v >= 0) supervisorOverrides[key] = v;
    }
    let supervisor = null;
    let tray = null;
    let quitting = false;
    // glmps-2-0-61: the shell once stopped for 93 minutes with no line in
    // shell.log, and the launch queue sat unclaimed with no way to say why.
    // The first cause recorded wins; the quit event logs it with the exit code.
    let exitReason = null;
    const noteExit = (why) => { exitReason ??= why; };
    process.on('uncaughtExceptionMonitor', (e, origin) => {
      noteExit(`${origin}: ${e?.message ?? e}`);
      log('error', 'shell uncaught exception', { origin, error: e?.stack || String(e) });
    });
    app.on('quit', (_e, exitCode) => log('info', 'shell exiting', { reason: exitReason ?? 'unknown (no tray quit, window close or session end recorded)', exitCode }));
    // A start line with no exit line before it means the process was killed.
    log('info', 'shell started', { pid: process.pid, version: app.getVersion() });
    let toldAboutTray = false;
    const canLaunchAtLogin = app.isPackaged && process.platform === 'win32';
    const toggles = () => {
      const s = writer.current();
      return { slackVisible: s.slackVisible, closeToTray: s.closeToTray, launchAtLogin: s.launchAtLogin, canLaunchAtLogin, kernelOwned: kernelOwned() };
    };
    const updateStatus = (snap) => {
      const v = statusView(snap, { now: Date.now() });
      if (shellWin && !shellWin.win.isDestroyed()) shellWin.win.setTitle(v.title);
      tray?.update(v);
    };
    // Scan 2026-10-15 F2: before the dashboard's first request. A remote
    // kernel never gets the local session (it is not this install's key).
    if (kernel.isLoopback) {
      installLocalSession({
        ses: session.fromPartition(PARTITIONS.dashboard), kernelUrl: kernel.url,
        localSession: createLocalSession({
          stateDir: resolveStateDir({ env: process.env, settings: writer.current(), homedir: os.homedir() }),
          log: (m) => log('warn', 'local-session', { msg: m }),
        }),
      });
    }
    shellWin = createShellWindow({
      settings: writer.current(), writer, kernel, slackUrl: SLACK_HOME, openExternal, log, notify, serviceName,
      ...(dashboardLoadTimeoutOverride > 0 ? { dashboardLoadTimeoutMs: dashboardLoadTimeoutOverride } : {}),
      onRetry: () => supervisor.retryNow(), onOpenLogs: openLogs, onStatusChange: updateStatus,
    });
    // Task 12b: the shell's half of the launch queue - a service-mode kernel
    // (session 0, no desktop) queues a launch instead of opening it; this is
    // what actually opens the terminal, in the operator's own session. Only
    // runs while the kernel itself is reachable (started/stopped below, off
    // the SAME up/degraded/down signal the window and tray already use), so
    // it never polls a kernel that is not even there yet.
    // only against a loopback kernel - the session-0
    // problem this exists for is local-only, and the runner executes
    // whatever the kernel hands it, in the operator's own session. A
    // remote kernelUrl must never create this at all, regardless of the
    // kernel's own up/degraded/down state.
    const launchRunner = shouldRunLaunches({ isLoopback: kernel.isLoopback })
      ? createLaunchRunner({
          kernelUrl: kernel.url,
          // the one directory a runner-origin record's
          // prompt path must resolve inside - the kernel's own state dir,
          // the same GLMPS_STATE_DIR/settings.stateDir formula resolveLogsDir
          // already builds on.
          stateDir: resolveStateDir({ env: process.env, settings: writer.current(), homedir: os.homedir() }),
          log: (m) => log('warn', 'launch-runner', { msg: m }),
          notify: (m) => notify('GLMPS 2.0 shell', m, 'info'),
        })
      : null;
    // The huddle's agy seats: the service kernel cannot load the operator's agy
    // sign-in, so it queues each call and this runner, in the operator's own
    // session, runs it. Same gating as the launch runner above: loopback kernel
    // only, polling only while the kernel is up or degraded.
    const agyRunner = shouldRunLaunches({ isLoopback: kernel.isLoopback })
      ? createAgyRunner({
          kernelUrl: kernel.url,
          stateDir: resolveStateDir({ env: process.env, settings: writer.current(), homedir: os.homedir() }),
          log: (m) => log('warn', 'agy-runner', { msg: m }),
        })
      : null;
    // The merge queue's git, gh and test runs: the service kernel has no GitHub
    // sign-in, so it queues each and this runner, in the operator's own session,
    // runs it against a strict allowlist (gitops-allow.js). Same gating again.
    const gitopsRunner = shouldRunLaunches({ isLoopback: kernel.isLoopback })
      ? createGitopsRunner({
          kernelUrl: kernel.url,
          stateDir: resolveStateDir({ env: process.env, settings: writer.current(), homedir: os.homedir() }),
          worktreesDir: resolveWorktreesDir({ env: process.env, settings: writer.current(), homedir: os.homedir() }),
          log: (m) => log('warn', 'gitops-runner', { msg: m }),
        })
      : null;
    // The Personality page's open buttons: the service has no desktop, so it
    // queues each editor open and this runner spawns the editor in the
    // operator's own session. Same gating again.
    const editorRunner = shouldRunLaunches({ isLoopback: kernel.isLoopback })
      ? createEditorRunner({
          kernelUrl: kernel.url,
          stateDir: resolveStateDir({ env: process.env, settings: writer.current(), homedir: os.homedir() }),
          log: (m) => log('warn', 'editor-runner', { msg: m }),
        })
      : null;
    supervisor = createSupervisor({
      checkHealth: () => checkHealth({ kernelUrl: kernel.url }),
      isKernelAlive: async () => (kernelHost?.running() ?? false) || tcpAccepts({ kernelUrl: kernel.url }),
      // Card glmps-2-0-214: a kernel answers /healthz 200 once it listens, so
      // an HTTP refusal while this app's own kernel is not running is another
      // program on the port (the GLMPS Tap on a client machine).
      portConflict: async (h) => (kernelHost && !kernelHost.running() && /^(http-\d+|bad-body)$/.test(h.reason ?? '')
        ? `port-conflict:${await identifyPortHolder({ kernelUrl: kernel.url })}` : null),
      startService: createKernelStarter({ startService: () => startService({ name: serviceName }), host: kernelHost }),
      canStart: kernel.isLoopback && process.platform === 'win32',
      onChange: (snap) => {
        shellWin.onSupervisor(snap);
        if (snap.state === 'up' || snap.state === 'degraded') { launchRunner?.start(); agyRunner?.start(); gitopsRunner?.start(); editorRunner?.start(); }
        else { launchRunner?.stop(); agyRunner?.stop(); gitopsRunner?.stop(); editorRunner?.stop(); }
      },
      onGiveUp: (snap) => (/^(unresponsive|waiting):/.test(snap.reason ?? '')
        ? notify('GLMPS 2.0 kernel is not answering', hungNotice({ kernelOwned: kernelOwned() }))
        : notify('GLMPS 2.0 kernel is offline', offlineView(snap, { kernelUrl: kernel.url, serviceName }).lead)),
      log,
      ...supervisorOverrides,
    });
    const setLaunchAtLogin = (on) => {
      // Windows: a Run-key entry named after the AppUserModelId (app.md), started in the tray.
      app.setLoginItemSettings({ openAtLogin: on, args: ['--hidden'] });
      writer.update({ launchAtLogin: on });
      tray?.refresh();
    };
    // The graphical setup wizard (glmps-2-0-202). Finishing it records
    // setupCompleted and applies the Run at startup choice; closing it any other
    // way counts as "not now", so it stops opening itself (the tray item still does).
    const stateDirOverride = process.env.GLMPS_STATE_DIR || writer.current().stateDir || null;
    const setupKernel = kernelDir
      ? { kernelDir, node: checkout?.nodePath ?? path.join(kernelDir, 'node.exe') }
      : DEV ? { kernelDir: path.resolve(app.getAppPath(), '..', '..'), node: 'node' } : null;
    // Restart the kernel so a freshly saved Slack connection is picked up: the
    // app's own kernel directly, else the dashboard's restart route.
    const restartKernel = async () => {
      if (kernelHost?.owned()) { const r = await kernelHost.restart(); return { ok: r.ok, message: r.reason }; }
      if (!kernel.isLoopback) return { ok: false, message: 'the kernel is not on this computer' };
      try {
        const res = await session.fromPartition(PARTITIONS.dashboard).fetch(`${kernel.origin}/api/restart`, { method: 'POST' });
        return { ok: res.status === 202 || res.ok, message: `answered ${res.status}` };
      } catch (e) { return { ok: false, message: e.message }; }
    };
    const setupWin = createSetupWindow({
      kernel: setupKernel, userData, profileFile: path.join(userData, 'glmps.profile.json'), stateDirOverride, kernelStateDir, restartKernel, openExternal, log,
      onFinish: ({ launchAtLogin }) => {
        writer.update({ setupCompleted: true });
        if (canLaunchAtLogin) setLaunchAtLogin(launchAtLogin);
      },
      onDismissed: () => { if (!writer.current().setupCompleted) writer.update({ setupWizardDismissed: true }); },
    });
    tray = createTray({
      assetsDir: iconDir({ isPackaged: app.isPackaged, resourcesPath: process.resourcesPath, assetsDir: ASSETS_DIR }),
      toggles,
      handlers: {
        show: () => shellWin.showWindow(),
        reload: () => { shellWin.views.slack.webContents.reload(); shellWin.retry(); },
        'open-logs': openLogs,
        'run-setup': () => setupWin.open(),
        'toggle-slack': () => { shellWin.runShortcut('toggle-slack'); tray.refresh(); },
        'toggle-close-to-tray': (item) => { writer.update({ closeToTray: item.checked }); tray.refresh(); },
        'toggle-launch-at-login': (item) => setLaunchAtLogin(item.checked),
        quit: () => { noteExit('tray Quit'); quitting = true; app.quit(); },
      },
    });
    // Reconcile the Windows Run-key with settings once at launch (a login-item
    // toggle changed while the app was not running still needs to take
    // effect); never touched outside a packaged Windows build (dev and smoke
    // runs are never app.isPackaged, so this never writes a real login item).
    // executableWillLaunchAtLogin, not openAtLogin: openAtLogin compares
    // against the args getLoginItemSettings is called with (empty by
    // default, per app.md), which never matches the { args: ['--hidden'] }
    // entry setLaunchAtLogin writes, so it would reconcile - and rewrite the
    // Run-key - on every single startup. executableWillLaunchAtLogin ignores
    // args entirely.
    if (shouldReconcileLoginItem({
      canLaunchAtLogin,
      desired: writer.current().launchAtLogin,
      current: canLaunchAtLogin ? app.getLoginItemSettings().executableWillLaunchAtLogin : undefined,
    })) setLaunchAtLogin(writer.current().launchAtLogin);
    // Windows: a shutdown, restart or sign-out.
    shellWin.win.on('session-end', () => noteExit('Windows session ended'));
    shellWin.win.on('close', (e) => {
      if (quitting) return;
      if (!writer.current().closeToTray) { noteExit('window closed (close-to-tray is off)'); return; } // closing quits the shell (and a bundled kernel with it)
      e.preventDefault();
      shellWin.win.hide();
      if (!toldAboutTray) {
        toldAboutTray = true;
        const n = closeNotice({ kernelOwned: kernelOwned() });
        notify(n.title, n.body, 'info');
      }
    });
    app.on('before-quit', () => {
      quitting = true;
      supervisor.stop();
      launchRunner?.stop();
      agyRunner?.stop();
      gitopsRunner?.stop();
      editorRunner?.stop();
      kernelHost?.stop();
      writer.flush();
      // A supervisor tick already in flight when Quit is clicked can still
      // settle after this and call updateStatus (safeCall in supervisor.js
      // keeps that from taking the loop down, but the tray is going away
      // here, not just the window - so this reference is dropped too, the
      // same guard shape as onSupervisor's win.isDestroyed() check).
      tray?.destroy();
      tray = null;
    });
    if (START_HIDDEN) shellWin.prepareHidden(); else shellWin.showWindow();
    if (shouldOpenSetup({ settings: writer.current(), smoke: Boolean(smoke) }) && !START_HIDDEN) setupWin.open();
    supervisor.start();
    if (smoke) smoke.run({ shellWin, kernel, writer }).then(() => { noteExit('smoke probe finished'); app.exit(smoke.exitCode()); });
  }).catch((e) => {
    process.stderr.write(`GLMPS 2.0 shell failed to start: ${e.stack || e.message}\n`);
    app.exit(1);
  });
}
