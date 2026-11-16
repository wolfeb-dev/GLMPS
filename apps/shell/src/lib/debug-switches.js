// apps/shell/src/lib/debug-switches.js
// Task 15, L2 (security review): Chromium honours --remote-debugging-port and
// --remote-debugging-pipe from the command line in a packaged build too, which
// would hand DevTools-protocol control of the dashboard and Slack sessions to
// anything able to start the exe with one extra argument. (The
// enableNodeCliInspectArguments fuse covers --inspect, not these.) A packaged
// build refuses to start with either; dev builds keep them (main.js's own
// GLMPS_SHELL_DEBUG_PORT path appends one on purpose).
const REFUSED = ['remote-debugging-port', 'remote-debugging-pipe'];
// Chromium on Windows accepts `--`, `-` and `/` as switch prefixes and
// compares switch names case-insensitively.
const SWITCH_RE = /^(?:--|-|\/)(remote-debugging-(?:port|pipe))(?:=|$)/i;

// Returns the refused switch name, or null when the start may proceed.
// hasSwitch is app.commandLine.hasSwitch (Chromium's own parsed view), a
// second source alongside the raw argv.
export function refusedDebugSwitch({ isDev, argv = [], hasSwitch = () => false }) {
  if (isDev) return null;
  for (const a of argv.slice(1)) {
    const m = SWITCH_RE.exec(String(a));
    if (m) return m[1].toLowerCase();
  }
  for (const name of REFUSED) if (hasSwitch(name)) return name;
  return null;
}
