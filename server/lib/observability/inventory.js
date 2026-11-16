// server/lib/observability/inventory.js
import fs from 'node:fs';
import path from 'node:path';

// The scan is written once, as generators that yield each filesystem call as
// an [op, arg] pair; runSync and runAsync perform the ops. The inventory timer
// uses the async driver because the sync scan held the live kernel's event
// loop for 750-870 ms every minute (card glmps-2-0-runtime-68, AC-4).
const OPS = {
  readdir: [(p) => fs.readdirSync(p, { withFileTypes: true }), (p) => fs.promises.readdir(p, { withFileTypes: true })],
  readdirNames: [(p) => fs.readdirSync(p), (p) => fs.promises.readdir(p)],
  stat: [(p) => fs.statSync(p), (p) => fs.promises.stat(p)],
  readFile: [(p) => fs.readFileSync(p, 'utf-8'), (p) => fs.promises.readFile(p, 'utf-8')],
  exists: [(p) => fs.existsSync(p), (p) => fs.promises.access(p).then(() => true, () => false)],
  realpath: [(p) => fs.realpathSync(p), (p) => fs.promises.realpath(p)],
};

function runSync(gen) {
  let step = gen.next();
  while (!step.done) {
    const [op, arg] = step.value;
    let value; let error = null;
    try { value = OPS[op][0](arg); } catch (e) { error = e; }
    step = error ? gen.throw(error) : gen.next(value);
  }
  return step.value;
}

async function runAsync(gen) {
  let step = gen.next();
  while (!step.done) {
    const [op, arg] = step.value;
    let value; let error = null;
    try { value = await OPS[op][1](arg); } catch (e) { error = e; }
    step = error ? gen.throw(error) : gen.next(value);
  }
  return step.value;
}

function* frontmatter(file) {
  let text = '';
  try { text = (yield ['readFile', file]).slice(0, 2000); } catch { return {}; }
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return {};
  const out = {};
  for (const lineText of m[1].split('\n')) {
    const kv = /^(\w[\w-]*):\s*(.+?)\s*$/.exec(lineText);
    if (kv) out[kv[1]] = kv[2];
  }
  return out;
}

// Returns every file path under dir, depth-capped.
function* walk(dir, depth, out = []) {
  if (depth < 0) return out;
  let entries = [];
  try { entries = yield ['readdir', dir]; } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    let isDir = e.isDirectory();
    // Follow symlinks/junctions (e.g. skills deployed from the private asset
    // store into ~/.claude/skills): a dirent that is neither a plain dir nor a
    // plain file gets resolved. The depth cap is the cycle guard.
    if (!isDir && !e.isFile()) { try { isDir = (yield ['stat', full]).isDirectory(); } catch { isDir = false; } }
    if (isDir) yield* walk(full, depth - 1, out);
    else out.push(full);
  }
  return out;
}

// Collect agent definitions (*.md, excluding SKILL.md) from a directory tree.
function* addAgentsFrom(dir, plugin, sink) {
  for (const f of yield* walk(dir, 4)) {
    if (!f.endsWith('.md') || f.endsWith(`${path.sep}SKILL.md`)) continue;
    const fm = yield* frontmatter(f);
    sink.push({ name: fm.name ?? path.basename(f, '.md'),
      description: fm.description ?? '', plugin, path: f });
  }
}

// Collect skills (SKILL.md files) from a directory tree.
function* addSkillsFrom(dir, plugin, sink) {
  for (const f of yield* walk(dir, 4)) {
    if (!f.endsWith(`${path.sep}SKILL.md`)) continue;
    const fm = yield* frontmatter(f);
    sink.push({ name: fm.name ?? path.basename(path.dirname(f)),
      description: fm.description ?? '', plugin, path: f });
  }
}

// Parse a semver-ish version from a plugins-cache path. Layout is
// <cache>/<marketplace>/<plugin>/<version>/{skills|agents}/... - the version is
// the segment immediately before 'skills'/'agents'. Returns numeric components,
// or null when there is no version segment (user/project assets).
function pathVersion(p) {
  const segs = (p ?? '').split(/[\\/]/);
  for (const anchor of ['skills', 'agents']) {
    const i = segs.indexOf(anchor);
    if (i > 0 && /^\d+(\.\d+)*$/.test(segs[i - 1])) return segs[i - 1].split('.').map(Number);
  }
  return null;
}

// Descending comparator: a newer version sorts first. null (no version) sorts last.
function cmpVersionDesc(a, b) {
  const va = a ?? [], vb = b ?? [];
  const n = Math.max(va.length, vb.length);
  for (let k = 0; k < n; k++) { const d = (vb[k] ?? 0) - (va[k] ?? 0); if (d) return d; }
  return 0;
}

