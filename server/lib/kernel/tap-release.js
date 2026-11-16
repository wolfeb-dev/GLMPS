// server/lib/kernel/tap-release.js
// The published tap release (server-and-client-tap task 7): <stateDir>/tap-dist/
// holds the signed installer, the signed update archive and release.json, written
// by `npm run release -- --publish <stateDir>` in apps/tap. The SHA-256 the
// dashboard shows is recomputed from the file on disk (cached by size and mtime),
// so a file swapped after publishing is refused rather than served under the
// published hash.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const RELEASE_DIR = 'tap-dist';
export const RELEASE_FILE = 'release.json';
export const INSTALLER_FILE = 'glmps-tap-setup.exe';
export const UPDATE_FILE = 'glmps-tap-update.zip';
export const ARTIFACTS = Object.freeze({ installer: INSTALLER_FILE, update: UPDATE_FILE });
const HEX64 = /^[0-9a-f]{64}$/;
const THUMB = /^[0-9A-F]{40}$/;

function hashFile(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('error', reject).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex')));
  });
}

const fail = (status, error) => ({ ok: false, status, error });

export function createTapRelease({ stateDir, hash = hashFile }) {
  const dir = path.join(stateDir, RELEASE_DIR);
  const cache = new Map();

  async function digest(file, st) {
    const hit = cache.get(file);
    if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.sha256;
    const sha256 = await hash(file);
    cache.set(file, { size: st.size, mtimeMs: st.mtimeMs, sha256 });
    return sha256;
  }

  /** {ok:true, release, files:{installer,update}} or {ok:false, status, error}. */
  async function load() {
    let raw;
    try { raw = fs.readFileSync(path.join(dir, RELEASE_FILE), 'utf8'); } catch (e) {
      if (e.code === 'ENOENT') return fail(404, 'no tap release is published; run `npm run release -- --test-cert --publish <stateDir>` in apps/tap');
      return fail(500, `release document unreadable (${e.code ?? 'error'})`);
    }
    let rel;
    try { rel = JSON.parse(raw); } catch { return fail(500, 'release document is not JSON'); }
    if (!rel || typeof rel !== 'object' || typeof rel.version !== 'string') return fail(500, 'release document has no version');
    const s = rel.signing;
    if (!s || !THUMB.test(String(s.thumbprint)) || (s.mode !== 'test' && s.mode !== 'release')) return fail(500, 'release document has no signer');
    const files = {};
    for (const [kind, name] of Object.entries(ARTIFACTS)) {
      const a = rel.artifacts?.[kind];
      if (!a || a.file !== name || !Number.isInteger(a.size) || !HEX64.test(String(a.sha256))) return fail(500, `release document's ${kind} entry is malformed`);
      const file = path.join(dir, name);
      let st;
      try { st = fs.statSync(file); } catch { return fail(500, `${name} is missing from the published release`); }
      if (st.size !== a.size || (await digest(file, st)) !== a.sha256) return fail(500, `${name} does not match the published SHA-256; publish the release again`);
      files[kind] = { file, size: a.size, sha256: a.sha256 };
    }
    return { ok: true, release: rel, files };
  }

  return { load, dir };
}
