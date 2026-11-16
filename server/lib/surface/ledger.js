// The Data ledger feed: how many items of each kind exist and which outside
// players hold a copy. Pure model plus one git-reading helper; the route
// supplies every input.
import { defaultExec, runGit } from './repo-tree.js';

const EXT = {
  markdown: ['.md', '.mdx'],
  config: ['.json', '.yml', '.yaml', '.toml', '.ini', '.cfg', '.conf', '.xml', '.config', '.props', '.csproj', '.sln'],
  code: ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.cs', '.go', '.rs', '.java', '.kt', '.rb', '.php', '.c', '.cpp', '.h', '.hpp', '.css', '.scss', '.html', '.sh', '.ps1', '.sql'],
};
const FILE_TYPES = ['markdown', 'config', 'code'];
const LABELS = {
  markdown: 'Markdown', config: 'Config', code: 'Code', projects: 'Projects',
  cards: 'Cards', sessions: 'Sessions', learning: 'Learning', alerts: 'Alerts',
};
const ANTHROPIC = new Set(['claude-code']);
const GCP = new Set(['antigravity', 'gemini-cli', 'agy-cli']);

const typeOfFile = (rel) => {
  const dot = rel.lastIndexOf('.');
  if (dot < 0 || dot < rel.lastIndexOf('/')) return null;
  const ext = rel.slice(dot).toLowerCase();
  return FILE_TYPES.find((t) => EXT[t].includes(ext)) ?? null;
};

const entry = (id, count, copies, onlyHere) => ({
  id, label: LABELS[id], count,
  copies: copies.filter((c) => c.count > 0),
  onlyHere,
});

export function ledgerModel({ rows = [], filesByRepo = {}, cards = [], tools = [], learningCount = 0, alertCount = 0 } = {}) {
  const fileCount = { markdown: [0, 0], config: [0, 0], code: [0, 0] }; // [on github, only here]
  let projGh = 0;
  for (const r of rows) {
    const remote = !!r?.remote;
    if (remote) projGh++;
    for (const rel of filesByRepo[r.repo] ?? []) {
      const t = typeOfFile(String(rel));
      if (t) fileCount[t][remote ? 0 : 1]++;
    }
  }
  const types = FILE_TYPES.map((t) => entry(t, fileCount[t][0] + fileCount[t][1], [{ player: 'github', count: fileCount[t][0] }], fileCount[t][1]));
  types.push(entry('projects', rows.length, [{ player: 'github', count: projGh }], rows.length - projGh));
  const slack = cards.filter((c) => c?.origin?.via === 'slack').length;
  types.push(entry('cards', cards.length, [{ player: 'slack', count: slack }], cards.length - slack));
  let anthropic = 0, gcp = 0, total = 0;
  for (const t of tools) {
    const n = Number(t?.sessionsFound) || 0;
    total += n;
    if (ANTHROPIC.has(t.id)) anthropic += n;
    else if (GCP.has(t.id)) gcp += n;
  }
  types.push(entry('sessions', total, [{ player: 'anthropic', count: anthropic }, { player: 'gcp', count: gcp }], total - anthropic - gcp));
  types.push(entry('learning', learningCount, [], learningCount));
  types.push(entry('alerts', alertCount, [], alertCount));
  return { ts: Date.now(), types };
}

export async function lsFilesByRepo(rows, exec = defaultExec) {
  const out = {};
  await Promise.all((rows ?? []).map(async (r) => {
    try {
      const { stdout } = await runGit(exec, r.path, ['ls-files', '-z']);
      out[r.repo] = String(stdout || '').split('\0').filter(Boolean);
    } catch { out[r.repo] = []; }
  }));
  return out;
}
