// The operator seed for the Slack project settings (card glmps-2-0-224): the
// values card glmps-2-0-220 moved out of code come back from the repo's own
// history into the settings file, dry run first, never overwriting a key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { valuesFromSource, planSeed, validValues } from '../../scripts/scut-seed-project-settings.mjs';

const SCRIPT = fileURLToPath(new URL('../../scripts/scut-seed-project-settings.mjs', import.meta.url));
const OLD_SOURCE = [
  "export const PROJECT_SYSTEMS = {",
  "  'Acme-App': 'epsilon-eridani',",
  "  'Northwind Portal': 'poseidon',",
  "};",
  "",
  "export const DEFAULT_PROJECT_CHANNELS = ['Acme-App', 'Northwind Portal'];",
  "",
].join('\n');
const SYSTEMS = { 'Acme-App': 'epsilon-eridani', 'Northwind Portal': 'poseidon' };

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-scut-seed-'));
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(path.join(repo, 'server', 'lib', 'scut'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'server', 'lib', 'scut', 'bobiverse.js'), OLD_SOURCE);
  const git = (...a) => execFileSync('git', ['-C', repo, ...a], { stdio: 'ignore' });
  git('init', '-q');
  git('add', '.');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'old');
  return { dir, repo, settings: path.join(dir, 'scut-settings.json') };
}
const seed = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });

test('valuesFromSource reads the two literals the old module exported', () => {
  assert.deepEqual(valuesFromSource(OLD_SOURCE), { projectSystems: SYSTEMS, defaultProjects: ['Acme-App', 'Northwind Portal'] });
  assert.deepEqual(validValues(valuesFromSource(OLD_SOURCE)), []);
  assert.equal(validValues({ projectSystems: { a: 'Not A Slug' }, defaultProjects: [] }).length, 1);
});

test('planSeed adds only the keys the file lacks', () => {
  const values = { projectSystems: SYSTEMS, defaultProjects: ['x'] };
  assert.deepEqual(planSeed({ bobMode: true, defaultProjects: [] }, values), { missing: ['projectSystems'], next: { bobMode: true, defaultProjects: [], projectSystems: SYSTEMS } });
});

test('dry run changes nothing; --apply writes with a backup; a second run is a no-op', () => {
  const f = fixture();
  try {
    fs.writeFileSync(f.settings, JSON.stringify({ bobMode: true }));
    const dry = seed(['--repo', f.repo, '--ref', 'HEAD', '--settings', f.settings]);
    assert.equal(dry.status, 0, dry.stdout + dry.stderr);
    assert.match(dry.stdout, /will add: projectSystems, defaultProjects/);
    assert.deepEqual(JSON.parse(fs.readFileSync(f.settings, 'utf8')), { bobMode: true });

    const applied = seed(['--repo', f.repo, '--ref', 'HEAD', '--settings', f.settings, '--apply']);
    assert.equal(applied.status, 0, applied.stdout + applied.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(f.settings, 'utf8')), { bobMode: true, projectSystems: SYSTEMS, defaultProjects: ['Acme-App', 'Northwind Portal'] });
    const backups = fs.readdirSync(f.dir).filter((n) => n.startsWith('scut-settings.json.bak-'));
    assert.equal(backups.length, 1);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.dir, backups[0]), 'utf8')), { bobMode: true });

    const again = seed(['--repo', f.repo, '--ref', 'HEAD', '--settings', f.settings, '--apply']);
    assert.equal(again.status, 0);
    assert.match(again.stdout, /already seeded/);
    assert.equal(fs.readdirSync(f.dir).filter((n) => n.startsWith('scut-settings.json.bak-')).length, 1);
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('--from takes the values from a JSON file; a bad source or a missing ref is a named stop', () => {
  const f = fixture();
  try {
    const from = path.join(f.dir, 'values.json');
    fs.writeFileSync(from, JSON.stringify({ projectSystems: { Garden: 'kappa-ceti' }, defaultProjects: ['Garden'] }));
    const r = seed(['--from', from, '--settings', f.settings, '--apply']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(f.settings, 'utf8')), { projectSystems: { Garden: 'kappa-ceti' }, defaultProjects: ['Garden'] });

    const missing = seed(['--repo', f.repo, '--ref', 'no-such-ref', '--settings', path.join(f.dir, 'other.json')]);
    assert.equal(missing.status, 1);
    assert.match(missing.stdout, /STOP: could not read .* pass --from/);
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('without --settings a test process is refused before anything is read', () => {
  const r = spawnSync(process.execPath, [SCRIPT, '--apply'], { encoding: 'utf8', env: { ...process.env, GLMPS_TEST: '1' } });
  assert.equal(r.status, 2);
  assert.match(r.stdout, /refused in a test process/);
});
