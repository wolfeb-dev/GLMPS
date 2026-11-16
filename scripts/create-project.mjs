#!/usr/bin/env node
// Create or adopt a project directory: mkdir, git init when needed, add it to
// ~/.claude/settings.json permissions.additionalDirectories, and pre-accept the
// harness trust dialog in ~/.claude.json. Usage: node scripts/create-project.mjs <dir>
// Status goes to stderr, like sync-project-dirs.mjs.
import os from 'node:os';
import path from 'node:path';
import { createProject } from '../server/lib/orchestration/project-dirs.js';
import { loadPrivateDirs } from '../server/lib/private-dirs.js';

const dir = process.argv[2];
if (!dir) { console.error('create-project: usage: node scripts/create-project.mjs <dir>'); process.exit(1); }

const claudeDir = path.join(os.homedir(), '.claude');
const r = createProject({
  settingsFile: path.join(claudeDir, 'settings.json'),
  dir: path.resolve(dir),
  privateDirs: loadPrivateDirs(),
  claudeConfigFile: claudeDir + '.json',
});
if (!r.ok) { console.error('create-project: ' + r.reason); process.exit(1); }
const did = [r.created && 'created', r.initialized && 'git init', r.registered && 'registered', r.trusted && 'trusted'].filter(Boolean);
console.error(`create-project: ${r.dir} (${did.length ? did.join(', ') : 'already set up'})`);
