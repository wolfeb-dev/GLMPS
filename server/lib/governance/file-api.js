// server/lib/governance/file-api.js
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const sha = s => crypto.createHash('sha256').update(s).digest('hex');

// Secret/credential material is never readable or writable through the dashboard
// file API, even when it lives inside an allowed editing root (the roots include
// ~/.claude, so .credentials.json would otherwise be exfiltratable, and a
// poisoned write could plant SSH keys / .env secrets). Basename + path-segment
// deny, independent of the root allowlist below.
// launch-token (server/lib/governance/launch-token.js)
// sits outside every root this server configures FileApi with by default,
// but an operator's editableRoots (or a nonstandard GLMPS_STATE_DIR placed
// inside one of those roots) could cover it, and its basename otherwise
// matched no existing pattern here. Denied the same way as .env/
// .credentials.json, independent of whatever roots end up configured.
const DENY_BASENAME = /^(\.credentials\.json|\.env(\..+)?|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|launch-token|local-session-key|access-token|actor-tokens\.json|.+\.(pem|key|ppk|pfx|p12|asc))$/i;
// .git too (its config can hold a token remote URL or a
// credential.helper store); no editor flow opens a .git file.
const DENY_SEGMENT = new Set(['.ssh', '.aws', '.gnupg', '.gpg', '.git']);

function isSensitive(resolved) {
  // Windows drops trailing dots and spaces from a name, so 'access-token.'
  // opens the token file; match on the stripped form.
  const strip = (s) => (process.platform === 'win32' ? s.replace(/[. ]+$/, '') : s);
  const base = strip(path.basename(resolved));
  if (DENY_BASENAME.test(base)) return true;
  return resolved.toLowerCase().split(/[\\/]/).some(seg => DENY_SEGMENT.has(strip(seg)));
}

// The fully resolved form of p: symlinks followed and (on Windows) 8.3
// short names expanded. A path that does not exist resolves its nearest
// existing ancestor and re-appends the missing tail.
//
// only a component that truly does not exist (ENOENT,
// ENOTDIR) falls back to its parent. A component that exists as a link but
// cannot be resolved (R5: a dangling symlink or junction, which a write
// would follow and create the target of) and any other failure (R6: EACCES,
// ELOOP) is refused outright, never treated as "not there yet".
function realWithTail(p) {
  const tail = [];
  let cur = p;
  for (;;) {
    try { return path.join(fs.realpathSync.native(cur), ...tail); }
    catch (e) {
      if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw new Error(`Path not allowed (unresolvable: ${e.code ?? 'error'})`);
      let isLink = false;
      try { isLink = fs.lstatSync(cur).isSymbolicLink(); } catch { /* truly absent */ }
      if (isLink) throw new Error('Path not allowed (dangling link)');
      const parent = path.dirname(cur);
      if (parent === cur) return p;
      tail.unshift(path.basename(cur));
      cur = parent;
    }
  }
}

// \\host\share, //host/share, \\?\..., \\.\... A realpath or stat of one
// is an outbound SMB call that offers the operator's NTLM credentials, so it
// is refused on the raw string, before anything touches the filesystem.
const UNC_OR_DEVICE = /^[\\/]{2}/;

export class FileApi {
  constructor(roots, undoDir) {
    this.roots = roots.map(r => path.resolve(r).toLowerCase());
    this.undoDir = undoDir;
  }

