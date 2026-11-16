// server/lib/personality/index.js
// The Personality page's data: every file that steers how the agents think,
// walked into five groups from injectable paths. Read-only. A missing file is
// skipped, a credential file is named and never read (credentials.js), and
// settings files list their keys but never serve their text.
import fs from 'node:fs';
import path from 'node:path';
import { isWithheld, isCredentialName } from './credentials.js';

const TEXT_CAP = 150_000;
const ROW_CAP = 80;
const DESC_CAP = 200;
const MANAGED_RE = /<!--\s*GLMPS:BEGIN memory/;
const GENERATED_HEADINGS = new Set(['learned guards', 'cross-agent memory']);

export const GROUPS = Object.freeze([
  { id: 'machine', name: 'Machine', sub: 'every session, every project', order: 'Read first. Project instruction files are appended after these, not substituted; settings at project scope override user scope key by key.' },
  { id: 'project', name: 'Project', sub: 'the runtime repo', order: 'Read after machine files, nearest directory last. Each AI reads its own instruction file; all three carry the same managed memory block.' },
  { id: 'agents', name: 'Agents and skills', sub: 'loaded when a task names them', order: 'A definition is loaded when its agent is dispatched or its skill is invoked; on a name clash Claude prefers the project agent over the user one, but the user skill over the project one.' },
  { id: 'runtime', name: 'Runtime', sub: 'in code, not files', order: 'Applied by GLMPS around the AI: the prompt a card starts with, and how huddle seats speak.' },
  { id: 'memory', name: 'Learned memory', sub: 'changes without anyone editing a prompt', order: 'Loaded at session start alongside the instructions (Claude reads the first 200 lines or 25 KB of the index). An old fact stays until someone removes it.' },
]);

const statOf = (p) => { try { return fs.statSync(p); } catch { return null; } };
const readDir = (p) => { try { return fs.readdirSync(p, { withFileTypes: true }); } catch { return []; } };
const cap = (s, n = DESC_CAP) => (s.length > n ? `${s.slice(0, n - 1)}...` : s);

function linkInfo(p) {
  try {
    if (!fs.lstatSync(p).isSymbolicLink()) return { link: false, realPath: null };
    return { link: true, realPath: fs.realpathSync.native(p) };
  } catch { return { link: false, realPath: null }; }
}

function frontMatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const out = {};
  if (!m) return out;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2].replace(/^["']|["']$/g, '').trim();
  }
  return out;
}

function mdOutline(text) {
  const out = [];
  let fence = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^```/.test(line)) { fence = !fence; continue; }
    if (fence) continue;
    const m = /^(#{1,3})\s+(.+?)\s*$/.exec(line);
    if (m) out.push({ level: m[1].length, text: m[2], generated: GENERATED_HEADINGS.has(m[2].toLowerCase()) });
  }
  return out;
}

function codeOutline(text) {
  const out = [];
  for (const m of text.matchAll(/^(?:export\s+)?(?:const|function)\s+([A-Z][A-Z0-9_]{2,})\b/gm)) out.push({ level: 1, text: m[1], generated: false });
  return out.slice(0, 20);
}

function jsonKeys(text) {
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v).map((k) => ({ level: 1, text: k, generated: false })) : [];
  } catch { return []; }
}

function section(text, title) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => new RegExp(`^##\\s+${title}\\s*$`, 'i').test(l));
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) if (/^##\s/.test(lines[i])) { end = i; break; }
  return lines.slice(start, end).join('\n');
}

