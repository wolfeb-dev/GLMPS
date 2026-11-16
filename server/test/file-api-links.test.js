// server/test/file-api-links.test.js
// Task 16 fix round 2:
// a save through a DANGLING symlink (notes.txt -> .ssh/authorized_keys,
//      not yet existing) passed every check: the native realpath failed, the
//      walk-up re-appended the link's own innocent name, and the write then
//      followed the link and planted the key. The real target of any link is
//      held to the sensitive-name, segment and 8.3 checks. Containment is
//      by the REQUESTED path on purpose: the
//      operator's ~/.claude is built from links into other repos, so a link
//      inside a root may point outside every root when its real target is
//      not sensitive.
// any realpath failure (EACCES, ELOOP) was treated like "does not exist
//      yet"; only ENOENT/ENOTDIR may fall back to the parent.
// Symlink cases skip with a reason when the host cannot create symlinks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FileApi } from '../lib/governance/file-api.js';

const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });
function mkTmp() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-lnk-')); tmpDirs.push(d); return d; }

function trySymlink(t, target, link, type) {
  try { fs.symlinkSync(target, link, type); return true; }
  catch (e) { t.skip(`cannot create a ${type ?? 'file'} symlink on this host: ${e.code ?? e.message}`); return false; }
}

test('R5: a save through a dangling symlink to a sensitive file is refused and plants nothing', (t) => {
  const root = mkTmp();
  fs.mkdirSync(path.join(root, '.ssh'));
  const target = path.join(root, '.ssh', 'authorized_keys');
  const link = path.join(root, 'notes.txt');
  if (!trySymlink(t, target, link, 'file')) return;
  const api = new FileApi([root], mkTmp());
  assert.throws(() => api.save(link, 'ssh-ed25519 AAAA attacker', null), /not allowed/i);
  assert.equal(fs.existsSync(target), false, 'no key was planted through the link');
});

test('R5: a dangling directory link in the parent chain is refused too', (t) => {
  const root = mkTmp();
  const link = path.join(root, 'cfg');
  if (!trySymlink(t, path.join(root, '.aws'), link, 'junction')) return;
  const api = new FileApi([root], mkTmp());
  assert.throws(() => api.save(path.join(link, 'credentials'), 'x', null), /not allowed/i);
  assert.equal(fs.existsSync(path.join(root, '.aws')), false);
});

// Controller ruling: ~/.claude is built from links into other
// repos, so a link inside a root may point outside every root as long as
// its real target is not sensitive. Containment stays by requested path.
test('R5: a link inside a root to a non-sensitive file outside every root is readable and savable', (t) => {
  const root = mkTmp();
  const outside = mkTmp();
  fs.writeFileSync(path.join(outside, 'CLAUDE.md'), 'assets repo copy');
  const fileLink = path.join(root, 'CLAUDE.md');
  if (!trySymlink(t, path.join(outside, 'CLAUDE.md'), fileLink, 'file')) return;
  const dirLink = path.join(root, 'skills');
  if (!trySymlink(t, outside, dirLink, 'junction')) return;
  const api = new FileApi([root], mkTmp());
  const r = api.read(fileLink);
  assert.equal(r.content, 'assets repo copy');
  api.save(fileLink, 'edited from the dashboard', r.hash);
  assert.equal(fs.readFileSync(path.join(outside, 'CLAUDE.md'), 'utf8'), 'edited from the dashboard');
  api.save(path.join(dirLink, 'new-skill.md'), 'x', null);
  assert.equal(fs.readFileSync(path.join(outside, 'new-skill.md'), 'utf8'), 'x');
});

test('R5: a link inside a root to a sensitive file outside every root is refused', (t) => {
  const root = mkTmp();
  const outside = mkTmp();
  fs.writeFileSync(path.join(outside, '.env'), 'SECRET=x');
  fs.mkdirSync(path.join(outside, '.ssh'));
  const fileLink = path.join(root, 'notes.txt');
  if (!trySymlink(t, path.join(outside, '.env'), fileLink, 'file')) return;
  const dirLink = path.join(root, 'keys');
  if (!trySymlink(t, path.join(outside, '.ssh'), dirLink, 'junction')) return;
  const api = new FileApi([root], mkTmp());
  assert.throws(() => api.read(fileLink), /not allowed/i);
  assert.throws(() => api.save(fileLink, 'y', null, { force: true }), /not allowed/i);
  assert.throws(() => api.save(path.join(dirLink, 'authorized_keys'), 'k', null), /not allowed/i);
  assert.equal(fs.existsSync(path.join(outside, '.ssh', 'authorized_keys')), false);
});

test('R5: a dangling link is refused for read as well as save', (t) => {
  const root = mkTmp();
  const link = path.join(root, 'gone.md');
  if (!trySymlink(t, path.join(root, 'missing.md'), link, 'file')) return;
  const api = new FileApi([root], mkTmp());
  assert.throws(() => api.read(link), /not allowed/i);
  assert.throws(() => api.save(link, 'x', null), /not allowed/i);
});

test('R5: an in-root link to an innocent in-root file still works', (t) => {
  const root = mkTmp();
  fs.writeFileSync(path.join(root, 'real.md'), 'hello');
  const link = path.join(root, 'alias.md');
  if (!trySymlink(t, path.join(root, 'real.md'), link, 'file')) return;
  const api = new FileApi([root], mkTmp());
  assert.equal(api.read(link).content, 'hello');
});

test('R6: a link loop (ELOOP, not ENOENT) is refused rather than treated as not-yet-existing', (t) => {
  const root = mkTmp();
  const a = path.join(root, 'a.txt'); const b = path.join(root, 'b.txt');
  if (!trySymlink(t, b, a, 'file')) return;
  if (!trySymlink(t, a, b, 'file')) return;
  const api = new FileApi([root], mkTmp());
  assert.throws(() => api.save(a, 'x', null), /not allowed/i);
  assert.throws(() => api.read(path.join(a, 'child')), /not allowed/i);
});

test('R6: a brand-new file and a new file in a brand-new folder still save (ENOENT falls back)', () => {
  const root = mkTmp();
  const api = new FileApi([root], mkTmp());
  api.save(path.join(root, 'new.md'), 'x', null);
  assert.equal(api.allows(path.join(root, 'not', 'yet', 'here.md')).ok, true);
});
