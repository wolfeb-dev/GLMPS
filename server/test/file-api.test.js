// server/test/file-api.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { FileApi } from '../lib/governance/file-api.js';

const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });
function mkTmp() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-')); tmpDirs.push(d); return d; }

function setup() {
  const root = mkTmp();
  const undoDir = mkTmp();
  const f = path.join(root, 'CLAUDE.md');
  fs.writeFileSync(f, 'original');
  return { root, undoDir, f, api: new FileApi([root], undoDir) };
}

test('read returns content + hash; paths outside roots rejected', () => {
  const { api, f } = setup();
  const r = api.read(f);
  assert.equal(r.content, 'original');
  assert.equal(r.hash, crypto.createHash('sha256').update('original').digest('hex'));
  assert.throws(() => api.read('C:\\Windows\\system.ini'), /not allowed/i);
  assert.throws(() => api.read(path.join(f, '..', '..', 'escape.txt')), /not allowed/i);
});

test('case-insensitive root match on Windows-style paths', () => {
  const { api, f } = setup();
  const upper = f.toUpperCase();
  // resolves inside root despite case difference; read should not throw allowlist error
  let threw = false;
  try { api.read(upper); } catch (e) { threw = /not allowed/i.test(e.message); }
  assert.equal(threw, false);
});

test('save with matching hash writes and stores undo; mismatch throws conflict', () => {
  const { api, f } = setup();
  const { hash } = api.read(f);
  api.save(f, 'updated', hash);
  assert.equal(fs.readFileSync(f, 'utf-8'), 'updated');
  assert.throws(() => api.save(f, 'clobber', hash), /conflict/i); // stale hash now
  api.undo(f);
  assert.equal(fs.readFileSync(f, 'utf-8'), 'original');
});

test('save with force=true skips conflict check; new file saves without hash', () => {
  const { api, f, root } = setup();
  api.save(f, 'forced', 'wrong-hash', { force: true });
  assert.equal(fs.readFileSync(f, 'utf-8'), 'forced');
  const fresh = path.join(root, 'new.md');
  api.save(fresh, 'hello', null);
  assert.equal(fs.readFileSync(fresh, 'utf-8'), 'hello');
});

test('alternate data stream paths are rejected', () => {
  const { api, f } = setup();
  assert.throws(() => api.read(f + ':hidden'), /not allowed/i);
  assert.throws(() => api.save(f + ':hidden', 'x', null), /not allowed/i);
});

test('credential/secret files are denied for read and write even inside a root', () => {
  const root = mkTmp();
  const undoDir = mkTmp();
  const api = new FileApi([root], undoDir);
  for (const name of ['.credentials.json', 'id_rsa', 'server.pem', 'private.key', '.env']) {
    const f = path.join(root, name);
    fs.writeFileSync(f, 'secret');
    assert.throws(() => api.read(f), /not allowed/i, `${name} read should be denied`);
    assert.throws(() => api.save(f, 'x', null, { force: true }), /not allowed/i, `${name} write should be denied`);
  }
});

test('a symlink alias to a sensitive file is refused even though its own name is not sensitive', (t) => {
  const root = mkTmp();
  const undoDir = mkTmp();
  const secret = path.join(root, '.env');
  fs.writeFileSync(secret, 'SECRET=x');
  const alias = path.join(root, 'notes.txt');
  try { fs.symlinkSync(secret, alias); }
  catch (e) { t.skip(`symlink creation needs elevated privilege on this host: ${e.code ?? e.message}`); return; }
  const api = new FileApi([root], undoDir);
  assert.throws(() => api.read(alias), /not allowed/i);
});

test('a hardlink alias to a sensitive file is refused via read(), and the message carries no path', () => {
  const root = mkTmp();
  const undoDir = mkTmp();
  const secret = path.join(root, '.env');
  fs.writeFileSync(secret, 'SECRET=x');
  const alias = path.join(root, 'alias.txt'); // an innocuous name; hardlinks need no elevated privilege
  fs.linkSync(secret, alias);
  const api = new FileApi([root], undoDir);
  assert.throws(() => api.read(alias), (e) => /not allowed/i.test(e.message) && !e.message.includes(root));
});

