// server/lib/chassis/deps.js
// Declarative third-party dependency manifest for `glmps init`.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { windowsCmdPath } from '../orchestration/editor-targets.js';

// install/update are argv arrays for the setup wizard (scripts/setup). The
// winget ids were checked with `winget show --id <id> --exact`; graphify goes
// through uv, as provisionGraphify does. graphify's update is a reinstall at
// @latest because `uv tool upgrade` keeps the exact pin a version-tick rollback
// writes into the tool receipt, exits 0 and changes nothing.
const winget = (verb, id) => ['winget', verb, '--id', id, '--exact', '--source', 'winget', '--accept-package-agreements', '--accept-source-agreements'];
const wingetDep = (id) => ({ wingetId: id, install: winget('install', id), update: winget('upgrade', id) });

export const DEP_MANIFEST = [
  { name: 'node', kind: 'runtime', required: true, cmd: ['node', '--version'], why: 'server runtime (>=18)', ...wingetDep('OpenJS.NodeJS.LTS') },
  { name: 'git', kind: 'cli', required: true, cmd: ['git', '--version'], why: 'branch display, worktrees, learning commits', ...wingetDep('Git.Git') },
  { name: 'graphify', kind: 'cli', required: false, cmd: ['graphify', '--version'], why: 'knowledge-graph rebuild/update; degrades to no-op',
    install: ['uv', 'tool', 'install', 'graphifyy'], update: ['uv', 'tool', 'install', 'graphifyy@latest'] },
  { name: 'claude', kind: 'cli', required: false, cmd: ['claude', '--version'], why: 'queue-runner launch + learning idea-apply', ...wingetDep('Anthropic.ClaudeCode') },
  { name: 'gh', kind: 'cli', required: false, cmd: ['gh', '--version'], why: 'GitHub sign-in, pull requests', ...wingetDep('GitHub.cli') },
];

// Boot-only: these probes run from `glmps init` (scripts/glmps-init.mjs), a CLI
// that finishes before any server listens, so the sync spawn blocks no request.
// Windows cannot spawn a .cmd/.bat without a shell, and npm installs Claude
// Code as claude.cmd, so a bare spawn reported an installed tool as missing.
// Resolve the name on PATH here and hand a shim to cmd.exe by absolute path;
// probe args are manifest constants, never input.
export function probeArgv(cmd, { platform = process.platform, env = process.env, exists = fs.existsSync } = {}) {
  const [name, ...args] = cmd;
  if (platform !== 'win32') return { file: name, args };
  const exts = (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  for (const dir of (env.PATH || env.Path || '').split(';').filter(Boolean)) {
    for (const ext of exts) {
      const hit = path.win32.join(dir, name + ext.toLowerCase());
      if (!exists(hit)) continue;
      if (/\.(cmd|bat)$/i.test(hit)) return { file: windowsCmdPath(env), args: ['/d', '/s', '/c', `""${hit}" ${args.join(' ')}"`] };
      return { file: hit, args };
    }
  }
  return { file: name, args };
}

export function defaultRun(cmd) {
  const { file, args } = probeArgv(cmd);
  const viaCmd = /cmd\.exe$/i.test(file);
  const r = spawnSync(file, args, { encoding: 'utf-8', shell: false, windowsVerbatimArguments: viaCmd });
  return { status: r.status ?? (r.error ? 127 : 0), stdout: (r.stdout ?? '').trim(), stderr: (r.stderr ?? '').trim() };
}

export function checkDep(dep, run = defaultRun) {
  let res; try { res = run(dep.cmd); } catch { res = { status: 127, stdout: '' }; }
  const present = res.status === 0;
  return { name: dep.name, required: dep.required, present, version: present ? (res.stdout || null) : null };
}

export function checkDeps(run = defaultRun) {
  const results = DEP_MANIFEST.map(d => checkDep(d, run));
  const missingRequired = results.filter(r => r.required && !r.present).map(r => r.name);
  return { ok: missingRequired.length === 0, results, missingRequired };
}

// "git version 2.56.0.windows.4" and winget's "2.56.0.4" are the same release.
function versionParts(text) {
  const m = /\d+(?:\.\d+)*/.exec(String(text ?? '').replace(/\.windows\./i, '.'));
  return m ? m[0].split('.').map(Number) : null;
}

export function compareVersions(a, b) {
  const pa = versionParts(a); const pb = versionParts(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

// Newest published version per winget-managed dep, read from `winget show`.
// Fail open: whatever cannot be read is left out and never reported outdated.
export function latestVersions(run = defaultRun) {
  const out = {};
  for (const d of DEP_MANIFEST) {
    if (!d.wingetId) continue;
    let res; try { res = run(['winget', 'show', '--id', d.wingetId, '--exact']); } catch { continue; }
    const m = res?.status === 0 ? /^Version:\s*(\S+)/m.exec(res.stdout ?? '') : null;
    if (m) out[d.name] = m[1];
  }
  return out;
}

// Pure: checkDeps().results (+ latestVersions()) -> what to do per dependency.
export function planDeps(results, latest = {}) {
  return results.map((r) => {
    const dep = DEP_MANIFEST.find((d) => d.name === r.name);
    const base = { name: r.name, required: r.required, installed: r.version, latest: latest[r.name] ?? null, update: dep?.update ?? null };
    if (!r.present) return { ...base, action: 'install', command: dep?.install ?? null };
    if (latest[r.name] && compareVersions(r.version, latest[r.name]) < 0) {
      return { ...base, action: 'update-available', command: dep?.update ?? null };
    }
    return { ...base, action: 'ok', command: null };
  });
}

// One line per dependency for the bash wizard: name, action, installed, latest,
// command, update command. Empty cells are '-': bash `read` with a tab IFS
// collapses adjacent tabs and would shift the columns.
export function planToTsv(plan) {
  const cell = (v) => String(v ?? '').replace(/[\t\r\n]+/g, ' ').trim() || '-';
  return plan.map((p) => [p.name, p.action, p.installed, p.latest, p.command?.join(' '), p.update?.join(' ')].map(cell).join('\t')).join('\n');
}
