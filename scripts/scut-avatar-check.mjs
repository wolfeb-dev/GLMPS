#!/usr/bin/env node
// scripts/scut-avatar-check.mjs
// Did the avatar upload actually work? Fetches every picture SCUT would ask
// Slack to load and says so.
//
//   node scripts/scut-avatar-check.mjs https://raw.githubusercontent.com/me/repo/main/assets/scut
//   node scripts/scut-avatar-check.mjs        # check whatever SCUT is configured with
//
// Run it BEFORE setting SCUT_AVATAR_BASE_URL (pass the URL) to find out whether
// the URL is right, and AFTER (no argument) to confirm the running config.
//
// Thin shell: argument handling, printing, exit code. Everything it decides
// lives in server/lib/scut/avatar-check.js, where it is unit-tested.
import { checkAvatarBase, formatReport, expectedAvatarPaths } from '../server/lib/scut/avatar-check.js';
import { getAvatarBaseUrl, settingsPath } from '../server/lib/scut/settings.js';

const DOC = 'docs/scut-profile-pictures.md';
const requested = process.argv[2] || null;
const configured = getAvatarBaseUrl();
const base = requested || configured;

const say = (lines) => { console.log(''); for (const l of lines) console.log(l ? `  ${l}` : ''); console.log(''); };

if (!base) {
  say([
    'No avatar base URL to check.',
    '',
    'Pass one:   node scripts/scut-avatar-check.mjs https://<host>/<path>/assets/scut',
    `Or set it:  "avatarBaseUrl" in ${settingsPath()}, or SCUT_AVATAR_BASE_URL`,
    '',
    `Walkthrough: ${DOC}`,
  ]);
  process.exit(2);
}

console.log('');
console.log(`  Checking ${expectedAvatarPaths().length} files under ${base}`);
if (!requested) console.log("  (this is SCUT's current setting)");

const report = await checkAvatarBase(base);
const { lines, exitCode } = formatReport(report, { configured, requested, settingsFile: settingsPath(), docPath: DOC });
say(lines);
process.exit(exitCode);
