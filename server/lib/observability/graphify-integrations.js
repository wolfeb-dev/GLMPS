// server/lib/observability/graphify-integrations.js
// What graphify installs for agents: the user-scope skill copies the app keeps
// in step with the package, and the per-repo files (CLAUDE.md, AGENTS.md,
// GEMINI.md, copilot instructions, the Claude PreToolUse hook) an opted-in
// machine repo gets.
//
// WHY BOTH SKILL PLATFORMS: on Windows `graphify gemini install` writes its
// skill variant into ~/.agents/skills, the directory the `agents` platform
// owns, and graphify's own auto-refresh skips any directory two installers
// share. That is how ~/.agents/skills sat at 0.9.51 under a 0.9.95 package. A
// bare `graphify install` refreshes only the detected platform (claude), so
// both are named explicitly, and a refresh follows any repo gemini install.
//
// No spawns of its own: callers inject `runCmd(bin, args, { cwd })` and the
// file readers, so tests never touch a real process or home directory.
import fs from 'node:fs';
import path from 'node:path';
import { compareVersions } from './graphify-version.js';

export const SKILL_PLATFORMS = Object.freeze(['claude', 'agents']);

/** User-scope SKILL.md directory graphify writes for `platform` (claude honors CLAUDE_CONFIG_DIR, as graphify does). */
export function skillDir(platform, { home, env = {} }) {
  if (platform === 'claude') {
    return path.join(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'skills', 'graphify');
  }
  return path.join(home, '.agents', 'skills', 'graphify');
}

const readText = (file) => { try { return fs.readFileSync(file, 'utf-8'); } catch { return null; } };
const exists = (file) => { try { return fs.existsSync(file); } catch { return false; } };

/**
 * Platforms whose skill copy needs `graphify install --platform <p>`:
 * missing, unstamped, or stamped with a version other than `installed`.
 * A stamp newer than the package is left alone (installing would downgrade
 * it) unless `allowDowngrade`: the app itself just rolled the package back.
 */
export function skillRefreshPlan({ installed, home, env = {}, platforms = SKILL_PLATFORMS, allowDowngrade = false, read = readText, has = exists }) {
  if (!installed || !home) return [];
  const plan = [];
  for (const platform of platforms) {
    const dir = skillDir(platform, { home, env });
    const stamp = has(path.join(dir, 'SKILL.md')) ? read(path.join(dir, '.graphify_version'))?.trim() : null;
    if (!stamp) { plan.push({ platform, from: null }); continue; }
    const cmp = compareVersions(stamp, installed);
    if (cmp < 0 || (cmp > 0 && allowDowngrade)) plan.push({ platform, from: stamp });
  }
  return plan;
}

/** Run each planned install. Never throws: every outcome is a result row. */
export async function refreshGraphifySkills({ runCmd, plan }) {
  const results = [];
  for (const { platform, from } of plan) {
    let res;
    try { res = await runCmd('graphify', ['install', '--platform', platform]); }
    catch (e) { res = { code: 1, stdout: '', stderr: String(e?.message ?? e) }; }
    results.push({ platform, from, ok: res.code === 0, detail: res.code === 0 ? '' : String(res.stderr || res.stdout || '').trim().slice(-300) });
  }
  return results;
}

// Each integration is present when graphify's own section heading is in the
// file it writes. The Claude PreToolUse hook has two shapes: 0.9.95 writes
// `graphify hook-guard`, older installs an inline graph.json check.
const CLAUDE_HOOK = /graphify hook-guard|graphify-out\/graph\.json/;
export const REPO_INTEGRATIONS = Object.freeze([
  { id: 'claude', args: ['claude', 'install'], present: (rd) => /^## graphify\b/m.test(rd('CLAUDE.md') ?? '') && CLAUDE_HOOK.test(rd('.claude/settings.json') ?? '') },
  { id: 'agents-md', args: ['aider', 'install'], present: (rd) => /^## graphify\b/m.test(rd('AGENTS.md') ?? '') },
  { id: 'gemini', args: ['gemini', 'install'], present: (rd) => /^## graphify\b/m.test(rd('GEMINI.md') ?? '') },
  { id: 'copilot', args: ['vscode', 'install'], present: (rd) => /^## graphify\b/m.test(rd('.github/copilot-instructions.md') ?? '') },
]);

export function missingRepoIntegrations(root, { read = readText } = {}) {
  const rd = (rel) => read(path.join(root, rel));
  return REPO_INTEGRATIONS.filter(i => !i.present(rd)).map(i => i.id);
}

/**
 * Install the missing integrations in each root, graphify's own installers
 * run with the root as cwd. Callers pass opted-in machine roots only: ship
 * repos carry theirs in source and nothing else is ever written.
 * Returns { root, installed: [id], failed: [{ id, detail }] } per root that
 * was missing something; `touchedSkills` is true when an install ran, since
 * gemini's overwrites ~/.agents/skills and the caller must refresh after.
 */
export async function installRepoIntegrations({ roots, runCmd, read = readText }) {
  const results = [];
  let touchedSkills = false;
  for (const root of roots) {
    const missing = new Set(missingRepoIntegrations(root, { read }));
    if (!missing.size) continue;
    const row = { root, installed: [], failed: [] };
    for (const integ of REPO_INTEGRATIONS) {
      if (!missing.has(integ.id)) continue;
      let res;
      try { res = await runCmd('graphify', integ.args, { cwd: root }); }
      catch (e) { res = { code: 1, stdout: '', stderr: String(e?.message ?? e) }; }
      touchedSkills = true;
      if (res.code === 0) row.installed.push(integ.id);
      else row.failed.push({ id: integ.id, detail: String(res.stderr || res.stdout || '').trim().slice(-300) });
    }
    results.push(row);
  }
  return { results, touchedSkills };
}
