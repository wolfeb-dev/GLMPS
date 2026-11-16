// Stands in for the WinSW wrapper: starts a child that watches its parent,
// prints the child's pid once the child says its watch is armed, then idles
// until the test kills it. detached, because on Windows libuv otherwise puts
// the child in a kill-on-close job and it dies with us; WinSW (.NET
// Process.Start) uses no job, which is how the real server outlived its
// wrapper. Waiting for "ready" matters on Linux: a parent killed before the
// child read its ppid leaves the child reparented to pid 1, watching that.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const child = spawn(process.execPath, [fileURLToPath(new URL('./parent-watch-child.mjs', import.meta.url)), ...process.argv.slice(2)], { stdio: ['ignore', 'pipe', 'ignore'], detached: true });
child.unref();
let said = '';
child.stdout.on('data', (d) => {
  said += d;
  if (/ready/.test(said)) {
    child.stdout.destroy();
    console.log(String(child.pid));
  }
});
setInterval(() => {}, 60_000);
