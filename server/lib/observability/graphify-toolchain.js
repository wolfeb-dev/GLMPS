// server/lib/observability/graphify-toolchain.js
// The graphify install itself: which launchers are running, waiting for none
// before uv touches the tool, and provisioning a pinned version on setup.
//
// WHY THE WAIT: on Windows a running graphify.exe (or graphify-mcp.exe) locks
// the launcher uv copies into ~/.local/bin. On 2026-10-23 `uv tool upgrade`
// upgraded the venv, then failed that copy (os error 32, exit 1), leaving a
// half-landed upgrade and a pending-rollback marker behind. POSIX has no such
// lock, so the list is empty there.
//
// No timers or spawns of its own: callers inject `runCmd`/`run`, `sleep` and
// `now`, so tests never touch a real process.

const LAUNCHER = /^graphify(-mcp)?\.exe$/i;

/** Parse `tasklist /FO CSV /NH` output into the graphify launchers it lists. */
export function parseGraphifyTasklist(stdout) {
  const out = [];
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const cols = line.match(/"([^"]*)"/g)?.map(c => c.slice(1, -1));
    if (!cols || cols.length < 2 || !LAUNCHER.test(cols[0])) continue;
    out.push({ image: cols[0], pid: Number(cols[1]) || null });
  }
  return out;
}

export async function listGraphifyProcesses({ runCmd, platform = process.platform }) {
  if (platform !== 'win32') return [];
  const res = await runCmd('tasklist', ['/FO', 'CSV', '/NH']);
  return res.code === 0 ? parseGraphifyTasklist(res.stdout) : [];
}

/**
 * Poll until no graphify launcher is running or maxWaitMs passes. Resolves
 * { idle: true } or { idle: false, processes } with the last ones seen.
 */
export async function waitForNoGraphifyProcess({
  list, maxWaitMs = 10 * 60 * 1000, pollMs = 15_000,
  sleep = (ms) => new Promise(r => setTimeout(r, ms).unref?.()), now = Date.now,
}) {
  const deadline = now() + maxWaitMs;
  for (;;) {
    const processes = await list();
    if (!processes.length) return { idle: true, processes };
    if (now() + pollMs > deadline) return { idle: false, processes };
    await sleep(pollMs);
  }
}

export const describeGraphifyProcesses = (processes) =>
  processes.map(p => `${p.image} pid ${p.pid ?? '?'}`).join(', ');

const versionOf = (stdout) => String(stdout || '').match(/(\d+\.\d+\.\d+)/)?.[1] ?? null;

/**
 * Setup-time provisioning. `run(cmd[])` is synchronous and returns
 * { status, stdout, stderr? } (chassis/deps.js defaultRun shape). Never
 * throws: graphify is an optional dependency, so every outcome is a report.
 * action: 'present' | 'installed' | 'installed-not-on-path' | 'uv-missing' | 'failed'
 */
export function provisionGraphify({ run, pinned = null }) {
  const safe = (cmd) => { try { return run(cmd); } catch (e) { return { status: 127, stdout: '', stderr: String(e?.message ?? e) }; } };
  const have = safe(['graphify', '--version']);
  if (have.status === 0) return { action: 'present', version: versionOf(have.stdout) };
  if (safe(['uv', '--version']).status !== 0) {
    return { action: 'uv-missing', version: null, detail: 'uv not found; install uv, then run: uv tool install graphifyy' + (pinned ? `==${pinned}` : '') };
  }
  const spec = pinned ? `graphifyy==${pinned}` : 'graphifyy';
  const install = safe(['uv', 'tool', 'install', spec]);
  if (install.status !== 0) {
    return { action: 'failed', version: null, detail: `uv tool install ${spec} exited ${install.status}: ${String(install.stderr || install.stdout || '').trim().slice(-500)}` };
  }
  const after = safe(['graphify', '--version']);
  if (after.status !== 0) {
    return { action: 'installed-not-on-path', version: pinned, detail: `installed ${spec}, but graphify is not on PATH; run: uv tool update-shell` };
  }
  return { action: 'installed', version: versionOf(after.stdout) };
}
