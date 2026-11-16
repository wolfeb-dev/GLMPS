#!/usr/bin/env node
// scripts/migrate-distilled-to-mem0.mjs
//
// D23/D24 cutover (glmps-159 task 6), Step 5. Runs the one-time migration of
// EVERY project's pre-D23 distilled pool
// (<claudeDir>/projects/*/memory/distilled/*.md) into Mem0, over HTTP
// (POST /api/memory/migrate-distilled) -- scripts do not import plugin
// internals, the server route does the real work (migrateDistilled +
// readAllDistilledFacts in server/lib/plugins/memory-plugin.js).
//
// Safe to re-run: the route keeps a ledger (<stateDir>/plugins/mem0/
// migrated.ndjson) keyed by content hash, so an already-imported fact is
// skipped (reported as `alreadyImported`), never re-sent or duplicated.
// Mem0's own infer:false add does NOT dedup
// identical text on its own - confirmed against the real adapter - the
// ledger is what makes a re-run after a partial failure safe.) Runs at
// deploy, AFTER this build is on the live server -- not part of
// building this task, which only builds and tests the route/script against
// tmp dirs.
//
//   node scripts/migrate-distilled-to-mem0.mjs

import http from 'node:http';

const port = Number(process.env.GLMPS_PORT || 8123);

function postJson(reqPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: reqPath, method: 'POST' }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

let result;
try {
  result = await postJson('/api/memory/migrate-distilled');
} catch (e) {
  process.stdout.write(`could not reach the memory server on port ${port}: ${e.message}\n`);
  process.exit(1);
}
if (result.status === 409) {
  process.stdout.write('a migration is already running (another call is in flight); try again shortly.\n');
  process.exit(1);
}
if (result.status !== 200) {
  process.stdout.write(`migration failed (${result.status}): ${result.body?.error ?? 'unknown error'}\n`);
  process.exit(1);
}
const {
  total, imported, alreadyImported, skippedPoisoned, failed, firstError,
} = result.body;
process.stdout.write(
  `distilled facts: ${total}  imported: ${imported}  already imported: ${alreadyImported}  `
  + `skipped (poisoned): ${skippedPoisoned}  failed: ${failed}\n`,
);
if (failed > 0) {
  process.stdout.write(`first error: ${firstError}\n`);
  process.stdout.write('some facts failed to import -- safe to re-run this script (already-imported facts are ledgered and skipped).\n');
  process.exit(1);
}
process.exit(0);
