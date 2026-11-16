// server/test/graphify-integrations.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  skillDir, skillRefreshPlan, refreshGraphifySkills,
  missingRepoIntegrations, installRepoIntegrations, REPO_INTEGRATIONS,
} from '../lib/observability/graphify-integrations.js';

const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });
function tmp() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-gint-')); tmpDirs.push(d); return d; }
function write(file, text) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); }
function stampSkill(home, platform, version, env = {}) {
  const dir = skillDir(platform, { home, env });
  write(path.join(dir, 'SKILL.md'), '# graphify');
  if (version) write(path.join(dir, '.graphify_version'), `${version}\n`);
}

test('skillDir: claude under ~/.claude (or CLAUDE_CONFIG_DIR), agents under ~/.agents', () => {
  assert.equal(skillDir('claude', { home: '/h' }), path.join('/h', '.claude', 'skills', 'graphify'));
  assert.equal(skillDir('claude', { home: '/h', env: { CLAUDE_CONFIG_DIR: '/cfg' } }), path.join('/cfg', 'skills', 'graphify'));
  assert.equal(skillDir('agents', { home: '/h' }), path.join('/h', '.agents', 'skills', 'graphify'));
});

test('skillRefreshPlan: the 0.9.51 agents copy under a 0.9.95 package is refreshed, the current claude copy is not', () => {
  const home = tmp();
  stampSkill(home, 'claude', '0.9.95');
  stampSkill(home, 'agents', '0.9.51');
  assert.deepEqual(skillRefreshPlan({ installed: '0.9.95', home }), [{ platform: 'agents', from: '0.9.51' }]);
});

test('skillRefreshPlan: missing and unstamped copies are installed', () => {
  const home = tmp();
  stampSkill(home, 'agents', null);
  assert.deepEqual(skillRefreshPlan({ installed: '0.9.95', home }), [
    { platform: 'claude', from: null }, { platform: 'agents', from: null },
  ]);
});

test('skillRefreshPlan: a copy stamped newer than the package is kept unless the app rolled back', () => {
  const home = tmp();
  stampSkill(home, 'claude', '0.9.95');
  stampSkill(home, 'agents', '0.9.95');
  assert.deepEqual(skillRefreshPlan({ installed: '0.9.90', home }), []);
  assert.deepEqual(skillRefreshPlan({ installed: '0.9.90', home, allowDowngrade: true }), [
    { platform: 'claude', from: '0.9.95' }, { platform: 'agents', from: '0.9.95' },
  ]);
});

test('skillRefreshPlan: no installed version or no home plans nothing', () => {
  assert.deepEqual(skillRefreshPlan({ installed: null, home: tmp() }), []);
  assert.deepEqual(skillRefreshPlan({ installed: '0.9.95', home: null }), []);
});

test('refreshGraphifySkills runs install --platform per plan row and never throws', async () => {
  const calls = [];
  const runCmd = async (bin, args) => {
    calls.push([bin, ...args]);
    if (args[2] === 'agents') throw new Error('spawn refused');
    return { code: 0, stdout: '', stderr: '' };
  };
  const out = await refreshGraphifySkills({ runCmd, plan: [{ platform: 'claude', from: '0.9.90' }, { platform: 'agents', from: '0.9.51' }] });
  assert.deepEqual(calls, [['graphify', 'install', '--platform', 'claude'], ['graphify', 'install', '--platform', 'agents']]);
  assert.deepEqual(out.map(r => [r.platform, r.ok]), [['claude', true], ['agents', false]]);
  assert.match(out[1].detail, /spawn refused/);
});

function fullyIntegrated(root) {
  write(path.join(root, 'CLAUDE.md'), '# repo\n\n## graphify\n\nrules\n');
  write(path.join(root, '.claude', 'settings.json'), '{"hooks":{"PreToolUse":[{"command":"[ -f graphify-out/graph.json ]"}]}}');
  write(path.join(root, 'AGENTS.md'), '## graphify\n');
  write(path.join(root, 'GEMINI.md'), '## graphify\n');
  write(path.join(root, '.github', 'copilot-instructions.md'), 'intro\n## graphify\n');
}

test('missingRepoIntegrations: an empty repo misses all four, a fully integrated one none', () => {
  const empty = tmp();
  assert.deepEqual(missingRepoIntegrations(empty), ['claude', 'agents-md', 'gemini', 'copilot']);
  const full = tmp();
  fullyIntegrated(full);
  assert.deepEqual(missingRepoIntegrations(full), []);
});

test('missingRepoIntegrations: a graphify mention without the section, or CLAUDE.md without the hook, is missing', () => {
  const root = tmp();
  fullyIntegrated(root);
  write(path.join(root, '.github', 'copilot-instructions.md'), '- graphify: run `graphify update .`\n');
  fs.rmSync(path.join(root, '.claude', 'settings.json'));
  assert.deepEqual(missingRepoIntegrations(root), ['claude', 'copilot']);
});

test('missingRepoIntegrations: the 0.9.95 hook-guard PreToolUse hook counts as present', () => {
  const root = tmp();
  fullyIntegrated(root);
  write(path.join(root, '.claude', 'settings.json'), '{"hooks":{"PreToolUse":[{"hooks":[{"command":"graphify hook-guard search"}]}]}}');
  assert.deepEqual(missingRepoIntegrations(root), []);
});

test('installRepoIntegrations runs graphify installers in the root, only for what is missing', async () => {
  const done = tmp();
  fullyIntegrated(done);
  const partial = tmp();
  fullyIntegrated(partial);
  fs.rmSync(path.join(partial, 'GEMINI.md'));
  fs.rmSync(path.join(partial, 'AGENTS.md'));
  const calls = [];
  const runCmd = async (bin, args, opts) => {
    calls.push({ cmd: [bin, ...args].join(' '), cwd: opts?.cwd });
    return args[0] === 'gemini' ? { code: 1, stdout: '', stderr: 'boom' } : { code: 0, stdout: '', stderr: '' };
  };
  const { results, touchedSkills } = await installRepoIntegrations({ roots: [done, partial], runCmd });
  assert.deepEqual(calls, [
    { cmd: 'graphify aider install', cwd: partial },
    { cmd: 'graphify gemini install', cwd: partial },
  ]);
  assert.deepEqual(results, [{ root: partial, installed: ['agents-md'], failed: [{ id: 'gemini', detail: 'boom' }] }]);
  assert.equal(touchedSkills, true);
});

test('installRepoIntegrations with nothing missing runs nothing and touches no skill', async () => {
  const root = tmp();
  fullyIntegrated(root);
  const { results, touchedSkills } = await installRepoIntegrations({ roots: [root], runCmd: async () => { throw new Error('must not run'); } });
  assert.deepEqual(results, []);
  assert.equal(touchedSkills, false);
});

test('REPO_INTEGRATIONS uses graphify installers that write the four repo files', () => {
  assert.deepEqual(REPO_INTEGRATIONS.map(i => i.args.join(' ')), ['claude install', 'aider install', 'gemini install', 'vscode install']);
});

// Ship repos carry their integrations in source (graphify plan task 9); the
// app never installs into them, so a dropped section would go unnoticed.
test.skip('the runtime repo (a ship repo) carries every graphify agent integration in source', () => {
  const repoRoot = path.resolve(import.meta.dirname, '..', '..');
  assert.deepEqual(missingRepoIntegrations(repoRoot), []);
});
