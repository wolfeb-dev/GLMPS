// apps/shell/test/gitops-allow-realpath.test.js
// Card glmps-2-0-147: after the cutover ~/.glmps is a junction to
// ~/.glmps2. Cards recorded before it carry the old spelling and the app
// refused every one ("card cwd must be inside the worktrees root") because the
// allowlist compared path text. With a resolver it compares where paths land.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateGitopsOp, canonicalPath } from '../src/lib/gitops-allow.js';

const SID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const realpath = fs.realpathSync.native;

function layout() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-allow-real-'));
  const state = path.join(home, '.glmps2');
  const legacy = path.join(home, '.glmps');
  const wt = path.join(state, 'runner', 'worktrees');
  for (const d of [path.join(wt, 'glmps-2.0', 'glmps-2-0-81'), path.join(state, 'role-settings'), path.join(state, 'outside')]) fs.mkdirSync(d, { recursive: true });
  fs.symlinkSync(state, legacy, 'junction');
  const cleanup = () => {
    try { fs.rmdirSync(legacy); } catch { try { fs.unlinkSync(legacy); } catch { /* gone */ } }
    fs.rmSync(home, { recursive: true, force: true });
  };
  return { home, state, legacy, wt, cleanup };
}

const card = (state, cwd) => ({
  kind: 'card', cwd, sessionId: SID, resume: false, timeoutMs: 1800000,
  settings: path.join(state, 'role-settings', 'worker-glmps-2-0-81.json'),
  promptFile: path.join(state, 'runner', 'glmps-2-0-81.prompt.md'),
});

test('a card recorded under the legacy junction is accepted against the current worktrees root', () => {
  const L = layout();
  try {
    const old = path.join(L.legacy, 'runner', 'worktrees', 'glmps-2.0', 'glmps-2-0-81');
    const textOnly = validateGitopsOp(card(L.state, old), { roots: { repos: [] }, stateDir: L.state, worktreesDir: L.wt });
    assert.equal(textOnly.ok, false, 'without a resolver the old spelling is refused, as before');
    assert.match(textOnly.reason, /card cwd must be inside the worktrees root/);
    const v = validateGitopsOp(card(L.state, old), { roots: { repos: [] }, stateDir: L.state, worktreesDir: L.wt, realpath });
    assert.equal(v.ok, true, v.reason);
    assert.equal(v.recipe.cwd, old, 'the recipe keeps the path the record gave');
  } finally { L.cleanup(); }
});

test('a shell whose settings still name the legacy state folder accepts records spelled under the new one', () => {
  const L = layout();
  try {
    const cwd = path.join(L.wt, 'glmps-2.0', 'glmps-2-0-81');
    const v = validateGitopsOp(card(L.state, cwd), {
      roots: { repos: [] }, stateDir: L.legacy, worktreesDir: path.join(L.legacy, 'runner', 'worktrees'), realpath,
    });
    assert.equal(v.ok, true, v.reason);
  } finally { L.cleanup(); }
});

test('a worktree that does not exist yet resolves through its existing ancestor', () => {
  const L = layout();
  try {
    const fresh = path.join(L.legacy, 'runner', 'worktrees', 'p', 'new-card');
    assert.equal(canonicalPath(fresh, realpath), path.join(realpath(L.wt), 'p', 'new-card'));
    const v = validateGitopsOp({ kind: 'git', cwd: L.state, args: ['worktree', 'add', fresh] }, { roots: { repos: [L.state] }, stateDir: L.state, worktreesDir: L.wt, realpath });
    assert.equal(v.ok, true, v.reason);
  } finally { L.cleanup(); }
});

test('resolving still refuses a path that lands outside the roots, a link out, and dot segments', () => {
  const L = layout();
  try {
    const out = validateGitopsOp(card(L.state, path.join(L.state, 'outside', 'x')), { roots: { repos: [] }, stateDir: L.state, worktreesDir: L.wt, realpath });
    assert.equal(out.ok, false);
    const escape = path.join(L.wt, 'glmps-2.0', 'escape');
    fs.symlinkSync(path.join(L.state, 'outside'), escape, 'junction');
    try {
      const v = validateGitopsOp(card(L.state, escape), { roots: { repos: [] }, stateDir: L.state, worktreesDir: L.wt, realpath });
      assert.equal(v.ok, false, 'a link inside the worktrees root that points out is refused');
    } finally { try { fs.rmdirSync(escape); } catch { fs.unlinkSync(escape); } }
    const dots = `${L.wt}${path.sep}..${path.sep}..${path.sep}outside`;
    assert.equal(canonicalPath(dots, realpath), dots, 'a dot-dot path is not resolved, so the existing checks see it');
    // A UNC path whose share path spells the worktrees root must not pass as the local folder.
    const unc = `\\\\${L.wt.replace(/^[A-Za-z]:[\\/]/, '')}\\glmps-2.0\\glmps-2-0-81`;
    assert.equal(canonicalPath(unc, realpath), unc, 'a UNC path is not resolved');
    assert.equal(validateGitopsOp(card(L.state, unc), { roots: { repos: [] }, stateDir: L.state, worktreesDir: L.wt, realpath }).ok, false, 'a UNC card cwd is refused');
  } finally { L.cleanup(); }
});

// glmps-2-0-155: the UNC refusal above held on Windows only because the share
// path lacks the drive letter; on Linux the same string normalised to the
// root and passed. A device-namespace spelling keeps the drive, skips the
// resolver, and so carried a link that points out of the root past the check.
test('a path spelled with a leading double separator is refused whatever it normalises to', () => {
  const L = layout();
  try {
    const escape = path.join(L.wt, 'glmps-2.0', 'escape');
    fs.symlinkSync(path.join(L.state, 'outside'), escape, 'junction');
    try {
      for (const p of [`\\\\.\\${escape}`, `//${escape.replace(/^[\\/]+/, '')}`, `\\\\${escape.replace(/^[\\/]+/, '')}`]) {
        assert.equal(validateGitopsOp(card(L.state, p), { roots: { repos: [] }, stateDir: L.state, worktreesDir: L.wt, realpath }).ok, false, `${p} is refused`);
      }
    } finally { try { fs.rmdirSync(escape); } catch { fs.unlinkSync(escape); } }
  } finally { L.cleanup(); }
});
