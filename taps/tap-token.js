// taps/tap-token.js
// The tap's pairing token at rest: <tapHome>/token.dpapi holds base64 of a DPAPI
// CurrentUser blob, so only the same Windows user on the same machine can read
// it back. The secret travels to PowerShell on stdin, never on its command line
// or in its environment, and no error here carries it.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const tokenFile = (home) => path.join(home, 'token.dpapi');
// The client certificate's private key (card glmps-2-0-runtime-147): made on this
// machine at pairing, kept under the same DPAPI and file rules as the token.
export const clientKeyFile = (home) => path.join(home, 'client-key.dpapi');

const fail = (code, message) => Object.assign(new Error(message), { code });
const needWindows = (platform) => {
  if (platform !== 'win32') throw fail('TAP_TOKEN_UNSUPPORTED_PLATFORM', `the tap token file needs Windows DPAPI; ${platform} is not supported yet`);
};

// Both scripts read raw bytes from stdin and write raw bytes or base64 to stdout.
// Pure .NET calls, no cmdlets: resolving a cmdlet makes PowerShell scan every
// module on its path, and with a cold module cache and a large path (the
// GitHub Windows runner ships the Az modules) that took close to a minute.
const READ_STDIN = '$i=[Console]::OpenStandardInput();$m=[IO.MemoryStream]::new();$i.CopyTo($m);$b=$m.ToArray();';
const LOAD_SECURITY = '[void][Reflection.Assembly]::Load("System.Security, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a");';
const PROTECT = `${LOAD_SECURITY}${READ_STDIN}`
  + '$o=[Security.Cryptography.ProtectedData]::Protect($b,$null,\'CurrentUser\');[Console]::Out.Write([Convert]::ToBase64String($o))';
const UNPROTECT = `${LOAD_SECURITY}${READ_STDIN}`
  + '$d=[Convert]::FromBase64String([Text.Encoding]::ASCII.GetString($b).Trim());'
  + '$o=[Security.Cryptography.ProtectedData]::Unprotect($d,$null,\'CurrentUser\');'
  + '$s=[Console]::OpenStandardOutput();$s.Write($o,0,$o.Length);$s.Flush()';

export function dpapiRunner(spawn = spawnSync) {
  const run = (script, input) => {
    const r = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { input, windowsHide: true });
    if (r.error || r.status !== 0) {
      throw fail('TAP_TOKEN_DPAPI', `DPAPI call failed (${r.error ? r.error.message : `powershell exit ${r.status}`}): ${String(r.stderr ?? '').slice(0, 200).trim()}`);
    }
    return r.stdout;
  };
  return {
    protect: (secret) => Buffer.from(run(PROTECT, Buffer.from(secret, 'utf8')).toString('ascii').trim(), 'base64'),
    unprotect: (blob) => run(UNPROTECT, Buffer.from(blob.toString('base64'), 'ascii')).toString('utf8'),
  };
}

function writeSecret(file, secret, what, { runner, platform = process.platform } = {}) {
  needWindows(platform);
  if (typeof secret !== 'string' || !secret) throw new TypeError(`${what} is required`);
  const blob = (runner ?? dpapiRunner()).protect(secret);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, blob.toString('base64'), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function readSecret(file, { runner, platform = process.platform } = {}) {
  needWindows(platform);
  let text;
  try { text = fs.readFileSync(file, 'utf8').trim(); } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
  try { return (runner ?? dpapiRunner()).unprotect(Buffer.from(text, 'base64')); } catch (e) {
    throw fail('TAP_TOKEN_UNREADABLE', `${file} could not be unprotected (${e.code ?? 'error'}); pair this client again`);
  }
}

export const writeToken = (home, secret, opts) => writeSecret(tokenFile(home), secret, 'a token', opts);
/** The token, or null when no token file exists yet (the agent is unpaired). */
export const readToken = (home, opts) => readSecret(tokenFile(home), opts);
export const writeClientKey = (home, pem, opts) => writeSecret(clientKeyFile(home), pem, 'a client key', opts);
/** The key PEM, or null when no key file exists (paired before client certificates, or never). */
export const readClientKey = (home, opts) => readSecret(clientKeyFile(home), opts);
