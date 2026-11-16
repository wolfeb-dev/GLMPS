// server/test/asset-deploy.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deployAssets } from '../lib/orchestration/asset-deploy.js';

const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });
function mkTmp() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-')); tmpDirs.push(d); return d; }

function seedAssets(assetsDir) {
  fs.mkdirSync(path.join(assetsDir, 'agents'), { recursive: true });
  fs.writeFileSync(path.join(assetsDir, 'agents', 'backtest-skeptic.md'), 'agent A');
  fs.mkdirSync(path.join(assetsDir, 'skills', 'strategy-architect'), { recursive: true });
  fs.writeFileSync(path.join(assetsDir, 'skills', 'strategy-architect', 'SKILL.md'), 'skill A');
  fs.writeFileSync(path.join(assetsDir, 'CLAUDE.global.md'), 'global rules');
}

test('deployAssets places all managed items; targets carry source content', () => {
  const root = mkTmp();
  const assetsDir = path.join(root, 'assets'), claudeDir = path.join(root, 'claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  seedAssets(assetsDir);
  const r = deployAssets({ assetsDir, claudeDir });
  assert.equal(fs.readFileSync(path.join(claudeDir, 'agents', 'backtest-skeptic.md'), 'utf8'), 'agent A');
  assert.equal(fs.readFileSync(path.join(claudeDir, 'skills', 'strategy-architect', 'SKILL.md'), 'utf8'), 'skill A');
  assert.equal(fs.readFileSync(path.join(claudeDir, 'CLAUDE.md'), 'utf8'), 'global rules');
  assert.equal(r.linked.length + r.copied.length, 3);
  assert.equal(r.failed.length, 0);
});

test('deployAssets is idempotent on re-run', () => {
  const root = mkTmp();
  const assetsDir = path.join(root, 'assets'), claudeDir = path.join(root, 'claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  seedAssets(assetsDir);
  deployAssets({ assetsDir, claudeDir });
  const r2 = deployAssets({ assetsDir, claudeDir });
  assert.equal(r2.skipped.length, 3);
  assert.equal(r2.linked.length + r2.copied.length + r2.backedUp.length, 0);
});

test('deployAssets backs up a conflicting real file before placing', () => {
  const root = mkTmp();
  const assetsDir = path.join(root, 'assets'), claudeDir = path.join(root, 'claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  seedAssets(assetsDir);
  fs.writeFileSync(path.join(claudeDir, 'CLAUDE.md'), 'OLD personal rules');
  const r = deployAssets({ assetsDir, claudeDir });
  assert.equal(fs.readFileSync(path.join(claudeDir, 'CLAUDE.md'), 'utf8'), 'global rules');
  assert.equal(r.backedUp.length, 1);
  assert.equal(fs.readFileSync(r.backedUp[0].backup, 'utf8'), 'OLD personal rules');
});

function seedPack(addonsDir, name, { manifest, agent = `${name}-agent.md`, skill = `${name}-skill`, globalMd = false } = {}) {
  const dir = path.join(addonsDir, name);
  fs.mkdirSync(path.join(dir, 'agents'), { recursive: true });
  if (manifest !== null) fs.writeFileSync(path.join(dir, 'addon.json'), manifest ?? JSON.stringify({ name, description: 'test pack' }));
  if (agent) fs.writeFileSync(path.join(dir, 'agents', agent), `agent ${name}`);
  if (skill) {
    fs.mkdirSync(path.join(dir, 'skills', skill), { recursive: true });
    fs.writeFileSync(path.join(dir, 'skills', skill, 'SKILL.md'), `skill ${name}`);
  }
  if (globalMd) fs.writeFileSync(path.join(dir, 'CLAUDE.global.md'), 'pack global');
  return dir;
}

function setup() {
  const root = mkTmp();
  const assetsDir = path.join(root, 'assets'), claudeDir = path.join(root, 'claude'), addonsDir = path.join(root, 'addons');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.mkdirSync(addonsDir, { recursive: true });
  seedAssets(assetsDir);
  return { root, assetsDir, claudeDir, addonsDir };
}

function snapshot(dir) {
  const out = [];
  const walk = (d) => {
    for (const n of fs.readdirSync(d).sort()) {
      const p = path.join(d, n);
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink()) out.push(`L ${p} -> ${fs.readlinkSync(p)}`);
      else if (st.isDirectory()) { out.push(`D ${p}`); walk(p); }
      else out.push(`F ${p} ${fs.readFileSync(p, 'utf8')}`);
    }
  };
  walk(dir);
  return out;
}

test('deployAssets links an add-on pack agents and skills into claudeDir', () => {
  const { assetsDir, claudeDir, addonsDir } = setup();
  seedPack(addonsDir, 'extra');
  const r = deployAssets({ assetsDir, claudeDir, addonsDir });
  assert.equal(fs.readFileSync(path.join(claudeDir, 'agents', 'extra-agent.md'), 'utf8'), 'agent extra');
  assert.equal(fs.readFileSync(path.join(claudeDir, 'skills', 'extra-skill', 'SKILL.md'), 'utf8'), 'skill extra');
  assert.equal(r.linked.length + r.copied.length, 5);
  assert.equal(r.failed.length, 0);
  assert.deepEqual(r.addons.map((a) => a.name), ['extra']);
});

test('deployAssets with a missing addonsDir is the core-only behaviour', () => {
  const { assetsDir, claudeDir, root } = setup();
  const r = deployAssets({ assetsDir, claudeDir, addonsDir: path.join(root, 'nope') });
  assert.equal(r.linked.length + r.copied.length, 3);
  assert.equal(r.failed.length, 0);
});

test('an add-on pack with a missing, unparsable or misnamed manifest fails by name and core plus other packs still link', () => {
  const { assetsDir, claudeDir, addonsDir } = setup();
  seedPack(addonsDir, 'a-missing', { manifest: null });
  seedPack(addonsDir, 'b-garbage', { manifest: '{not json' });
  seedPack(addonsDir, 'c-misnamed', { manifest: JSON.stringify({ name: 'other' }) });
  seedPack(addonsDir, 'd-good');
  const r = deployAssets({ assetsDir, claudeDir, addonsDir });
  assert.equal(r.failed.length, 3);
  assert.deepEqual(r.failed.map((f) => f.dest), ['a-missing', 'b-garbage', 'c-misnamed'].map((n) => path.join(addonsDir, n)));
  assert.match(r.failed[0].error, /addon\.json/);
  assert.match(r.failed[2].error, /other/);
  assert.ok(fs.existsSync(path.join(claudeDir, 'agents', 'd-good-agent.md')));
  assert.ok(fs.existsSync(path.join(claudeDir, 'CLAUDE.md')));
  for (const n of ['a-missing', 'b-garbage', 'c-misnamed']) assert.ok(!fs.existsSync(path.join(claudeDir, 'agents', `${n}-agent.md`)));
});

test('an add-on item colliding with a core destination fails, core wins', () => {
  const { assetsDir, claudeDir, addonsDir } = setup();
  seedPack(addonsDir, 'extra', { agent: 'backtest-skeptic.md' });
  const r = deployAssets({ assetsDir, claudeDir, addonsDir });
  assert.equal(fs.readFileSync(path.join(claudeDir, 'agents', 'backtest-skeptic.md'), 'utf8'), 'agent A');
  assert.equal(r.failed.length, 1);
  assert.equal(r.failed[0].dest, path.join(claudeDir, 'agents', 'backtest-skeptic.md'));
  assert.ok(r.failed[0].error.includes(path.join(addonsDir, 'extra', 'agents', 'backtest-skeptic.md')));
  assert.ok(fs.existsSync(path.join(claudeDir, 'skills', 'extra-skill')), 'the other items in the pack still link');
});

test('two packs claiming one destination: the earlier (sorted) wins, the later fails naming the colliding source', () => {
  const { assetsDir, claudeDir, addonsDir } = setup();
  seedPack(addonsDir, 'alpha', { agent: 'shared.md' });
  seedPack(addonsDir, 'beta', { agent: 'shared.md' });
  const r = deployAssets({ assetsDir, claudeDir, addonsDir });
  assert.equal(fs.readFileSync(path.join(claudeDir, 'agents', 'shared.md'), 'utf8'), 'agent alpha');
  assert.equal(r.failed.length, 1);
  assert.ok(r.failed[0].error.includes(path.join(addonsDir, 'alpha', 'agents', 'shared.md')));
});

test('CLAUDE.global.md inside a pack is ignored', () => {
  const { assetsDir, claudeDir, addonsDir } = setup();
  seedPack(addonsDir, 'extra', { globalMd: true });
  deployAssets({ assetsDir, claudeDir, addonsDir });
  assert.equal(fs.readFileSync(path.join(claudeDir, 'CLAUDE.md'), 'utf8'), 'global rules');
});

test('dryRun writes nothing and plans link, skip, relink, collision and invalid-pack', () => {
  const { root, assetsDir, claudeDir, addonsDir } = setup();
  seedPack(addonsDir, 'extra');
  seedPack(addonsDir, 'zbad', { manifest: '{' });
  seedPack(addonsDir, 'zdup', { agent: 'extra-agent.md', skill: null });
  deployAssets({ assetsDir, claudeDir, addonsDir });
  // point the extra skill somewhere else so it must be relinked
  const skillDest = path.join(claudeDir, 'skills', 'extra-skill');
  const elsewhere = path.join(root, 'elsewhere');
  fs.mkdirSync(elsewhere);
  fs.rmSync(skillDest, { recursive: true, force: true });
  fs.symlinkSync(elsewhere, skillDest, 'junction');
  const before = snapshot(root);
  const r = deployAssets({ assetsDir, claudeDir, addonsDir, dryRun: true });
  assert.deepEqual(snapshot(root), before);
  const acts = (dest) => r.planned.filter((p) => p.dest === dest).map((p) => p.action);
  assert.deepEqual(acts(skillDest), ['relink']);
  assert.deepEqual(acts(path.join(claudeDir, 'agents', 'extra-agent.md')).sort(), ['collision', 'skip']);
  assert.deepEqual(acts(path.join(claudeDir, 'CLAUDE.md')), ['skip']);
  assert.deepEqual(acts(path.join(addonsDir, 'zbad')), ['invalid-pack']);
  assert.ok(r.failed.length >= 2);
  for (const k of ['linked', 'skipped', 'backedUp', 'copied', 'failed']) assert.ok(Array.isArray(r[k]));
});

test('dryRun on a fresh claudeDir plans link and creates nothing', () => {
  const { root, assetsDir, addonsDir } = setup();
  const claudeDir = path.join(root, 'fresh-claude');
  seedPack(addonsDir, 'extra');
  const r = deployAssets({ assetsDir, claudeDir, addonsDir, dryRun: true });
  assert.ok(!fs.existsSync(claudeDir));
  assert.equal(r.planned.filter((p) => p.action === 'link').length, 5);
});

// Rule 6 and 8 of the dev/prod promotion: a rollback or a deleted skill leaves
// a link in ~/.claude whose source is gone. Junctions, so no symlink privilege.
function dangle(storeDir, claudeDir, name) {
  const src = path.join(storeDir, 'skills', name);
  fs.mkdirSync(src, { recursive: true });
  fs.mkdirSync(path.join(claudeDir, 'skills'), { recursive: true });
  const dest = path.join(claudeDir, 'skills', name);
  fs.symlinkSync(src, dest, 'junction');
  fs.rmSync(src, { recursive: true, force: true });
  return dest;
}

test('prune removes links into the asset and add-on stores whose source is gone, and nothing else', () => {
  const { root, assetsDir, claudeDir, addonsDir } = setup();
  seedPack(addonsDir, 'extra');
  deployAssets({ assetsDir, claudeDir, addonsDir });
  const goneCore = dangle(assetsDir, claudeDir, 'gone-core');
  const gonePack = dangle(path.join(addonsDir, 'extra'), claudeDir, 'gone-pack');
  const foreign = dangle(path.join(root, 'elsewhere'), claudeDir, 'foreign');
  const ownDir = path.join(claudeDir, 'skills', 'own');
  fs.mkdirSync(ownDir);
  const r = deployAssets({ assetsDir, claudeDir, addonsDir, prune: true });
  assert.deepEqual(r.pruned.sort(), [goneCore, gonePack].sort());
  assert.equal(fs.lstatSync(goneCore, { throwIfNoEntry: false }), undefined);
  assert.equal(fs.lstatSync(gonePack, { throwIfNoEntry: false }), undefined);
  assert.ok(fs.lstatSync(foreign).isSymbolicLink(), 'a link outside the managed stores is not ours to remove');
  assert.ok(fs.statSync(ownDir).isDirectory());
  assert.ok(fs.existsSync(path.join(claudeDir, 'skills', 'strategy-architect', 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(claudeDir, 'skills', 'extra-skill', 'SKILL.md')));
  assert.equal(r.failed.length, 0);
});

test('without prune a dangling managed link is left in place', () => {
  const { assetsDir, claudeDir } = setup();
  const gone = dangle(assetsDir, claudeDir, 'gone');
  const r = deployAssets({ assetsDir, claudeDir });
  assert.deepEqual(r.pruned, []);
  assert.ok(fs.lstatSync(gone).isSymbolicLink());
});

test('dryRun with prune plans the removal and writes nothing', () => {
  const { root, assetsDir, claudeDir } = setup();
  deployAssets({ assetsDir, claudeDir });
  const gone = dangle(assetsDir, claudeDir, 'gone');
  const before = snapshot(root);
  const r = deployAssets({ assetsDir, claudeDir, dryRun: true, prune: true });
  assert.deepEqual(snapshot(root), before);
  assert.deepEqual(r.pruned, [gone]);
  assert.deepEqual(r.planned.filter((p) => p.action === 'prune').map((p) => p.dest), [gone]);
});

test('prune on a claudeDir with no agents or skills dirs is a no-op', () => {
  const { root, assetsDir } = setup();
  const r = deployAssets({ assetsDir, claudeDir: path.join(root, 'fresh'), dryRun: true, prune: true });
  assert.deepEqual(r.pruned, []);
});
