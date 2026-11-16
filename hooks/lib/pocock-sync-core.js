// Pure core of hooks/pocock-sync.js. Upstream ships these ten skills as
// user-only (disable-model-invocation), so a queue-runner agent cannot invoke
// them; the 2.0 rules name them, so we keep agent-usable copies whose only
// difference from upstream is that one frontmatter line (card glmps-2-0-33).
export const FORKED = [
  'to-spec', 'to-tickets', 'implement', 'implement-spec',
  'grill-me', 'grill-with-docs', 'triage', 'wayfinder', 'improve-codebase-architecture', 'handoff',
];
export const PLUGIN_ID = 'mattpocock-skills@claude-plugins-official';
export const MARKETPLACE = 'claude-plugins-official';
export const UPDATE_EVERY_MS = 24 * 60 * 60 * 1000;

export function forkSkillMarkdown(md) {
  const text = String(md ?? '');
  const m = text.match(/^---\r?\n[\s\S]*?\r?\n---/);
  if (!m) return text;
  const front = m[0].replace(/^disable-model-invocation:\s*true\s*\r?\n/m, '');
  return front + text.slice(m[0].length);
}

export function findPluginInstall(installedJson) {
  const entries = installedJson?.plugins?.[PLUGIN_ID];
  if (!Array.isArray(entries)) return null;
  const e = entries.find((x) => x && x.scope === 'user' && typeof x.installPath === 'string');
  return e ? { path: e.installPath, version: e.version ?? null, sha: e.gitCommitSha ?? null } : null;
}

// A fork that vanished upstream is reported, never deleted: the rules still
// name it, and a missing skill fails louder than a stale one.
export function planSync({ install, state, upstreamHas, localHas = () => true, now }) {
  if (!install) return { copy: [], missing: [], runUpdate: false };
  const missing = FORKED.filter((n) => !upstreamHas(n));
  const moved = !state || state.sha !== install.sha;
  const copy = FORKED.filter((n) => upstreamHas(n) && (moved || !localHas(n)));
  const runUpdate = !(Number.isFinite(state?.lastUpdateCheck) && now - state.lastUpdateCheck < UPDATE_EVERY_MS);
  return { copy, missing, runUpdate };
}