test('a hardlinked file is refused for save() too (moving the check into _check covers every caller)', () => {
  const root = mkTmp();
  const undoDir = mkTmp();
  const target = path.join(root, 'shared.txt');
  fs.writeFileSync(target, 'x');
  const alias = path.join(root, 'alias2.txt');
  fs.linkSync(target, alias);
  const api = new FileApi([root], undoDir);
  assert.throws(() => api.save(alias, 'y', null, { force: true }), /not allowed/i);
});

test('an ordinary single-link file is unaffected by the hardlink check: reads and saves normally', () => {
  const { api, f } = setup();
  const r = api.read(f);
  assert.equal(r.content, 'original');
  api.save(f, 'updated-again', r.hash);
  assert.equal(fs.readFileSync(f, 'utf-8'), 'updated-again');
});

// by default <stateDir>/launch-token sits outside every
// root this server configures FileApi with (P.claudeDir, antigravity dirs,
// the operator's own editableRoots, REPO_ROOT, the config file) - but an
// operator's editableRoots (or a nonstandard GLMPS_STATE_DIR placed inside
// one of those roots) COULD cover it, and the token's basename does not
// otherwise match any existing sensitive pattern. Denied by name now,
// the same defense-in-depth as .credentials.json/.env - independent of
// whatever roots end up configured.
test('V-2: launch-token is denied for read and write even inside a root (same defense-in-depth as .env/.credentials.json)', () => {
  const root = mkTmp();
  const undoDir = mkTmp();
  const api = new FileApi([root], undoDir);
  const f = path.join(root, 'launch-token');
  fs.writeFileSync(f, 'a'.repeat(64));
  assert.throws(() => api.read(f), /not allowed/i, 'launch-token read should be denied');
  assert.throws(() => api.save(f, 'x', null, { force: true }), /not allowed/i, 'launch-token write should be denied');
});

test('files under a sensitive directory segment (.ssh/.aws) are denied', () => {
  const root = mkTmp();
  const undoDir = mkTmp();
  fs.mkdirSync(path.join(root, '.ssh'), { recursive: true });
  const f = path.join(root, '.ssh', 'config');
  fs.writeFileSync(f, 'Host *');
  const api = new FileApi([root], undoDir);
  assert.throws(() => api.read(f), /not allowed/i);
});

test('ordinary editable files (CLAUDE.md) remain allowed', () => {
  const { api, f } = setup();
  assert.doesNotThrow(() => api.read(f));
});

// the open-in-editor route used to call
// read() purely to reuse its allowlist check, discarding the content - which
// meant an allowlisted-but-missing/wrong-kind file surfaced as a raw
// readFileSync throw (an uncaught ENOENT/EISDIR) instead of a clean, named
// refusal. `allows()` is the allowlist decision ALONE, with no file I/O at
// all, so a caller can validate WHERE a path may be before deciding whether
// (or how) to touch its bytes.
test('allows: allowlist-only check, no file read - succeeds even for a file that does not exist yet', () => {
  const { api, root } = setup();
  const notYetWritten = path.join(root, 'not-created-yet.md');
  const r = api.allows(notYetWritten);
  assert.equal(r.ok, true);
});

test('allows: refuses paths outside the roots and sensitive files, by name, without throwing', () => {
  const { api, root } = setup();
  const outside = api.allows('C:\\Windows\\system.ini');
  assert.equal(outside.ok, false);
  assert.match(outside.reason, /not allowed/i);
  const sensitive = api.allows(path.join(root, '.env'));
  assert.equal(sensitive.ok, false);
  assert.match(sensitive.reason, /not allowed/i);
});

test('undo is one-level: second consecutive undo throws', () => {
  const { api, f } = setup();
  const { hash } = api.read(f);
  api.save(f, 'v2', hash);
  api.undo(f);
  assert.throws(() => api.undo(f));
});

// .git internals (config can carry a token remote URL or a
// credential.helper store) are never readable or writable through FileApi.
test('S-F2: files under a .git segment are denied for read and save', () => {
  const root = mkTmp();
  const undoDir = mkTmp();
  fs.mkdirSync(path.join(root, '.git'));
  const f = path.join(root, '.git', 'config');
  fs.writeFileSync(f, '[remote "origin"]\n\turl = https://token@example.invalid/x.git\n');
  const api = new FileApi([root], undoDir);
  assert.throws(() => api.read(f), /not allowed/i);
  assert.throws(() => api.save(f, 'x', null, { force: true }), /not allowed/i);
  assert.throws(() => api.read(path.join(root, '.GIT', 'config')), /not allowed/i);
});
