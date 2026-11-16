// server/lib/observability/skills-view.js
//
// Pure, read-only inventory + usage report for the /api/skills route (v1:
// observability only - no adopt/retire actions, those are separate tickets).
// Given the installed-skills inventory (scanInventory's .skills) and the
// already-kind:'skill'-filtered durable event log, reports per-skill use
// counts + last-seen timestamps, a never-used seed list, and any skill
// events that don't resolve to a currently-installed skill.
//
// Label matching deliberately mirrors usage.js's splitUsage() approach (bare
// name / 'plugin:name' / SKILL.md-path forms) for consistency, but extends
// it from a boolean used/unused check to a count + max-ts, and - like
// usage.js - a bare/ambiguous label that matches more than one installed
// skill (e.g. two plugins shipping a same-named skill, see
// inventory.test.js's "keeps same-named skills from different plugins
// distinct") counts the event toward ALL matching installed skills. This is
// a known v1 limitation, not a bug: disambiguating same-named skills across
// plugins from label text alone isn't reliably possible without a session's
// full plugin-resolution context.
//
// Fully pure: no I/O, no fs access. Never throws on empty/malformed input.

const norm = p => (p ?? '').toLowerCase().replace(/\\/g, '/');

// Same numeric-ms / ISO-string normalization as event-log.js's private
// (unexported) tsToMs - reimplemented here rather than imported.
function tsToMs(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const n = Date.parse(v);
    return Number.isNaN(n) ? null : n;
  }
  return null;
}

// Resolve a skill event's label down to its best-effort bare skill name:
// drop a 'plugin:' prefix, then take the last path segment, treating a
// trailing SKILL.md segment as standing for its parent directory's name.
// Mirrors usage.js's `segs` logic exactly.
function labelKey(label) {
  const segs = (label ?? '').split(':').pop().split(/[\\/]/).filter(Boolean);
  if (!segs.length) return '';
  if (segs.length >= 2 && segs[segs.length - 1].toLowerCase() === 'skill.md')
    return segs[segs.length - 2].toLowerCase();
  return segs[segs.length - 1].toLowerCase();
}

function bump(map, key, tsMs) {
  const st = map.get(key) ?? { uses: 0, lastSeenMs: null };
  st.uses += 1;
  if (tsMs !== null && (st.lastSeenMs === null || tsMs > st.lastSeenMs)) st.lastSeenMs = tsMs;
  map.set(key, st);
}

export function buildSkillsView(inventory, events) {
  const installed = Array.isArray(inventory?.skills) ? inventory.skills : [];
  const installedAvailable = installed.length > 0;
  const evs = Array.isArray(events) ? events : [];

  // name(lowercase) -> [skill,...]; may hold >1 entry for same-named skills
  // shipped by different plugins (see module doc comment above).
  const byName = new Map();
  const byPluginName = new Map(); // 'plugin:name'(lowercase) -> skill
  const byPath = new Map();       // normalized path -> skill
  for (const s of installed) {
    const nameKey = (s?.name ?? '').toLowerCase();
    if (nameKey) {
      if (!byName.has(nameKey)) byName.set(nameKey, []);
      byName.get(nameKey).push(s);
      byPluginName.set(`${(s?.plugin ?? '').toLowerCase()}:${nameKey}`, s);
    }
    if (s?.path) byPath.set(norm(s.path), s);
  }

  const statsByInstalled = new Map();    // skill object identity -> { uses, lastSeenMs }
  const statsByObserved = new Map();     // resolved name string -> { uses, lastSeenMs }

  for (const e of evs) {
    const label = e?.label ?? '';
    const path = e?.path ?? null;
    if (!label && !path) continue;
    const tsMs = tsToMs(e?.ts);

    const matched = new Set();
    const wholeLabel = label.toLowerCase();
    if (wholeLabel) {
      if (byPluginName.has(wholeLabel)) matched.add(byPluginName.get(wholeLabel));
      if (byName.has(wholeLabel)) for (const s of byName.get(wholeLabel)) matched.add(s);
    }
    const rkey = labelKey(label);
    if (rkey && byName.has(rkey)) for (const s of byName.get(rkey)) matched.add(s);
    if (path && byPath.has(norm(path))) matched.add(byPath.get(norm(path)));

    if (matched.size) {
      for (const s of matched) bump(statsByInstalled, s, tsMs);
    } else {
      const name = rkey || wholeLabel;
      if (name) bump(statsByObserved, name, tsMs);
    }
  }

  // `id` is a stable `plugin:name` join key (lowercased) - the SAME identity
  // convention inventory.js's dedupeInventory() already uses internally, so
  // skill-observation-log.js / skill-retire.js can key off it without
  // depending on `path` (which moves across marketplace-cache version bumps).
  // Purely additive: existing readers of name/description/plugin/uses/
  // lastSeen/installed are unaffected.
  const toRow = (name, description, plugin, installedFlag, st) => ({
    id: `${(plugin ?? '').toLowerCase()}:${(name ?? '').toLowerCase()}`,
    name, description: description ?? null, plugin: plugin ?? null,
    uses: st?.uses ?? 0,
    lastSeen: st && st.lastSeenMs !== null ? new Date(st.lastSeenMs).toISOString() : null,
    installed: installedFlag,
  });

  const skills = [];
  for (const s of installed) {
    skills.push(toRow(s?.name, s?.description, s?.plugin, true, statsByInstalled.get(s)));
  }
  for (const [name, st] of statsByObserved) {
    skills.push(toRow(name, null, null, false, st));
  }

  skills.sort((a, b) => b.uses - a.uses || String(a.name).localeCompare(String(b.name)));

  const neverUsed = installedAvailable ? skills.filter(s => s.installed && s.uses === 0) : [];

  return { skills, neverUsed, installedAvailable };
}
