// apps/shell/test/status-format.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatAge, obligationsPhrase, statusView, offlineView, trayMenuModel, describeStart, closeNotice, hungNotice } from '../src/lib/status-format.js';

const NOW = 1_800_000_000_000;
const snap = (over) => ({ state: 'checking', reason: null, attempts: 0, maxAttempts: 5, streakStartTs: null, lastHealth: null, lastHealthReason: null, lastStart: null, nextCheckTs: null, ...over });
const K = 'http://127.0.0.1:8124/';

test('formatAge and obligationsPhrase', () => {
  assert.equal(formatAge(42_000), '42 s ago');
  assert.equal(formatAge(3 * 60_000 + 5_000), '3 min ago');
  assert.equal(formatAge(5 * 3_600_000), '5 h ago');
  assert.equal(formatAge(50 * 3_600_000), '2 d ago');
  assert.equal(formatAge(-5), '0 s ago');
  assert.equal(formatAge(null), null);
  assert.equal(obligationsPhrase(1), '1 open obligation');
  assert.equal(obligationsPhrase(3), '3 open obligations');
  assert.equal(obligationsPhrase(null), 'obligations unknown');
});

test('title when the kernel is up: status, obligation count from /healthz, time since the last event', () => {
  const v = statusView(snap({ state: 'up', lastHealth: { status: 'up', open_obligations: 3, last_event_ts: NOW - 125_000 } }), { now: NOW });
  assert.equal(v.title, 'GLMPS 2.0: kernel up, 3 open obligations, last event 2 min ago');
  assert.equal(v.level, 'up');
  assert.equal(v.trayIcon, 'tray-up');
  assert.equal(v.menuStatus, 'Kernel up, 3 open obligations, last event 2 min ago');
});

test('degraded and a kernel with no events yet', () => {
  const v = statusView(snap({ state: 'degraded', lastHealth: { status: 'degraded', open_obligations: 0, last_event_ts: null } }), { now: NOW });
  assert.equal(v.title, 'GLMPS 2.0: kernel degraded, 0 open obligations, no events yet');
  assert.equal(v.trayIcon, 'tray-degraded');
});

test('every down state has its own words and the down icon; the title prefix is the human-facing "GLMPS 2.0"', () => {
  const t = (over) => statusView(snap(over), { now: NOW }).title;
  assert.equal(t({ state: 'checking' }), 'GLMPS 2.0: checking the kernel');
  assert.equal(t({ state: 'starting', attempts: 2 }), 'GLMPS 2.0: kernel down, starting it (try 2 of 5)');
  assert.equal(t({ state: 'refused', reason: 'access-denied' }), 'GLMPS 2.0: kernel offline, start refused (access denied)');
  assert.equal(t({ state: 'refused', reason: 'not-installed' }), 'GLMPS 2.0: kernel service not installed');
  assert.equal(t({ state: 'refused', reason: 'disabled' }), 'GLMPS 2.0: kernel offline, service disabled');
  assert.equal(t({ state: 'offline', reason: 'gave-up:start-requested' }), 'GLMPS 2.0: kernel offline, gave up after 5 tries');
  assert.equal(t({ state: 'offline', reason: 'remote-kernel:timeout' }), 'GLMPS 2.0: kernel offline (not on this machine)');
  assert.equal(t({ state: 'offline', reason: 'load-failed:ERR_CONNECTION_RESET' }), 'GLMPS 2.0: dashboard page failed to load');
  assert.equal(statusView(snap({ state: 'offline', reason: 'supervisor-error:x' }), { now: NOW }).trayIcon, 'tray-down');
});

test('the tray tooltip never exceeds the 127-character Windows limit', () => {
  const v = statusView(snap({ state: 'refused', reason: 'x'.repeat(300) }), { now: NOW });
  assert.ok(v.tooltip.length <= 127);
  assert.ok(v.tooltip.endsWith('...'));
});

