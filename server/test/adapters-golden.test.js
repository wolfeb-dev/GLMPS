// server/test/adapters-golden.test.js
// glmps-46: golden-fixture replay regression suite. Every capture adapter has
// >=1 committed sanitized fixture under server/test/fixtures/<tool>/; replaying
// it through the adapter's real extract must reproduce the committed snapshot
// of the normalized event stream ({kind,lane,label,path,tool,ts,...}) exactly.
// A mismatch fails the suite.
//
// Regenerate snapshots intentionally with:  GLMPS_UPDATE_GOLDEN=1 node --test server/test/adapters-golden.test.js
// (then REVIEW the expected.json diffs before committing - they are the contract).
//
// No live ~/.claude or ~/.gemini reads: replay is pure (fixture text/db in,
// events out); sqlite fixtures are .sql dumps built into a temp db.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOL_REGISTRY } from '../lib/observability/capture-registry.js';
import { adapterHealth, resetAdapterHealth } from '../lib/adapters/health.js';

import * as gemini from '../lib/adapters/gemini-cli.js';
import * as codex from '../lib/adapters/codex-cli.js';
import * as copilot from '../lib/adapters/copilot-chat.js';
import * as copilotCli from '../lib/adapters/copilot-cli.js';
import * as hermes from '../lib/adapters/hermes.js';
import * as agyCli from '../lib/adapters/agy-cli.js';
import * as cline from '../lib/adapters/cline.js';
import * as opencode from '../lib/adapters/opencode.js';
import * as openclaw from '../lib/adapters/openclaw.js';
import * as cursorCli from '../lib/adapters/cursor-cli.js';
import * as grok from '../lib/adapters/grok.js';
import * as pi from '../lib/adapters/pi.js';
import * as droid from '../lib/adapters/droid.js';
import { extractClaudeEvents } from '../lib/observability/extract-claude.js';
import { extractAgEvents } from '../lib/observability/extract-antigravity.js';

let DatabaseSync = null;
try { ({ DatabaseSync } = await import('node:sqlite')); } catch {}

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const REPO_ROOT = path.resolve(FIXTURES, '..', '..', '..');
const UPDATE = process.env.GLMPS_UPDATE_GOLDEN === '1';
const SID = 'golden';

const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });

function replayJsonl(file, extractor) {
  const lines = fs.readFileSync(file, 'utf-8').split('\n').filter(l => l.trim());
  return { events: lines.flatMap(l => extractor(l, SID)) };
}

function buildDbFromSql(sqlFile) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-golden-'));
  tmpDirs.push(tmp);
  const dbPath = path.join(tmp, 'fixture.db');
  const db = new DatabaseSync(dbPath);
  db.exec(fs.readFileSync(sqlFile, 'utf-8'));
  db.close();
  return dbPath;
}

