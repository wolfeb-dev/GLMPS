// server/lib/governance/launch-token.js
// the shell trusts whatever answers on the loopback
// kernel URL - another local account binding the same port while the real
// service is down could otherwise serve launch records (and the allowlist
// from its own /api/config) just as convincingly as the real kernel. A
// per-install token, created once and known only inside this install's own
// state dir, is what proves the shell is actually talking to ITS kernel;
// required (a header) on GET /api/launches, claim and result.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const TOKEN_RE = /^[0-9a-f]{64}$/;

// fileName: scan 2026-10-15 F2 keeps its local-session key the same way, in its own file.
export function readOrCreateLaunchToken(stateDir, { fsImpl = fs, randomBytes = crypto.randomBytes, fileName = 'launch-token' } = {}) {
  const file = path.join(stateDir, fileName);
  let existing = null;
  try {
    existing = fsImpl.readFileSync(file, 'utf8').trim();
  } catch (e) {
    // ENOENT (genuinely missing) is the only read error
    // that means "create one" - any OTHER error (EACCES, a locked file,
    // ...) reading an EXISTING file must be a NAMED failure, never
    // silently treated as missing. The original bare catch minted (and
    // overwrote) a fresh token on ANY read failure, which would have
    // invisibly invalidated every shell already holding the old one over
    // a transient permissions glitch.
    if (e?.code !== 'ENOENT') throw new Error(`${fileName} file could not be read (${e?.code || e?.message || e}): ${file}`);
  }
  if (existing !== null && TOKEN_RE.test(existing)) return existing;
  const token = randomBytes(32).toString('hex');
  fsImpl.mkdirSync(stateDir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  // exclusive ('wx') and owner-only (0o600) AT CREATION,
  // not via a later chmod - closes the brief window a world-readable tmp
  // file used to sit in between writeFileSync and chmodSync, and 'wx'
  // fails loudly instead of silently clobbering a same-named tmp file
  // another concurrent minting attempt (a second kernel process racing
  // this one) left behind.
  fsImpl.writeFileSync(tmp, token, { mode: 0o600, flag: 'wx' });
  fsImpl.renameSync(tmp, file);
  // Readable by the operator account only, where the platform supports it
  // (POSIX chmod; Windows ACLs are not controlled this way, so this is
  // best-effort hardening, never the actual security boundary - the
  // random 32-byte token itself is).
  try { fsImpl.chmodSync(file, 0o600); } catch { /* best effort */ }
  return token;
}
