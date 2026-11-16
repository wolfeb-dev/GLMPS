// Kills every process whose command line names one of the given directories.
// The shadow-instance tests spawn a detached supervisor plus the server it
// supervises; both carry a unique mkdtemp dir on their command line, so that
// is the one handle that still works when a test failed, timed out, or never
// learned the pid (runStart gave up waiting but the supervisor started anyway).
// Matching on those dirs means it can only ever touch processes this test file
// created, never another run's or the live 2.0 instance.
import { execFileSync } from 'node:child_process';

const PS_LIST = `
$dirs = ($env:GLMPS_SWEEP_DIRS | ConvertFrom-Json)
Get-CimInstance Win32_Process | Where-Object {
  $cl = $_.CommandLine
  if (-not $cl -or $_.ProcessId -eq ${process.pid}) { return $false }
  foreach ($d in $dirs) { if ($cl.IndexOf($d, [StringComparison]::OrdinalIgnoreCase) -ge 0) { return $true } }
  return $false
} | ForEach-Object { $_.ProcessId }
`;

export function listMatching(dirs) {
  const env = { ...process.env, GLMPS_SWEEP_DIRS: JSON.stringify(dirs) };
  if (process.platform === 'win32') {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS_LIST],
      { encoding: 'utf-8', windowsHide: true, env, timeout: 30000 });
    return out.split(/\r?\n/).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  }
  const out = execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf-8', timeout: 30000 });
  const pids = [];
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (m && Number(m[1]) !== process.pid && dirs.some((d) => m[2].includes(d))) pids.push(Number(m[1]));
  }
  return pids;
}

function killPid(pid) {
  try {
    if (process.platform === 'win32') {
      // /T takes the supervisor's server with it even if the pid list was stale.
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 15000 });
    } else {
      process.kill(pid, 'SIGKILL');
    }
  } catch { /* already gone */ }
}

// Repeats because a supervisor that is still starting can spawn its server
// between the listing and the kill.
export function sweepSpawned(dirs) {
  if (!dirs.length) return 0;
  let killed = 0;
  for (let pass = 0; pass < 5; pass++) {
    let pids;
    try { pids = listMatching(dirs); } catch { return killed; }
    if (!pids.length) return killed;
    for (const pid of pids) { killPid(pid); killed++; }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
  }
  return killed;
}