// Prompt text that lives only in code, pulled from the source file at build
// time. Each extractor returns null when the source is not in the expected
// shape, and the card is then skipped rather than guessed.
function quotedConst(raw, name) {
  const m = new RegExp(`\\bconst\\s+${name}\\s*=\\s*'((?:[^'\\\\\\n]|\\\\.)*)'`).exec(raw);
  return m ? m[1].replace(/\\(['\\])/g, '$1') : null;
}
function judgePrompt(raw, vendored = {}) {
  const list = (n) => { const m = new RegExp(`const\\s+${n}\\s*=\\s*\\[([^\\]]*)\\]`).exec(raw); return m ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).join(', ') : null; };
  const classes = list('TASK_CLASSES'); const outcomes = list('OUTCOMES');
  const m = /(Also classify what the task was about as one of: )\$\{TASK_CLASSES\.join\([^)]*\)\}(; and how it ended as one of: )\$\{OUTCOMES\.join\([^)]*\)\}(\.)/.exec(raw);
  if (!m || !classes || !outcomes) return null;
  const suffix = `${m[1]}${classes}${m[2]}${outcomes}${m[3]}`;
  const { trajectory, taskCompletion } = vendored;
  if (typeof trajectory !== 'string' || typeof taskCompletion !== 'string') {
    return `${suffix}\n\nThe judge also sends two prompts vendored from openevals (trajectory accuracy and task completion). Those live in plugins/judge/vendor/openevals and are not shown here.`;
  }
  return `Trajectory accuracy (vendored from openevals):\n\n${trajectory}\n\nTask completion (vendored from openevals), followed by this classify instruction:\n\n${taskCompletion}\n\n${suffix}`;
}
function tripleQuoted(raw, name) {
  const m = new RegExp(`^${name}\\s*=\\s*"""([\\s\\S]*?)"""`, 'm').exec(raw);
  return m ? m[1] : null;
}
function mem0Note(raw) {
  if (!/\.add\([^)]*\binfer\b/.test(raw)) return null;
  return "Mem0's built-in fact extraction. The adapter calls Memory.add with infer on and sets no custom prompt, so the wording comes from the vendored mem0ai package, not from this repo.";
}

// kind: 'md' (outline + text), 'json' (keys only, no text), 'code' (constants + text)
function fileCard(ctx, spec) {
  const { file, kind = 'md' } = spec;
  if (!file || isWithheld(file, ctx)) return null;
  const st = statOf(file);
  if (!st || !st.isFile()) return null;
  const { link, realPath } = linkInfo(file);
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const managed = MANAGED_RE.test(raw) || (kind === 'md' && section(raw, 'Learned guards') !== null);
  const outline = kind === 'json' ? jsonKeys(raw) : kind === 'code' ? codeOutline(raw) : mdOutline(raw);
  const body = spec.text !== undefined ? spec.text : kind === 'json' ? null : raw;
  return {
    id: spec.id, group: spec.group, name: spec.name, controls: spec.controls,
    readBy: spec.readBy, shapes: spec.shapes, note: spec.note ?? null,
    path: file, realPath, size: st.size, mtime: st.mtimeMs,
    badges: { generated: managed || spec.generated === true, link, overridden: false, withheld: false },
    outline, text: body === null ? null : body.slice(0, TEXT_CAP), truncated: body !== null && body.length > TEXT_CAP,
    openPath: file, openKind: 'file',
  };
}

function collectionCard(spec, rows) {
  const mtime = rows.reduce((m, r) => Math.max(m, r.mtime ?? 0), 0);
  return {
    id: spec.id, group: spec.group, name: spec.name, controls: spec.controls,
    readBy: spec.readBy, shapes: spec.shapes, note: spec.note ?? null,
    path: spec.folder ?? null, realPath: null, size: rows.reduce((n, r) => n + (r.size ?? 0), 0), mtime: mtime || null,
    badges: { generated: false, link: rows.length > 0 && rows.every((r) => r.link), overridden: rows.some((r) => r.overridden), withheld: false },
    outline: [], text: null, truncated: false,
    count: spec.count ?? rows.length,
    rows: rows.slice(0, ROW_CAP),
    searchText: spec.searchText ?? rows.map((r) => `${r.name} ${r.description ?? ''}`).join(' '),
    ...(spec.folder ? { openPath: spec.folder, openKind: 'dir' } : (() => { const r = rows.find((x) => x.openPath); return { openPath: r?.openPath ?? null, openKind: r ? 'file' : null }; })()),
  };
}

function withheldRow(file) {
  return { name: path.basename(file), path: file, withheld: true };
}

