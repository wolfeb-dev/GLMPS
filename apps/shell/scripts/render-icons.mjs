// npm run icons: writes the six icon files from icon-lib.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { buildIcons } from './icon-lib.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
for (const [rel, buf] of Object.entries(buildIcons())) {
  const out = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, buf);
  console.log(`${rel} ${buf.length} bytes`);
}