test('offline page: starting shows the try count and a countdown target; headline names the kernel as "GLMPS 2.0", lead names the Windows service as "GLMPS2"', () => {
  const o = offlineView(snap({ state: 'starting', attempts: 2, nextCheckTs: NOW + 4000, lastHealthReason: 'unreachable', streakStartTs: NOW - 60_000 }), { kernelUrl: K });
  assert.equal(o.headline, 'The GLMPS 2.0 kernel is not answering');
  assert.equal(o.lead, 'Starting the GLMPS2 service, try 2 of 5.');
  assert.equal(o.nextCheckTs, NOW + 4000);
  assert.deepEqual(o.rows[0], ['Last check', 'no answer (unreachable)']);
  assert.deepEqual(o.rows[1], ['Kernel', K]);
  assert.equal(o.rows[2][0], 'Down since');
  assert.match(o.rows[2][1], /^\d{2}:\d{2}$/);
  assert.deepEqual(o.actions, ['retry', 'open-logs']);
  assert.equal(o.footer, 'Slack keeps working in the other pane.');
});

test('offline page: access denied names the error and the fix; headline names the kernel, lead and command name the service', () => {
  const o = offlineView(snap({ state: 'refused', reason: 'access-denied', lastStart: { ok: false, code: 5, reason: 'access-denied' } }), { kernelUrl: K });
  assert.equal(o.headline, 'The GLMPS 2.0 kernel is offline');
  assert.match(o.lead, /refused to let this account start the GLMPS2 service/);
  assert.deepEqual(o.rows[0], ['Last error', 'access-denied (sc.exe 5)']);
  assert.equal(o.command, 'node scripts/service/install-service.mjs');
});

test('offline page: not installed and disabled headlines name the Windows service, not the "GLMPS 2.0" brand', () => {
  const o = (over, opts = {}) => offlineView(snap(over), { kernelUrl: K, ...opts });
  assert.equal(o({ state: 'refused', reason: 'not-installed' }).headline, 'The GLMPS2 service is not installed');
  const disabled = o({ state: 'refused', reason: 'disabled' });
  assert.equal(disabled.headline, 'The GLMPS2 service is disabled');
  assert.equal(disabled.command, 'sc.exe config GLMPS2 start= auto');
});

test('offline page: gave up names the kernel in the headline and the service in the lead and command', () => {
  const gave = offlineView(snap({ state: 'offline', reason: 'gave-up:start-requested' }), { kernelUrl: K, serviceName: 'GLMPS2' });
  assert.equal(gave.headline, 'The GLMPS 2.0 kernel is offline');
  assert.equal(gave.lead, 'The GLMPS2 service was started 5 times and the kernel never answered.');
  assert.equal(gave.command, 'sc.exe start GLMPS2');
});

test('offline page: a remote kernel gets its own headline, lead and a hint to check the settings', () => {
  const o = offlineView(snap({ state: 'offline', reason: 'remote-kernel:timeout' }), { kernelUrl: K });
  assert.equal(o.headline, 'The GLMPS 2.0 kernel is not answering');
  assert.match(o.lead, /not on this machine/);
  assert.equal(o.hint, 'Check the kernel URL in settings if this is not where GLMPS 2.0 runs.');
  assert.equal(o.command, null);
});

test('offline page: a failed dashboard load gets a hint to reload or check the logs', () => {
  const o = offlineView(snap({ state: 'offline', reason: 'load-failed:ERR_FAILED' }), { kernelUrl: K });
  assert.equal(o.headline, 'The dashboard page did not load');
  assert.equal(o.lead, 'The kernel answered, but loading the dashboard failed: ERR_FAILED.');
  assert.equal(o.hint, 'Reload the view, or open the logs folder if this keeps happening.');
});

