// server/test/claude-trust.test.js
// Tests for server/lib/orchestration/claude-trust.js - the harness trust record
// that keeps a freshly created or freshly adopted project folder from stalling
// its first interactive session on the trust dialog.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { claudeConfigPath, trustPlan, markTrusted } from '../lib/orchestration/claude-trust.js';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'mc-trust-')); }
function withConfig(obj) {
  const file = path.join(tmp(), '.claude.json');
  fs.writeFileSync(file, JSON.stringify(obj));
  return file;
}

test('claudeConfigPath: GLMPS_CLAUDE_CONFIG_FILE wins outright', () => {
  assert.equal(claudeConfigPath({ GLMPS_CLAUDE_CONFIG_FILE: 'X:/custom.json' }), 'X:/custom.json');
});

test('claudeConfigPath: otherwise it is .claude.json in the home dir', () => {
  const p = claudeConfigPath({}).replace(/\\/g, '/');
  assert.match(p, /\/\.claude\.json$/);
});

// This is the test isolation, not a convenience. Every startServer({ env }) test
// already points GLMPS_CLAUDE_DIR at a temp dir; deriving the config file as that
// dir's sibling means the server's worktree-creation call resolves to a path
// that does not exist under test, so it writes nothing instead of stamping trust
// records for temp worktrees into the operator's real harness config.
test('claudeConfigPath: derives from GLMPS_CLAUDE_DIR as its sibling .json', () => {
  assert.equal(claudeConfigPath({ GLMPS_CLAUDE_DIR: 'X:/tmp/t1/.claude' }), 'X:/tmp/t1/.claude.json');
});

test('claudeConfigPath: a trailing separator on GLMPS_CLAUDE_DIR does not double up', () => {
  assert.equal(claudeConfigPath({ GLMPS_CLAUDE_DIR: 'X:\\tmp\\t1\\.claude\\' }), 'X:/tmp/t1/.claude.json');
});

test('markTrusted: an isolated GLMPS_CLAUDE_DIR with no sibling config writes nothing', () => {
  const dir = path.join(tmp(), '.claude');
  const r = markTrusted({ dirs: ['D:/a'], env: { GLMPS_CLAUDE_DIR: dir } });
  assert.equal(r.ok, false);
  assert.equal(r.changed, false);
  assert.equal(fs.existsSync(dir + '.json'), false, 'no config was created');
});

test('trustPlan: an unknown dir is planned as a new forward-slashed key', () => {
  const plan = trustPlan({ projects: {}, dirs: ['D:\\glmps-site'] });
  assert.deepEqual(plan, [{ key: 'D:/glmps-site', existing: [] }]);
});

test('trustPlan: an already-trusted dir is not planned', () => {
  const projects = { 'D:/glmps-site': { hasTrustDialogAccepted: true } };
  assert.deepEqual(trustPlan({ projects, dirs: ['D:/glmps-site'] }), []);
});

// The harness writes whatever cwd string it was launched with, so the same
// directory shows up as D:/x, d:/x and D:\x. Flipping the entry that is already
// there beats adding a fourth spelling that the harness will never read.
test('trustPlan: an existing untrusted key is flipped in place, not duplicated', () => {
  const projects = { 'd:\\GLMPS-Site': { hasTrustDialogAccepted: false } };
  const plan = trustPlan({ projects, dirs: ['D:/glmps-site'] });
  assert.deepEqual(plan, [{ key: 'D:/glmps-site', existing: ['d:\\GLMPS-Site'] }]);
});

// The live config really does carry D:/glmps alongside
// d:/glmps with different flag values. Picking one spelling would make
// the outcome depend on key order and leave a session launched with the other
// spelling still prompting, so every untrusted spelling is flipped.
test('trustPlan: with several spellings present, every untrusted one is flipped', () => {
  const projects = {
    'D:/glmps': { hasTrustDialogAccepted: true },
    'd:/glmps': { hasTrustDialogAccepted: false },
  };
  const plan = trustPlan({ projects, dirs: ['D:/glmps'] });
  assert.deepEqual(plan, [{ key: 'D:/glmps', existing: ['d:/glmps'] }]);
});

test('trustPlan: order does not matter - the trusted spelling listed last still leaves the other planned', () => {
  const projects = {
    'd:/glmps': { hasTrustDialogAccepted: false },
    'D:/glmps': { hasTrustDialogAccepted: true },
  };
  const plan = trustPlan({ projects, dirs: ['D:/glmps'] });
  assert.deepEqual(plan, [{ key: 'D:/glmps', existing: ['d:/glmps'] }]);
});

test('trustPlan: when every spelling is already trusted, nothing is planned', () => {
  const projects = {
    'D:/glmps': { hasTrustDialogAccepted: true },
    'd:/glmps': { hasTrustDialogAccepted: true },
  };
  assert.deepEqual(trustPlan({ projects, dirs: ['D:/glmps'] }), []);
});

