#!/usr/bin/env node
// scripts/scut-seed-project-settings.mjs
// Seeds the Slack settings file with the Bob-mode star-system map
// (projectSystems) and the default project channel list (defaultProjects).
// Card glmps-2-0-220 moved both out of code so a shipped build names none of
// the maintainer's projects; this puts an installation's own values back where
// the server now reads them (card glmps-2-0-224).
//
//   node scripts/scut-seed-project-settings.mjs            dry run: prints the plan, changes nothing
//   node scripts/scut-seed-project-settings.mjs --apply    writes, after a backup of the file
//
// Where the values come from, so this file names no project:
//   default        server/lib/scut/bobiverse.js as it stood before the move
//                  (commit dae029f5^), read from this checkout's git history
//   --ref <rev>    the same file at another revision
//   --from <json>  a JSON file { "projectSystems": {...}, "defaultProjects": [...] }
// Other options: --settings <file> (default: the file the server reads),
// --repo <dir> (default: this checkout).
//
// Idempotent: a key the settings file already has is never overwritten.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { settingsPath } from '../server/lib/scut/settings.js';

const DEFAULT_REF = 'dae029f5^';
const SOURCE_FILE = 'server/lib/scut/bobiverse.js';
const KEYS = ['projectSystems', 'defaultProjects'];

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// The two literals the old module exported, evaluated in an empty context: they
// are plain object and array literals in this repo's own history.
export function valuesFromSource(text) {
  const literal = (name, open, close) => {
    const m = new RegExp(`export const ${name}\\s*=\\s*(\\${open}[\\s\\S]*?\\${close});`).exec(text);
    // Round-tripped through JSON so the result is plain data of this realm.
    return m ? JSON.parse(JSON.stringify(vm.runInNewContext(`(${m[1]})`, Object.create(null), { timeout: 1000 }))) : undefined;
  };
  return { projectSystems: literal('PROJECT_SYSTEMS', '{', '}'), defaultProjects: literal('DEFAULT_PROJECT_CHANNELS', '[', ']') };
}

export function validValues({ projectSystems, defaultProjects } = {}) {
  const errors = [];
  if (!isObject(projectSystems) || !Object.entries(projectSystems).every(([p, s]) => p && typeof s === 'string' && /^[a-z0-9-]{1,80}$/.test(s))) {
    errors.push('projectSystems must map each project to a lowercase channel slug');
  }
  if (!Array.isArray(defaultProjects) || !defaultProjects.every((p) => typeof p === 'string' && p.trim())) {
    errors.push('defaultProjects must be a list of project names');
  }
  return errors;
}

export function planSeed(current, values) {
  const missing = KEYS.filter((k) => !(k in current));
  const next = { ...current };
  for (const k of missing) next[k] = values[k];
  return { missing, next };
}

function isTestProcess() {
  return !!(process.env.NODE_TEST_CONTEXT || process.env.GLMPS_TEST === '1');
}

function main(argv) {
  const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
  const apply = argv.includes('--apply');
  const say = (m) => console.log(m);
  const settings = opt('--settings');
  // A test that forgets --settings must never reach the operator's real file.
  if (!settings && isTestProcess()) { say('STOP: refused in a test process without --settings'); return 2; }
  const file = settings || settingsPath();
  const repo = opt('--repo') || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  say(apply ? 'MODE: apply' : 'MODE: dry run (nothing changes; add --apply to act)');

  let values;
  const from = opt('--from');
  if (from) {
    try { values = JSON.parse(fs.readFileSync(from, 'utf8')); } catch (e) { say(`STOP: ${from} is not readable JSON (${e.message})`); return 1; }
    say(`values: ${from}`);
  } else {
    const ref = opt('--ref') || DEFAULT_REF;
    let text;
    try {
      text = execFileSync('git', ['-C', repo, 'show', `${ref}:${SOURCE_FILE}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      say(`STOP: could not read ${SOURCE_FILE} at ${ref} in ${repo} (${String(e.stderr || e.message).trim()}); pass --from <json> instead`);
      return 1;
    }
    try { values = valuesFromSource(text); } catch (e) { say(`STOP: could not read the values at ${ref} (${e.message})`); return 1; }
    say(`values: ${SOURCE_FILE} at ${ref}`);
  }
  const errors = validValues(values);
  if (errors.length) { say(`STOP: ${errors.join('; ')}`); return 1; }
  say(`  projectSystems: ${Object.keys(values.projectSystems).length} project(s); defaultProjects: ${values.defaultProjects.length}`);

  say(`settings: ${file}`);
  let current = {};
  if (fs.existsSync(file)) {
    try { current = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { say(`STOP: the settings file is not valid JSON (${e.message}); fix it by hand first`); return 1; }
    if (!isObject(current)) { say('STOP: the settings file is not a JSON object'); return 1; }
  }
  const { missing, next } = planSeed(current, values);
  if (!missing.length) { say('  already seeded: both keys are present, left unchanged'); return 0; }
  say(`  will add: ${missing.join(', ')} (existing keys are never overwritten)`);
  if (!apply) { say('Dry run complete. Run again with --apply to write.'); return 0; }
  if (fs.existsSync(file)) {
    const bak = `${file}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.copyFileSync(file, bak);
    say(`  backup: ${bak}`);
  } else fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
  fs.renameSync(tmp, file);
  say('  written');
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
