// server/test/personality.test.js
// The Personality page's data: five groups walked from injectable paths, built
// against a fixture home, repo and assets tree. Nothing here reads the real ones.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildPersonality, openOnlyRoots } from '../lib/personality/index.js';

const SECRET = 'SENTINEL-DO-NOT-LEAK-7f3a';
const w = (file, text = 'x') => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); return file; };

function fixture({ link = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-personality-'));
  const home = path.join(root, 'home');
  const repo = path.join(root, 'repo');
  const assets = path.join(repo, 'assets');
  const claudeDir = path.join(home, '.claude');
  const geminiDir = path.join(home, '.gemini');
  const memoryDir = path.join(claudeDir, 'projects', 'proj', 'memory');
  const configFile = w(path.join(root, 'config.json'), JSON.stringify({ apiKey: SECRET, huddle: { maxTokens: 321, seats: { riker: { model: 'm' } } } }));

  const globalSrc = w(path.join(assets, 'CLAUDE.global.md'), '# Global\n## Approach\nbe brief\n## Learned guards\nnever guess\n');
  fs.mkdirSync(claudeDir, { recursive: true });
  if (link) fs.symlinkSync(globalSrc, path.join(claudeDir, 'CLAUDE.md'));
  else w(path.join(claudeDir, 'CLAUDE.md'), '# Global\n## Approach\nbe brief\n');
  w(path.join(claudeDir, 'settings.json'), JSON.stringify({ env: { TOKEN: SECRET }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node hooks/done-gate.js' }] }] }, permissions: {} }));
  w(path.join(claudeDir, 'agents', 'debugger.md'), '---\nname: debugger\ndescription: Reproduce first\n---\nbody');
  w(path.join(claudeDir, 'skills', 'grilling', 'SKILL.md'), '---\nname: grilling\ndescription: Grill the plan\n---\n');
  w(path.join(claudeDir, 'skills', 'design-tokens', 'SKILL.md'), 'x');
  w(path.join(claudeDir, 'commands', 'critique-ux.md'), '---\ndescription: UX pass\n---\n');
  w(path.join(memoryDir, 'MEMORY.md'), '- [Pacific](pacific.md) - report times\n');
  w(path.join(memoryDir, 'pacific.md'), '---\nname: Report times in Pacific\ndescription: name the zone\n---\nbody');

  w(path.join(geminiDir, 'settings.json'), JSON.stringify({ ide: {}, security: { auth: SECRET } }));
  w(path.join(geminiDir, 'config', 'config.json'), JSON.stringify({ plugins: [], userSettings: {} }));
  w(path.join(geminiDir, 'oauth_creds.json'), SECRET);
  w(path.join(geminiDir, 'google_accounts.json'), SECRET);
  w(path.join(geminiDir, 'config', 'skills', 'a', 'SKILL.md'), 'x');
  w(path.join(geminiDir, 'antigravity', 'skills', 'b', 'SKILL.md'), 'x');

  w(path.join(repo, 'CLAUDE.md'), '# Rules\n## Kernel\nk\n<!-- GLMPS:BEGIN memory (managed block) -->\n## Cross-Agent Memory\nfacts\n<!-- GLMPS:END memory -->\n');
  w(path.join(repo, 'AGENTS.md'), '<!-- GLMPS:BEGIN memory (managed block) -->\n## Cross-Agent Memory\n<!-- GLMPS:END memory -->\n');
  w(path.join(repo, 'GEMINI.md'), '# Gemini\nplain\n');
  w(path.join(repo, 'CONTEXT.md'), '# Words\n');
  w(path.join(repo, 'docs', 'comms-altitude.md'), '# Altitude\n');
  w(path.join(repo, 'docs', 'agents', 'issue-tracker.md'), '# Tracker\n');
  w(path.join(repo, '.claude', 'settings.json'), '{}');
  w(path.join(repo, 'hooks', 'done-gate.js'), '// gate\n');
  w(path.join(repo, 'hooks', 'api-token-helper.js'), '// withheld by name\n');
  w(path.join(repo, 'server', 'lib', 'orchestration', 'queue-runner.js'), 'export const CARD_PROMPT = 1;\n');
  w(path.join(repo, 'server', 'lib', 'huddle', 'roster.js'), 'export const DEFAULT_SEATS = {};\n');
  w(path.join(repo, 'server', 'lib', 'scut', 'bobiverse.js'), 'export const NAMES = {};\n');

  const agentsDir = path.join(assets, 'agents');
  w(path.join(agentsDir, 'huddle', 'chair.md'), '---\nname: chair\ndescription: Owns the question\npersonality: Calm and brief\n---\nbody');
  w(path.join(agentsDir, 'huddle', 'sre.md'), '---\nname: sre\ndescription: Failure first\npersonality: Pessimist\n---\nbody');

  const opts = { homeDir: home, claudeDir, geminiDir, repoRoot: repo, assetsDir: assets, agentsDir, memoryDir, configFile, crossAgentMemoryCount: () => 7 };
  return { root, opts, home, repo, geminiDir, claudeDir };
}

const flat = (data) => data.groups.flatMap((g) => g.cards);
const card = (data, id) => flat(data).find((c) => c.id === id);

test('five groups come back in reading order, broadest first', () => {
  const { opts } = fixture();
  const data = buildPersonality(opts);
  assert.deepEqual(data.groups.map((g) => g.id), ['machine', 'project', 'agents', 'runtime', 'memory']);
  for (const g of data.groups) assert.ok(g.cards.length > 0, g.id);
});

test('a file card has name, controls, readBy, size, mtime, outline and text', () => {
  const { opts } = fixture();
  const c = card(buildPersonality(opts), 'machine-global-instructions');
  assert.equal(c.name, 'Global instructions');
  assert.ok(c.controls.length > 0);
  assert.deepEqual(c.readBy, ['claude']);
  assert.ok(c.size > 0);
  assert.ok(Number.isFinite(c.mtime));
  assert.deepEqual(c.outline.map((o) => o.text), ['Global', 'Approach']);
  assert.match(c.text, /be brief/);
  assert.equal(c.path, path.join(opts.claudeDir, 'CLAUDE.md'));
});

test('a link shows its real path and a link badge', (t) => {
  let f;
  try { f = fixture({ link: true }); } catch (e) { if (e.code === 'EPERM') return t.skip('symlinks need privilege here'); throw e; }
  const c = card(buildPersonality(f.opts), 'machine-global-instructions');
  assert.equal(c.badges.link, true);
  assert.equal(fs.realpathSync.native(c.realPath), fs.realpathSync.native(path.join(f.repo, 'assets', 'CLAUDE.global.md')));
  assert.equal(c.badges.generated, true, 'the Learned guards section is written by GLMPS');
});

test('the managed memory block marks a file generated; a plain file is not', () => {
  const { opts } = fixture();
  const data = buildPersonality(opts);
  assert.equal(card(data, 'project-claude-md').badges.generated, true);
  assert.equal(card(data, 'project-agents-md').badges.generated, true);
  assert.equal(card(data, 'project-gemini-md').badges.generated, false);
  assert.deepEqual(card(data, 'project-gemini-md').readBy, ['gemini']);
});

test('settings files list their keys but never serve their text', () => {
  const { opts } = fixture();
  const data = buildPersonality(opts);
  const s = card(data, 'machine-global-settings');
  assert.deepEqual(s.outline.map((o) => o.text).sort(), ['env', 'hooks', 'permissions']);
  assert.equal(s.text, null);
  assert.equal(JSON.stringify(data).includes(SECRET), false);
});

test('credential files are listed by name and path only, with no text', () => {
  const { opts, geminiDir } = fixture();
  const data = buildPersonality(opts);
  const g = card(data, 'machine-gemini-settings');
  const withheld = g.rows.filter((r) => r.withheld);
  assert.deepEqual(withheld.map((r) => r.name).sort(), ['google_accounts.json', 'oauth_creds.json']);
  for (const r of withheld) {
    assert.equal(r.text, undefined);
    assert.equal(r.path, path.join(geminiDir, r.name));
  }
  assert.equal(JSON.stringify(data).includes(SECRET), false);
});

test('a token-named file inside a collection is withheld by name', () => {
  const { opts } = fixture();
  const hooks = card(buildPersonality(opts), 'machine-hooks');
  const names = hooks.rows.map((r) => r.name);
  assert.ok(names.includes('done-gate.js'));
  const t = hooks.rows.find((r) => r.name === 'api-token-helper.js');
  assert.equal(t.withheld, true);
  assert.equal(t.description, undefined);
});

test('the huddle config card is the huddle block only; other config keys never leave', () => {
  const { opts } = fixture();
  const data = buildPersonality(opts);
  const c = card(data, 'runtime-huddle-config');
  assert.match(c.text, /321/);
  assert.equal(c.text.includes(SECRET), false);
  assert.equal(c.text.includes('apiKey'), false);
  assert.equal(JSON.stringify(data).includes(SECRET), false);
});

test('runtime cards are the source files of the code constants', () => {
  const { opts, repo } = fixture();
  const data = buildPersonality(opts);
  assert.equal(card(data, 'runtime-card-prompt').path, path.join(repo, 'server', 'lib', 'orchestration', 'queue-runner.js'));
  assert.equal(card(data, 'runtime-huddle-seats').path, path.join(repo, 'server', 'lib', 'huddle', 'roster.js'));
  assert.equal(card(data, 'runtime-scut-personas').path, path.join(repo, 'server', 'lib', 'scut', 'bobiverse.js'));
  assert.match(card(data, 'runtime-card-prompt').text, /CARD_PROMPT/);
});

test('collections are one card with rows: work agents, brainstorm team, skills, commands, auto-memory', () => {
  const { opts, repo } = fixture();
  const data = buildPersonality(opts);
  const agents = card(data, 'agents-work-agents');
  assert.deepEqual(agents.rows.map((r) => r.name), ['debugger']);
  assert.equal(agents.rows[0].description, 'Reproduce first');
  const team = card(data, 'agents-brainstorm-team');
  assert.deepEqual(team.rows.map((r) => r.name), ['chair', 'sre']);
  assert.equal(team.rows[0].description, 'Owns the question');
  assert.equal(team.rows[0].personality, 'Calm and brief');
  assert.equal(team.rows[0].path, path.join(repo, 'assets', 'agents', 'huddle', 'chair.md'));
  const skills = card(data, 'agents-skills');
  assert.equal(skills.rows.find((r) => r.name === 'Claude, vendored').count, 2);
  assert.match(skills.searchText, /grilling/);
  assert.equal(card(data, 'agents-slash-commands').rows.length, 1);
  const mem = card(data, 'memory-auto-memory');
  assert.deepEqual(mem.rows.map((r) => r.name), ['Report times in Pacific']);
});

test('an absent brainstorm team directory is an empty collection, not an error', () => {
  const { opts, repo } = fixture();
  fs.rmSync(path.join(repo, 'assets', 'agents', 'huddle'), { recursive: true });
  const team = card(buildPersonality(opts), 'agents-brainstorm-team');
  assert.deepEqual(team.rows, []);
});

test('cross-agent memory is a store: it opens the Memory view and shows the count', () => {
  const { opts } = fixture();
  const c = card(buildPersonality(opts), 'memory-cross-agent');
  assert.equal(c.openView, 'memory');
  assert.equal(c.count, 7);
});

test('a missing file is skipped without an error', () => {
  const { opts, repo } = fixture();
  fs.rmSync(path.join(repo, 'GEMINI.md'));
  const data = buildPersonality(opts);
  assert.equal(card(data, 'project-gemini-md'), undefined);
});

test('every card has an open target: a path, or the Memory view', () => {
  const { opts } = fixture();
  for (const c of flat(buildPersonality(opts))) {
    assert.ok(c.openPath || c.openView, `${c.id} has no open action`);
  }
});

test('openOnlyRoots names the gemini files and skills the page links to, not the whole folder', () => {
  const { opts, geminiDir } = fixture();
  const roots = openOnlyRoots(opts);
  assert.ok(roots.includes(path.join(geminiDir, 'settings.json')));
  assert.ok(roots.includes(path.join(geminiDir, 'config', 'config.json')));
  assert.ok(roots.includes(path.join(geminiDir, 'config', 'skills')));
  assert.equal(roots.includes(geminiDir), false);
  assert.equal(roots.includes(path.join(geminiDir, 'config')), false);
});


function writePromptSources(repo) {
  w(path.join(repo, 'server', 'lib', 'loops', 'auto-diagnosis.js'), "const SYSTEM = 'You diagnose a failing loop. Do not guess.';\nexport const X = 1;\n");
  w(path.join(repo, 'scripts', 'wiki-build-cli.mjs'), "const WIKI_SYSTEM_PROMPT = 'You write one wiki page.';\n");
  w(path.join(repo, 'plugins', 'judge', 'adapter.js'), "export const TASK_CLASSES = ['debug', 'feature'];\nexport const OUTCOMES = ['succeeded', 'failed'];\nconst prompt = `${fill(TASK_COMPLETION_PROMPT, {})}\n\nAlso classify what the task was about as one of: ${TASK_CLASSES.join(', ')}; and how it ended as one of: ${OUTCOMES.join(', ')}.`;\n");
  w(path.join(repo, 'plugins', 'gepa', 'propose_guards.py'), 'JUDGE_TEMPLATE = """You audit guard rules.\nGuards: {candidate}\n"""\n\ndef bullets(t):\n  return []\n');
  w(path.join(repo, 'plugins', 'mem0', 'adapter.js'), 'const r = await (await mem()).add(messages, { userId: project, infer });\n');
}

test('five prompt cards carry text extracted from their code sources', () => {
  const { opts } = fixture();
  writePromptSources(opts.repoRoot);
  const data = buildPersonality(opts);
  const diag = card(data, 'runtime-prompt-loop-diagnosis');
  assert.equal(diag.group, 'runtime');
  assert.match(diag.text, /^You diagnose a failing loop\. Do not guess\.$/);
  assert.match(diag.note, /^A code constant: /);
  assert.equal(card(data, 'runtime-prompt-wiki-writer').text, 'You write one wiki page.');
  const judge = card(data, 'runtime-prompt-session-judge').text;
  assert.match(judge, /one of: debug, feature; and how it ended as one of: succeeded, failed\./);
  assert.match(card(data, 'runtime-prompt-guard-proposer').text, /^You audit guard rules\.\nGuards: \{candidate\}/);
  const mem = card(data, 'runtime-prompt-memory-extraction').text;
  assert.match(mem, /no custom prompt/i);
});

test('a missing or unparseable prompt source skips its card, nothing is invented', () => {
  const { opts } = fixture();
  writePromptSources(opts.repoRoot);
  fs.rmSync(path.join(opts.repoRoot, 'scripts', 'wiki-build-cli.mjs'));
  w(path.join(opts.repoRoot, 'server', 'lib', 'loops', 'auto-diagnosis.js'), 'export const nothing = 1;\n');
  const data = buildPersonality(opts);
  assert.equal(card(data, 'runtime-prompt-wiki-writer'), undefined);
  assert.equal(card(data, 'runtime-prompt-loop-diagnosis'), undefined);
  assert.ok(card(data, 'runtime-prompt-guard-proposer'));
});

test('usedBy lists the loops and graphs whose steering names a card', () => {
  const { opts } = fixture();
  const data = buildPersonality({
    ...opts,
    loopSteers: [
      { loop: 'launch-queue', card: 'runtime-card-prompt', mode: 'reads' },
      { loop: 'scut-reopen', card: 'runtime-card-prompt', mode: 'reads' },
      { loop: 'launch-queue', card: 'runtime-card-prompt', mode: 'indirect' },
    ],
    graphSteers: [{ graph: 'Machine graph', card: 'project-claude-md', mode: 'writes' }],
  });
  assert.deepEqual(card(data, 'runtime-card-prompt').usedBy, ['launch-queue', 'scut-reopen']);
  assert.deepEqual(card(data, 'project-claude-md').usedByGraphs, ['Machine graph']);
  assert.deepEqual(card(data, 'project-claude-md').usedBy, []);
  assert.deepEqual(card(data, 'machine-global-settings').usedBy, []);
});

test('the session judge card shows the vendored openevals prompts when they are passed in', () => {
  const { opts, repo } = fixture();
  fs.mkdirSync(path.join(repo, 'plugins', 'judge'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'plugins', 'judge', 'adapter.js'), [
    "const TASK_CLASSES = ['feature', 'debug'];",
    "const OUTCOMES = ['done', 'blocked'];",
    'const p = `x\n\nAlso classify what the task was about as one of: ${TASK_CLASSES.join(\', \')}; and how it ended as one of: ${OUTCOMES.join(\', \')}.`;',
  ].join('\n'));
  const withVendor = card(buildPersonality({ ...opts, judgeVendorPrompts: { trajectory: 'TRAJ PROMPT', taskCompletion: 'DONE PROMPT' } }), 'runtime-prompt-session-judge');
  assert.match(withVendor.text, /TRAJ PROMPT/);
  assert.match(withVendor.text, /DONE PROMPT/);
  assert.match(withVendor.text, /feature, debug/);
  const without = card(buildPersonality(opts), 'runtime-prompt-session-judge');
  assert.match(without.text, /not shown here/);
});
