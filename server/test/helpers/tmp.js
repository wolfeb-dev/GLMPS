import fs from 'node:fs';
import os from 'node:os';

// Windows can hand out TEMP in 8.3 form (C:\Users\RUNNER~1 on the GitHub
// runner) while git and realpathSync.native report the long form, so a path
// built on os.tmpdir() compares unequal to the same directory read back.
// fs.realpathSync (the JS one) keeps the short name; only .native expands it.
export const tmpRoot = () => fs.realpathSync.native(os.tmpdir());
