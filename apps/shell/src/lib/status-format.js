// apps/shell/src/lib/status-format.js
// Every word the shell shows about the kernel: title bar, tray tooltip, tray
// menu and the offline page. Pure, so the copy is under test.
//
// Two names, on purpose: PRODUCT_NAME ("GLMPS 2.0") is the
// human-facing brand, used wherever the copy names the kernel/product in
// general, so the operator can tell this build apart from production at a
// glance (title bar, tray tooltip prefix, and headlines that say "the
// kernel"). SERVICE_NAME_DEFAULT ("GLMPS2") is the literal Windows service
// identity, used only where the copy names the service itself: a lead
// sentence about starting/installing it, or a command the operator runs
// against it (sc.exe, install-service.mjs) - that text has to match what
// Services/sc.exe actually shows, so it is never the branded name. GLMPS2
// also matches the settings folder and the log prefix (endpoints.js,
// service-control.js, settings.js, shell-log.js).
import { SHORTCUT_LABELS } from './shortcuts.js';

const TOOLTIP_MAX = 127; // Windows notification-area tooltip limit
const PRODUCT_NAME = 'GLMPS 2.0';
const SERVICE_NAME_DEFAULT = 'GLMPS2';
const INSTALL = 'node scripts/service/install-service.mjs';
// The Tap's own uninstaller at its install home (taps/tap-agent-lib.js tapHome).
const TAP_UNINSTALL = '& "$env:LOCALAPPDATA\\GLMPS\\tap\\node.exe" "$env:LOCALAPPDATA\\GLMPS\\tap\\taps\\tap-setup.mjs" --uninstall';

function portOf(kernelUrl) {
  try {
    const u = new URL(kernelUrl);
    return u.port || (u.protocol === 'https:' ? '443' : '80');
  } catch { return '8123'; }
}

export function hungNotice({ kernelOwned }) {
  const lead = 'The kernel is running but has not answered for 5 minutes. It may be hung; ';
  return lead + (kernelOwned ? `quit ${PRODUCT_NAME} from the tray and start it again.` : `restart the ${SERVICE_NAME_DEFAULT} service.`);
}

export function formatAge(ms) {
  if (ms == null || !Number.isFinite(ms)) return null;
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
}

export function obligationsPhrase(n) {
  if (!Number.isInteger(n)) return 'obligations unknown';
  return `${n} open obligation${n === 1 ? '' : 's'}`;
}

function view(level, text) {
  const title = `${PRODUCT_NAME}: ${text}`;
  return {
    level, title,
    tooltip: title.length > TOOLTIP_MAX ? `${title.slice(0, TOOLTIP_MAX - 3)}...` : title,
    trayIcon: `tray-${level}`,
    menuStatus: text.charAt(0).toUpperCase() + text.slice(1),
  };
}

export function statusView(snap, { now }) {
  const h = snap.lastHealth;
  const reason = String(snap.reason ?? '');
  if (reason.startsWith('load-failed:')) return view('degraded', 'dashboard page failed to load');
  if ((snap.state === 'up' || snap.state === 'degraded') && h) {
    const age = h.last_event_ts == null ? 'no events yet' : `last event ${formatAge(now - h.last_event_ts)}`;
    return view(snap.state, `kernel ${snap.state}, ${obligationsPhrase(h.open_obligations)}, ${age}`);
  }
  if (snap.state === 'checking') return view('down', 'checking the kernel');
  // The same scope as offlineView: lastStart changes only on a start attempt,
  // so outside starting/gave-up it can be stale (card glmps-2-0-221).
  if (snap.lastStart?.reason === 'embedded-missing' && (snap.state === 'starting' || reason.startsWith('gave-up'))) return view('down', `kernel files missing, reinstall ${PRODUCT_NAME}`);
  if (snap.state === 'starting') return view('down', `kernel down, starting it (try ${snap.attempts} of ${snap.maxAttempts})`);
  if (snap.state === 'refused') {
    if (reason === 'not-installed') return view('down', 'kernel service not installed');
    if (reason === 'access-denied') return view('down', 'kernel offline, start refused (access denied)');
    if (reason === 'disabled') return view('down', 'kernel offline, service disabled');
    return view('down', `kernel offline, start refused (${reason})`);
  }
  if (reason === 'port-conflict:tap') return view('down', 'kernel offline, the GLMPS Tap holds its port');
  if (reason.startsWith('port-conflict:')) return view('down', 'kernel offline, another program holds its port');
  if (reason.startsWith('remote-kernel')) return view('down', 'kernel offline (not on this machine)');
  if (reason.startsWith('gave-up')) return view('down', `kernel offline, gave up after ${snap.maxAttempts} tries`);
  return view('down', 'kernel offline');
}

