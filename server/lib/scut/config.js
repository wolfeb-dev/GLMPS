// server/lib/scut/config.js
// SCUT credential handling: the 3 secrets (bot token, app-level token, signing
// secret) come from env vars (preferred) or a gitignored JSON file the wizard
// writes. This module NEVER reads a pre-existing secret/prod path - only SCUT's
// own creds file (which we created) or explicit env vars.
import { join } from 'node:path';
import { readJsonStoreOrDegrade, writeJsonStore } from '../json-store.js';
import { resolveStateDir } from '../state-dir.js';

const REQUIRED = ['botToken', 'appToken', 'signingSecret'];

/**
 * Default creds-file location (gitignored). Overridable via SCUT_CREDS_FILE.
 * `env` is injectable so a caller threading its own env object (server.js
 * startServer({ env })) resolves this path from that env rather than the real
 * process environment.
 */
export function credsPath(env = process.env) {
  if (env.SCUT_CREDS_FILE) return env.SCUT_CREDS_FILE;
  const stateDir = resolveStateDir({ env });
  return join(stateDir, 'scut.json');
}

/** Validate credential shape. Returns { ok, errors }. */
export function validateCreds(creds = {}) {
  const errors = [];
  if (typeof creds.botToken !== 'string' || !creds.botToken.startsWith('xoxb-')) {
    errors.push('botToken must be a string starting with "xoxb-"');
  }
  if (typeof creds.appToken !== 'string' || !creds.appToken.startsWith('xapp-')) {
    errors.push('appToken must be a string starting with "xapp-"');
  }
  // signingSecret is OPTIONAL for a Socket-Mode app: events AND interactivity
  // arrive over the app-token WebSocket, so there is no HTTP request signature to
  // verify. If provided it must be a non-empty string; omitting it is fine.
  if (creds.signingSecret != null && (typeof creds.signingSecret !== 'string' || creds.signingSecret.length === 0)) {
    errors.push('signingSecret, if provided, must be a non-empty string');
  }
  return { ok: errors.length === 0, errors };
}

/** Persist creds to the gitignored file. Throws if the creds are invalid. */
export function saveCreds(creds, { file = credsPath() } = {}) {
  const v = validateCreds(creds);
  if (!v.ok) throw new Error(`refusing to save invalid SCUT creds: ${v.errors.join('; ')}`);
  const payload = { botToken: creds.botToken, appToken: creds.appToken, signingSecret: creds.signingSecret };
  // mode 0o600 is best-effort (ignored on Windows, honored on POSIX).
  writeJsonStore(file, payload, { trailingNewline: true, mode: 0o600 });
  return file;
}

/**
 * Load creds. Env vars (SCUT_BOT_TOKEN / SCUT_APP_TOKEN / SCUT_SIGNING_SECRET)
 * win over the file. Returns { botToken, appToken, signingSecret, source } where
 * source is 'env' | 'file' | 'none' | 'mixed'. Missing fields are null.
 */
export function loadCreds({ env = process.env, file = credsPath(env) } = {}) {
  const fromEnv = {
    botToken: env.SCUT_BOT_TOKEN || null,
    appToken: env.SCUT_APP_TOKEN || null,
    signingSecret: env.SCUT_SIGNING_SECRET || null,
  };
  let fromFile = { botToken: null, appToken: null, signingSecret: null };
  // A file that cannot be read is treated as absent for this load (logged by the
  // helper). Nothing here writes, so the degraded read is never persisted.
  const parsed = readJsonStoreOrDegrade(file, { fallback: null });
  if (parsed && typeof parsed === 'object') {
    fromFile = {
      botToken: parsed.botToken ?? null,
      appToken: parsed.appToken ?? null,
      signingSecret: parsed.signingSecret ?? null,
    };
  }

  const merged = {};
  const sources = new Set();
  for (const k of REQUIRED) {
    if (fromEnv[k]) { merged[k] = fromEnv[k]; sources.add('env'); }
    else if (fromFile[k]) { merged[k] = fromFile[k]; sources.add('file'); }
    else { merged[k] = null; }
  }
  let source = 'none';
  if (sources.size === 1) source = [...sources][0];
  else if (sources.size > 1) source = 'mixed';
  return { ...merged, source };
}