// One row per markdown file in `dir`, name and description from its front matter.
function mdRows(ctx, dir, { named = false } = {}) {
  const rows = [];
  for (const e of readDir(dir)) {
    if (!e.isFile() && !e.isSymbolicLink()) continue;
    if (!/\.md$/i.test(e.name)) continue;
    const file = path.join(dir, e.name);
    if (isWithheld(file, ctx)) { rows.push(withheldRow(file)); continue; }
    const st = statOf(file);
    if (!st || !st.isFile()) continue;
    let raw = '';
    try { raw = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const fm = frontMatter(raw);
    const { link, realPath } = linkInfo(file);
    rows.push({
      name: named && fm.name ? fm.name : e.name.replace(/\.md$/i, ''),
      description: cap(fm.description ?? ''),
      ...(fm.personality ? { personality: cap(fm.personality) } : {}),
      path: file, realPath, link, size: st.size, mtime: st.mtimeMs,
      source: path.basename(path.dirname(realPath ?? file)),
      openPath: file, openKind: 'file', overridden: false,
    });
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

function hookEvents(settingsFile) {
  const byFile = new Map();
  let doc = null;
  try { doc = JSON.parse(fs.readFileSync(settingsFile, 'utf8')); } catch { return byFile; }
  for (const [event, entries] of Object.entries(doc?.hooks ?? {})) {
    for (const entry of Array.isArray(entries) ? entries : []) {
      for (const h of Array.isArray(entry?.hooks) ? entry.hooks : []) {
        for (const m of String(h?.command ?? '').matchAll(/([\w.-]+\.js)\b/g)) {
          const set = byFile.get(m[1]) ?? new Set();
          set.add(event);
          byFile.set(m[1], set);
        }
      }
    }
  }
  return byFile;
}

function hookRows(ctx, hooksDir, settingsFile) {
  const events = hookEvents(settingsFile);
  const rows = [];
  for (const e of readDir(hooksDir)) {
    if (!e.isFile() || !/\.js$/i.test(e.name)) continue;
    const file = path.join(hooksDir, e.name);
    if (isWithheld(file, ctx)) { rows.push(withheldRow(file)); continue; }
    const st = statOf(file);
    if (!st) continue;
    const ev = [...(events.get(e.name) ?? [])];
    rows.push({ name: e.name, description: ev.length ? ev.join(', ') : 'not wired in settings', path: file, size: st.size, mtime: st.mtimeMs, source: 'hooks', openPath: file, openKind: 'file' });
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

function skillGroup(ctx, name, dir) {
  const entries = readDir(dir).filter((e) => e.isDirectory() || e.isSymbolicLink());
  const names = entries.map((e) => e.name).filter((n) => !isWithheld(path.join(dir, n), ctx));
  return { row: { name, count: entries.length, path: dir, source: dir, openPath: dir, openKind: 'dir', mtime: statOf(dir)?.mtimeMs ?? null }, names };
}

function huddleBlock(configFile) {
  if (!configFile) return null;
  try {
    const cfg = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    return cfg && typeof cfg.huddle === 'object' && cfg.huddle !== null ? cfg.huddle : null;
  } catch { return null; }
}

export function openOnlyRoots({ geminiDir }) {
  if (!geminiDir) return [];
  return [
    path.join(geminiDir, 'settings.json'),
    path.join(geminiDir, 'config', 'config.json'),
    path.join(geminiDir, 'config', 'skills'),
  ];
}

export function buildPersonality({
  homeDir, claudeDir, geminiDir, repoRoot, assetsDir, agentsDir, memoryDir, configFile = null,
  crossAgentMemoryCount = () => null, loopSteers = [], graphSteers = [], judgeVendorPrompts = {},
}) {
  const ctx = { geminiDir };
  const cards = [];
  const add = (c) => { if (c) cards.push(c); };
  const repo = (...p) => path.join(repoRoot, ...p);
  void homeDir; void assetsDir;

  const globalFile = path.join(claudeDir, 'CLAUDE.md');
  const settingsFile = path.join(claudeDir, 'settings.json');

  add(fileCard(ctx, { id: 'machine-global-instructions', group: 'machine', name: 'Global instructions', file: globalFile, controls: 'Who you are to the agent: reporting altitude, git policy, UI rules, learned guards.', readBy: ['claude'], shapes: ['personality', 'guardrail'], note: 'Written by you, and by the learning loop (Learned guards section).' }));
  add(fileCard(ctx, { id: 'machine-global-settings', group: 'machine', kind: 'json', name: 'Global settings', file: settingsFile, controls: 'Permissions, auto mode, effort, plugins, and which hooks run.', readBy: ['claude'], shapes: ['guardrail'], note: 'Keys only: settings can hold secrets, so the text is never served.' }));
  if (statOf(repo('hooks'))?.isDirectory()) {
    add(collectionCard({ id: 'machine-hooks', group: 'machine', name: 'Hooks', controls: 'Code that blocks or injects text around every action.', readBy: ['claude'], shapes: ['guardrail'], folder: repo('hooks') }, hookRows(ctx, repo('hooks'), settingsFile)));
  }
  if (geminiDir) {
    const rows = [];
    for (const [rel, desc] of [['settings.json', 'ide, security'], ['config/config.json', 'plugins, user settings']]) {
      const file = path.join(geminiDir, ...rel.split('/'));
      const st = statOf(file);
      if (st?.isFile() && !isWithheld(file, ctx)) rows.push({ name: rel, description: desc, path: file, size: st.size, mtime: st.mtimeMs, source: '.gemini', openPath: file, openKind: 'file' });
    }
    for (const dir of [geminiDir, path.join(geminiDir, 'config')]) {
      for (const e of readDir(dir)) if (e.isFile() && isCredentialName(e.name)) rows.push(withheldRow(path.join(dir, e.name)));
    }
    if (rows.length) add(collectionCard({ id: 'machine-gemini-settings', group: 'machine', name: 'Gemini settings', controls: 'IDE, security and plugin settings for Gemini and agy.', readBy: ['gemini'], shapes: ['guardrail'], note: 'Credential files in the same folder are listed by name only and never read.' }, rows));
  }

  add(fileCard(ctx, { id: 'project-claude-md', group: 'project', name: 'CLAUDE.md', file: repo('CLAUDE.md'), controls: 'Kernel rules, session control, poisoning safeguards, Slack handoff.', readBy: ['claude'], shapes: ['personality', 'guardrail'] }));
  add(fileCard(ctx, { id: 'project-gemini-md', group: 'project', name: 'GEMINI.md', file: repo('GEMINI.md'), controls: 'Gemini-specific rules and the managed memory block.', readBy: ['gemini'], shapes: ['memory'] }));
  add(fileCard(ctx, { id: 'project-agents-md', group: 'project', name: 'AGENTS.md', file: repo('AGENTS.md'), controls: 'The managed memory block. Antigravity reads it; Claude skips it when a CLAUDE.md exists.', readBy: ['gemini'], shapes: ['memory'] }));
  {
    const rows = [];
    const refs = [['CONTEXT.md', 'Words agents must use'], ['docs/comms-altitude.md', 'How an agent writes to you']];
    for (const e of readDir(repo('docs', 'agents'))) if (/\.md$/i.test(e.name)) refs.push([`docs/agents/${e.name}`, 'Agent reference doc']);
    for (const [rel, desc] of refs) {
      const file = repo(...rel.split('/'));
      const st = statOf(file);
      if (st?.isFile() && !isWithheld(file, ctx)) rows.push({ name: rel, description: desc, path: file, size: st.size, mtime: st.mtimeMs, source: 'repo', openPath: file, openKind: 'file' });
    }
    if (rows.length) add(collectionCard({ id: 'project-reference-docs', group: 'project', name: 'Reference docs', controls: 'Glossary, reporting contract, skill cues, tracker, triage labels, domain.', readBy: ['claude', 'gemini'], shapes: ['personality'] }, rows));
  }
  add(fileCard(ctx, { id: 'project-settings', group: 'project', kind: 'json', name: 'Project settings', file: repo('.claude', 'settings.json'), controls: 'Project permissions and hooks.', readBy: ['claude'], shapes: ['guardrail'] }));

  {
    const projectAgents = new Set(readDir(repo('.claude', 'agents')).map((e) => e.name));
    const rows = mdRows(ctx, path.join(claudeDir, 'agents'), { named: true });
    for (const r of rows) r.overridden = projectAgents.has(path.basename(r.path));
    if (rows.length) add(collectionCard({ id: 'agents-work-agents', group: 'agents', name: 'Work agents', controls: 'The specialists runner sessions dispatch: each file is a system prompt plus tool list.', readBy: ['claude'], shapes: ['personality', 'routing'], folder: path.join(claudeDir, 'agents') }, rows));
  }
  if (agentsDir) {
    const teamDir = path.join(agentsDir, 'huddle');
    add(collectionCard({ id: 'agents-brainstorm-team', group: 'agents', name: 'Brainstorm team', controls: "The huddle's seats: each file is one seat's character, read by the roster.", readBy: ['claude', 'gemini'], shapes: ['personality'], folder: teamDir }, mdRows(ctx, teamDir, { named: true })));
  }
  {
    const groups = [
      skillGroup(ctx, 'Claude, vendored', path.join(claudeDir, 'skills')),
      ...(geminiDir ? [skillGroup(ctx, 'Antigravity IDE', path.join(geminiDir, 'antigravity', 'skills')), skillGroup(ctx, 'agy CLI', path.join(geminiDir, 'config', 'skills'))] : []),
    ].filter((g) => g.row.count > 0);
    if (groups.length) {
      const c = collectionCard({ id: 'agents-skills', group: 'agents', name: 'Skills', controls: 'How a named job is done: grilling, to-spec, the UI skills, research.', readBy: ['claude', 'gemini'], shapes: ['personality'], searchText: groups.flatMap((g) => g.names).join(' '), count: groups.reduce((n, g) => n + g.row.count, 0) }, groups.map((g) => g.row));
      add(c);
    }
  }
  {
    const dir = path.join(claudeDir, 'commands');
    const rows = mdRows(ctx, dir);
    if (rows.length) add(collectionCard({ id: 'agents-slash-commands', group: 'agents', name: 'Slash commands', controls: 'Named prompts you type.', readBy: ['claude'], shapes: ['personality'], folder: dir }, rows));
  }

  const code = (id, name, controls, rel, readBy, shapes, extra = {}) =>
    add(fileCard(ctx, { id, group: 'runtime', kind: 'code', name, controls, file: repo(...rel), readBy, shapes, ...extra }));
  code('runtime-card-prompt', 'Card prompt template', 'How every runner session starts: intent first, altitude, park loop.', ['server', 'lib', 'orchestration', 'queue-runner.js'], ['claude', 'gemini'], ['guardrail', 'routing'], { note: 'A code constant: changing it needs a code change and a deploy.' });
  code('runtime-huddle-seats', 'Huddle seats and rules', "Each seat's engine, model and voice, plus the meeting rules.", ['server', 'lib', 'huddle', 'roster.js'], ['claude', 'gemini'], ['personality', 'routing'], { note: 'A code constant; seat characters are read from the brainstorm team files.' });
  code('runtime-scut-personas', 'SCUT personas', 'Names, roles and Slack faces of the agents.', ['server', 'lib', 'scut', 'bobiverse.js'], ['claude'], ['personality']);
  const promptCard = (id, name, controls, rel, extract, readBy = ['claude']) => {
    const file = repo(...rel);
    let raw; try { raw = fs.readFileSync(file, 'utf8'); } catch { return; }
    const text = extract(raw);
    if (text === null) return;
    add(fileCard(ctx, { id, group: 'runtime', kind: 'code', name, controls, file, readBy, shapes: ['guardrail'], note: `A code constant: changing it needs a code change and a deploy. Source: ${rel.join('/')}`, text }));
  };
  promptCard('runtime-prompt-loop-diagnosis', 'Loop diagnosis prompt', 'What the obligation sweeper asks the model about a failing loop.', ['server', 'lib', 'loops', 'auto-diagnosis.js'], (r) => quotedConst(r, 'SYSTEM'));
  promptCard('runtime-prompt-session-judge', 'Session judge prompts', 'How a finished session is judged and classified.', ['plugins', 'judge', 'adapter.js'], (r) => judgePrompt(r, judgeVendorPrompts));
  promptCard('runtime-prompt-wiki-writer', 'Wiki writer prompt', 'The house voice every wiki page is written in.', ['scripts', 'wiki-build-cli.mjs'], (r) => quotedConst(r, 'WIKI_SYSTEM_PROMPT'), ['gemini']);
  promptCard('runtime-prompt-guard-proposer', 'Guard proposer prompt', 'How candidate guard rules are scored against a recurring failure.', ['plugins', 'gepa', 'propose_guards.py'], (r) => tripleQuoted(r, 'JUDGE_TEMPLATE'));
  promptCard('runtime-prompt-memory-extraction', 'Memory extraction prompt', 'What decides which facts from a session become memories.', ['plugins', 'mem0', 'adapter.js'], mem0Note);
  {
    const block = huddleBlock(configFile);
    if (block && configFile) {
      const st = statOf(configFile);
      const text = JSON.stringify(block, null, 2);
      cards.push({
        id: 'runtime-huddle-config', group: 'runtime', name: 'Huddle config', controls: 'Models, effort, token cap and seat overrides for the huddle.',
        readBy: ['claude', 'gemini'], shapes: ['routing'], note: 'Only the huddle block of config.json is shown.',
        path: configFile, realPath: null, size: text.length, mtime: st?.mtimeMs ?? null,
        badges: { generated: false, link: false, overridden: false, withheld: false },
        outline: Object.keys(block).map((k) => ({ level: 1, text: k, generated: false })), text, truncated: false,
        openPath: configFile, openKind: 'file',
      });
    }
  }

  {
    const guards = (() => { try { return section(fs.readFileSync(globalFile, 'utf8'), 'Learned guards'); } catch { return null; } })();
    const st = statOf(globalFile);
    if (guards && st) {
      cards.push({
        id: 'memory-learned-guards', group: 'memory', name: 'Learned guards', controls: 'Rules the learning loop promoted into the global instructions.',
        readBy: ['claude'], shapes: ['guardrail', 'memory'], note: 'A section of the global instructions, written by GLMPS.',
        path: globalFile, realPath: linkInfo(globalFile).realPath, size: guards.length, mtime: st.mtimeMs,
        badges: { generated: true, link: linkInfo(globalFile).link, overridden: false, withheld: false },
        outline: [], text: guards.slice(0, TEXT_CAP), truncated: guards.length > TEXT_CAP, openPath: globalFile, openKind: 'file',
      });
    }
  }
  {
    const rows = mdRows(ctx, memoryDir, { named: true }).filter((r) => r.withheld || r.name !== 'MEMORY').sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0));
    if (rows.length) add(collectionCard({ id: 'memory-auto-memory', group: 'memory', name: 'Auto-memory', controls: 'Facts and corrections the agent saved for itself, for this project.', readBy: ['claude'], shapes: ['memory'], folder: memoryDir }, rows));
  }
  {
    const count = crossAgentMemoryCount();
    cards.push({
      id: 'memory-cross-agent', group: 'memory', name: 'Cross-agent memory', controls: 'One store, synced into the instruction files of every agent.',
      readBy: ['claude', 'gemini'], shapes: ['memory'], note: 'A store, not a file: it opens in the Memory view where it is edited.',
      path: null, realPath: null, size: null, mtime: null,
      badges: { generated: true, link: false, overridden: false, withheld: false },
      outline: [], text: null, truncated: false, count, openView: 'memory', openPath: null, openKind: null,
    });
  }

  const usedBy = new Map(); const usedByGraphs = new Map();
  const note = (map, key, name) => { if (!map.has(key)) map.set(key, new Set()); map.get(key).add(name); };
  for (const s of loopSteers) note(usedBy, s.card, s.loop);
  for (const s of graphSteers) note(usedByGraphs, s.card, s.graph);
  for (const c of cards) {
    c.usedBy = [...(usedBy.get(c.id) ?? [])].sort();
    c.usedByGraphs = [...(usedByGraphs.get(c.id) ?? [])].sort();
  }

  const groups = GROUPS.map((g) => ({ ...g, cards: cards.filter((c) => c.group === g.id) }));
  return { generatedAt: Date.now(), groups, totals: { cards: cards.length, generated: cards.filter((c) => c.badges.generated).length } };
}
