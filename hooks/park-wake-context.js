#!/usr/bin/env node
// PostToolUse hook: when a parked runner session reads an operator wake reply
// from the GLMPS park loop, tell the auto-mode classifier where it came from.
// Context only, not intent (see server/lib/governance/park-wake-context.js).
// Emits nothing for any other tool result, and exits 0 on any error.
import { fileURLToPath } from 'node:url';
import { parkWakeContext } from '../server/lib/governance/park-wake-context.js';

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => { raw += d; });
  process.stdin.on('end', () => {
    try {
      const out = parkWakeContext(JSON.parse(raw || '{}'));
      if (out) process.stdout.write(JSON.stringify(out));
    } catch { /* fail open */ }
    process.exit(0);
  });
  process.stdin.on('error', () => process.exit(0));
}
