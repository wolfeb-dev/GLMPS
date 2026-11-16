#!/usr/bin/env node
// scripts/setup/setup-status.mjs - the desktop setup wizard's health probe.
// Prints one JSON line (server/lib/chassis/setup-status.js). Read-only.
//   --no-latest   skip the winget lookups and the live Slack check (offline)
//   <path>        the profile file to report on (default: $GLMPS_PROFILE)
import fs from 'node:fs';
import os from 'node:os';
import { defaultRun, latestVersions } from '../../server/lib/chassis/deps.js';
import { buildSetupStatus } from '../../server/lib/chassis/setup-status.js';
import { loadCreds, validateCreds } from '../../server/lib/scut/config.js';
import { checkSlackTokens } from '../../server/lib/scut/connect.js';
import { createSlackWeb } from '../../server/lib/scut/slack-web.js';
import { resolveInstallPaths } from '../install-hooks-lib.mjs';
import { getPaths } from '../../server/lib/paths.js';
import { loadConfig as loadRunnerConfig } from '../../server/lib/orchestration/runner-store.js';
import { defaultProgramFiles } from '../../server/lib/orchestration/editor-detect.js';

const args = process.argv.slice(2);
const profilePath = args.find((a) => !a.startsWith('--')) ?? process.env.GLMPS_PROFILE ?? null;
let hooksRecordFile = null;
try { hooksRecordFile = resolveInstallPaths({ env: process.env, homedir: os.homedir() }).hooksRecordFile; } catch { /* unresolvable: hooks read as not installed */ }

const offline = args.includes('--no-latest');
// Saved tokens are only half the answer: Slack may have revoked them since.
let slackLive = null;
if (!offline) {
  try {
    const creds = loadCreds();
    if (validateCreds(creds).ok) {
      slackLive = await checkSlackTokens({ botToken: creds.botToken, appToken: creds.appToken, makeWeb: (token) => createSlackWeb({ token, timeoutMs: 10_000, maxRetries: 1 }) });
    }
  } catch { slackLive = { ok: false, error: 'unreachable', unreachable: true }; }
}

let runnerConfig = null;
try { runnerConfig = loadRunnerConfig(getPaths(process.env).stateDir); } catch { /* no config: no pick yet */ }

console.log(JSON.stringify(buildSetupStatus({
  home: os.homedir(),
  programFiles: defaultProgramFiles(process.env),
  readdir: (d) => fs.readdirSync(d),
  runnerConfig,
  run: defaultRun,
  latest: offline ? {} : latestVersions(),
  loadCreds: () => loadCreds(),
  exists: (p) => fs.existsSync(p),
  readFile: (p) => fs.readFileSync(p, 'utf8'),
  hooksRecordFile,
  profilePath,
  slackLive,
})));
