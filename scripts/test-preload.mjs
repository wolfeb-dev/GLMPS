// Loaded through test.env's NODE_OPTIONS by every test-file process (card
// glmps-2-0-184). Windows can hand out TEMP in 8.3 form while git and
// realpathSync.native report the long form, so a test comparing a temp path with
// one read back sees two strings for one directory. Normalising here covers npm
// test, affected-tests and the merge queue alike, not just CI.
import fs from 'node:fs';
import os from 'node:os';

if (process.platform === 'win32') {
  try {
    const long = fs.realpathSync.native(os.tmpdir());
    process.env.TEMP = long;
    process.env.TMP = long;
  } catch { /* an unreadable TEMP is left alone; long-tmp-guard.test.js names the cause */ }
}

// Processes the tests spawn inherit the long TEMP; they must not inherit the
// relative --import, which would not resolve from another cwd.
delete process.env.NODE_OPTIONS;
