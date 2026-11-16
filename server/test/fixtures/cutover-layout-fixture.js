// server/test/fixtures/cutover-layout-fixture.js
// A temp machine for scripts/cutover/layout.mjs (card glmps-2-0-144): a home
// with ~/.glmps as the live state folder, a D: stand-in with the
// stale glmps-2.0 checkout (one runner worktree inside the state folder) and
// the old runtime checkout's config.json, two bare remotes where glmps2/main
// has one commit made after the T5 import, and shims for sc, schtasks and the
// kernel's HTTP answers. Real git runs only against these temp repos.
import fs from 'node:fs';
import { tmpRoot } from '../helpers/tmp.js';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { layoutFor, opsTaskArguments } from '../../../scripts/cutover/layout.mjs';

const roots = [];
process.on('exit', () => {
  for (const d of roots) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
});

const IDENT = { GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' };
function gitEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('GIT_')) delete env[k];
  return { ...env, ...IDENT, GIT_TERMINAL_PROMPT: '0' };
}
export function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, env: gitEnv(), stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
export function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

const xmlEsc = (s) => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
export function taskXml({ command, args, workdir }) {
  return `<?xml version="1.0" encoding="UTF-16"?>\r\n<Task version="1.3" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">\r\n  <Actions Context="Author">\r\n    <Exec>\r\n      <Command>${xmlEsc(command)}</Command>\r\n      <Arguments>${xmlEsc(args)}</Arguments>\r\n${workdir ? `      <WorkingDirectory>${xmlEsc(workdir)}</WorkingDirectory>\r\n` : ''}    </Exec>\r\n  </Actions>\r\n</Task>\r\n`;
}

export function serviceXml({ runtime, state }) {
  return `<service>\n  <id>GLMPS2</id>\n  <executable>C:\\Program Files\\nodejs\\node.exe</executable>\n  <arguments>"${path.join(runtime, 'server', 'server.js')}"</arguments>\n  <workingdirectory>${runtime}</workingdirectory>\n  <env name="GLMPS_SERVICE" value="1" />\n  <env name="GLMPS_STATE_DIR" value="${state}" />\n  <env name="GLMPS_ASSETS_DIR" value="D:/glmps-assets" />\n  <logpath>${path.join(state, 'logs')}</logpath>\n</service>\n`;
}

const CMD = (L, name) => `@echo off\r\nrem ${name}\r\ncd /d ${L.oldRuntime} || goto :fail\r\nnode scripts\\service\\promote.mjs\r\n:fail\r\n`;

