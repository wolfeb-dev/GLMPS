#!/usr/bin/env node
// Run only the tests this working tree's change affects (card
// glmps-2-0-runtime-98, F3). The same selection the merge queue makes for a
// PR: changed test files plus test files that name a changed file, measured
// from the merge base with the integration branch and including uncommitted
// and untracked files. Runner sessions are denied a bare full-suite run; this
// is what they run instead.
//
//   node scripts/affected-tests.mjs           run the affected tests
//   node scripts/affected-tests.mjs --print   print the selection and command only
//   node scripts/affected-tests.mjs --base origin/main
//   node scripts/affected-tests.mjs --full    run the full suite anyway (operator use)
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { selectAffectedTests, isTestFile } from '../server/lib/orchestration/affected-tests.js';

const git = (args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
const lines = (s) => String(s).split(/\r?\n/).map((x) => x.trim()).filter(Boolean);

export function pickBase(explicit, has) {
  if (explicit) return explicit;
  return ['origin/glmps2/main', 'origin/main', 'origin/master'].find(has) ?? null;
}

/** The node argv for a `node <flags> "<glob>"` test script with the glob swapped for files. */
export function testArgv(script, files) {
  const m = /^node\s+(.*?)\s+(?:"[^"]*\*[^"]*"|'[^']*\*[^']*'|\S*\*\S*)\s*$/.exec(String(script ?? '').trim());
  if (!m || !/(^|\s)--test(\s|=|$)/.test(m[1])) return null;
  return [...m[1].split(/\s+/).filter(Boolean), ...files];
}

function main(argv) {
  const opt = { print: argv.includes('--print'), full: argv.includes('--full') };
  const bi = argv.indexOf('--base');
  const has = (ref) => { try { git(['rev-parse', '--verify', '-q', ref]); return true; } catch { return false; } };
  const base = pickBase(bi >= 0 ? argv[bi + 1] : null, has);
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  const script = pkg?.scripts?.test;
  if (opt.full) return spawnSync('npm', ['test'], { stdio: 'inherit', shell: process.platform === 'win32' }).status ?? 1;
  if (!base) { console.error('affected-tests: no integration branch found (try --base <ref>)'); return 2; }
  const mb = git(['merge-base', 'HEAD', base]).trim();
  const changed = [...new Set([...lines(git(['diff', '--name-only', mb])), ...lines(git(['ls-files', '--others', '--exclude-standard']))])];
  const testFiles = [...new Set([...lines(git(['ls-files'])), ...changed].filter(isTestFile))].filter((f) => fs.existsSync(f));
  const sel = selectAffectedTests({ changed, testFiles, readFile: (f) => fs.readFileSync(f, 'utf8') });
  console.log(`affected-tests: ${changed.length} changed file(s) since ${base}; ${sel.full ? `full suite needed (${sel.full})` : `${sel.files.length} of ${testFiles.length} test files affected`}`);
  if (sel.full) {
    console.log('affected-tests: the merge queue and the batched run on the base cover the full suite; run with --full only if you must.');
    return 0;
  }
  if (!sel.files.length) { console.log('affected-tests: nothing to run'); return 0; }
  const args = testArgv(script, sel.files);
  if (!args) { console.error(`affected-tests: cannot narrow the test script (${script}); name the files: node --test ${sel.files.join(' ')}`); return 2; }
  console.log(`affected-tests: node ${args.join(' ')}`);
  if (opt.print) return 0;
  // Spawned directly (no shell), so a long file list is not held to cmd.exe's limit.
  return spawnSync(process.execPath, args, { stdio: 'inherit', windowsHide: true }).status ?? 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exit(main(process.argv.slice(2)));
