// Authenticode for the tap release (server-and-client-tap task 7, D4), through
// Windows PowerShell 5.1's own cmdlets, so no Windows SDK or signtool is needed.
// Two certificate sources:
//   test     an untrusted self-signed code-signing certificate kept as a file in
//            .cache/ and never added to any certificate store; the tap pins its
//            thumbprint instead of trusting it.
//   release  a purchased certificate already in the CurrentUser\My store (a USB
//            token or a cloud signing client exposes it there), chosen by
//            thumbprint; the key never leaves the token or the service.
// Every input reaches PowerShell through the environment, never the script text.
import { spawnSync } from 'node:child_process';

export const TEST_SUBJECT = 'CN=GLMPS Tap Test Signing';
const THUMB_RE = /^[0-9A-F]{40}$/;

const LOAD_CERT = '$ErrorActionPreference="Stop";'
  + 'if($env:GLMPS_SIGN_MODE -eq "test"){$p=$env:GLMPS_SIGN_PFX;'
  + 'if(-not(Test-Path $p)){'
  + '$rsa=[Security.Cryptography.RSA]::Create(3072);'
  + '$req=New-Object Security.Cryptography.X509Certificates.CertificateRequest($env:GLMPS_SIGN_SUBJECT,$rsa,[Security.Cryptography.HashAlgorithmName]::SHA256,[Security.Cryptography.RSASignaturePadding]::Pkcs1);'
  + '$eku=New-Object Security.Cryptography.OidCollection;[void]$eku.Add((New-Object Security.Cryptography.Oid "1.3.6.1.5.5.7.3.3"));'
  + '$req.CertificateExtensions.Add((New-Object Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension($eku,$false)));'
  + '$req.CertificateExtensions.Add((New-Object Security.Cryptography.X509Certificates.X509KeyUsageExtension([Security.Cryptography.X509Certificates.X509KeyUsageFlags]::DigitalSignature,$true)));'
  + '$n=$req.CreateSelfSigned([DateTimeOffset]::Now.AddDays(-1),[DateTimeOffset]::Now.AddYears(2));'
  + '[IO.File]::WriteAllBytes($p,$n.Export("Pfx",""))};'
  + '$c=New-Object Security.Cryptography.X509Certificates.X509Certificate2($p,"","Exportable")}'
  + 'else{$c=Get-Item -LiteralPath ("Cert:\\CurrentUser\\My\\"+$env:GLMPS_SIGN_THUMBPRINT)};'
  + 'if(-not $c.HasPrivateKey){throw "the signing certificate has no private key on this machine"};'
  + 'if(-not ($c.EnhancedKeyUsageList|?{$_.ObjectId -eq "1.3.6.1.5.5.7.3.3"})){throw "the certificate is not a code-signing certificate"};';

const INFO = `${LOAD_CERT}[Console]::Out.Write((ConvertTo-Json -Compress @{thumbprint=$c.Thumbprint;subject=$c.Subject;notAfter=$c.NotAfter.ToString("o")}))`;

const SIGN = `${LOAD_CERT}$out=@();foreach($f in ($env:GLMPS_SIGN_FILES -split "\\|")){`
  + 'if($env:GLMPS_SIGN_TIMESTAMP){$null=Set-AuthenticodeSignature -FilePath $f -Certificate $c -HashAlgorithm SHA256 -TimestampServer $env:GLMPS_SIGN_TIMESTAMP}'
  + 'else{$null=Set-AuthenticodeSignature -FilePath $f -Certificate $c -HashAlgorithm SHA256};'
  + '$g=Get-AuthenticodeSignature -FilePath $f;'
  + '$out+=@{file=$f;status=[string]$g.Status;thumbprint=[string]$g.SignerCertificate.Thumbprint;timestamped=[bool]$g.TimeStamperCertificate}};'
  + '[Console]::Out.Write((ConvertTo-Json -Compress -InputObject $out))';

const CATALOG = '$ErrorActionPreference="Stop";New-FileCatalog -Path $env:GLMPS_CATALOG_DIR -CatalogFilePath $env:GLMPS_CATALOG_FILE -CatalogVersion 2.0|Out-Null';

/** Which certificate to sign with, from the release flags. */
export function signingMode({ testCert, thumbprint, timestamp }) {
  if (testCert && thumbprint) return { ok: false, reason: 'pass --test-cert or --thumbprint, not both' };
  if (testCert) return { ok: true, mode: 'test', timestamp: timestamp || null };
  if (!thumbprint) return { ok: false, reason: 'pass --test-cert to sign with the self-signed test certificate, or --thumbprint <T> for a purchased one (apps/tap/SIGNING.md)' };
  const t = String(thumbprint).replace(/\s+/g, '').toUpperCase();
  if (!THUMB_RE.test(t)) return { ok: false, reason: `--thumbprint must be 40 hex characters, got ${thumbprint}` };
  // A release signature without a timestamp stops verifying when the certificate expires (460 days at most).
  if (!timestamp) return { ok: false, reason: '--thumbprint needs --timestamp <the certificate vendor\'s RFC 3161 URL>, so signatures outlive the certificate' };
  return { ok: true, mode: 'release', thumbprint: t, timestamp };
}

/** null when every signed file carries the expected signer and status, else the reason. */
export function checkSigned(results, { mode, thumbprint }) {
  const list = Array.isArray(results) ? results : [results];
  for (const r of list) {
    if (String(r?.thumbprint ?? '').toUpperCase() !== thumbprint) return `${r?.file}: signed by ${r?.thumbprint || 'nobody'}, expected ${thumbprint} (${r?.status})`;
    if (r.status === 'Valid') continue;
    if (mode === 'test' && (r.status === 'UnknownError' || r.status === 'NotTrusted')) continue;
    return `${r.file}: signature status ${r.status}`;
  }
  return null;
}

export function powershellSigner({ spawn = spawnSync, pfx, subject = TEST_SUBJECT } = {}) {
  const ps = (script, env) => {
    const r = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { env: { ...process.env, ...env }, encoding: 'utf8', windowsHide: true });
    if (r.error || r.status !== 0) throw new Error(`PowerShell failed (${r.error ? r.error.message : `exit ${r.status}`}): ${String(r.stderr ?? '').trim().slice(0, 500)}`);
    return r.stdout;
  };
  const certEnv = (m) => ({ GLMPS_SIGN_MODE: m.mode, GLMPS_SIGN_PFX: pfx ?? '', GLMPS_SIGN_SUBJECT: subject, GLMPS_SIGN_THUMBPRINT: m.thumbprint ?? '' });
  return {
    info: (m) => JSON.parse(ps(INFO, certEnv(m))),
    sign: (m, files) => JSON.parse(ps(SIGN, { ...certEnv(m), GLMPS_SIGN_FILES: files.join('|'), GLMPS_SIGN_TIMESTAMP: m.timestamp ?? '' })),
    catalog: (dir, file) => { ps(CATALOG, { GLMPS_CATALOG_DIR: dir, GLMPS_CATALOG_FILE: file }); },
  };
}
