// Small text and checkout/process helpers shared by the merge queue and main-suite loop.
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';

export const short = (sha) => String(sha ?? '').slice(0, 7);
export const errText = (e) => String(e?.message ?? e ?? 'unknown error');

export const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
export const TAIL_CHARS = 4000;

/** "owner/name" (lowercase) from an https or ssh GitHub remote URL, else null. */
export function parseRemote(url) {
  if (typeof url !== 'string') return null;
  const m = /^(?:https?:\/\/(?:[^@/]+@)?|ssh:\/\/(?:[^@/]+@)?|[^@/\s]+@)github\.com[/:]([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null;
}

export function remoteMatchesRepo(url, repo) {
  const got = parseRemote(url);
  return !!got && got === String(repo ?? '').toLowerCase();
}

export function findCheckout({ repo, roots = [], remoteOf, override = null }) {
  if (override?.path) return override.path;
  for (const root of roots) {
    let url = null;
    try { url = remoteOf(root); } catch { url = null; }
    if (remoteMatchesRepo(url, repo)) return root;
  }
  return null;
}

export function resolveTestCommand({ override = null, pkg = null } = {}) {
  const timeoutMs = Number.isFinite(override?.timeoutMs) && override.timeoutMs > 0 ? override.timeoutMs : DEFAULT_TIMEOUT_MS;
  if (typeof override?.test === 'string' && override.test.trim()) return { command: override.test.trim(), timeoutMs };
  const script = pkg?.scripts?.test;
  if (typeof script === 'string' && script.trim() && !/no test specified/i.test(script)) return { command: 'npm test', timeoutMs };
  for (const name of ['build', 'lint']) {
    const s = pkg?.scripts?.[name];
    if (typeof s === 'string' && s.trim()) return { command: `npm run ${name}`, timeoutMs, fallback: name };
  }
  return { command: null, timeoutMs };
}

export function workDirFor(worktreesDir, id) {
  return path.join(worktreesDir, 'merge-queue', String(id).replace(/[^A-Za-z0-9._-]/g, '_'));
}

export function defaultGit(args, { cwd } = {}) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ status: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: stdout ?? '', stderr: stderr || (err ? errText(err) : '') });
    });
  });
}

function killTree(child) {
  return new Promise((resolve) => {
    try {
      if (process.platform === 'win32' && child.pid) {
        const k = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
        k.on('error', resolve); k.on('close', resolve);
      } else { child.kill('SIGKILL'); resolve(); }
    } catch { resolve(); }
  });
}

export function defaultRunTest({ command, cwd, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    let buf = '';
    let done = false;
    let timedOut = false;
    let child;
    try { child = spawn(command, { cwd, shell: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { reject(e); return; }
    const take = (d) => { buf = (buf + d.toString()).slice(-TAIL_CHARS * 2); };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ...r, tail: buf.slice(-TAIL_CHARS), durationMs: Date.now() - started });
    };
    const timer = setTimeout(() => { timedOut = true; killTree(child).then(() => finish({ exitCode: null, timedOut: true })); }, timeoutMs);
    child.on('error', (e) => { if (!done) { done = true; clearTimeout(timer); reject(e); } });
    child.on('close', (code) => finish(timedOut ? { exitCode: null, timedOut: true } : { exitCode: code, timedOut: false }));
  });
}
