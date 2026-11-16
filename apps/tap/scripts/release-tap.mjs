// npm run release -- (--test-cert | --thumbprint <T> --timestamp <URL>) [--publish <stateDir>]
// Builds the tap bundle, pins the signer, signs a catalog over every file, checks
// it the way the installer will, zips it as the tap update, compiles the
// installer stub around that zip and signs it. Output in dist/release/;
// --publish copies it to <stateDir>/tap-dist/ for the kernel's download routes.
// Windows only: PowerShell 5.1, tar.exe and the .NET Framework csc.exe ship with Windows 11.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { buildTap } from './build-tap.mjs';
import { sha256 } from './bundle-lib.mjs';
import { signingMode, checkSigned, powershellSigner } from './sign-lib.mjs';
import { CATALOG_FILE, SIGNER_FILE, verifyTapPayload } from '../../../taps/tap-signature.js';
import { TAP_SETUP_VERSION } from '../../../taps/tap-setup.mjs';
import { RELEASE_FILE, RELEASE_DIR, INSTALLER_FILE, UPDATE_FILE } from '../../../server/lib/kernel/tap-release.js';

const TAP_ROOT = path.resolve(import.meta.dirname, '..');
const SYS = process.env.SystemRoot || 'C:\\Windows';
const CSC = path.join(SYS, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
const TAR = path.join(SYS, 'System32', 'tar.exe');

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, ...opts });
  if (r.error || r.status !== 0) throw new Error(`${path.basename(cmd)} failed (${r.error ? r.error.message : `exit ${r.status}`}): ${String(r.stdout ?? '').trim().slice(-800)} ${String(r.stderr ?? '').trim().slice(-800)}`);
  return r.stdout;
}

const fileInfo = (file) => { const b = fs.readFileSync(file); return { file: path.basename(file), size: b.length, sha256: sha256(b) }; };

export async function releaseTap({ mode, outDir = path.join(TAP_ROOT, 'dist', 'release'), signer = powershellSigner({ pfx: path.join(TAP_ROOT, '.cache', 'test-signing.pfx') }), log = console.log }) {
  fs.mkdirSync(path.join(TAP_ROOT, '.cache'), { recursive: true });
  const cert = signer.info(mode);
  const m = { ...mode, thumbprint: cert.thumbprint.toUpperCase() };
  log(`signing as ${cert.subject} (${m.thumbprint}, ${m.mode}, valid to ${cert.notAfter})`);

  fs.rmSync(outDir, { recursive: true, force: true });
  const payload = path.join(outDir, 'payload');
  const { manifest } = await buildTap({ outDir: payload });
  const pin = { thumbprint: m.thumbprint, mode: m.mode, subject: cert.subject };
  fs.writeFileSync(path.join(payload, SIGNER_FILE), JSON.stringify(pin, null, 2) + '\n');

  // The catalog is written beside the payload, signed, then moved in, so it never lists itself.
  const cat = path.join(outDir, CATALOG_FILE);
  signer.catalog(payload, cat);
  const bad = checkSigned(signer.sign(m, [cat]), m);
  if (bad) throw new Error(`catalog signing: ${bad}`);
  fs.renameSync(cat, path.join(payload, CATALOG_FILE));
  const v = verifyTapPayload(payload, { pin });
  if (!v.ok) throw new Error(`the signed payload fails the installer's own check: ${v.reason}`);
  log(`payload: ${Object.keys(manifest.files).length} entries + node.exe, catalog ${v.result.signature} by the pinned signer`);

  const update = path.join(outDir, UPDATE_FILE);
  run(TAR, ['-a', '-c', '-f', update, '-C', payload, '.']);

  const exe = path.join(outDir, INSTALLER_FILE);
  const csOut = run(CSC, ['/nologo', '/optimize+', '/target:exe', '/platform:anycpu',
    '/r:System.IO.Compression.dll', '/r:System.IO.Compression.FileSystem.dll',
    `/resource:${update},payload.zip`, `/out:${exe}`, path.join(TAP_ROOT, 'installer', 'Setup.cs')]);
  if (csOut.trim()) log(csOut.trim());
  const bad2 = checkSigned(signer.sign(m, [exe]), m);
  if (bad2) throw new Error(`installer signing: ${bad2}`);

  const release = {
    version: TAP_SETUP_VERSION,
    commit: manifest.commit,
    builtAt: new Date().toISOString(),
    node: manifest.node.version,
    signing: pin,
    artifacts: { installer: fileInfo(exe), update: fileInfo(update) },
  };
  fs.writeFileSync(path.join(outDir, RELEASE_FILE), JSON.stringify(release, null, 2) + '\n');
  fs.rmSync(payload, { recursive: true, force: true });
  return { outDir, release };
}

export function publishRelease(outDir, stateDir) {
  const dest = path.join(stateDir, RELEASE_DIR);
  fs.mkdirSync(dest, { recursive: true });
  for (const f of [INSTALLER_FILE, UPDATE_FILE]) fs.copyFileSync(path.join(outDir, f), path.join(dest, f));
  // The document goes last: the kernel serves nothing until it names files that are already there.
  fs.copyFileSync(path.join(outDir, RELEASE_FILE), path.join(dest, RELEASE_FILE));
  return dest;
}

function flag(argv, name) { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; }

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  if (process.platform !== 'win32') { console.error('release-tap: Windows only (Authenticode, csc.exe)'); process.exit(1); }
  const argv = process.argv.slice(2);
  const mode = signingMode({ testCert: argv.includes('--test-cert'), thumbprint: flag(argv, '--thumbprint'), timestamp: flag(argv, '--timestamp') });
  if (!mode.ok) { console.error(`release-tap: ${mode.reason}`); process.exit(2); }
  const { outDir, release } = await releaseTap({ mode });
  for (const [k, a] of Object.entries(release.artifacts)) console.log(`${k}: ${a.file} ${a.size} bytes sha256 ${a.sha256}`);
  const stateDir = flag(argv, '--publish');
  if (stateDir) console.log(`published to ${publishRelease(outDir, path.resolve(stateDir))}`);
}