export function describeStart(r) {
  return r.code == null ? r.reason : `${r.reason} (sc.exe ${r.code})`;
}

function hhmm(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function offlineView(snap, { kernelUrl, serviceName = SERVICE_NAME_DEFAULT, slackVisible = true }) {
  const reason = String(snap.reason ?? '');
  if (snap.state === 'checking') {
    return { headline: `Connecting to the ${PRODUCT_NAME} kernel`, lead: `Checking ${kernelUrl}`, rows: [], hint: null, command: null, nextCheckTs: null, actions: [], footer: null };
  }
  // The kernel has already answered: this is not a failure to explain, only a
  // page load still in flight (the normal gap on every launch and every
  // retry, between the supervisor reporting up and the dashboard's
  // did-finish-load). No retry/open-logs actions - there is nothing to retry
  // yet - and no countdown, since the next health poll is not what ends this.
  if (snap.state === 'up' || snap.state === 'degraded') {
    return { headline: `Loading the ${PRODUCT_NAME} dashboard`, lead: 'The kernel answered; the dashboard page is loading.', rows: [], hint: null, command: null, nextCheckTs: null, actions: [], footer: null };
  }
  const rows = [];
  if (snap.lastStart && !snap.lastStart.ok) rows.push(['Last error', describeStart(snap.lastStart)]);
  else if (snap.lastHealthReason) rows.push(['Last check', `no answer (${snap.lastHealthReason})`]);
  rows.push(['Kernel', kernelUrl]);
  if (snap.streakStartTs) rows.push(['Down since', hhmm(snap.streakStartTs)]);
  const base = { rows, hint: null, command: null, nextCheckTs: null, actions: ['retry', 'open-logs'],
    footer: slackVisible ? 'Slack keeps working in the other pane.' : null };
  // glmps-2-0-59: kernel-host.js reasons all start with 'embedded-', for the
  // bundled kernel and the checkout one alike.
  const bundled = String(snap.lastStart?.reason ?? '').startsWith('embedded-') || reason === 'gave-up:embedded-started';
  const lastReason = snap.lastStart?.reason;
  if (lastReason === 'embedded-missing' && (snap.state === 'starting' || reason.startsWith('gave-up'))) {
    return { ...base, headline: `The ${PRODUCT_NAME} kernel files are missing`, lead: 'The kernel files this app ships with are not on disk, so there is nothing to start. Antivirus may have quarantined them.', hint: `Reinstall ${PRODUCT_NAME}, or restore resources\\kernel from your antivirus quarantine, then Retry.`, nextCheckTs: snap.state === 'starting' ? snap.nextCheckTs : null };
  }
  if (lastReason === 'embedded-spawn-failed' && reason.startsWith('gave-up')) {
    return { ...base, headline: `The ${PRODUCT_NAME} kernel is offline`, lead: 'Windows would not start the kernel this app runs.', hint: 'Open the logs folder: shell.log says why.' };
  }
  if (snap.state === 'starting') {
    if (bundled) return { ...base, headline: `The ${PRODUCT_NAME} kernel is not answering`, lead: `Starting the kernel this app runs, try ${snap.attempts} of ${snap.maxAttempts}.`, nextCheckTs: snap.nextCheckTs };
    return { ...base, headline: `The ${PRODUCT_NAME} kernel is not answering`, lead: `Starting the ${serviceName} service, try ${snap.attempts} of ${snap.maxAttempts}.`, nextCheckTs: snap.nextCheckTs };
  }
  if (snap.state === 'refused' && reason === 'not-installed') {
    return { ...base, headline: `The ${serviceName} service is not installed`, lead: 'The shell starts the kernel service but never installs it.', hint: 'Install it once from an elevated terminal in the glmps folder:', command: INSTALL };
  }
  if (snap.state === 'refused' && reason === 'access-denied') {
    return { ...base, headline: `The ${PRODUCT_NAME} kernel is offline`, lead: `Windows refused to let this account start the ${serviceName} service (access denied).`, hint: 'Reinstall the service from an elevated terminal so it grants start rights to your account:', command: INSTALL };
  }
  if (snap.state === 'refused' && reason === 'disabled') {
    return { ...base, headline: `The ${serviceName} service is disabled`, lead: `Windows has the ${serviceName} service set to Disabled, so it cannot start.`, hint: 'Set it back to automatic from an elevated terminal:', command: `sc.exe config ${serviceName} start= auto` };
  }
  if (reason.startsWith('port-conflict:')) {
    const port = portOf(kernelUrl);
    if (reason === 'port-conflict:tap') {
      return { ...base, headline: `The GLMPS Tap is using port ${port}`,
        lead: `This computer also has the GLMPS Tap, the client agent that reports to another computer's kernel. It holds the port this app's kernel needs, so the kernel cannot start. To keep this computer a client instead, uninstall ${PRODUCT_NAME}.`,
        hint: `To run ${PRODUCT_NAME} here, uninstall the Tap from PowerShell, then click Retry:`, command: TAP_UNINSTALL };
    }
    return { ...base, headline: `Another program is using port ${port}`,
      lead: `Something else on this computer answers at ${kernelUrl} (${snap.lastHealthReason ?? 'not a kernel'}), so this app's kernel cannot start there.`,
      hint: 'Find it from PowerShell, close it, then click Retry:', command: `netstat -ano | findstr :${port}` };
  }
  if (reason.startsWith('remote-kernel')) {
    return { ...base, headline: `The ${PRODUCT_NAME} kernel is not answering`, lead: `The kernel at ${kernelUrl} is not on this machine, so the shell does not try to start it.`, hint: `Check the kernel URL in settings if this is not where ${PRODUCT_NAME} runs.` };
  }
  if (reason.startsWith('load-failed:')) {
    return { ...base, headline: 'The dashboard page did not load', lead: `The kernel answered, but loading the dashboard failed: ${reason.slice('load-failed:'.length)}.`, hint: 'Reload the view, or open the logs folder if this keeps happening.' };
  }
  if (reason.startsWith('gave-up') && bundled) {
    return { ...base, headline: `The ${PRODUCT_NAME} kernel is offline`, lead: `The kernel this app runs was started ${snap.maxAttempts} times and never answered.`, hint: 'Open the logs folder: kernel.log says why.' };
  }
  if (reason.startsWith('gave-up')) {
    return { ...base, headline: `The ${PRODUCT_NAME} kernel is offline`, lead: `The ${serviceName} service was started ${snap.maxAttempts} times and the kernel never answered.`, hint: 'The service log usually says why. Open the logs folder, or start it yourself from an elevated terminal:', command: `sc.exe start ${serviceName}` };
  }
  return { ...base, headline: `The ${PRODUCT_NAME} kernel is offline`, lead: reason ? `The shell could not reach the kernel (${reason}).` : 'The shell could not reach the kernel.', hint: 'Open the logs folder to see why.' };
}

// Card glmps-2-0-runtime-12: with the kernel inside the app, closing the
// window is safe and Quit or a sign-out is not; the notice says which.
export function closeNotice({ kernelOwned }) {
  return {
    title: `${PRODUCT_NAME} is still running in the tray`,
    body: kernelOwned
      ? 'The kernel keeps running with the window closed. Quit from the tray, or signing out, stops it: the nightly run, Slack approvals, deadlines and the merge queue then wait until the app runs again.'
      : 'Right-click the tray icon to quit the shell. The kernel keeps running either way.',
  };
}

export function trayMenuModel(statusViewResult, { slackVisible, closeToTray, launchAtLogin, canLaunchAtLogin, kernelOwned = false }) {
  return [
    { id: 'status', label: statusViewResult.menuStatus, enabled: false },
    { type: 'separator' },
    { id: 'show', label: 'Show window' },
    { id: 'reload', label: 'Reload views' },
    { id: 'open-logs', label: 'Open logs folder' },
    { id: 'run-setup', label: 'Run setup wizard' },
    { type: 'separator' },
    { id: 'toggle-slack', label: `Show Slack pane (${SHORTCUT_LABELS['toggle-slack']})`, type: 'checkbox', checked: slackVisible },
    { id: 'toggle-close-to-tray', label: 'Close button hides to tray', type: 'checkbox', checked: closeToTray },
    { id: 'toggle-launch-at-login', label: 'Run at startup', type: 'checkbox', checked: launchAtLogin, enabled: canLaunchAtLogin },
    { type: 'separator' },
    ...(kernelOwned ? [{ id: 'kernel-owned', label: 'Kernel runs in this app: stops on Quit or sign-out', enabled: false }] : []),
    { id: 'quit', label: kernelOwned ? 'Quit (stops the kernel)' : 'Quit shell (kernel keeps running)' },
  ];
}
