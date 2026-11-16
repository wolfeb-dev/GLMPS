#!/usr/bin/env node
// scripts/setup/editor-setup.mjs - the Default IDE wizard step's effects.
//   save <target>      write the pick as lastTarget and openTarget in the runner config
//   install <target>   install the companion into that IDE with its own CLI
// Prints one JSON line: { ok, target } or { ok: false, reason }. The kernel dir
// is this script's own checkout, the state dir comes from GLMPS_STATE_DIR.
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getPaths } from '../../server/lib/paths.js';
import { saveConfig } from '../../server/lib/orchestration/runner-store.js';
import { defaultProgramFiles } from '../../server/lib/orchestration/editor-detect.js';
import { saveEditorPick, installCompanion } from '../../server/lib/chassis/editor-setup.js';

const [verb, target] = process.argv.slice(2);
const kernelDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let result;
if (verb === 'save') {
  result = saveEditorPick({ target, saveConfig: (patch) => saveConfig(getPaths(process.env).stateDir, patch) });
} else if (verb === 'install') {
  result = installCompanion({
    target, home: os.homedir(), programFiles: defaultProgramFiles(process.env), kernelDir,
    run: (cmd) => spawnSync(cmd.file, cmd.args, cmd.options),
  });
} else {
  result = { ok: false, reason: 'bad-verb' };
}
console.log(JSON.stringify(result));
process.exit(result.ok ? 0 : 1);