  _check(p) {
    if (typeof p !== 'string' || !p) throw new Error('Path not allowed: (empty)');
    if (UNC_OR_DEVICE.test(p)) throw new Error('Path not allowed (UNC or device path)');
    const resolved = path.resolve(p);
    if (UNC_OR_DEVICE.test(resolved)) throw new Error('Path not allowed (UNC or device path)');
    if (resolved.indexOf(':', 2) !== -1) throw new Error(`Path not allowed: ${resolved}`);
    if (isSensitive(resolved)) throw new Error(`Path not allowed (sensitive): ${resolved}`);
    // root containment on the LEXICAL path, before realpath/stat, so a
    // path outside every root never reaches the filesystem at all.
    const low = resolved.toLowerCase();
    const root = this.roots.find(r => low === r || low.startsWith(r + path.sep));
    if (root === undefined) throw new Error(`Path not allowed: ${resolved}`);
    // Belt and braces for S-F1: on win32 a tilde-digit segment below the
    // root is refused outright, even where nothing exists yet to resolve
    // (the root itself may legitimately be configured in short form).
    if (process.platform === 'win32' && low.slice(root.length).split(/[\\/]/).some(seg => /~\d/.test(seg)))
      throw new Error('Path not allowed (short name)');
    // A symlink can alias an innocuous-looking name to a sensitive target
    // (notes.txt -> ../.env): the basename/segment check above only sees the
    // link's own name, never what it points at. Resolve through any symlink
    // in the chain (a no-op for a plain file, and for a path that does not
    // exist yet, e.g. a new save()) and check the real target too.
    // the NATIVE realpath, because on Windows the JS
    // realpathSync does not expand 8.3 short names (ENV~1 stays ENV~1, so
    // a request for it read .env). For a path that does not exist yet (a
    // new save target) the nearest existing ancestor is resolved instead,
    // so a new file under SSH~1 is seen as a file under .ssh.
    const real = realWithTail(resolved);
    if (real !== resolved && isSensitive(real)) throw new Error(`Path not allowed (sensitive): ${resolved}`);
    // A hardlink is a second directory entry for the SAME inode: there is no
    // separate "real path" to resolve the way a symlink has, so neither check
    // above can see that notes.txt IS a sensitive file's data. Refuse any
    // hardlinked regular file outright, for
    // every caller of _check (read, save, undo, assertAllowed) rather than
    // just the one caller that first hit this. The message is deliberately
    // generic (no resolved path): every _check error can reach an HTTP
    // client's response body verbatim (see server.js's /api/file routes).
    let st = null;
    try { st = fs.statSync(resolved); } catch { /* does not exist yet: nothing to check */ }
    if (st && st.isFile() && st.nlink > 1) throw new Error('Path not allowed (hardlink)');
    // Containment is by the REQUESTED path on purpose (controller ruling,
    // the operator's ~/.claude is built from links
    // (CLAUDE.md and agents/*.md into the assets repo, skills/* into
    // ~/.agents/skills), so a link inside a root may point outside every
    // root. Its real target is still held to the sensitive checks above,
    // and a dangling or unresolvable link is refused (realWithTail).
    return resolved;
  }

  // Public form of the allowlist and secret check, for callers that read a
  // file through something other than read() (the surface file diff reads the
  // committed side with git show).
  assertAllowed(p) { return this._check(p); }

  // the allowlist decision ALONE, with no
  // filesystem access at all - server.js's open-in-editor route used to call
  // read() purely to reuse this check, reading (and discarding) the whole
  // file just to find out whether it was allowed. A caller can now validate
  // WHERE a path may be before doing anything with its bytes, and a missing
  // or wrong-kind but ALLOWED file surfaces through a separate, named check
  // (shellSafePath's "not found" / "not a file") instead of a raw
  // readFileSync throw.
  allows(p) {
    try { this._check(p); return { ok: true }; }
    catch (e) { return { ok: false, reason: e.message }; }
  }

  read(p) {
    const f = this._check(p);
    const content = fs.readFileSync(f, 'utf-8');
    return { path: f, content, hash: sha(content), mtimeMs: fs.statSync(f).mtimeMs };
  }

  save(p, content, expectedHash, { force = false } = {}) {
    const f = this._check(p);
    let prev = null;
    try { prev = fs.readFileSync(f, 'utf-8'); } catch {}
    if (!force && prev !== null && sha(prev) !== expectedHash)
      throw new Error('Conflict: file changed on disk since it was loaded');
    if (prev !== null) {
      fs.mkdirSync(this.undoDir, { recursive: true });
      fs.writeFileSync(path.join(this.undoDir, sha(f.toLowerCase()) + '.undo'), prev);
    }
    fs.writeFileSync(f, content);
    return { hash: sha(content) };
  }

  undo(p) {
    const f = this._check(p);
    const u = path.join(this.undoDir, sha(f.toLowerCase()) + '.undo');
    const prev = fs.readFileSync(u, 'utf-8'); // throws if no undo exists
    fs.writeFileSync(f, prev);
    fs.rmSync(u);
    return { hash: sha(prev) };
  }
}
