#!/usr/bin/env node
// SessionStart hook: keep the agent-usable copies of the Pocock skills in step
// with the installed plugin, and let upstream updates arrive on their own.
//
// The copy runs inline (a few small files, only when the plugin's commit sha
// moved). The upstream update shells out to the plugin CLI over the network, so
// it runs at most once a day in a detached child (`--update`) that never holds
// up a session. Prints nothing unless a forked skill disappeared upstream.
// Never throws and always exits 0.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { FORKED, PLUGIN_ID, MARKETPLACE, forkSkillMarkdown, findPluginInstall, planSync } from './lib/pocock-sync-core.js';

const claudeDir = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function upstreamSkillDirs(installPath) {
  const manifest = readJson(path.join(installPath, '.claude-plugin', 'plugin.json'));
  const dirs = new Map();
  for (const rel of Array.isArray(manifest?.skills) ? manifest.skills : []) {
    const abs = path.join(installPath, rel);
    if (fs.existsSync(path.join(abs, 'SKILL.md'))) dirs.set(path.basename(abs), abs);
  }
  return dirs;
}

function copySkill(src, dest) {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(src, dest, { recursive: true });
  const skill = path.join(dest, 'SKILL.md');
  fs.writeFileSync(skill, forkSkillMarkdown(fs.readFileSync(skill, 'utf8')));
}

export function runSync({ now = Date.now(), spawnUpdate = defaultSpawnUpdate } = {}) {
  const dir = claudeDir();
  const statePath = path.join(dir, 'pocock-sync.json');
  const state = readJson(statePath);
  const install = findPluginInstall(readJson(path.join(dir, 'plugins', 'installed_plugins.json')));
  const upstream = install ? upstreamSkillDirs(install.path) : new Map();
  const plan = planSync({ install, state, now, upstreamHas: (n) => upstream.has(n),
    localHas: (n) => fs.existsSync(path.join(dir, 'skills', n, 'SKILL.md')) });
  for (const name of plan.copy) copySkill(upstream.get(name), path.join(dir, 'skills', name));
  if (!install) return { plan, wrote: false };
  if (plan.runUpdate) spawnUpdate();
  const next = { version: install.version, sha: install.sha, missing: plan.missing,
    lastUpdateCheck: plan.runUpdate ? now : state?.lastUpdateCheck ?? now, syncedAt: plan.copy.length ? now : state?.syncedAt ?? null };
  fs.writeFileSync(statePath, JSON.stringify(next, null, 2));
  return { plan, wrote: true };
}

// windowsHide, not detached, on Windows: DETACHED_PROCESS makes the child
// console-less so the `claude` console grandchild pops a visible Terminal window.
// Detached elsewhere so the update outlives this short-lived hook.
export function defaultSpawnUpdate({ spawnImpl = spawn, platform = process.platform } = {}) {
  const child = spawnImpl(process.execPath, [fileURLToPath(import.meta.url), '--update'], { detached: platform !== 'win32', stdio: 'ignore', windowsHide: true });
  child.unref();
}

function runUpstreamUpdate() {
  const opts = { stdio: 'ignore', windowsHide: true, timeout: 120_000, shell: process.platform === 'win32' };
  try { execFileSync('claude', ['plugin', 'marketplace', 'update', MARKETPLACE], opts); } catch { /* next day */ }
  try { execFileSync('claude', ['plugin', 'update', PLUGIN_ID], opts); } catch { /* next day */ }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.includes('--update')) runUpstreamUpdate();
    else {
      const { plan } = runSync();
      if (plan.missing.length) {
        console.log(`Pocock skills: ${plan.missing.join(', ')} no longer ship upstream; the local copies were kept. ` +
          `Rules that name them need a new mapping (${FORKED.length} forks expected).`);
      }
    }
  } catch { /* a sync problem must never block a session */ }
  process.exit(0);
}