export function makeMachine({ conflict = false, stale = false } = {}) {
  const root = fs.mkdtempSync(path.join(tmpRoot(), 'mc-cutover-layout-'));
  roots.push(root);
  const D = path.join(root, 'D');
  const remotes = path.join(root, 'remotes');
  const L = layoutFor({
    home: path.join(root, 'home'),
    oldRuntime: path.join(D, 'glmps-2.0-runtime'),
    runtimeRepo: path.join(D, 'glmps'),
    repoDir: path.join(D, 'glmps-2.0'),
    liveDir: path.join(D, 'glmps-2.0-live'),
    remoteUrl: path.join(remotes, 'glmps-2.0.git'),
    runtimeRemoteUrl: path.join(remotes, 'glmps.git'),
    kernelUrl: 'http://127.0.0.1:65530',
  });
  fs.mkdirSync(D, { recursive: true });

  // The runtime remote: glmps2/main with a commit the T5 import took.
  git(['init', '-q', '--bare', L.runtimeRemoteUrl], root);
  const rt = path.join(root, 'seed-runtime');
  git(['init', '-q', '-b', 'glmps2/main', rt], root);
  write(path.join(rt, 'runtime.txt'), 'imported\n');
  git(['add', '.'], rt);
  git(['commit', '-q', '-m', 'runtime before import'], rt);
  git(['remote', 'add', 'origin', L.runtimeRemoteUrl], rt);
  git(['push', '-q', 'origin', 'glmps2/main'], rt);

  // The merged repo: corpus plus the import, with the ops scripts at their tracked paths.
  git(['init', '-q', '--bare', '-b', 'main', L.remoteUrl], root);
  const seed = path.join(root, 'seed-2.0');
  git(['init', '-q', '-b', 'main', seed], root);
  write(path.join(seed, 'docs', 'README.md'), 'corpus\n');
  for (const n of ['deploy-glmps2', 'restart-glmps2', 'rebuild-app']) write(path.join(seed, 'scripts', 'service', `${n}.cmd`), CMD(L, n));
  write(path.join(seed, '.gitignore'), 'config.json\n');
  if (!stale) write(path.join(seed, 'scripts', 'service', 'promote.mjs'), "export const INTEGRATION_KEY = `wolfeb-dev/glmps-2.0@${INTEGRATION_BRANCH}`;\n");
  git(['add', '.'], seed);
  git(['commit', '-q', '-m', 'corpus'], seed);
  git(['fetch', '-q', L.runtimeRemoteUrl, 'glmps2/main:refs/import'], seed);
  git(['merge', '-q', '--allow-unrelated-histories', '-m', 'T5 import', 'refs/import'], seed);
  git(['remote', 'add', 'origin', L.remoteUrl], seed);
  git(['push', '-q', 'origin', 'main'], seed);

  // A glmps2/main commit made after the import; the conflict variant edits the same line on main.
  write(path.join(rt, 'runtime.txt'), 'after import\n');
  git(['commit', '-q', '-am', 'runtime after import'], rt);
  git(['push', '-q', 'origin', 'glmps2/main'], rt);
  if (conflict) {
    write(path.join(seed, 'runtime.txt'), 'changed on main\n');
    git(['commit', '-q', '-am', 'main edits the runtime file'], seed);
    git(['push', '-q', 'origin', 'main'], seed);
  }

  // The live state folder.
  const S = L.oldState;
  write(path.join(S, 'runner', 'config.json'), '{"enabled":true,"maxConcurrent":2}\n');
  write(path.join(S, 'service', 'GLMPS2.xml'), serviceXml({ runtime: L.oldRuntime, state: S }));
  write(path.join(S, 'service', 'GLMPS2.exe'), 'winsw');
  write(path.join(S, 'kernel.db'), 'DB');
  write(path.join(S, 'kernel.db-wal'), 'WAL');
  write(path.join(S, 'actions-minutes.json'), '{}');
  write(path.join(S, 'tested-trees.jsonl'), '{"sha":"a"}\n');
  write(path.join(S, 'approvals.jsonl'), '{"old":1}\n');
  write(path.join(S, 'ledgers', 'approvals.jsonl'), '{"new":1}\n');
  write(path.join(S, 'logs', 'deploy-glmps2.log'), 'last deploy\n');
  write(path.join(S, 'restart-glmps2.log'), 'last restart\n');
  fs.mkdirSync(path.join(S, 'requests'), { recursive: true });

  // The stale checkout, with a runner worktree under the state folder.
  git(['clone', '-q', L.remoteUrl, L.repoDir], root);
  const card = path.join(S, 'runner', 'worktrees', 'glmps-2.0', 'glmps-2-0-1');
  git(['worktree', 'add', '-q', '-b', 'glmps-runner/glmps-2.0/glmps-2-0-1', card], L.repoDir);
  write(path.join(card, 'wip.txt'), 'uncommitted card work\n');

  // The old runtime checkout's gitignored live config.
  write(path.join(L.oldRuntime, 'config.json'), `${JSON.stringify({
    port: 8123,
    canonicalProject: { target: 'glmps-2.0-runtime', names: ['glmps-2.0-runtime', 'glmps-2', 'glmps-2-0', 'glmps'] },
    mergeQueue: {
      autoDeploy: { 'wolfeb-dev/glmps@glmps2/main': 'deploy-glmps2' },
      repos: { 'wolfeb-dev/glmps': { path: path.join(S, 'repos', 'glmps'), timeoutMs: 600000 } },
    },
    nightly: { enabled: false, repoAllowlist: ['glmps', 'glmps-2.0-runtime'] },
    scratch: { worktreesDir: path.join(S, 'runner', 'worktrees') },
  }, null, 2)}\n`);

  // Home-folder ops scripts, one with an old backup beside it.
  for (const n of ['deploy-glmps2', 'restart-glmps2', 'rebuild-app']) write(path.join(L.home, `${n}.cmd`), `@echo off\r\nrem old ${n}\r\n`);
  write(path.join(L.home, 'deploy-glmps2.cmd.bak-2026-10-25'), 'older\r\n');

  const machine = { root, L, items: [], svc: { state: 'RUNNING', binPath: `"${path.join(S, 'service', 'GLMPS2.exe')}"` }, tasks: {}, calls: [], elevated: true };
  const opsArgs = (n) => opsTaskArguments(path.join(L.home, `${n}.cmd`), n === 'deploy-glmps2' ? path.join(S, 'logs', `${n}.log`) : path.join(S, `${n}.log`));
  for (const n of ['deploy-glmps2', 'restart-glmps2', 'rebuild-app']) machine.tasks[`\\GLMPS\\${n}`] = taskXml({ command: 'cmd.exe', args: opsArgs(n) });
  machine.tasks['GLMPS Nightly Run'] = taskXml({ command: 'C:\\Program Files\\nodejs\\node.exe', args: `"${path.join(L.oldRuntime, 'scripts', 'nightly-run.mjs')}"`, workdir: L.oldRuntime });
  machine.originalTasks = { ...machine.tasks };
  machine.sys = shimSys(machine);
  return machine;
}

