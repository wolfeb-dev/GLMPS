// server/lib/orchestration/project-dirs.js
// Keep settings.json permissions.additionalDirectories in sync with the git repos
// found one level under each configured root. Roots come from GLMPS_PROJECT_ROOTS
// (set by the caller); there is no hardcoded default, so this is a no-op until
// configured - safe for OSS.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { isPrivateDir } from '../private-dirs.js';
import { markTrusted } from './claude-trust.js';

function normRoot(r) {
  return r.replace(/\\/g, '/').replace(/\/+$/, '') + '/';
}

// Immediate child dirs of each root that contain a `.git` entry (dir or file).
export function findRepoDirs(roots) {
  const out = [];
  for (const root of roots) {
    const r = normRoot(root);
    let entries;
    try { entries = fs.readdirSync(r, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (/^\$/.test(e.name) || /^System Volume Information$/i.test(e.name)) continue;
      const dir = path.join(r, e.name);
      try {
        if (fs.existsSync(path.join(dir, '.git'))) out.push(dir.replace(/\\/g, '/'));
      } catch {}
    }
  }
  return out;
}

// Managed roots refreshed from disk; manually-added dirs outside the roots preserved.
//
// privateDirs (server/lib/private-dirs.js) are filtered from the RESULT rather
// than from `found` alone. That placement is load-bearing: it also strips a
// private dir that arrived through the `preserved` path (added by hand outside
// the roots) and, more importantly, REMOVES one that is already present in
// settings.json. Filtering only `found` would prevent new exposure while
// leaving existing exposure in place permanently - which is the situation this
// was written to fix (D:\Docs was already synced by the time anyone noticed).
export function computeAdditionalDirectories({ roots, current = [], privateDirs = [] }) {
  const normRoots = roots.map(normRoot);
  const found = findRepoDirs(roots);
  const isManaged = (d) => {
    const n = d.replace(/\\/g, '/').toLowerCase();
    return normRoots.some((r) => n.startsWith(r.toLowerCase()));
  };
  const preserved = current.filter((d) => !isManaged(d));
  return [...new Set([...preserved, ...found])]
    .filter((d) => !isPrivateDir(d, privateDirs))
    .sort((a, b) => a.localeCompare(b));
}

// Read settings, recompute additionalDirectories, write atomically only on change.
export function syncProjectDirs({ settingsFile, roots, privateDirs = [] }) {
  let settings;
  try { settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8')); }
  catch (err) { return { ok: false, reason: `cannot read ${settingsFile}: ${err.message}` }; }

  settings.permissions = settings.permissions || {};
  const current = Array.isArray(settings.permissions.additionalDirectories)
    ? settings.permissions.additionalDirectories : [];
  const next = computeAdditionalDirectories({ roots, current, privateDirs });
  const curSorted = [...current].sort((a, b) => a.localeCompare(b));
  const unchanged = next.length === curSorted.length && next.every((v, i) => v === curSorted[i]);
  if (unchanged) return { ok: true, changed: false, dirs: next };

  settings.permissions.additionalDirectories = next;
  const tmp = settingsFile + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n');
  fs.renameSync(tmp, settingsFile);
  return { ok: true, changed: true, dirs: next };
}

const slash = (p) => String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
const defaultRunGit = (dir) => execFileSync('git', ['init', '-q', dir], { windowsHide: true, stdio: 'ignore' });

// Adopt a directory as a project: make it, git init it when it is not a repo,
// register it in additionalDirectories, and pre-accept the harness trust dialog.
// Adopting an existing repo is the same call. Never throws.
//
// The private check runs first and before any filesystem change, so a refused
// dir leaves no trace. A settings file that cannot be parsed is reported and
// left alone (never rewritten from a guess); a missing one is created.
export function createProject({ settingsFile, dir, privateDirs = [], claudeConfigFile, env = process.env, runGit = defaultRunGit } = {}) {
  try {
    const raw = String(dir ?? '').trim();
    if (!raw) return { ok: false, reason: 'path is empty' };
    if (!path.isAbsolute(raw)) return { ok: false, reason: 'path is not absolute' };
    const norm = slash(path.resolve(raw));
    if (isPrivateDir(norm, privateDirs)) return { ok: false, private: true, reason: 'path is a private directory and cannot be registered as a project' };

    let settings = {};
    let settingsExisted = true;
    try { settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8')); }
    catch (err) {
      if (err?.code === 'ENOENT') settingsExisted = false;
      else return { ok: false, reason: `cannot read ${settingsFile}: ${err.message}` };
    }
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return { ok: false, reason: `${settingsFile} is not a JSON object` };

    const created = !fs.existsSync(norm);
    fs.mkdirSync(norm, { recursive: true });
    const initialized = !fs.existsSync(path.join(norm, '.git'));
    if (initialized) runGit(norm);

    const perms = settings.permissions && typeof settings.permissions === 'object' ? settings.permissions : {};
    const current = Array.isArray(perms.additionalDirectories) ? perms.additionalDirectories : [];
    const registered = !current.some((d) => slash(d).toLowerCase() === norm.toLowerCase());
    if (registered || !settingsExisted) {
      settings.permissions = { ...perms, additionalDirectories: registered ? [...current, norm] : current };
      fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
      const tmp = settingsFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n');
      fs.renameSync(tmp, settingsFile);
    }

    const t = markTrusted({ dirs: [norm], privateDirs, env, file: claudeConfigFile });
    const trusted = t.ok && t.reason !== 'disabled';
    return { ok: true, dir: norm, created, initialized, registered, trusted, ...(t.ok ? {} : { reason: t.reason }) };
  } catch (err) {
    return { ok: false, reason: err?.message ?? String(err) };
  }
}