// Canonical identity of a file on disk, case-insensitive, resolving symlinks/junctions.
function* realKey(p) {
  let r = p ?? '';
  try { r = yield ['realpath', p]; } catch {}
  return r.toLowerCase();
}

/**
 * Remove duplicate inventory entries produced by the scan.
 *  1. Collapse entries that resolve to the same physical file - the same asset
 *     reached via symlink farms (~/.claude/skills -> ~/.agents/skills) or via
 *     overlapping synced project roots.
 *  2. For skills/agents, collapse a single plugin's skill/agent that is present
 *     under multiple cached versions (e.g. superpowers 5.1.0 + 6.0.3), keeping
 *     the newest. Same-named assets from DIFFERENT plugins stay distinct - they
 *     are genuinely different skills, invoked as `plugin:name`.
 */
export function dedupeInventory(inv) {
  return runSync(dedupeOps(inv));
}

function* dedupeOps(inv) {
  const out = {};
  for (const cat of ['skills', 'agents', 'memory', 'contextFiles']) {
    const byReal = new Map();
    for (const it of inv[cat] ?? []) {
      const k = yield* realKey(it.path);
      if (!byReal.has(k)) byReal.set(k, it);
    }
    let kept = [...byReal.values()];
    if (cat === 'skills' || cat === 'agents') {
      const byId = new Map();
      for (const it of kept) {
        const id = `${(it.plugin ?? '').toLowerCase()}\u0000${(it.name ?? '').toLowerCase()}`;
        const prev = byId.get(id);
        if (!prev || cmpVersionDesc(pathVersion(it.path), pathVersion(prev.path)) < 0) byId.set(id, it);
      }
      kept = [...byId.values()];
    }
    out[cat] = kept;
  }
  return out;
}

// projectRoots: cwds seen in session history (for CLAUDE.md/.agents scans)
export function scanInventory(opts) {
  return runSync(scanOps(opts));
}

export function scanInventoryAsync(opts) {
  return runAsync(scanOps(opts));
}

function* scanOps({ pluginsCacheDir, projectsDir, projectRoots = [], claudeDir }) {
  const skills = [], agents = [], memory = [], contextFiles = [];

  for (const f of yield* walk(pluginsCacheDir, 7)) {
    const rel = path.relative(pluginsCacheDir, f);
    const parts = rel.split(path.sep);
    const plugin = parts.length >= 2 ? parts[1] : 'unknown';
    if (f.endsWith(`${path.sep}SKILL.md`) && rel.includes(`${path.sep}skills${path.sep}`)) {
      const fm = yield* frontmatter(f);
      skills.push({ name: fm.name ?? path.basename(path.dirname(f)),
        description: fm.description ?? '', plugin, path: f });
    } else if (rel.includes(`${path.sep}agents${path.sep}`) && f.endsWith('.md')) {
      const fm = yield* frontmatter(f);
      agents.push({ name: fm.name ?? path.basename(f, '.md'),
        description: fm.description ?? '', plugin, path: f });
    }
  }

  let projDirs = [];
  try { projDirs = yield ['readdir', projectsDir]; } catch {}
  for (const d of projDirs) {
    if (!d.isDirectory()) continue;
    const memDir = path.join(projectsDir, d.name, 'memory');
    let files = [];
    try { files = yield ['readdirNames', memDir]; } catch { continue; }
    for (const f of files) if (f.endsWith('.md'))
      memory.push({ name: f, project: d.name, path: path.join(memDir, f),
        description: (yield* frontmatter(path.join(memDir, f))).description ?? '' });
  }

  for (const root of projectRoots) {
    for (const name of ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md', 'acceptance.md']) {
      const f = path.join(root, name);
      if (yield ['exists', f]) contextFiles.push({ name, root, path: f });
    }
    // Claude Code project-level agents and skills (<root>/.claude/{agents,skills})
    yield* addAgentsFrom(path.join(root, '.claude', 'agents'), 'project', agents);
    yield* addSkillsFrom(path.join(root, '.claude', 'skills'), 'project', skills);
    // Antigravity project skills (<root>/.agents/skills)
    yield* addSkillsFrom(path.join(root, '.agents', 'skills'), 'project', skills);
  }

  if (claudeDir) {
    const g = path.join(claudeDir, 'CLAUDE.md');
    if (yield ['exists', g])
      contextFiles.push({ name: 'CLAUDE.md (global)', root: claudeDir, path: g });
    // Claude Code user-level (global) agents and skills (~/.claude/{agents,skills})
    yield* addAgentsFrom(path.join(claudeDir, 'agents'), 'user', agents);
    yield* addSkillsFrom(path.join(claudeDir, 'skills'), 'user', skills);
  }
  return yield* dedupeOps({ skills, agents, memory, contextFiles });
}