export function shimSys(m) {
  const sc = (args) => {
    m.calls.push(['sc', ...args]);
    const [verb] = args;
    if (verb === 'query') return { status: 0, stdout: `SERVICE_NAME: GLMPS2\r\n        TYPE               : 10  WIN32_OWN_PROCESS\r\n        STATE              : ${m.svc.state === 'RUNNING' ? 4 : 1}  ${m.svc.state}\r\n`, stderr: '' };
    if (verb === 'stop') { m.svc.state = 'STOPPED'; return { status: 0, stdout: '', stderr: '' }; }
    if (verb === 'start') { m.svc.state = 'RUNNING'; return { status: 0, stdout: '', stderr: '' }; }
    if (verb === 'qc') return { status: 0, stdout: `[SC] QueryServiceConfig SUCCESS\r\n\r\nSERVICE_NAME: GLMPS2\r\n        BINARY_PATH_NAME   : ${m.svc.binPath}\r\n`, stderr: '' };
    if (verb === 'config') { m.svc.binPath = args[3]; return { status: 0, stdout: '[SC] ChangeServiceConfig SUCCESS', stderr: '' }; }
    return { status: 1, stdout: '', stderr: `unknown sc ${verb}` };
  };
  const schtasks = (args) => {
    m.calls.push(['schtasks', ...args]);
    const name = args[args.indexOf('/TN') + 1];
    if (args[0] === '/Query') return m.tasks[name] ? { status: 0, stdout: m.tasks[name], stderr: '' } : { status: 1, stdout: '', stderr: 'ERROR: The system cannot find the file specified.' };
    if (args[0] === '/Create') {
      const buf = fs.readFileSync(args[args.indexOf('/XML') + 1]);
      m.tasks[name] = buf.subarray(2).toString('utf16le');
      return { status: 0, stdout: 'SUCCESS', stderr: '' };
    }
    return { status: 1, stdout: '', stderr: 'unknown schtasks verb' };
  };
  const http = async (url) => {
    m.calls.push(['http', url]);
    if (m.svc.state !== 'RUNNING') return { ok: false, error: 'connect ECONNREFUSED' };
    const u = new URL(url);
    if (u.pathname === '/healthz') return { ok: true, status: 200, json: { status: 'up', version: '0.1.0+abc1234' } };
    if (u.pathname === '/api/backlog' && u.searchParams.get('counts') === '1') return { ok: true, status: 200, json: { counts: { queued: 1, done: 3 } } };
    if (u.pathname === '/api/backlog') return { ok: true, status: 200, json: { items: m.items } };
    return { ok: true, status: 404, json: null };
  };
  return {
    sc, schtasks, http,
    git: (args, cwd) => {
      try {
        return { status: 0, stdout: execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, env: gitEnv(), stdio: ['ignore', 'pipe', 'pipe'] }), stderr: '' };
      } catch (e) {
        return { status: typeof e.status === 'number' ? e.status : -1, stdout: String(e.stdout ?? ''), stderr: String(e.stderr ?? e.message) };
      }
    },
    isElevated: () => m.elevated,
    sleep: async () => {},
  };
}

/** Every file under `dir` (links not followed) as rel -> content, for before/after comparisons. */
export function digest(dir, { skip = () => false } = {}) {
  const out = {};
  const walk = (d) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      const rel = path.relative(dir, p).split(path.sep).join('/');
      if (skip(rel)) continue;
      if (e.isSymbolicLink()) out[rel] = `-> ${fs.readlinkSync(p)}`;
      else if (e.isDirectory()) walk(p);
      else out[rel] = fs.readFileSync(p, 'utf8');
    }
  };
  walk(dir);
  return out;
}
