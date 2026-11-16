// server/lib/observability/wiki-facts.js
// The facts the admin guide's reference tables are built from, read straight
// from the code so a table cannot disagree with it: config keys and defaults,
// HTTP routes, loops, Windows scheduled tasks and environment variables. The
// model never writes these; it writes the prose around them. The checker's
// coverage rule then proves every extracted fact reached a page.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const FACT_KINDS = Object.freeze(['config', 'routes', 'loops', 'tasks', 'env']);

const show = (v) => {
  if (v === null || v === undefined) return 'null';
  const s = JSON.stringify(v);
  return s.length > 80 ? `${s.slice(0, 77)}...` : s;
};

// One row per top-level key, plus one per key of a plain-object default, so
// `wikiLoop.everyMs` is findable without dumping whole objects.
export function configFacts(defaults) {
  const rows = [];
  for (const [k, v] of Object.entries(defaults ?? {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length) {
      for (const [k2, v2] of Object.entries(v)) rows.push({ key: `${k}.${k2}`, value: show(v2) });
    } else {
      rows.push({ key: k, value: show(v) });
    }
  }
  return rows.sort((a, b) => a.key.localeCompare(b.key));
}

// `u.pathname.match(/^\/api\/x\/([^/]+)$/)` back to `/api/x/:id`.
function regexToPath(src) {
  let n = 0;
  return src.replace(/^\^/, '').replace(/\$$/, '').replace(/\\\//g, '/')
    .replace(/\((?:\?:)?[^()]*\)/g, () => (n++ === 0 ? ':id' : `:p${n}`))
    .replace(/\\\./g, '.');
}

export function routeFacts(serverSrc) {
  const lines = String(serverSrc).split(/\r?\n/);
  const seen = new Map();
  const add = (method, p) => {
    if (!p.startsWith('/')) return;
    const key = `${method} ${p}`;
    if (!seen.has(key)) seen.set(key, { method, path: p });
  };
  const methodNear = (i) => {
    for (let j = i; j < Math.min(lines.length, i + 3); j++) {
      const m = lines[j].match(/req\.method === '([A-Z]+)'/);
      if (m) return m[1];
    }
    return 'ANY';
  };
  lines.forEach((line, i) => {
    for (const m of line.matchAll(/u\.pathname === '([^']+)'(\s*&&\s*req\.method === '([A-Z]+)')?/g)) add(m[3] ?? methodNear(i), m[1]);
    for (const m of line.matchAll(/u\.pathname\.match\(\/(.+?)\/\)/g)) add(methodNear(i), regexToPath(m[1]));
  });
  for (const m of String(serverSrc).matchAll(/registerRoute\(\{\s*method:\s*'([A-Z]+)',\s*pattern:\s*'([^']+)'/g)) add(m[1], m[2]);
  return [...seen.values()].sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}

const fmtMs = (ms) => {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '';
  if (ms % 3600000 === 0) return `every ${ms / 3600000} h`;
  if (ms % 60000 === 0) return `every ${ms / 60000} min`;
  return `every ${Math.round(ms / 1000)} s`;
};

// Loop records the registry persists under <stateDir>/loops; a file without a
// trigger is a loop's side store (a budget, a recent-runs list), not a loop.
export function loopFacts(stateDir) {
  if (!stateDir) return [];
  const dir = path.join(stateDir, 'loops');
  let names;
  try { names = fs.readdirSync(dir).filter(f => f.endsWith('.json')); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  const rows = [];
  for (const f of names) {
    let rec;
    try { rec = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
    if (!rec || !rec.name || !rec.trigger) continue;
    const t = rec.trigger;
    const trigger = t.everyMs ? fmtMs(t.everyMs) : t.onEvent ? `on ${t.onEvent}` : t.external ? `external: ${t.external}` : 'manual';
    const sla = rec.sla?.maxAgeMs ? `fresh within ${fmtMs(rec.sla.maxAgeMs).replace('every ', '')}` : '';
    rows.push({ name: rec.name, trigger, sla });
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

export function taskFacts(scripts) {
  const rows = [];
  for (const { path: p, text } of scripts) {
    const name = String(text).match(/\[string\]\$TaskName\s*=\s*'([^']+)'/)?.[1];
    if (!name) continue;
    const t = String(text).match(/New-ScheduledTaskTrigger\s+([^\r\n|]+)/)?.[1] ?? '';
    const at = String(text).match(/\[string\]\$At\s*=\s*'([^']+)'/)?.[1];
    const every = t.match(/-RepetitionInterval\s*\(New-TimeSpan\s+-Minutes\s+(\d+)\)/)?.[1];
    const trigger = every ? `every ${every} min` : /-Daily/.test(t) ? `daily${at ? ` at ${at}` : ''}` : t.trim().replace(/\s+/g, ' ');
    rows.push({ name, trigger, script: p });
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

export function envFacts(sources) {
  const byName = new Map();
  for (const { path: p, text } of sources) {
    for (const m of String(text).matchAll(/\b(?:process\.)?env\.([A-Z][A-Z0-9_]{2,})\b/g)) {
      if (!byName.has(m[1])) byName.set(m[1], new Set());
      byName.get(m[1]).add(p);
    }
  }
  return [...byName.entries()].map(([name, files]) => ({ name, files: [...files].sort().join(', ') }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

const readIf = (abs) => { try { return fs.readFileSync(abs, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };

/**
 * Every fact kind for a repo. Returns {} for a repo that is not the GLMPS
 * runtime (no server/server.js): other projects get no admin guide.
 */
export async function extractFacts({ repoRoot, stateDir = null }) {
  const serverSrc = readIf(path.join(repoRoot, 'server', 'server.js'));
  if (serverSrc == null) return {};
  const defaultsFile = path.resolve(repoRoot, 'server', 'lib', 'config-defaults.js');
  let config = [];
  if (fs.existsSync(defaultsFile)) {
    const mod = await import(pathToFileURL(defaultsFile).href);
    config = configFacts(mod.configDefaults());
  }
  const ps1 = [];
  for (const dir of ['scripts', path.join('scripts', 'service')]) {
    let names = [];
    try { names = fs.readdirSync(path.join(repoRoot, dir)).filter(f => f.endsWith('.ps1')); } catch { names = []; }
    for (const f of names) ps1.push({ path: path.join(dir, f).replace(/\\/g, '/'), text: readIf(path.join(repoRoot, dir, f)) ?? '' });
  }
  const envSources = ['server/lib/paths.js', 'server/server.js']
    .map(p => ({ path: p, text: readIf(path.join(repoRoot, p)) ?? '' }));
  return {
    config,
    routes: routeFacts(serverSrc),
    loops: loopFacts(stateDir),
    tasks: taskFacts(ps1),
    env: envFacts(envSources),
  };
}

// Each kind as a reference table: the label every coverage check keys on is
// the first cell (config key, route path, loop name, task name, variable).
export function factTable(kind, facts) {
  const rows = facts?.[kind] ?? [];
  switch (kind) {
    case 'config': return { title: 'Configuration keys', columns: ['Key', 'Default'], rows: rows.map(r => [r.key, r.value]) };
    case 'routes': return { title: 'Routes', columns: ['Path', 'Method'], rows: rows.map(r => [r.path, r.method]) };
    case 'loops': return { title: 'Loops', columns: ['Loop', 'Runs', 'Expected freshness'], rows: rows.map(r => [r.name, r.trigger, r.sla]) };
    case 'tasks': return { title: 'Windows scheduled tasks', columns: ['Task', 'Trigger', 'Registered by'], rows: rows.map(r => [r.name, r.trigger, r.script]) };
    case 'env': return { title: 'Environment variables', columns: ['Variable', 'Read in'], rows: rows.map(r => [r.name, r.files]) };
    default: return null;
  }
}
