#!/usr/bin/env node
// scripts/scut-migrate-archived-channels.mjs
// One-time D27 migration. Usage: node scripts/scut-migrate-archived-channels.mjs [--dry-run]
// Reads the SCUT creds and settings the server uses; prints the report as JSON;
// exits 1 while any channel still needs a manual step (listed in failures).
//
// This is the HELD half of D27 C3/C4: running it against the real Slack
// workspace is Task 13, left for the operator's own cutover. Two refusals
// below exist so an automated run (a test, an accidental dispatch) can never
// reach real Slack or a real token by mistake:
//   - no bot token configured -> named refusal, before any Slack client is
//     built.
//   - running inside a test process without an injected fake `web` -> named
//     refusal, checked FIRST, using the same test-process signals as
//     server/lib/orchestration/test-write-guard.js (NODE_TEST_CONTEXT,
//     GLMPS_TEST=1, or an argv[1] ending in .test.js). A spawned child process
//     cannot receive a fake `web` object across the process boundary, so for
//     a real `node scripts/...mjs` invocation this is the only possible
//     signal; it is what makes it safe for a test to spawn this very file.
//
// `run()` and `isTestProcess()` are exported so a test can exercise them as
// pure parts (an injected `web`, or a plain signal check) without ever
// running `main()` - `main()` only fires when this file is executed
// directly (see the import.meta.url guard at the bottom), never on import.
import { pathToFileURL } from 'node:url';
import { loadCreds } from '../server/lib/scut/config.js';
import { createSlackWeb } from '../server/lib/scut/slack-web.js';
import { getAllowedUsers, settingsPath, getBobMode, getAvatarBaseUrl, getProjectSystems } from '../server/lib/scut/settings.js';
import { resolveTheme } from '../server/lib/scut/bobiverse.js';
import { ticketChannelsPath } from '../server/lib/scut/ticket-channels.js';
import { migrateArchivedChannels } from '../server/lib/scut/ticket-migration.js';
import * as backlogStore from '../server/lib/orchestration/backlog-store.js';
import { getPaths } from '../server/lib/paths.js';
// Phase C final review, M8: imported, not duplicated - this is the exact
// same four-signal check test-write-guard.js's testRealGitWriteRefused uses.
import { isTestProcess } from '../server/lib/orchestration/test-write-guard.js';

export { isTestProcess };

/**
 * Runs the migration (or dry run) and returns the report. `web` is injected
 * for a test's fake Slack client; when omitted, a real one is built from the
 * configured bot token - but only once the test-process guard has cleared,
 * and only when this is not a dry run (fix round 1, Minor: --dry-run must
 * not require a bot token, so counts can be previewed before credentials
 * exist).
 */
export async function run({ env = process.env, argv = process.argv, web = null, dryRun = argv.includes('--dry-run') } = {}) {
  if (!web && isTestProcess({ env, argv })) {
    const err = new Error('scut-migrate-archived-channels: refusing to run inside a test process without an injected fake web');
    err.code = 'test_process_refused';
    throw err;
  }
  let resolvedWeb = web;
  if (!resolvedWeb && !dryRun) {
    const creds = loadCreds({ env });
    if (!creds.botToken) {
      const err = new Error('scut-migrate-archived-channels: no SCUT bot token configured (set SCUT_BOT_TOKEN, or run scripts/scut-setup.mjs to write the creds file); refusing to run');
      err.code = 'no_token_configured';
      throw err;
    }
    resolvedWeb = createSlackWeb({ token: creds.botToken });
  }
  const P = getPaths(env);
  const items = new Map(backlogStore.load(P.stateDir).items.map((i) => [i.id, i]));
  const settingsFile = settingsPath(env);
  const theme = resolveTheme(getBobMode({ file: settingsFile }), { avatarBaseUrl: getAvatarBaseUrl({ file: settingsFile, env }), projectSystems: getProjectSystems({ file: settingsFile }) });
  return migrateArchivedChannels({
    web: resolvedWeb,
    file: ticketChannelsPath(P.stateDir, env),
    operatorIds: getAllowedUsers({ file: settingsFile }),
    // read the SAME CLOSED_STATES Set backlogStore exports,
    // never a locally duplicated copy - a diverged set would silently clear
    // archivedTs on a closed ticket (treating it as still open) and that
    // channel would never be migrated.
    isClosed: (id) => backlogStore.CLOSED_STATES.has(items.get(id)?.state),
    dryRun,
    theme,
  });
}

async function main() {
  try {
    const report = await run();
    // Fix round 1, Minor (fold): `unarchived`, `hidden` and `failed` are
    // independent tallies below, not a partition of `total` - see the same
    // note in server/lib/scut/ticket-migration.js.
    console.log(JSON.stringify(report, null, 2));
    process.exit(report.failed === 0 ? 0 : 1);
  } catch (err) {
    console.error(JSON.stringify({ error: err?.code ?? 'migration_failed', message: err?.message ?? String(err) }, null, 2));
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