test('offline page: an unrecognised offline reason still gets the "GLMPS 2.0" headline and a hint to check the logs', () => {
  const o = offlineView(snap({ state: 'offline', reason: 'supervisor-error:boom' }), { kernelUrl: K });
  assert.equal(o.headline, 'The GLMPS 2.0 kernel is offline');
  assert.equal(o.lead, 'The shell could not reach the kernel (supervisor-error:boom).');
  assert.equal(o.hint, 'Open the logs folder to see why.');
});

test('offline page: checking has no brand-name conflict, no actions and no footer', () => {
  const c = offlineView(snap({ state: 'checking' }), { kernelUrl: K });
  assert.equal(c.headline, 'Connecting to the GLMPS 2.0 kernel');
  assert.deepEqual(c.actions, []);
  assert.equal(offlineView(snap({ state: 'starting', attempts: 1 }), { kernelUrl: K, slackVisible: false }).footer, null);
});

test('offline page: while the kernel is up/degraded and the dashboard has not finished loading, the page says so, never "offline", and offers no retry/logs actions', () => {
  const up = offlineView(snap({ state: 'up', lastHealth: { status: 'up', open_obligations: 0, last_event_ts: NOW } }), { kernelUrl: K });
  assert.equal(up.headline, 'Loading the GLMPS 2.0 dashboard');
  assert.doesNotMatch(up.lead, /offline/i);
  assert.deepEqual(up.actions, []);
  assert.equal(up.nextCheckTs, null);
  assert.equal(up.hint, null);
  assert.equal(up.command, null);
  const degraded = offlineView(snap({ state: 'degraded', lastHealth: { status: 'degraded', open_obligations: 0, last_event_ts: NOW } }), { kernelUrl: K });
  assert.equal(degraded.headline, 'Loading the GLMPS 2.0 dashboard');
});

test('offline page: serviceName defaults to GLMPS2 when the caller does not pass one', () => {
  const o = offlineView(snap({ state: 'starting', attempts: 1 }), { kernelUrl: K });
  assert.equal(o.lead, 'Starting the GLMPS2 service, try 1 of 5.');
});

test('describeStart', () => {
  assert.equal(describeStart({ ok: false, code: 5, reason: 'access-denied' }), 'access-denied (sc.exe 5)');
  assert.equal(describeStart({ ok: false, code: null, reason: 'sc-timeout' }), 'sc-timeout');
});

test('tray menu: the quit item says the kernel keeps running; toggles reflect settings', () => {
  const v = statusView(snap({ state: 'up', lastHealth: { status: 'up', open_obligations: 1, last_event_ts: NOW } }), { now: NOW });
  const m = trayMenuModel(v, { slackVisible: true, closeToTray: false, launchAtLogin: true, canLaunchAtLogin: false });
  const byId = Object.fromEntries(m.filter((i) => i.id).map((i) => [i.id, i]));
  assert.equal(byId.status.label, 'Kernel up, 1 open obligation, last event 0 s ago');
  assert.equal(byId.status.enabled, false);
  assert.deepEqual(['show', 'reload', 'open-logs', 'run-setup'].map((id) => byId[id].label), ['Show window', 'Reload views', 'Open logs folder', 'Run setup wizard']);
  assert.equal(byId['toggle-slack'].checked, true);
  assert.equal(byId['toggle-slack'].label, 'Show Slack pane (Ctrl+Alt+S)');
  assert.equal(byId['toggle-close-to-tray'].checked, false);
  assert.equal(byId['toggle-launch-at-login'].enabled, false);
  assert.equal(byId['toggle-launch-at-login'].label, 'Run at startup');
  assert.equal(byId['kernel-owned'], undefined, 'no in-app line while the service runs the kernel');
  assert.equal(m.at(-1).label, 'Quit shell (kernel keeps running)');
});

