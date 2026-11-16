// server/test/launch-roots.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchCwdCheck, launchCwdChecker } from '../lib/governance/launch-roots.js';

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

test('F15: a cwd inside (or equal to) a configured root is allowed; a sibling with a shared prefix is not', () => {
  const root = tmp('mc-lr-root-');
  const inside = path.join(root, 'proj'); fs.mkdirSync(inside);
  assert.deepEqual(launchCwdCheck(root, [root]), { ok: true });
  assert.deepEqual(launchCwdCheck(inside, [root]), { ok: true });
  const sibling = `${root}x`; fs.mkdirSync(sibling);
  const r = launchCwdCheck(sibling, [root]);
  assert.equal(r.ok, false);
  assert.match(r.reason, /not inside a configured project root/);
});

test('F15: a cwd that does not exist yet is judged lexically (the route then falls back to its default cwd)', () => {
  const root = tmp('mc-lr-root-');
  assert.deepEqual(launchCwdCheck(path.join(root, 'gone'), [root]), { ok: true });
  assert.equal(launchCwdCheck(path.join(os.tmpdir(), `mc-lr-nowhere-${process.pid}`), [root]).ok, false);
});

test('F15: a link inside a root that resolves outside every root is refused', (t) => {
  const root = tmp('mc-lr-root-');
  const outside = tmp('mc-lr-outside-');
  const link = path.join(root, 'escape');
  try { fs.symlinkSync(outside, link, 'junction'); }
  catch (e) { t.skip(`cannot create a junction/symlink here (${e.code})`); return; }
  const r = launchCwdCheck(link, [root]);
  assert.equal(r.ok, false);
  assert.match(r.reason, /outside every configured project root/);
});

test('Review focus 5: a root configured in another spelling (8.3 short name, junction) is matched by real path', () => {
  const base = tmp('mc-lr-alias-');
  const longDir = path.join(base, 'longname'); fs.mkdirSync(path.join(longDir, 'proj'), { recursive: true });
  const shortRoot = path.join(base, 'LONGNA~1');
  const realpath = (p) => {
    const r = path.resolve(p);
    if (r.toLowerCase().startsWith(shortRoot.toLowerCase())) return longDir + r.slice(shortRoot.length);
    return r;
  };
  assert.deepEqual(launchCwdCheck(path.join(longDir, 'proj'), [shortRoot], { realpath }), { ok: true });
  if (process.platform === 'win32') {
    assert.deepEqual(launchCwdCheck(path.join(longDir, 'proj').toUpperCase(), [longDir.toLowerCase()], { realpath: (p) => path.resolve(p) }), { ok: true }, 'case-insensitive on win32');
  }
});

test('F15: an empty or non-array root list refuses everything', () => {
  assert.equal(launchCwdCheck(os.tmpdir(), []).ok, false);
  assert.equal(launchCwdCheck(os.tmpdir(), null).ok, false);
});

// glmps-2-0-runtime-86: /api/config checked every known project dir against
// ~45 roots and resolved every root again per dir (857 ms at boot).
test('launchCwdChecker resolves the roots once for many dirs, with the same verdicts', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-lr-many-'));
  try {
    const roots = [path.join(tmp, 'a'), path.join(tmp, 'b')];
    for (const r of roots) fs.mkdirSync(r);
    const dirs = [path.join(tmp, 'a', 'x'), path.join(tmp, 'b'), path.join(tmp, 'c')];
    let calls = 0;
    const realpath = (p) => { calls++; return fs.realpathSync.native(p); };
    const check = launchCwdChecker(roots, { realpath });
    const verdicts = dirs.map((d) => check(d));
    assert.equal(calls, roots.length + dirs.length);
    assert.deepEqual(verdicts, dirs.map((d) => launchCwdCheck(d, roots)));
    assert.deepEqual(verdicts.map((v) => v.ok), [true, true, false]);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
