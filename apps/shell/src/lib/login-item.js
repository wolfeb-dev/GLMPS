// apps/shell/src/lib/login-item.js
// Whether the shell should rewrite the Windows Run-key login item this
// launch. Pure: the read (app.getLoginItemSettings) and the write
// (app.setLoginItemSettings) both stay in main.js, which is not a pure
// module (it imports electron); this is only the decision between them.
//
// getLoginItemSettings()'s openAtLogin compares against the args it is
// called with (empty by default, per app.md) - it would have to be called
// with { args: ['--hidden'] } to match the entry setLaunchAtLogin actually
// writes, or it always reads as a mismatch and reconciles on every launch.
// executableWillLaunchAtLogin sidesteps that entirely: it ignores args and
// reports whether the executable would launch at login with any arguments,
// which is exactly what this app's own single managed Run-key entry needs.
export function shouldReconcileLoginItem({ canLaunchAtLogin, desired, current }) {
  return Boolean(canLaunchAtLogin) && Boolean(current) !== Boolean(desired);
}
