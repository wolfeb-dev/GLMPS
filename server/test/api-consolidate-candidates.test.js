// server/test/api-consolidate-candidates.test.js
// HTTP smoke of GET /api/memory/consolidate-candidates: propose-only
// near-duplicate clustering across the memory-dir and CLAUDE.global.md
// "## Learned guards" domains. Uses temp GLMPS_STATE_DIR/GLMPS_CLAUDE_DIR/
// GLMPS_MEMORY_DIR/GLMPS_ASSETS_DIR throughout - never touches the user's real
// ~/.claude memory or glmps-assets checkout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server.js';

function tmp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

async function withServer(envExtra, fn) {
  const stateDir = tmp('mc-consolidate-state-');
  const claudeDir = tmp('mc-consolidate-claude-');
  fs.mkdirSync(path.join(claudeDir, 'projects'), { recursive: true });
  const configFile = path.join(stateDir, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({}));
  const env = { ...process.env, GLMPS_STATE_DIR: stateDir, GLMPS_CLAUDE_DIR: claudeDir, ...envExtra };
  const h = await startServer({ port: 0, env, configFile });
  const base = `http://127.0.0.1:${h.port}`;
  const get = async (p) => { const r = await fetch(base + p); return { status: r.status, body: await r.json() }; };
  try { await fn({ get, stateDir, claudeDir }); }
  finally { await h.close?.(); fs.rmSync(stateDir, { recursive: true, force: true }); fs.rmSync(claudeDir, { recursive: true, force: true }); }
}

test('GET /api/memory/consolidate-candidates: no memory dir and no CLAUDE.global.md -> empty candidates, no throw', async () => {
  const memoryDir = path.join(tmp('mc-consolidate-mem-'), 'nonexistent', 'memory');
  const assetsDir = tmp('mc-consolidate-assets-empty-');
  await withServer({ GLMPS_MEMORY_DIR: memoryDir, GLMPS_ASSETS_DIR: assetsDir }, async ({ get }) => {
    const r = await get('/api/memory/consolidate-candidates');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.candidates, []);
  });
});

test('GET /api/memory/consolidate-candidates: near-duplicate memory files surface a memory-domain proposal', async () => {
  const memoryDir = tmp('mc-consolidate-mem-');
  fs.writeFileSync(path.join(memoryDir, 'MEMORY.md'), '# Memory index\n');
  fs.writeFileSync(
    path.join(memoryDir, 'sleep-poll-a.md'),
    '---\nname: sleep-poll-a\ndescription: d\nmetadata:\n  node_type: memory\n  type: project\n---\n\nNever poll with sleep N then cat - use run_in_background or Monitor instead.\n',
  );
  fs.writeFileSync(
    path.join(memoryDir, 'sleep-poll-b.md'),
    '---\nname: sleep-poll-b\ndescription: d\nmetadata:\n  node_type: memory\n  type: project\n---\n\nNever poll using sleep N then cat, use run_in_background or Monitor rather than that.\n',
  );
  const assetsDir = tmp('mc-consolidate-assets-empty-');

  await withServer({ GLMPS_MEMORY_DIR: memoryDir, GLMPS_ASSETS_DIR: assetsDir }, async ({ get }) => {
    const r = await get('/api/memory/consolidate-candidates');
    assert.equal(r.status, 200);
    assert.equal(r.body.candidates.length, 1);
    const c = r.body.candidates[0];
    assert.equal(c.domain, 'memory');
    assert.deepEqual(c.members.sort(), ['sleep-poll-a.md', 'sleep-poll-b.md']);
    assert.ok(c.members.includes(c.canonicalId));

    // Propose-only: the source files are untouched, MEMORY.md is untouched,
    // and no third file was written.
    assert.equal(fs.readdirSync(memoryDir).filter((n) => n.endsWith('.md')).length, 3);
  });
});

test('GET /api/memory/consolidate-candidates: near-duplicate CLAUDE.global.md guard lines surface a guards-domain proposal', async () => {
  const memoryDir = path.join(tmp('mc-consolidate-mem-'), 'empty', 'memory');
  const assetsDir = tmp('mc-consolidate-assets-');
  fs.writeFileSync(
    path.join(assetsDir, 'CLAUDE.global.md'),
    [
      '# Global',
      '',
      '## Learned guards',
      '- Never poll with sleep N then cat - use run_in_background or Monitor.',
      '- Never poll using sleep N then cat, use run_in_background or Monitor instead.',
      '- Use the Grep/Read tools instead of Bash grep/cat for searching and reading files.',
    ].join('\n'),
  );

  await withServer({ GLMPS_MEMORY_DIR: memoryDir, GLMPS_ASSETS_DIR: assetsDir }, async ({ get }) => {
    const r = await get('/api/memory/consolidate-candidates');
    assert.equal(r.status, 200);
    assert.equal(r.body.candidates.length, 1);
    const c = r.body.candidates[0];
    assert.equal(c.domain, 'guards');
    assert.equal(c.members.length, 2);

    // Propose-only: CLAUDE.global.md itself is untouched.
    const stillThere = fs.readFileSync(path.join(assetsDir, 'CLAUDE.global.md'), 'utf-8');
    assert.match(stillThere, /Never poll with sleep N then cat - use run_in_background or Monitor\./);
    assert.match(stillThere, /Never poll using sleep N then cat, use run_in_background or Monitor instead\./);
  });
});

test('GET /api/memory/consolidate-candidates: threshold and minClusterSize query params are honored', async () => {
  const memoryDir = tmp('mc-consolidate-mem-');
  fs.writeFileSync(
    path.join(memoryDir, 'a.md'),
    '---\nname: a\ndescription: d\nmetadata:\n  node_type: memory\n  type: project\n---\n\nNever poll with sleep N then cat - use run_in_background or Monitor.\n',
  );
  fs.writeFileSync(
    path.join(memoryDir, 'b.md'),
    '---\nname: b\ndescription: d\nmetadata:\n  node_type: memory\n  type: project\n---\n\nNever poll using sleep N then cat, use run_in_background or Monitor instead.\n',
  );
  const assetsDir = tmp('mc-consolidate-assets-empty-');

  await withServer({ GLMPS_MEMORY_DIR: memoryDir, GLMPS_ASSETS_DIR: assetsDir }, async ({ get }) => {
    // minClusterSize above the actual cluster size (2) suppresses the proposal.
    const suppressed = await get('/api/memory/consolidate-candidates?minClusterSize=3');
    assert.deepEqual(suppressed.body.candidates, []);

    // An unreachably high similarity threshold also suppresses it.
    const strict = await get('/api/memory/consolidate-candidates?threshold=0.999');
    assert.deepEqual(strict.body.candidates, []);
  });
});