// glmps-2-0-59: with no service installed the shell runs the bundled kernel
// itself, so the copy must stop talking about a service and must not promise
// the kernel outlives Quit.
test('bundled kernel: the offline page names the bundled kernel, not the service', () => {
  const starting = offlineView(snap({ state: 'starting', attempts: 2, lastStart: { ok: true, code: null, reason: 'embedded-started' } }), { kernelUrl: K });
  assert.equal(starting.lead, 'Starting the kernel this app runs, try 2 of 5.');
  const gave = offlineView(snap({ state: 'offline', reason: 'gave-up:embedded-started' }), { kernelUrl: K });
  assert.equal(gave.lead, 'The kernel this app runs was started 5 times and never answered.');
  assert.equal(gave.hint, 'Open the logs folder: kernel.log says why.');
  assert.equal(gave.command, null);
  const missing = offlineView(snap({ state: 'starting', attempts: 1, lastStart: { ok: false, code: null, reason: 'embedded-missing' } }), { kernelUrl: K });
  assert.deepEqual(missing.rows[0], ['Last error', 'embedded-missing']);
});

// Card glmps-2-0-214: missing kernel files and a refused spawn each say what
// happened and a step an installed app's user can take; neither names the
// service or a command run from a source folder.
test('bundled kernel: missing files and a failed spawn name a step that works without a source checkout', () => {
  const missingLead = 'The kernel files this app ships with are not on disk, so there is nothing to start. Antivirus may have quarantined them.';
  const missingHint = 'Reinstall GLMPS 2.0, or restore resources\\kernel from your antivirus quarantine, then Retry.';
  for (const s of [
    snap({ state: 'starting', attempts: 1, lastStart: { ok: false, code: null, reason: 'embedded-missing' } }),
    snap({ state: 'offline', reason: 'gave-up:embedded-missing', lastStart: { ok: false, code: null, reason: 'embedded-missing' } }),
  ]) {
    const v = offlineView(s, { kernelUrl: K });
    assert.equal(v.headline, 'The GLMPS 2.0 kernel files are missing');
    assert.equal(v.lead, missingLead);
    assert.equal(v.hint, missingHint);
    assert.equal(v.command, null);
  }
  assert.equal(statusView(snap({ state: 'starting', attempts: 1, lastStart: { ok: false, code: null, reason: 'embedded-missing' } }), { now: NOW }).menuStatus, 'Kernel files missing, reinstall GLMPS 2.0');
  const spawn = offlineView(snap({ state: 'offline', reason: 'gave-up:embedded-spawn-failed', lastStart: { ok: false, code: null, reason: 'embedded-spawn-failed' } }), { kernelUrl: K });
  assert.equal(spawn.lead, 'Windows would not start the kernel this app runs.');
  assert.equal(spawn.hint, 'Open the logs folder: shell.log says why.');
  assert.equal(spawn.command, null);
});

test('bundled kernel: Quit says it stops the kernel', () => {
  const v = statusView(snap({ state: 'up', lastHealth: { status: 'up', open_obligations: 0, last_event_ts: NOW } }), { now: NOW });
  const m = trayMenuModel(v, { slackVisible: true, closeToTray: false, launchAtLogin: false, canLaunchAtLogin: false, kernelOwned: true });
  assert.equal(m.at(-1).label, 'Quit (stops the kernel)');
  const owned = m.find((i) => i.id === 'kernel-owned');
  assert.equal(owned.label, 'Kernel runs in this app: stops on Quit or sign-out');
  assert.equal(owned.enabled, false);
  assert.ok(m.indexOf(owned) < m.length - 1);
});

// Card glmps-2-0-runtime-12: the close notice names what pauses.
test('close notice: an in-app kernel names what stops on Quit and sign-out; a service kernel keeps running', () => {
  const own = closeNotice({ kernelOwned: true });
  assert.equal(own.title, 'GLMPS 2.0 is still running in the tray');
  assert.equal(own.body, 'The kernel keeps running with the window closed. Quit from the tray, or signing out, stops it: the nightly run, Slack approvals, deadlines and the merge queue then wait until the app runs again.');
  assert.equal(closeNotice({ kernelOwned: false }).body, 'Right-click the tray icon to quit the shell. The kernel keeps running either way.');
});

