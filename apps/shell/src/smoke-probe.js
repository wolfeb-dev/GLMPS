// apps/shell/src/smoke-probe.js
// Dev-only self-checks, active only when main.js sees GLMPS_SHELL_SMOKE in an
// unpackaged run. Records openExternal instead of opening a browser.
import fs from 'node:fs';
import { BaseWindow, session } from 'electron';
import { PARTITIONS } from './shell-window.js';
import { createBoundedExec } from './lib/bounded-exec.js';

export function createSmokeProbe({ file }) {
  const opened = [];
  const checks = [];
  const check = (name, ok, detail = null) => checks.push({ name, ok: Boolean(ok), detail });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function waitFor(pred, ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await pred()) return true; await sleep(100); }
    return false;
  }
  // executeJavaScript against a webContents whose renderer just crashed can
  // sit pending indefinitely (Electron 44.4.5) rather than reject promptly,
  // which would defeat waitFor's own timeout: waitFor only checks its clock
  // between iterations, so one never-settling attempt hangs the whole probe,
  // not just that attempt. Bounding each individual call keeps a crashed
  // renderer's still-in-flight attempts from doing that.
  // the last failure is kept and put into the check's detail.
  const bounded = createBoundedExec();
  const tryExec = bounded.tryExec;
  const execDetail = (extra = {}) => ({ ...extra, lastExecError: bounded.lastError() });
  return {
    openExternal: async (url) => { opened.push(url); },
    exitCode: () => (checks.length && checks.every((c) => c.ok) ? 0 : 1),
    async run({ shellWin, kernel, writer }) {
      // the stub's control port (smoke-env.mjs); its kernel port refuses
      // connections while down, so it cannot carry these requests.
      const stubControl = process.env.GLMPS_SMOKE_STUB_CONTROL || kernel.url;
      try {
        // Phase A: launched with the stub kernel down and a service name that
        // does not exist, so sc.exe answers 1060 and the pane must explain it.
        const offlineShown = await waitFor(() => shellWin.state().supervisor?.state === 'refused', 20_000);
        check('with the kernel down, the supervisor reports the service as not installed', offlineShown, shellWin.state().supervisor);
        check('the offline page covers the dashboard pane (never blank)', shellWin.state().offlineVisible === true);
        const headline = await shellWin.views.offline.webContents.executeJavaScript('document.querySelector("h1").textContent');
        check('the offline page says the service is not installed', headline === 'The GLMPS_SMOKE_NO_SUCH_SERVICE service is not installed', headline);
        check('the offline page has no node integration', await shellWin.views.offline.webContents.executeJavaScript('typeof require === "undefined"') === true);
        // the window title comes from statusView, not a
        // hardcoded literal - checked here against an exact, deterministic string
        // (the 'refused'/'not-installed' branch has no timestamps or counters).
        check('the window title comes from statusView, not a hardcoded literal',
          shellWin.win.getTitle() === 'GLMPS 2.0: kernel service not installed', shellWin.win.getTitle());
        await fetch(new URL('/__stub/up', stubControl));
        await shellWin.retry();
        // the moment the supervisor reports
        // the kernel up, loadDashboard() kicks off a real page load that has not
        // necessarily finished yet - the offline page must say so, never "kernel
        // offline", while the kernel itself already answered. This is not racy:
        // pushOffline() is called synchronously inside the same up-transition
        // that retryNow()'s tick() awaits, and nothing pushes another
        // offline:state message until the next event (10 s away), so the text
        // is stable once delivered - only the IPC delivery itself needs a poll.
        let loadingHeadline = null;
        const sawLoading = await waitFor(async () => {
          loadingHeadline = await shellWin.views.offline.webContents.executeJavaScript('document.querySelector("h1").textContent');
          return loadingHeadline === 'Loading the GLMPS 2.0 dashboard';
        }, 5_000);
        check('while the kernel is up and the dashboard is still loading, the offline page says so, never "offline"', sawLoading, loadingHeadline);
        check('after the kernel comes up and Retry, the dashboard replaces the offline page', await waitFor(() => shellWin.state().offlineVisible === false, 20_000), shellWin.state().supervisor);

        const { views, win } = shellWin;
        const dash = views.dashboard.webContents;
        check('dashboard loaded the kernel page', await waitFor(() => !dash.isLoading() && dash.getURL().startsWith(kernel.origin), 20_000), dash.getURL());
        check('dashboard uses persist:glmps', dash.session === session.fromPartition(PARTITIONS.dashboard));
        check('slack uses persist:slack', views.slack.webContents.session === session.fromPartition(PARTITIONS.slack));
        check('dashboard has no node integration', await dash.executeJavaScript('typeof require === "undefined" && typeof process === "undefined"') === true);
        check('dashboard has no preload bridge', await dash.executeJavaScript('typeof window.glmpsSplitter === "undefined" && typeof window.glmpsOffline === "undefined"') === true);
        await dash.executeJavaScript('document.getElementById("ext").click()', true);
        check('an external link went to the system browser', await waitFor(() => opened.includes('https://example.com/outside'), 5_000), opened);
        check('no second window was created', BaseWindow.getAllWindows().length === 1, BaseWindow.getAllWindows().length);
        const { layout } = shellWin.state();
        const c = win.getContentBounds();
        check('the panes tile the content width', layout.dashboard.width + layout.splitter.width + layout.slack.width === c.width, { layout, c });

        // OVERLAY_DRAG z-order: 'splitter:start' is driven
        // through the real preload bridge, exactly as a genuine pointerdown
        // would, so this exercises the actual IPC path end to end.
        const nameOf = (v) => (v === views.dashboard ? 'dashboard' : v === views.slack ? 'slack' : v === views.splitter ? 'splitter' : 'unknown');
        await views.splitter.webContents.executeJavaScript('window.glmpsSplitter.start()', true);
        check('splitter:start is observed as a drag', await waitFor(() => shellWin.state().dragging === true, 2_000), shellWin.state());
        const stack = win.contentView.children;
        check('splitter:start raises the splitter view to the top of the z-order',
          stack.length > 0 && stack[stack.length - 1] === views.splitter, stack.map(nameOf));
        const contentDuringDrag = win.getContentBounds();
        const boundsDuringDrag = views.splitter.getBounds();
        check('splitter:start expands the splitter view to cover the window',
          boundsDuringDrag.x === 0 && boundsDuringDrag.y === 0
            && boundsDuringDrag.width === contentDuringDrag.width && boundsDuringDrag.height === contentDuringDrag.height,
          { boundsDuringDrag, contentDuringDrag });
        await views.splitter.webContents.executeJavaScript(`window.glmpsSplitter.end(${Math.round(contentDuringDrag.x + contentDuringDrag.width / 2)})`, true);
        check('splitter:end is observed as no longer dragging', await waitFor(() => shellWin.state().dragging === false, 2_000), shellWin.state());
        const boundsAfterEnd = views.splitter.getBounds();
        const stripAfterEnd = shellWin.state().layout.splitter;
        check('splitter:end returns the splitter view to the thin strip',
          Boolean(stripAfterEnd) && boundsAfterEnd.x === stripAfterEnd.x && boundsAfterEnd.width === stripAfterEnd.width && boundsAfterEnd.height === stripAfterEnd.height,
          { boundsAfterEnd, stripAfterEnd });

        // the stuck-drag gap. Start a second drag, then force a
        // window blur - the same as alt-tabbing away mid-drag, or the
        // pointer being released outside the window so 'splitter:end' never
        // arrives - and confirm endDrag()'s reset path fires: dragging
        // clears and the splitter view is back to its thin strip, not left
        // full-window and swallowing every click until restart.
        await views.splitter.webContents.executeJavaScript('window.glmpsSplitter.start()', true);
        check('a second drag starts (splitter:start observed)', await waitFor(() => shellWin.state().dragging === true, 2_000), shellWin.state());
        // win.emit('blur') runs every 'blur' listener synchronously and
        // returns only once they've all finished, so this is checked without
        // polling - deliberately, so the 2 s no-progress watchdog (a second,
        // independent path to the same endDrag()) can never race with or
        // mask a genuine failure here the way a multi-second waitFor would.
        win.emit('blur');
        check('a window blur mid-drag clears dragging synchronously, before any watchdog could', shellWin.state().dragging === false, shellWin.state());
        const boundsAfterBlur = views.splitter.getBounds();
        const stripAfterBlur = shellWin.state().layout.splitter;
        check('a window blur mid-drag returns the splitter view to the thin strip',
          Boolean(stripAfterBlur) && boundsAfterBlur.x === stripAfterBlur.x && boundsAfterBlur.width === stripAfterBlur.width && boundsAfterBlur.height === stripAfterBlur.height,
          { boundsAfterBlur, stripAfterBlur });

        shellWin.runShortcut('toggle-slack');
        check('Ctrl+Alt+S hides the Slack pane', shellWin.state().layout.slack === null);
        shellWin.runShortcut('toggle-slack');
        shellWin.runShortcut('swap-sides');
        check('Ctrl+Alt+X puts Slack on the left', shellWin.state().layout.slack.x === 0);
        shellWin.runShortcut('swap-sides');

        // a genuine renderer crash on the splitter
        // and the offline view must recover - reload and come back live - not
        // stay dark or stuck stale. forcefullyCrashRenderer is a real crash
        // (render-process-gone fires for real), not a synthetic emit.
        views.splitter.webContents.forcefullyCrashRenderer();
        check('a forced splitter crash reloads the page and its bridge comes back',
          await waitFor(async () => (await tryExec(views.splitter.webContents, 'typeof window.glmpsSplitter !== "undefined"')) === true, 15_000), execDetail());
        const barValue = await tryExec(views.splitter.webContents, 'document.getElementById("bar").getAttribute("aria-valuenow")');
        check('after a forced splitter crash, its ratio was resent to the reloaded page (not left stale)',
          barValue != null && Number(barValue) === Math.round(shellWin.state().ratio * 100), execDetail({ barValue }));

        views.offline.webContents.forcefullyCrashRenderer();
        check('a forced offline-view crash reloads the page and its bridge comes back',
          await waitFor(async () => (await tryExec(views.offline.webContents, 'typeof window.glmpsOffline !== "undefined"')) === true, 15_000), execDetail());

        // a stale loadFailure from an earlier broken
        // dashboard page must not shadow a fresh, successful navigation routed
        // there (e.g. a Slack link to the kernel). A real, unroutable address
        // forces a genuine did-fail-load first; will-navigate is then driven
        // directly (WebContents is an EventEmitter, like the existing
        // win.emit('blur') check above) to exercise the private to-dashboard
        // route the same way a real Slack link click would.
        await Promise.race([
          new Promise((resolve) => { dash.once('did-fail-load', resolve); dash.loadURL('http://127.0.0.1:1/'); }),
          sleep(5_000),
        ]);
        check('a real dashboard load failure shows the offline page with a load-failed reason',
          await waitFor(() => String(shellWin.effectiveSnapshot().reason ?? '').startsWith('load-failed:') && shellWin.state().offlineVisible === true, 5_000),
          shellWin.effectiveSnapshot());
        views.slack.webContents.emit('will-navigate', { url: kernel.url, preventDefault: () => {} });
        check('routing a Slack link to the dashboard clears the stale loadFailure; the dashboard replaces the offline page again',
          await waitFor(() => !dash.isLoading() && dash.getURL().startsWith(kernel.origin) && shellWin.state().offlineVisible === false, 20_000),
          shellWin.effectiveSnapshot());

        // a kernel that flaps up then down again
        // before the dashboard finishes loading must not leave the load timer
        // armed - left running, it would later fire and report
        // load-failed:timeout over this down state's own, truer reason.
        // GLMPS_SHELL_DASHBOARD_LOAD_TIMEOUT_MS (run-smoke.mjs) shortens the
        // real 20 s to 3 s for this whole run; hang-page keeps the dashboard's
        // page request pending indefinitely so a real page load can never
        // race the flap and clear the timer on its own - only
        // onSupervisor's own clear (the fix under test) can do it here.
        const hungCount = async () => (await (await fetch(new URL('/__stub/hung-count', stubControl))).json()).count;
        await fetch(new URL('/__stub/hang-page', stubControl));
        await fetch(new URL('/__stub/down', stubControl));
        await shellWin.retry();
        check('flap: the kernel going down is reported',
          await waitFor(() => !['up', 'degraded'].includes(shellWin.state().supervisor?.state), 5_000), shellWin.state().supervisor);
        await fetch(new URL('/__stub/up', stubControl));
        await shellWin.retry();
        check('flap: the kernel coming back up arms a fresh dashboard load (hung on the stub side)',
          await waitFor(() => ['up', 'degraded'].includes(shellWin.state().supervisor?.state), 5_000), shellWin.state().supervisor);
        // Wait for the dashboard's actual HTTP request to have reached the
        // stub and be genuinely parked there before flipping the kernel back
        // down: without this, the next /__stub/down below can win the race
        // against a request that has not arrived yet, destroying its
        // connection instead (a real, different failure - ERR_EMPTY_RESPONSE
        // - which clears the timer through the pre-existing, correct
        // did-fail-load path, silently proving nothing about the fix here).
        check('flap: the dashboard page request actually reached the stub and is parked there',
          await waitFor(async () => (await hungCount()) >= 1, 5_000));
        await fetch(new URL('/__stub/down', stubControl));
        await shellWin.retry();
        check('flap: the kernel going down again is reported before the hung dashboard load could ever finish',
          await waitFor(() => !['up', 'degraded'].includes(shellWin.state().supervisor?.state), 5_000), shellWin.state().supervisor);
        await sleep(3_500); // well past the 3 s shortened load timeout
        check('flap: a stale dashboard-load timer never overwrites the true down reason with load-failed:timeout',
          !String(shellWin.effectiveSnapshot().reason ?? '').startsWith('load-failed:timeout'), shellWin.effectiveSnapshot());
        await fetch(new URL('/__stub/resume-page', stubControl));
        await fetch(new URL('/__stub/up', stubControl));
        await shellWin.retry();
        check('flap: the dashboard recovers once the kernel and its page are both healthy again',
          await waitFor(() => shellWin.state().offlineVisible === false, 20_000), shellWin.state().supervisor);

        // Phase C: the status surface.
        check('the title bar shows kernel status, obligations and event age',
          /^GLMPS 2\.0: kernel up, 2 open obligations, last event \d+ (s|min) ago$/.test(win.getTitle()), win.getTitle());
        win.close();
        await sleep(300);
        check('closing the window hides it to the tray; the shell keeps running', !win.isDestroyed() && !win.isVisible());
        win.show();

        // a --hidden (launch-at-login)
        // start must never show the window while applying the persisted
        // maximized preference (win.maximize() shows the window as a
        // documented side effect - base-window.md - so it cannot be called
        // during the hidden phase); the first real reveal (a tray click or a
        // second instance) is what applies it, via the same showWindow() both
        // paths now share.
        win.hide();
        writer.update({ maximized: true });
        shellWin.prepareHidden();
        check('prepareHidden lays out the panes without ever showing the window',
          win.isVisible() === false, { visible: win.isVisible(), maximized: win.isMaximized() });
        shellWin.showWindow();
        check('showWindow then reveals the window already maximized, per the persisted setting',
          win.isVisible() === true && win.isMaximized() === true, { visible: win.isVisible(), maximized: win.isMaximized() });
        win.unmaximize();
        writer.update({ maximized: false });
      } catch (e) {
        check('the probe ran without throwing', false, e.stack || e.message);
      } finally {
        fs.writeFileSync(file, JSON.stringify({ checks }, null, 2));
      }
    },
  };
}