// One replay recipe per capture adapter. `fixture` is the raw golden artifact
// (relative to server/test/fixtures/); each returns the normalized extract output.
const GOLDEN = [
  { id: 'claude-code', fixture: 'claude-code/transcript.jsonl',
    replay: f => replayJsonl(f, extractClaudeEvents) },
  { id: 'antigravity', fixture: 'antigravity/session.jsonl',
    replay: f => replayJsonl(f, extractAgEvents) },
  { id: 'codex-cli', fixture: 'codex-cli/rollout.jsonl',
    replay: f => { codex.resetTokenState(); return replayJsonl(f, codex.extractLine); } },
  { id: 'gemini-cli', fixture: 'gemini-cli/session.json',
    replay: f => { const r = gemini.extractSnapshot(fs.readFileSync(f, 'utf-8'), SID); return { title: r.title, events: r.events }; } },
  { id: 'copilot-chat', fixture: 'copilot-chat/chat.json',
    replay: f => { const r = copilot.extractSnapshot(fs.readFileSync(f, 'utf-8'), SID); return { title: r.title ?? null, events: r.events }; } },
  { id: 'copilot-cli', fixture: 'copilot-cli/events.jsonl',
    replay: f => replayJsonl(f, copilotCli.extractLine) },
  { id: 'openclaw', fixture: 'openclaw/session.jsonl',
    replay: f => replayJsonl(f, openclaw.extractLine) },
  { id: 'cline', fixture: 'cline/ui_messages.json',
    replay: f => { const r = cline.extractSnapshot(fs.readFileSync(f, 'utf-8'), SID); return { title: r.title, events: r.events }; } },
  { id: 'opencode', fixture: 'opencode/storage',
    replay: f => {
      const sessionFile = path.join(f, 'session', 'prj', 'ses_1.json');
      const messagesDir = path.join(f, 'message', 'ses_1');
      const r = opencode.extractSnapshot(fs.readFileSync(sessionFile, 'utf-8'), SID, { extra: { messagesDir } });
      return { title: r.title, events: r.events };
    } },
  { id: 'cursor-cli', fixture: 'cursor-cli/transcript.jsonl',
    replay: f => replayJsonl(f, cursorCli.extractLine) },
  { id: 'grok', fixture: 'grok/chat_history.jsonl',
    replay: f => replayJsonl(f, grok.extractLine) },
  { id: 'pi', fixture: 'pi/session.jsonl',
    replay: f => replayJsonl(f, pi.extractLine) },
  { id: 'droid', fixture: 'droid/session.jsonl',
    replay: f => replayJsonl(f, droid.extractLine) },
  { id: 'hermes', fixture: 'hermes/state.sql', sqlite: true,
    replay: f => {
      const db = buildDbFromSql(f);
      const r = hermes.extractSteps(db, -1, { sessionId: 'golden' });
      return { title: r.title, events: r.events };
    } },
  { id: 'agy-cli', fixture: 'agy-cli/steps.sql', sqlite: true,
    replay: f => {
      const db = buildDbFromSql(f);
      const r = agyCli.extractSteps(db, -1);
      return { title: r.title, events: r.events };
    } },
];

test('golden: every capture adapter in the registry has a replay recipe here', () => {
  const covered = new Set(GOLDEN.map(g => g.id));
  const withAdapter = TOOL_REGISTRY.filter(t => t.adapter);
  for (const t of withAdapter) {
    assert.ok(covered.has(t.id), `registry adapter ${t.id} has no golden replay recipe`);
  }
});

test('golden: registry fixture paths point at the committed artifacts', () => {
  for (const g of GOLDEN) {
    const entry = TOOL_REGISTRY.find(t => t.id === g.id);
    assert.ok(entry, `${g.id} missing from registry`);
    assert.equal(typeof entry.fixture, 'string', `${g.id} registry entry has no fixture`);
    const abs = path.join(REPO_ROOT, entry.fixture);
    assert.ok(fs.existsSync(abs), `${g.id} registry fixture missing on disk: ${entry.fixture}`);
  }
});

for (const g of GOLDEN) {
  test(`golden replay: ${g.id} fixture reproduces its snapshot exactly`, (t) => {
    if (g.sqlite && !DatabaseSync) return t.skip('node:sqlite not available');
    const fixture = path.join(FIXTURES, g.fixture);
    assert.ok(fs.existsSync(fixture), `fixture missing: ${g.fixture}`);

    resetAdapterHealth();
    const got = g.replay(fixture);
    // shared event shape sanity: every event carries kind + lane
    assert.ok(Array.isArray(got.events) && got.events.length > 0, `${g.id} fixture yields no events`);
    for (const e of got.events) {
      assert.equal(typeof e.kind, 'string', `${g.id} event missing kind`);
      assert.equal(typeof e.lane, 'string', `${g.id} event missing lane`);
    }
    // a valid golden fixture must not trip the drift detector (glmps-45)
    assert.equal(adapterHealth()[g.id]?.degraded, undefined, `${g.id} golden fixture tripped drift detection`);

    const snapPath = path.join(FIXTURES, path.dirname(g.fixture) === '.' ? g.id : g.fixture.split('/')[0], 'expected.json');
    if (UPDATE) {
      fs.writeFileSync(snapPath, JSON.stringify(got, null, 2) + '\n');
      t.diagnostic(`updated ${snapPath}`);
      return;
    }
    assert.ok(fs.existsSync(snapPath), `snapshot missing: ${snapPath} (run with GLMPS_UPDATE_GOLDEN=1 to create, then review)`);
    const expected = JSON.parse(fs.readFileSync(snapPath, 'utf-8'));
    assert.deepEqual(got, expected, `${g.id}: extract output drifted from golden snapshot`);
  });
}
