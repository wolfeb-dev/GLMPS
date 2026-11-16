// taps/statusline-chain.js
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { recordStatus } from './statusline-chain-lib.js';
import { resolveStateDir } from '../server/lib/state-dir.js';

// honour GLMPS_STATE_DIR the same way server/lib/
// paths.js does (env.GLMPS_STATE_DIR ?? the homedir default) - the installer
// writes the delegate file under GLMPS_STATE_DIR when it is set, so this chain
// must read it from the same place or it silently finds no delegate at all.
const stateDir = resolveStateDir();
const statusDir = path.join(stateDir, 'status');
const delegateFile = path.join(stateDir, 'state', 'statusline-delegate.json');

let raw = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', c => raw += c);
process.stdin.on('end', () => {
  let input = null;
  try { input = JSON.parse(raw); } catch {}
  if (input) { try { recordStatus(input, statusDir); } catch {} }
  // delegate to the previous statusline command (e.g. Claude Manager's tap)
  let delegate = null;
  try { delegate = JSON.parse(fs.readFileSync(delegateFile, 'utf-8')).command; } catch {}
  if (delegate) {
    // delegate command is passed verbatim to the shell - it must be pre-quoted in settings.json (it is, for Claude Manager's tap)
    const r = spawnSync(delegate, { input: raw, shell: true, encoding: 'utf-8', timeout: 5000 });
    if (typeof r.stdout === 'string') process.stdout.write(r.stdout);
  }
});
