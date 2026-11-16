// taps/tap-signature.js
// Authenticode check of a tap payload (server-and-client-tap task 7, D4). JS
// files cannot carry a signature, so the release signs a catalog (tap.cat)
// holding every file's hash. The installer runs this on its own payload before
// installing, and a tap update must pass it before it replaces anything.
// Windows PowerShell 5.1 does the work (Test-FileCatalog, Get-AuthenticodeSignature);
// the folder reaches it through the environment, never spliced into the script.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const CATALOG_FILE = 'tap.cat';
export const SIGNER_FILE = 'signer.json';
const THUMB_RE = /^[0-9A-F]{40}$/;

const VERIFY = '$ErrorActionPreference="Stop";'
  + '$d=$env:GLMPS_TAP_VERIFY_DIR;$c=Join-Path $d "tap.cat";'
  + '$r=Test-FileCatalog -Path $d -CatalogFilePath $c -FilesToSkip "tap.cat" -Detailed;'
  + '$g=Get-AuthenticodeSignature -FilePath $c;'
  + '$miss=@($r.CatalogItems.Keys|?{-not $r.PathItems.ContainsKey($_)});'
  + '$extra=@($r.PathItems.Keys|?{-not $r.CatalogItems.ContainsKey($_)});'
  + '$bad=@($r.CatalogItems.Keys|?{$r.PathItems.ContainsKey($_) -and $r.PathItems[$_] -ne $r.CatalogItems[$_]});'
  + '[Console]::Out.Write((ConvertTo-Json -Compress @{catalog=[string]$r.Status;signature=[string]$g.Status;'
  + 'thumbprint=[string]$g.SignerCertificate.Thumbprint;subject=[string]$g.SignerCertificate.Subject;missing=$miss;extra=$extra;changed=$bad}))';

/** A signer pin from signer.json content; throws on anything else. */
export function parsePin(obj) {
  if (!obj || typeof obj !== 'object') throw new TypeError('signer pin must be an object');
  const thumbprint = String(obj.thumbprint ?? '').toUpperCase();
  if (!THUMB_RE.test(thumbprint)) throw new TypeError('signer pin needs a 40-hex thumbprint');
  if (obj.mode !== 'test' && obj.mode !== 'release') throw new TypeError('signer pin mode must be test or release');
  return { thumbprint, mode: obj.mode, subject: typeof obj.subject === 'string' ? obj.subject : null };
}

export function readPin(dir) {
  return parsePin(JSON.parse(fs.readFileSync(path.join(dir, SIGNER_FILE), 'utf8')));
}

// A self-signed test certificate is never trusted machine-wide (that would need
// a Root store change), so test mode accepts an untrusted chain, but only from
// the pinned signer and never with a hash mismatch.
const UNTRUSTED_CHAIN = new Set(['UnknownError', 'NotTrusted']);

/** null when the payload passes, else the reason it is refused. */
export function evaluateVerification(r, pin) {
  if (!r || typeof r !== 'object') return 'no verification result';
  const list = (a) => (Array.isArray(a) ? a : a ? [a] : []);
  const missing = list(r.missing), extra = list(r.extra), changed = list(r.changed);
  if (changed.length) return `${changed.length} file(s) differ from the signed catalog: ${changed.slice(0, 5).join(', ')}`;
  if (missing.length) return `${missing.length} file(s) in the signed catalog are missing: ${missing.slice(0, 5).join(', ')}`;
  if (extra.length) return `${extra.length} file(s) are not in the signed catalog: ${extra.slice(0, 5).join(', ')}`;
  if (r.catalog !== 'Valid') return `the payload does not match its catalog (${r.catalog})`;
  if (r.signature === 'NotSigned') return 'the catalog is not signed';
  if (r.signature === 'HashMismatch') return 'the catalog signature does not match its content';
  const thumb = String(r.thumbprint ?? '').toUpperCase();
  if (thumb !== pin.thumbprint) return `signed by ${thumb || 'nobody'} (${r.subject || 'unknown'}), not the pinned signer ${pin.thumbprint}`;
  if (r.signature === 'Valid') return null;
  if (pin.mode === 'test' && UNTRUSTED_CHAIN.has(r.signature)) return null;
  return `the catalog signature is ${r.signature}${pin.mode === 'release' ? '; a release pin needs a trusted chain' : ''}`;
}

// Started from PowerShell 7, the inherited PSModulePath lists 7's own module
// folders first and 5.1 then fails to load Microsoft.PowerShell.Security.
// Without it, 5.1 builds its default path.
export function windowsPowerShellEnv(extra = {}, base = process.env) {
  const env = {};
  for (const [k, v] of Object.entries(base)) if (k.toLowerCase() !== 'psmodulepath') env[k] = v;
  return { ...env, ...extra };
}

export function powershellVerifier(spawn = spawnSync) {
  return (dir) => {
    const r = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', VERIFY], {
      env: windowsPowerShellEnv({ GLMPS_TAP_VERIFY_DIR: dir }), windowsHide: true, encoding: 'utf8',
    });
    if (r.error || r.status !== 0) return { error: `verification could not run (${r.error ? r.error.message : `powershell exit ${r.status}`}): ${String(r.stderr ?? '').slice(0, 300).trim()}` };
    try { return JSON.parse(r.stdout); } catch { return { error: 'verification output was not JSON' }; }
  };
}

/** {ok:true, result} or {ok:false, reason}. */
export function verifyTapPayload(dir, { pin, verify, platform = process.platform } = {}) {
  if (platform !== 'win32') return { ok: false, reason: `Authenticode verification needs Windows; ${platform} is not supported yet` };
  let p;
  try { p = parsePin(pin); } catch (e) { return { ok: false, reason: `no usable signer pin: ${e.message}` }; }
  if (!fs.existsSync(path.join(dir, CATALOG_FILE))) return { ok: false, reason: `${CATALOG_FILE} is missing; the payload is unsigned` };
  const result = (verify ?? powershellVerifier())(dir);
  if (result?.error) return { ok: false, reason: result.error };
  const reason = evaluateVerification(result, p);
  return reason ? { ok: false, reason, result } : { ok: true, result };
}
