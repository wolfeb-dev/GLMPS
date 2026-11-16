import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FORKED, forkSkillMarkdown, findPluginInstall, planSync, UPDATE_EVERY_MS } from '../../hooks/lib/pocock-sync-core.js';

const SKILL = '---\nname: to-spec\ndescription: Turn the conversation into a spec.\ndisable-model-invocation: true\n---\n\nBody line.\n';

test('the forked set is the ten user-only skills agents need to invoke', () => {
  assert.deepEqual(FORKED, [
    'to-spec', 'to-tickets', 'implement', 'implement-spec',
    'grill-me', 'grill-with-docs', 'triage', 'wayfinder', 'improve-codebase-architecture', 'handoff',
  ]);
});

test('forkSkillMarkdown removes only the user-only flag', () => {
  const out = forkSkillMarkdown(SKILL);
  assert.equal(out, '---\nname: to-spec\ndescription: Turn the conversation into a spec.\n---\n\nBody line.\n');
  assert.equal(forkSkillMarkdown(out), out, 'idempotent');
  const crlf = SKILL.replace(/\n/g, '\r\n');
  assert.doesNotMatch(forkSkillMarkdown(crlf), /disable-model-invocation/);
  const inBody = '---\nname: x\n---\n\ndisable-model-invocation: true is explained here\n';
  assert.equal(forkSkillMarkdown(inBody), inBody, 'only the frontmatter is touched');
});

test('findPluginInstall reads the user-scope entry and returns null on bad input', () => {
  const json = { plugins: { 'mattpocock-skills@claude-plugins-official': [
    { scope: 'project', installPath: 'P', version: '0.1.0', gitCommitSha: 'p' },
    { scope: 'user', installPath: 'C:\\x\\1.3.1', version: '1.3.1', gitCommitSha: 'abc' },
  ] } };
  assert.deepEqual(findPluginInstall(json), { path: 'C:\\x\\1.3.1', version: '1.3.1', sha: 'abc' });
  assert.equal(findPluginInstall(null), null);
  assert.equal(findPluginInstall({ plugins: {} }), null);
  assert.equal(findPluginInstall({ plugins: { 'mattpocock-skills@claude-plugins-official': 'nope' } }), null);
});

const install = { path: 'P', version: '1.3.1', sha: 'abc' };
const all = (n) => FORKED.includes(n);

test('planSync copies every fork on a new version and nothing on the same sha', () => {
  const fresh = planSync({ install, state: null, upstreamHas: all, now: 0 });
  assert.deepEqual(fresh.copy, FORKED);
  const same = planSync({ install, state: { sha: 'abc', lastUpdateCheck: 0 }, upstreamHas: all, now: 1 });
  assert.deepEqual(same.copy, []);
  const moved = planSync({ install, state: { sha: 'old', lastUpdateCheck: 0 }, upstreamHas: all, now: 1 });
  assert.deepEqual(moved.copy, FORKED);
  const deleted = planSync({ install, state: { sha: 'abc', lastUpdateCheck: 0 }, upstreamHas: all, localHas: (n) => n !== 'to-tickets', now: 1 });
  assert.deepEqual(deleted.copy, ['to-tickets'], 'a deleted local copy comes back without waiting for a new version');
});

test('planSync reports a fork missing upstream and does not delete it', () => {
  const r = planSync({ install, state: null, upstreamHas: (n) => n !== 'implement-spec', now: 0 });
  assert.deepEqual(r.missing, ['implement-spec']);
  assert.ok(!r.copy.includes('implement-spec'));
  assert.equal(r.remove, undefined, 'there is no remove action');
});

test('planSync asks for an upstream update only after 24 h', () => {
  assert.equal(UPDATE_EVERY_MS, 24 * 60 * 60 * 1000);
  assert.equal(planSync({ install, state: { sha: 'abc', lastUpdateCheck: 1000 }, upstreamHas: all, now: 1000 + UPDATE_EVERY_MS - 1 }).runUpdate, false);
  assert.equal(planSync({ install, state: { sha: 'abc', lastUpdateCheck: 1000 }, upstreamHas: all, now: 1000 + UPDATE_EVERY_MS }).runUpdate, true);
  assert.equal(planSync({ install, state: null, upstreamHas: all, now: 5 }).runUpdate, true);
  assert.equal(planSync({ install: null, state: null, upstreamHas: all, now: 5 }).runUpdate, false, 'an uninstalled plugin is never reinstalled behind the operator');
  assert.deepEqual(planSync({ install: null, state: null, upstreamHas: all, now: 5 }).copy, []);
});

test('runSync copies the forks out of a plugin install with the flag removed, and spawns the update once', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pocock-sync-'));
  const plugin = path.join(home, 'cache', 'mp', '1.3.1');
  const rels = FORKED.filter((n) => n !== 'implement-spec').map((n) => `./skills/engineering/${n}`);
  for (const rel of rels) {
    fs.mkdirSync(path.join(plugin, rel, 'agents'), { recursive: true });
    fs.writeFileSync(path.join(plugin, rel, 'SKILL.md'), SKILL.replace('to-spec', path.basename(rel)));
    fs.writeFileSync(path.join(plugin, rel, 'agents', 'openai.yaml'), 'x: 1\n');
  }
  fs.mkdirSync(path.join(plugin, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(plugin, '.claude-plugin', 'plugin.json'), JSON.stringify({ skills: rels }));
  fs.mkdirSync(path.join(home, 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(home, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: {
    'mattpocock-skills@claude-plugins-official': [{ scope: 'user', installPath: plugin, version: '1.3.1', gitCommitSha: 'abc' }] } }));
  const prev = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = home;
  try {
    const { runSync } = await import('../../hooks/pocock-sync.js');
    let spawned = 0;
    const r1 = runSync({ now: 1000, spawnUpdate: () => { spawned++; } });
    assert.deepEqual(r1.plan.missing, ['implement-spec']);
    const copied = fs.readFileSync(path.join(home, 'skills', 'to-tickets', 'SKILL.md'), 'utf8');
    assert.doesNotMatch(copied, /disable-model-invocation/);
    assert.match(copied, /name: to-tickets/);
    assert.ok(fs.existsSync(path.join(home, 'skills', 'to-tickets', 'agents', 'openai.yaml')));
    const r2 = runSync({ now: 2000, spawnUpdate: () => { spawned++; } });
    assert.deepEqual(r2.plan.copy, []);
    assert.equal(spawned, 1, 'the upstream update runs once a day, not every session');
    assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'pocock-sync.json'), 'utf8')).sha, 'abc');
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prev;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('the upstream-update spawn is not detached on win32 (no console-less child), detached elsewhere', async () => {
  const { defaultSpawnUpdate } = await import('../../hooks/pocock-sync.js');
  const seen = [];
  const spawnImpl = (file, args, opts) => { seen.push(opts); return { unref() {} }; };
  defaultSpawnUpdate({ spawnImpl, platform: 'win32' });
  defaultSpawnUpdate({ spawnImpl, platform: 'linux' });
  assert.equal(seen[0].detached, false);
  assert.equal(seen[0].windowsHide, true);
  assert.equal(seen[1].detached, true);
});