// Card glmps-2-0-214: the new machine's GLMPS Tap held the kernel port. The
// page names the Tap, the port, and both ways out; it never tells the user to
// restart a service the machine does not have.
test('port conflict: the Tap and another program each get their own copy and a way out', () => {
  const tap = offlineView(snap({ state: 'offline', reason: 'port-conflict:tap', lastHealthReason: 'http-403' }), { kernelUrl: 'http://127.0.0.1:8123/' });
  assert.equal(tap.headline, 'The GLMPS Tap is using port 8123');
  assert.equal(tap.lead, 'This computer also has the GLMPS Tap, the client agent that reports to another computer\'s kernel. It holds the port this app\'s kernel needs, so the kernel cannot start. To keep this computer a client instead, uninstall GLMPS 2.0.');
  assert.equal(tap.hint, 'To run GLMPS 2.0 here, uninstall the Tap from PowerShell, then click Retry:');
  assert.equal(tap.command, '& "$env:LOCALAPPDATA\\GLMPS\\tap\\node.exe" "$env:LOCALAPPDATA\\GLMPS\\tap\\taps\\tap-setup.mjs" --uninstall');
  assert.deepEqual(tap.actions, ['retry', 'open-logs']);
  assert.equal(statusView(snap({ state: 'offline', reason: 'port-conflict:tap' }), { now: NOW }).menuStatus, 'Kernel offline, the GLMPS Tap holds its port');
  const other = offlineView(snap({ state: 'offline', reason: 'port-conflict:other', lastHealthReason: 'http-404' }), { kernelUrl: K });
  assert.equal(other.headline, 'Another program is using port 8124');
  assert.equal(other.lead, 'Something else on this computer answers at http://127.0.0.1:8124/ (http-404), so this app\'s kernel cannot start there.');
  assert.equal(other.hint, 'Find it from PowerShell, close it, then click Retry:');
  assert.equal(other.command, 'netstat -ano | findstr :8124');
  assert.equal(statusView(snap({ state: 'offline', reason: 'port-conflict:other' }), { now: NOW }).menuStatus, 'Kernel offline, another program holds its port');
});

test('hung notice: the app that runs its own kernel says restart the app, not the service', () => {
  assert.equal(hungNotice({ kernelOwned: true }), 'The kernel is running but has not answered for 5 minutes. It may be hung; quit GLMPS 2.0 from the tray and start it again.');
  assert.equal(hungNotice({ kernelOwned: false }), 'The kernel is running but has not answered for 5 minutes. It may be hung; restart the GLMPS2 service.');
});

test('a stale embedded-missing start does not outrank a later port conflict: tray and offline page agree (glmps-2-0-221)', () => {
  const stale = { ok: false, code: null, reason: 'embedded-missing' };
  for (const [reason, menu, headline] of [
    ['port-conflict:tap', 'Kernel offline, the GLMPS Tap holds its port', 'The GLMPS Tap is using port 8124'],
    ['port-conflict:other', 'Kernel offline, another program holds its port', 'Another program is using port 8124'],
  ]) {
    const s = snap({ state: 'offline', reason, lastStart: stale, lastHealthReason: 'http-403' });
    assert.equal(statusView(s, { now: NOW }).menuStatus, menu);
    assert.equal(offlineView(s, { kernelUrl: K }).headline, headline);
  }
  const gaveUp = snap({ state: 'offline', reason: 'gave-up:embedded-missing', lastStart: stale });
  assert.equal(statusView(gaveUp, { now: NOW }).menuStatus, 'Kernel files missing, reinstall GLMPS 2.0');
  assert.equal(offlineView(gaveUp, { kernelUrl: K }).headline, 'The GLMPS 2.0 kernel files are missing');
});
