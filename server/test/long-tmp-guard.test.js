// Card glmps-2-0-172: Windows can hand out TEMP in 8.3 form (C:\Users\RUNNER~1
// on the GitHub runner) while git and realpathSync.native report the long form,
// so any test that builds a path on os.tmpdir() and compares it with a path read
// back sees two strings for one directory (card glmps-2-0-178 hit 42 of them).
// test.env preloads scripts/test-preload.mjs into every test process, which sets
// one long-form TEMP for the whole suite (card glmps-2-0-184); this fails loudly,
// with the cause, if a run ever starts without it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('the suite runs with a long-form temp dir', { skip: process.platform !== 'win32' && 'only Windows has 8.3 names' }, () => {
  const tmp = os.tmpdir();
  const long = fs.realpathSync.native(tmp);
  assert.equal(tmp.toLowerCase(), long.toLowerCase(),
    `TEMP is in 8.3 short form (${tmp}, long form ${long}); tests comparing temp paths with what git reads back will fail. Run the tests with --env-file=test.env (its NODE_OPTIONS preload sets the long form), or set TEMP and TMP to the long form yourself.`);
});

test('a run started with an 8.3 TEMP sees the long form, and spawned processes do not inherit the preload', { skip: process.platform !== 'win32' && 'only Windows has 8.3 names' }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'long-tmp-guard-'));
  try {
    const long = path.join(dir, 'a-long-temp-folder-name');
    fs.mkdirSync(long);
    const shortName = spawnSync('cmd', ['/d', '/s', '/c', `"for %I in ("${long}") do @echo %~sI"`], { encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true }).stdout.trim();
    if (!shortName || shortName.toLowerCase() === long.toLowerCase()) return t.skip('this volume has no 8.3 names');
    const env = { ...process.env, TEMP: shortName, TMP: shortName };
    delete env.NODE_OPTIONS;
    const probe = "const c=require('child_process').spawnSync(process.execPath,['-p','process.env.NODE_OPTIONS||\"none\"'],{encoding:'utf8'});console.log(JSON.stringify({tmp:require('os').tmpdir(),TMP:process.env.TMP,child:c.stdout.trim()}))";
    const r = spawnSync(process.execPath, ['--env-file=test.env', '-e', probe], { cwd: ROOT, env, encoding: 'utf8', windowsHide: true });
    assert.equal(r.status, 0, r.stderr);
    const seen = JSON.parse(r.stdout.trim());
    assert.equal(seen.tmp.toLowerCase(), fs.realpathSync.native(long).toLowerCase());
    assert.equal(seen.TMP, seen.tmp);
    assert.equal(seen.child, 'none');

    // The suite entry itself, as npm test and affected-tests start it: the
    // test-file process the runner spawns must see the long form too.
    const probeFile = path.join(dir, 'probe.mjs');
    fs.writeFileSync(probeFile, [
      "import { test } from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import os from 'node:os';",
      "test('long temp', () => { assert.equal(os.tmpdir().toLowerCase(), process.env.LONG_TMP_EXPECTED.toLowerCase()); assert.equal(process.env.TMP, os.tmpdir()); });",
    ].join('\n'));
    // NODE_TEST_CONTEXT would make the nested runner report to this one over a
    // private channel instead of running as a top-level suite.
    const suiteEnv = { ...env, LONG_TMP_EXPECTED: fs.realpathSync.native(long) };
    delete suiteEnv.NODE_TEST_CONTEXT;
    const suite = spawnSync(process.execPath, ['--test', '--env-file=test.env', probeFile], { cwd: ROOT, env: suiteEnv, encoding: 'utf8', windowsHide: true });
    assert.equal(suite.status, 0, `${suite.stdout}${suite.stderr}`);
    assert.match(suite.stdout, /pass 1/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
