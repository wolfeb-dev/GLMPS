// server/lib/orchestration/graphify-spawn.js
// the ONE way the kernel runs `graphify update <root>`. The binary is
// spawned directly (shell:false), so a root path containing shell
// metacharacters is just an argument. There is no shell fallback: an
// unresolved binary fails the rebuild by name (code 127).
import { spawn as nodeSpawn, execFile } from 'node:child_process';
import { killProcessTree } from '../plugins/claude-model.js';

// One budget for every `graphify update`: a kernel rebuild on a new graphify
// version ran 13 to 23 minutes on 2026-11-03, so 10 minutes killed real work.
export const GRAPHIFY_UPDATE_TIMEOUT_MS = 45 * 60_000;

// The timeout is ours, not spawn's: spawn's `timeout` signals only
// graphify.exe, the uv launcher, and the python rebuild under it ran on for
// about 23 minutes after the caller had given up and released the root's lock.
export async function spawnGraphifyUpdateWith({ resolveBin, spawnImpl = nodeSpawn, killTree = (c) => killProcessTree(c, process.platform) }, root, { timeout = GRAPHIFY_UPDATE_TIMEOUT_MS, env } = {}) {
  const bin = await resolveBin();
  return new Promise((res) => {
    if (!bin) {
      res({ code: 127, stdout: '', stderr: 'graphify update refused: no graphify binary on PATH (the shell fallback was removed, F23; a lone .cmd/.bat shim is not spawnable without a shell)' });
      return;
    }
    let child;
    try { child = spawnImpl(bin, ['update', root], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...(env ? { env } : {}) }); }
    catch (e) { res({ code: 1, stdout: '', stderr: String(e?.message ?? e) }); return; }
    let stdout = ''; let stderr = ''; let timedOut = false; let done = false;
    const finish = (r) => { if (done) return; done = true; clearTimeout(timer); res(r); };
    const timer = setTimeout(() => {
      timedOut = true;
      Promise.resolve().then(() => killTree(child)).catch(() => {});
    }, timeout);
    child.stdout?.on('data', (d) => { stdout += d; });
    child.stderr?.on('data', (d) => { stderr += d; });
    child.on('close', (code) => finish(timedOut
      ? { code: null, stdout, stderr: `${stderr}${stderr ? '\n' : ''}graphify update timed out after ${Math.round(timeout / 1000)} s; process tree killed`, timedOut: true }
      : { code, stdout, stderr }));
    child.on('error', (err) => finish({ code: 1, stdout: '', stderr: String(err?.message ?? err) }));
  });
}

// Async so a ticket-creation request never waits on `where`/`which`. A hit is
// cached; a miss is not, so a graphify installed after boot is found on the
// next call, and concurrent callers share one in-flight probe. On win32 only a real .exe is spawnable without a shell; a .cmd or
// .bat shim alone counts as unresolved.
export function createGraphifyResolver({
  platform = process.platform,
  exec = (finder) => new Promise((resolve, reject) => {
    execFile(finder, ['graphify'], { encoding: 'utf-8', windowsHide: true, timeout: 10_000 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  }),
} = {}) {
  let hit = null;
  let inflight = null;
  return function resolveGraphifyBin() {
    if (hit) return Promise.resolve(hit);
    inflight ??= (async () => {
      try {
        const lines = String((await exec(platform === 'win32' ? 'where' : 'which')) ?? '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
        const pick = platform === 'win32' ? lines.find((l) => /\.exe$/i.test(l)) : lines[0];
        if (pick) hit = pick;
      } catch { /* a miss is reported by the caller by name */ }
      return hit;
    })().finally(() => { inflight = null; });
    return inflight;
  };
}

export const resolveGraphifyBin = createGraphifyResolver();

export async function runGraphifyWith({ resolveBin, runCmd }, args) {
  const bin = await resolveBin();
  return bin
    ? runCmd(bin, args)
    : ({ code: 127, stdout: '', stderr: 'graphify refused: no graphify binary on PATH (the shell fallback was removed, F23; a lone .cmd/.bat shim is not spawnable without a shell)' });
}