test('markTrusted: flips every untrusted spelling and adds no new key', () => {
  const file = withConfig({ projects: {
    'D:/mc': { hasTrustDialogAccepted: true },
    'd:/mc': { hasTrustDialogAccepted: false },
    'D:\\mc': { hasTrustDialogAccepted: false },
  } });
  const r = markTrusted({ dirs: ['D:/mc'], file, env: {} });
  assert.equal(r.changed, true);
  const after = JSON.parse(fs.readFileSync(file, 'utf8')).projects;
  assert.equal(Object.keys(after).length, 3, 'no fourth spelling was invented');
  for (const k of Object.keys(after)) assert.equal(after[k].hasTrustDialogAccepted, true, k);
});

test('trustPlan: a private dir is never planned', () => {
  const plan = trustPlan({ projects: {}, dirs: ['D:/Vault'], privateDirs: ['D:/Vault'] });
  assert.deepEqual(plan, []);
});

test('trustPlan: a subdirectory of a private dir is never planned', () => {
  const plan = trustPlan({ projects: {}, dirs: ['D:/Vault/2026'], privateDirs: ['D:/Vault'] });
  assert.deepEqual(plan, []);
});

test('markTrusted: writes the flag and preserves every unrelated key', () => {
  const file = withConfig({ numStartups: 7, projects: { 'D:/a': { allowedTools: ['x'] } } });
  const r = markTrusted({ dirs: ['D:/a', 'D:/b'], file, env: {} });
  assert.equal(r.ok, true);
  assert.equal(r.changed, true);
  assert.deepEqual(r.trusted.sort(), ['D:/a', 'D:/b']);
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(after.numStartups, 7, 'unrelated top-level key survives');
  assert.deepEqual(after.projects['D:/a'].allowedTools, ['x'], 'unrelated project key survives');
  assert.equal(after.projects['D:/a'].hasTrustDialogAccepted, true);
  assert.equal(after.projects['D:/b'].hasTrustDialogAccepted, true);
});

test('markTrusted: nothing to do means the file is not rewritten at all', () => {
  const file = withConfig({ projects: { 'D:/a': { hasTrustDialogAccepted: true } } });
  const before = fs.statSync(file).mtimeMs;
  const r = markTrusted({ dirs: ['D:/a'], file, env: {} });
  assert.equal(r.changed, false);
  assert.equal(fs.statSync(file).mtimeMs, before, 'no write when no change');
});

test('markTrusted: a missing config file degrades to ok:false, never throws', () => {
  const r = markTrusted({ dirs: ['D:/a'], file: path.join(tmp(), 'absent.json'), env: {} });
  assert.equal(r.ok, false);
  assert.equal(r.changed, false);
  assert.ok(r.reason);
});

test('markTrusted: malformed JSON degrades to ok:false and leaves the file alone', () => {
  const file = withConfig({});
  fs.writeFileSync(file, '{ not json');
  const r = markTrusted({ dirs: ['D:/a'], file, env: {} });
  assert.equal(r.ok, false);
  assert.equal(fs.readFileSync(file, 'utf8'), '{ not json');
});

test('markTrusted: GLMPS_AUTO_TRUST=0 is a hard opt-out', () => {
  const file = withConfig({ projects: {} });
  const r = markTrusted({ dirs: ['D:/a'], file, env: { GLMPS_AUTO_TRUST: '0' } });
  assert.equal(r.changed, false);
  assert.equal(r.reason, 'disabled');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).projects, {});
});

// The sync is the adoption mechanism: a directory becomes a project the moment
// it lands in additionalDirectories. Trust has to be granted on the same list,
// or the very next interactive session there hits the dialog. This pins the
// list-in / flags-out contract that scripts/sync-project-dirs.mjs relies on.
test('markTrusted: trusts a whole synced dir list in one pass', () => {
  const file = withConfig({ projects: { 'D:/a': { hasTrustDialogAccepted: true } } });
  const dirs = ['D:/a', 'D:/b', 'D:/c'];
  const r = markTrusted({ dirs, file, env: {} });
  assert.equal(r.changed, true);
  assert.deepEqual(r.trusted.sort(), ['D:/b', 'D:/c'], 'only the gaps are reported');
  const after = JSON.parse(fs.readFileSync(file, 'utf8')).projects;
  for (const d of dirs) assert.equal(after[d].hasTrustDialogAccepted, true);
});

test('markTrusted: a private dir in the synced list is skipped, its siblings are not', () => {
  const file = withConfig({ projects: {} });
  const r = markTrusted({ dirs: ['D:/Vault', 'D:/Vaults'], file, privateDirs: ['D:/Vault'], env: {} });
  assert.deepEqual(r.trusted, ['D:/Vaults']);
  const after = JSON.parse(fs.readFileSync(file, 'utf8')).projects;
  assert.equal(after['D:/Vault'], undefined);
});
