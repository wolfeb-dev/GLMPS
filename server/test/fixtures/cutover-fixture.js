// server/test/fixtures/cutover-fixture.js
// Scratch layout for the cutover-mode tests (D30). Everything lives under one
// mkdtemp dir: a fake home with .glmps and .glmps-2, a
// runtime checkout stand-in, and a real git repo standing in for production's
// assets repo (its remote URL is unreachable and never fetched). `deps` are
// the injected process, port and Scheduled Task lookups, all reporting
// "nothing running". No test using this touches the real home, port 8123 or
// 8124, a real service or a Scheduled Task.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// The cutover seams open only with GLMPS_TEST=1 under node --test. npm test gets it
// from test.env; a bare `node --test <file>` does not, and then the real gate
// runs (real home, elevation for pid command lines) and every apply refuses.
if (process.env.NODE_TEST_CONTEXT && process.env.GLMPS_TEST === undefined) process.env.GLMPS_TEST = '1';

const roots = [];
process.on('exit', () => {
  for (const d of roots) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
});

export function scratch(prefix = 'mc-cutover-') {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(d);
  return d;
}

export function git(args, cwd) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('GIT_')) delete env[k];
  return execFileSync('git', args, { cwd, encoding: 'utf-8', windowsHide: true, env });
}

export function makeRepo(dir, { remote = 'https://example.invalid/glmps-assets.git' } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  git(['init', '-q'], dir);
  git(['config', 'user.email', 'test@example.com'], dir);
  git(['config', 'user.name', 'Test'], dir);
  fs.writeFileSync(path.join(dir, 'seed.txt'), 'seed\n');
  git(['add', '.'], dir);
  git(['commit', '-q', '-m', 'seed'], dir);
  if (remote) git(['remote', 'add', 'origin', remote], dir);
  return dir;
}

export function makeWorld({ runtimePort = 8124 } = {}) {
  const root = scratch();
  const home = path.join(root, 'home');
  const stateDir = path.join(home, '.glmps');
  const shadowDir = path.join(home, '.glmps-2');
  const runtimeDir = path.join(root, 'glmps-2.0-runtime');
  for (const d of [stateDir, shadowDir, path.join(runtimeDir, 'server')]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'backlog.json'), '[]\n');
  fs.writeFileSync(path.join(runtimeDir, 'config.json'), JSON.stringify({ port: runtimePort, scut: { enabled: false } }, null, 2));
  fs.writeFileSync(path.join(runtimeDir, 'server', 'server.js'), '');
  const prodAssets = makeRepo(path.join(root, 'glmps-assets'));
  const deps = {
    userInfoFn: () => ({ homedir: home }),
    // The guard refuses a listing without its own pid, so "nothing running" is
    // a listing holding only this test process.
    listServerProcessesFn: () => ({ ok: true, processes: [{ pid: process.pid, commandLine: process.argv.join(' ') }] }),
    queryListeningPidFn: () => ({ found: false }),
    queryTaskFn: () => ({ found: false }),
  };
  return { root, home, stateDir, shadowDir, runtimeDir, prodAssets, deps };
}

export function copyTree(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) copyTree(s, d);
    else if (e.isFile()) fs.copyFileSync(s, d);
  }
}
